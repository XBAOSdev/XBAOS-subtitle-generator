/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 只用 Node 22 内置的 WebSocket，不引第三方包 —— 这个项目的探针工具
 * 服务于「依赖越少越好」这条约束，自己写几十行比装 puppeteer 更符合初衷。
 *
 * 浏览器探针（ui-probe.mjs）和 Electron 探针（electron-probe.mjs）共用这一份。
 */

import { writeFileSync } from 'node:fs'

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    /** 连接断开的原因，断开后新的请求直接失败而不是永远挂着 */
    this.closedReason = null

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(msg.error.message))
        else entry.resolve(msg.result)
        return
      }
      const handlers = this.listeners.get(msg.method)
      if (handlers) for (const fn of handlers) fn(msg.params)
    })

    /**
     * 连接断开时必须把所有在途请求一起结算掉。
     *
     * 少了这一步，一旦对端进程死掉（例如 Electron 的 GPU 进程崩溃把整个应用带崩），
     * WS 关闭但请求既不 resolve 也不 reject，调用方会永远等下去 ——
     * 表面现象是「探针跑着跑着就没声音了」，看不出任何原因。
     */
    const onGone = (label) => {
      if (this.closedReason) return
      this.closedReason = label
      for (const [id, entry] of this.pending) {
        this.pending.delete(id)
        entry.reject(new Error(`CDP 连接已断开（${label}），请求 #${id} 未能完成`))
      }
    }
    ws.addEventListener('close', (event) => onGone(`close code=${event.code}`))
    ws.addEventListener('error', () => onGone('error'))
  }

  /**
   * 发一条 CDP 命令。
   *
   * 默认带超时：对端进程半死不活时（典型是渲染进程崩了但 ws 还没触发 close），
   * 请求会既不 resolve 也不 reject，调用方永远等下去 —— 表现出来是「探针跑着
   * 跑着就没声音了」，看不出任何原因。超时把它变成一条明确的失败。
   * 需要跑很久的命令（引擎识别、模型下载）自己传更长的 timeoutMs。
   */
  send(method, params = {}, { timeoutMs = 90_000 } = {}) {
    if (this.closedReason) {
      return Promise.reject(new Error(`CDP 连接已断开（${this.closedReason}），无法发送 ${method}`))
    }
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超过 ${timeoutMs}ms 没有响应`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`发送 ${method} 失败: ${err.message}`))
      }
    })
  }

  once(method) {
    return new Promise((resolve) => {
      const handlers = this.listeners.get(method) ?? []
      const fn = (params) => {
        this.listeners.set(
          method,
          (this.listeners.get(method) ?? []).filter((h) => h !== fn),
        )
        resolve(params)
      }
      this.listeners.set(method, [...handlers, fn])
    })
  }

  /** 持续订阅某个事件，返回取消函数 */
  on(method, callback) {
    const handlers = this.listeners.get(method) ?? []
    const fn = (params) => callback(params)
    this.listeners.set(method, [...handlers, fn])
    return () => {
      this.listeners.set(
        method,
        (this.listeners.get(method) ?? []).filter((h) => h !== fn),
      )
    }
  }

  /** 在页面里求值，返回 JS 值 */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate 失败')
    }
    return res.result.value
  }

  async click(x, y) {
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 }
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 已经关了 */
    }
  }
}

/**
 * 截图存盘。
 * clip 可只截一小块并放大（scale > 1），用于核对排版细节。
 * @param {Cdp} cdp
 * @param {string} filePath 绝对路径
 */
export async function capture(cdp, filePath, clip) {
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: clip.scale ?? 1 } } : {}),
  })
  writeFileSync(filePath, Buffer.from(res.data, 'base64'))
  return filePath
}

/**
 * 连上某个 CDP 的 WebSocket 地址。
 * 加超时是必要的：对端进程半死不活时，socket 既不 open 也不 error，
 * 没有超时就会永远等下去。
 */
export async function connect(webSocketDebuggerUrl, { timeoutMs = 10_000 } = {}) {
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`连接 CDP 超时（${timeoutMs}ms）`)), timeoutMs)
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('连接 CDP 失败'))
      },
      { once: true },
    )
  })
  return new Cdp(ws)
}

/** 轮询等待调试端口就绪，返回 /json/version 的内容 */
export async function waitForDebugPort(port, { attempts = 80, intervalMs = 250 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

/**
 * 等待页面里出现匹配调试目标的标签页。
 * Electron 启动时会先有一个 about:blank 的 target，主窗口加载完 URL 才有内容，
 * 所以必须轮询而不是只取一次列表。
 */
export async function waitForPageTarget(port, { attempts = 80, intervalMs = 250, exclude = [] } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const list = await res.json()
        const page = list.find(
          (t) => t.type === 'page' && t.webSocketDebuggerUrl && !exclude.includes(t.url),
        )
        if (page) return page
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}
