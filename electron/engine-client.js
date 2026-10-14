/**
 * 识别引擎进程管理。
 *
 * 引擎（xbaos-engine.exe）是独立进程，协议是行分隔的 JSON：
 * 我们往它的 stdin 写一行请求，它往 stdout 回若干行响应，日志走 stderr。
 *
 * 这里负责四件事：
 *   1. 生命周期 —— 惰性启动、崩溃后重启、退出时干净收尾
 *   2. 请求关联 —— 每条响应都带 id，用它把响应派回对应的请求
 *   3. 流式转发 —— progress / segment 是边跑边推的，直接转给调用方
 *   4. 背压保护 —— stdout 按行切分，不完整的行留在缓冲里等下一块
 *
 * 为什么不做超时：一次识别可能跑几分钟，任何固定超时都是错的。
 * 卡死由「用户点取消」和「进程退出」两条路径兜底。
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

/** 引擎进程非正常退出 */
export class EngineCrashError extends Error {
  constructor(message, code, signal) {
    super(message)
    this.name = 'EngineCrashError'
    this.code = code
    this.signal = signal
  }
}

/** 引擎回了一条 type=error */
export class EngineRequestError extends Error {
  constructor(id, message) {
    super(message)
    this.name = 'EngineRequestError'
    this.requestId = id
  }
}

/** 用户主动取消 */
export class EngineCanceledError extends Error {
  constructor(id) {
    super('识别已取消')
    this.name = 'EngineCanceledError'
    this.requestId = id
  }
}

/** 这条响应是「终态」，收到就该把请求结算掉 */
const TERMINAL_TYPES = new Set(['pong', 'loaded', 'done', 'canceled', 'error'])

export class EngineClient extends EventEmitter {
  /** @type {import('node:child_process').ChildProcess | null} */
  #proc = null
  #exe = ''
  #spawnArgs = []

  #nextId = 1
  /** @type {Map<number, {resolve: Function, reject: Function, onEvent?: Function, settled: boolean}>} */
  #pending = new Map()

  #stdoutBuf = ''
  #stderrBuf = ''
  #starting = null
  #disposed = false
  #logLines = 0

  constructor(exe, args = []) {
    super()
    this.#exe = exe
    this.#spawnArgs = args
  }

  get exe() {
    return this.#exe
  }

  get running() {
    return this.#proc !== null && this.#proc.exitCode === null && !this.#proc.killed
  }

  /** 引擎是否已经加载了模型（由 ping / load / unload 的结果推断） */
  modelLoaded = false
  /** 当前实际生效的后端，'cpu' | 'vulkan' | 'unknown' */
  backend = 'unknown'

  // ---------------------------------------------------------------- 进程管理

  /**
   * 确保引擎在跑。并发调用只会启动一次 —— 多个请求同时到达时
   * 都拿同一个 Promise，不会各起一个进程。
   */
  async start() {
    if (this.running) return this
    if (this.#starting) return this.#starting
    if (this.#disposed) throw new Error('引擎客户端已关闭')

    this.#starting = new Promise((resolve, reject) => {
      let proc
      try {
        // windowsHide 避免打包后弹黑框；shell 必须关掉，参数里有含空格的路径
        proc = spawn(this.#exe, this.#spawnArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        })
      } catch (err) {
        this.#starting = null
        reject(err)
        return
      }

      this.#proc = proc
      this.#stdoutBuf = ''
      this.#stderrBuf = ''

      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => this.#onStdout(chunk))

      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk) => this.#onStderr(chunk))

      proc.on('error', (err) => {
        this.#starting = null
        this.emit('log', 'error', `引擎进程启动失败: ${err.message}`)
        this.#failAllPending(new EngineCrashError(`引擎进程启动失败: ${err.message}`, null, null))
        reject(err)
      })

      proc.on('exit', (code, signal) => this.#onExit(code, signal))

      // 进程起来了就先单步 resolve —— 真正的握手交给 ping，
      // 免得把「可执行文件能跑」和「引擎协议正常」混成一件事
      this.#starting = null
      this.emit('log', 'info', `引擎进程已启动 pid=${proc.pid}`)
      resolve(this)
    })

    return this.#starting
  }

  #onExit(code, signal) {
    const wasRunning = this.#proc !== null
    this.#proc = null

    // 正常关闭：pending 已经空了，什么都不用做
    const crashed = wasRunning && this.#pending.size > 0
    if (crashed) {
      this.emit('log', 'error', `引擎进程异常退出 code=${code} signal=${signal}`)
      this.#failAllPending(
        new EngineCrashError(`识别引擎意外退出（代码 ${code ?? '无'}）`, code, signal),
      )
    } else if (wasRunning) {
      this.emit('log', 'info', `引擎进程已退出 code=${code}`)
    }

    this.modelLoaded = false
    this.backend = 'unknown'
    this.emit('exit', { code, signal, crashed })
  }

  /** 主动关闭。先发 shutdown 让它自己退，超时就强杀。 */
  async stop({ timeoutMs = 1500 } = {}) {
    const proc = this.#proc
    if (!proc) return

    try {
      proc.stdin.write(JSON.stringify({ id: this.#nextId++, cmd: 'shutdown' }) + '\n')
    } catch {
      /* stdin 已关，直接走下面的强杀 */
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.emit('log', 'warn', '引擎未按时退出，强制结束')
        try {
          proc.kill()
        } catch {
          /* 已经没了 */
        }
        resolve()
      }, timeoutMs)

      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** 与 stop 的区别：这个不允许再启动新进程 */
  async dispose() {
    this.#disposed = true
    await this.stop()
    this.removeAllListeners()
  }

  // ------------------------------------------------------------------ 输出

  #onStdout(chunk) {
    this.#stdoutBuf += chunk

    // 按 \n 切，最后一段可能不完整，留在缓冲里
    const lines = this.#stdoutBuf.split('\n')
    this.#stdoutBuf = lines.pop() ?? ''

    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        // 引擎理论上不会往 stdout 写非 JSON，写进来就是 bug，不要静默吞掉
        this.emit('log', 'warn', `无法解析引擎输出: ${text.slice(0, 300)}`)
        continue
      }
      this.#onMessage(msg)
    }
  }

  #onStderr(chunk) {
    this.#stderrBuf += chunk
    const lines = this.#stderrBuf.split('\n')
    this.#stderrBuf = lines.pop() ?? ''

    for (const line of lines) {
      const text = line.trimEnd()
      if (!text) continue
      // whisper 的日志很吵，全量转发会淹掉真正有用的信息，只保留前若干条
      if (this.#logLines < 200) {
        this.#logLines++
        this.emit('log', 'engine', text)
      } else if (this.#logLines === 200) {
        this.#logLines++
        this.emit('log', 'engine', '(后续引擎日志已省略)')
      }
    }
  }

  #onMessage(msg) {
    const id = typeof msg.id === 'number' ? msg.id : null

    // 后端回退是主动上报，不结算请求
    if (msg.type === 'fallback') {
      if (msg.to) this.backend = msg.to
      this.emit('fallback', msg)
      return
    }

    const entry = id === null ? null : this.#pending.get(id)
    if (!entry) {
      // 没有对应请求的消息：可能请求已被取消，也可能是引擎自说自话
      this.emit('log', 'warn', `收到无主响应: ${JSON.stringify(msg).slice(0, 200)}`)
      return
    }

    if (TERMINAL_TYPES.has(msg.type)) {
      this.#pending.delete(id)
      entry.settled = true

      if (msg.type === 'error') {
        entry.reject(new EngineRequestError(id, msg.message || '引擎返回未知错误'))
      } else if (msg.type === 'canceled') {
        entry.reject(new EngineCanceledError(id))
      } else {
        if (msg.type === 'loaded') {
          this.modelLoaded = true
          if (msg.backend) this.backend = msg.backend
        }
        entry.resolve(msg)
      }
      return
    }

    // 流式消息
    entry.onEvent?.(msg)
  }

  #failAllPending(err) {
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id)
      entry.settled = true
      entry.reject(err)
    }
  }

  // ------------------------------------------------------------------ 请求

  /**
   * 发一条命令。
   * @param {string} cmd
   * @param {object} payload 除 cmd 外的字段
   * @param {{onEvent?: (msg: object) => void}} [opts] onEvent 接 progress / segment
   */
  async request(cmd, payload = {}, opts = {}) {
    await this.start()

    const proc = this.#proc
    if (!proc || !proc.stdin.writable) {
      throw new EngineCrashError('引擎进程不可用', null, null)
    }

    const id = this.#nextId++
    const line = JSON.stringify({ id, cmd, ...payload }) + '\n'

    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onEvent: opts.onEvent, settled: false })
    })

    try {
      proc.stdin.write(line, (err) => {
        if (!err) return
        const entry = this.#pending.get(id)
        if (!entry) return
        this.#pending.delete(id)
        entry.reject(new EngineCrashError(`无法向引擎写入命令: ${err.message}`, null, null))
      })
    } catch (err) {
      this.#pending.delete(id)
      throw new EngineCrashError(`无法向引擎写入命令: ${err.message}`, null, null)
    }

    return promise
  }

  // ---------------------------------------------------------- 命令语义封装

  ping() {
    return this.request('ping')
  }

  load({ model, backend = 'auto' }) {
    return this.request('load', { model, backend })
  }

  unload() {
    return this.request('unload').finally(() => {
      this.modelLoaded = false
    })
  }

  /**
   * @param {{audio: string, language?: string, prompt?: string, threads?: number, translate?: boolean,
   *          temperature?: number, beamSize?: number, bestOf?: number, vad?: boolean, normalize?: boolean,
   *          highPass?: boolean, vadOptions?: object, ranges?: {start: number, end: number}[]}} opts
   * @param {(msg: object) => void} onEvent
   */
  transcribe(opts, onEvent) {
    const payload = {
      audio: opts.audio,
      language: opts.language ?? 'auto',
      translate: !!opts.translate,
    }
    if (opts.prompt) payload.prompt = opts.prompt
    if (opts.threads) payload.threads = opts.threads
    // 多遍识别与音质前处理参数：只有显式给了才传，引擎侧有各自默认值
    if (typeof opts.temperature === 'number') payload.temperature = opts.temperature
    if (opts.beamSize) payload.beamSize = opts.beamSize
    if (opts.bestOf) payload.bestOf = opts.bestOf
    if (typeof opts.vad === 'boolean') payload.vad = opts.vad
    if (typeof opts.normalize === 'boolean') payload.normalize = opts.normalize
    if (typeof opts.highPass === 'boolean') payload.highPass = opts.highPass
    if (opts.vadOptions && typeof opts.vadOptions === 'object') payload.vadOptions = opts.vadOptions
    if (Array.isArray(opts.ranges) && opts.ranges.length > 0) payload.ranges = opts.ranges

    return this.request('transcribe', payload, { onEvent })
  }

  /** 取消不影响后续请求 —— 引擎处理完 abort 后还能继续用 */
  abort() {
    return this.request('abort', {}, {}).catch((err) => {
      this.emit('log', 'warn', `取消失败: ${err.message}`)
    })
  }
}
