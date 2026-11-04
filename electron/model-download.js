/**
 * 模型下载器（主进程）。
 *
 * 为什么下载必须在主进程做：
 *   1. 渲染进程跑在 file:// 协议下，且应用的安全策略禁止页面自身发起外联；
 *   2. 大文件落盘、断点续传、校验都需要 Node 的文件系统能力；
 *   3. Electron 的 net 模块走系统网络栈，行为与 Chromium 一致且不受
 *      页面 CSP 约束，是这里唯一合适的通道。
 *
 * 设计要点：
 *   - 多文件：ONNX 模型是「一个目录 + 若干文件」，whisper 是「单个 .bin」。
 *     条目里的 files 数组统一描述，下载器按顺序拉，进度按**总字节**聚合 ——
 *     界面不需要知道底下有几个文件。
 *   - 双源：国内平台（ModelScope / hf-mirror）在前，另一个在后。
 *     第一个源连不上或返回错误状态时自动换下一个源重试（含续传状态重置）。
 *   - 断点续传：数据先写进 <file>.part，请求带 Range 头。
 *     服务器返回 206 就续写，返回 200（不支持 Range）就从头重写。
 *   - 完整性：清单里每个文件都带真实 sha256，逐个核对。
 *     只有用户自己放进目录的模型（不经这里下载）才没有哈希可比，
 *     那种情况不归本模块管。
 *   - 进度事件节流 250ms，避免 IPC 消息洪泛拖慢界面。
 *
 * 模型来源与许可见 model-catalog.js，这里只管搬运。
 */

import { net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

import { findCatalog } from './model-catalog.js'

/** ggml 文件魔数 0x67676d6c 按小端写入后的前 4 字节 */
function looksLikeGgml(buf) {
  return buf.length >= 4 && buf[0] === 0x6c && buf[1] === 0x6d && buf[2] === 0x67 && buf[3] === 0x67
}

const MIN_MODEL_BYTES = 1024 * 1024 // 任何正经模型都不可能小于 1MB

/** 流式算 SHA256，229MB 约一秒 */
function sha256File(full) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const rs = fs.createReadStream(full, { highWaterMark: 1 << 20 })
    rs.on('data', (chunk) => hash.update(chunk))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}

function fileSize(full) {
  try {
    return fs.statSync(full).size
  } catch {
    return 0
  }
}

export class ModelDownloader {
  /**
   * @param {(payload: object) => void} emit 向渲染进程推送进度事件
   */
  constructor(emit) {
    this.emit = emit
    /** @type {Map<string, object>} key -> 任务状态 */
    this.jobs = new Map()
  }

  isRunning(key) {
    return this.jobs.has(key)
  }

  /** 目录型模型落在 <模型目录>/<id>/，文件型直接落在 <模型目录>/ */
  targetDir(entry, destRoot) {
    return entry.kind === 'dir' ? path.join(destRoot, entry.id) : destRoot
  }

  /** 该条目的全部文件是否已经在磁盘上 */
  isInstalled(entry, destRoot) {
    const dir = this.targetDir(entry, destRoot)
    return entry.files.every((f) => fileSize(path.join(dir, f.name)) >= (f.size || MIN_MODEL_BYTES))
  }

  /**
   * 开始一个下载任务。已在跑时直接返回 false，由 IPC 层决定怎么提示。
   * @returns {boolean}
   */
  start(key, destRoot) {
    const entry = findCatalog(key)
    if (!entry) throw new Error(`未知的模型：${key}`)
    if (this.jobs.has(key)) return false

    if (this.isInstalled(entry, destRoot)) {
      this.emit({ key, status: 'done', already: true })
      return false
    }

    const targetDir = this.targetDir(entry, destRoot)
    fs.mkdirSync(targetDir, { recursive: true })

    const job = {
      key,
      entry,
      destRoot,
      targetDir,
      /** 已完成的文件总字节 */
      doneBytes: 0,
      /** 当前文件已接收字节 */
      curReceived: 0,
      total: entry.files.reduce((sum, f) => sum + (f.size || 0), 0),
      fileIndex: 0,
      request: null,
      lastEmit: 0,
      aborted: false,
      canceled: false,
    }
    this.jobs.set(key, job)
    this.emit({ key, status: 'start', total: job.total })
    void this.run(job)
    return true
  }

  cancel(key) {
    const job = this.jobs.get(key)
    if (!job) return false
    job.canceled = true
    job.aborted = true
    try {
      job.request?.abort()
    } catch {
      /* 还没建连就取消，无需处理 */
    }
    // abort 不保证触发 error / end（Electron 只发 aborted 事件），
    // 直接结算当前尝试，让 run() 走到取消分支
    job.settle?.()
    return true
  }

  async run(job) {
    for (let i = 0; i < job.entry.files.length; i++) {
      if (job.canceled) break
      const file = job.entry.files[i]
      job.fileIndex = i
      job.curReceived = 0

      const destPath = path.join(job.targetDir, file.name)
      // 上次已经下完的文件（比如两个文件下到一半断了）直接跳过，不重下
      if (file.size && fileSize(destPath) === file.size) {
        if (await this.verifyFile(job, destPath, file)) {
          job.doneBytes += file.size
          continue
        }
      }

      let ok = false
      for (let u = 0; u < file.urls.length && !ok; u++) {
        if (job.canceled) break
        try {
          ok = await this.fetchOne(job, file, destPath, file.urls[u], u > 0)
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err)
        }
      }

      if (!ok) {
        /*
         * 取消不是失败。cancel() 会直接结算当前尝试让它返回 false，
         * 若在这里一律报错，用户点了「取消」却收到「下载失败」——
         * 而且 .part 还留着，下次续传时看起来像是自己坏过。
         */
        if (job.canceled) {
          this.finish(job, 'canceled')
          return
        }
        this.finish(job, 'error', job.error ?? '所有下载源都失败了')
        return
      }
      job.doneBytes += file.size || fileSize(destPath)
    }

    if (job.canceled) {
      // 保留 .part，下次继续
      this.finish(job, 'canceled')
      return
    }

    this.finish(job, 'done', null, {
      dest: job.targetDir,
      total: job.total || job.doneBytes,
      received: job.doneBytes,
    })
  }

  finish(job, status, message, extra = {}) {
    this.jobs.delete(job.key)
    this.emit({
      key: job.key,
      status,
      message: message ?? undefined,
      received: job.doneBytes + job.curReceived,
      total: job.total,
      ...extra,
    })
  }

  /** 校验一个已落盘的文件。给了 sha256 就从严，没给就只看魔数与体积 */
  async verifyFile(job, full, file) {
    if (file.sha256) {
      try {
        return (await sha256File(full)) === file.sha256
      } catch {
        return false
      }
    }
    if (file.name.toLowerCase().endsWith('.bin')) {
      let head
      try {
        const fd = fs.openSync(full, 'r')
        head = Buffer.alloc(4)
        fs.readSync(fd, head, 0, 4, 0)
        fs.closeSync(fd)
      } catch {
        return false
      }
      return looksLikeGgml(head) && fileSize(full) >= MIN_MODEL_BYTES
    }
    return fileSize(full) > 0
  }

  /**
   * 拉一个文件。成功返回 true；失败返回 false（换下一个源）。
   */
  fetchOne(job, file, destPath, url, isFallback) {
    return new Promise((resolve) => {
      const part = `${destPath}.part`
      let resumeSize = fileSize(part)

      const request = net.request({ url, method: 'GET' })
      request.setHeader('User-Agent', 'XBAOS-SubtitleGenerator')
      if (resumeSize > 0) request.setHeader('Range', `bytes=${resumeSize}-`)

      let fd = null
      let settled = false

      const finish = (result) => {
        if (settled) return
        settled = true
        job.settle = null
        if (fd !== null) {
          try {
            fs.closeSync(fd)
          } catch {
            /* 已关闭 */
          }
          fd = null
        }
        resolve(result)
      }
      // cancel() 需要能在流事件不触发的情况下结算当前尝试
      job.settle = finish

      request.on('response', (res) => {
        const status = res.statusCode ?? 0

        if (status !== 200 && status !== 206) {
          job.error = `下载源返回 HTTP ${status}${isFallback ? '' : '，将尝试镜像源'}`
          res.resume()
          finish(false)
          return
        }

        // 服务器忽略 Range 从头发了完整内容：改写而不是续写
        if (status === 200 && resumeSize > 0) resumeSize = 0
        if (status === 200) job.curReceived = 0

        try {
          fd = fs.openSync(part, resumeSize > 0 ? 'a' : 'w')
        } catch (err) {
          job.error = `无法写入临时文件：${err instanceof Error ? err.message : String(err)}`
          finish(false)
          return
        }

        res.on('data', (chunk) => {
          if (job.aborted) return
          try {
            fs.writeSync(fd, chunk)
          } catch (err) {
            job.aborted = true
            try {
              request.abort()
            } catch {
              /* 已中断 */
            }
            job.error = `写盘失败：${err instanceof Error ? err.message : String(err)}`
            return
          }
          job.curReceived += chunk.length
          this.maybeEmitProgress(job)
        })

        res.on('end', async () => {
          if (job.aborted) {
            finish(false)
            return
          }
          const got = fileSize(part)
          if (file.size && got !== file.size) {
            job.error = `下载不完整（${got}/${file.size} 字节），可重试续传`
            finish(false)
            return
          }
          const ok = await this.verifyFile(job, part, file)
          if (!ok) {
            job.error = '下载的内容校验未通过，已丢弃'
            try {
              fs.unlinkSync(part)
            } catch {
              /* 删不掉就留着，下次重写 */
            }
            finish(false)
            return
          }
          try {
            fs.renameSync(part, destPath)
          } catch (err) {
            job.error = `文件落盘失败：${err instanceof Error ? err.message : String(err)}`
            finish(false)
            return
          }
          finish(true)
        })

        res.on('error', (err) => {
          if (job.canceled) {
            finish(false)
            return
          }
          job.error = `网络错误：${err.message}${isFallback ? '' : '，将尝试镜像源'}`
          finish(false)
        })
      })

      request.on('error', (err) => {
        if (job.canceled) {
          finish(false)
          return
        }
        job.error = `无法连接下载源：${err.message}${isFallback ? '' : '，将尝试镜像源'}`
        finish(false)
      })

      job.request = request
      request.end()
    })
  }

  maybeEmitProgress(job) {
    const now = Date.now()
    const received = job.doneBytes + job.curReceived
    if (now - job.lastEmit < 250 && received < job.total) return
    job.lastEmit = now
    this.emit({
      key: job.key,
      status: 'progress',
      received,
      total: job.total,
      fileIndex: job.fileIndex,
      fileCount: job.entry.files.length,
      percent: job.total > 0 ? Math.min(99.9, (received / job.total) * 100) : 0,
    })
  }

  /**
   * 删除模型目录里的模型。
   *
   * 只接受纯标识名，拒绝任何路径穿越。目录型模型按「先清文件、再删空目录」
   * 走，不用递归删除 —— 万一用户往模型目录里塞了自己的东西，宁可留着让他看见，
   * 也不要一次 rm -rf 抹掉。
   */
  async remove(id, destRoot, kind = 'file') {
    if (path.basename(id) !== id) {
      throw new Error('只允许删除模型目录下的内容')
    }
    const root = path.resolve(destRoot)
    const target = path.join(root, id)
    if (!target.startsWith(root + path.sep)) throw new Error('非法路径')

    if (kind === 'dir') {
      let entries
      try {
        entries = fs.readdirSync(target, { withFileTypes: true })
      } catch (err) {
        if (err.code === 'ENOENT') return true
        throw err
      }
      // 先整体检查再删：边删边查的话，碰到子文件夹时会留下删了一半的目录
      const foreign = entries.find((e) => !e.isFile())
      if (foreign) {
        throw new Error('模型目录里还有子文件夹，请在资源管理器中手动删除')
      }
      for (const e of entries) {
        await fsp.unlink(path.join(target, e.name))
      }
      await fsp.rmdir(target)
      return true
    }

    // 主文件可能不存在（比如上次取消后只剩 .part），此时只清理续传残留
    for (const p of [target, `${target}.part`]) {
      try {
        await fsp.unlink(p)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    return true
  }
}
