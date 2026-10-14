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
 *   - 双源：Hugging Face 官方在前、hf-mirror.com 国内镜像在后，
 *     第一个源连不上或返回错误状态时自动换下一个源重试（含续传状态重置）。
 *   - 断点续传：数据先写进 <file>.part，请求带 Range 头。
 *     服务器返回 206 就续写，返回 200（不支持 Range）就从头重写。
 *   - 完整性：下载完校验 ggml 魔数（0x67676d6c，文件前 4 字节为
 *     6c 6d 67 67）+ 最小体积，防止把 CDN 的 403 HTML 页面当成模型。
 *     SHA256 校验需要逐条目维护哈希表且上游会随模型更新变化，
 *     魔数 + 体积对「下错文件」这一实际风险已经足够。
 *   - 进度事件节流 250ms，避免 IPC 消息洪泛拖慢界面。
 *
 * 模型来源（均为开源可商用许可）：
 *   small  ggerganov/whisper.cpp          ggml-small.bin
 *   base   ggerganov/whisper.cpp          ggml-base.bin
 *   turbo  ggerganov/whisper.cpp          ggml-large-v3-turbo.bin
 *   belle  BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml   ggml-model.bin
 *
 * 注：small 在 2026-10-14「模型不随包」之前只靠随包分发、没有下载源，
 * 改成不随包后若不补源，推荐档反而成了唯一拿不到的模型。
 */

import { net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

/** 下载完成后文件会落到用户模型目录，统一重命名成带来源语义的名字 */
export const MODEL_CATALOG = [
  {
    key: 'small',
    file: 'ggml-small.bin',
    sizeLabel: '约 480MB',
    urls: [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
      'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    ],
  },
  {
    key: 'base',
    file: 'ggml-base.bin',
    sizeLabel: '约 140MB',
    urls: [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    ],
  },
  {
    key: 'turbo',
    file: 'ggml-large-v3-turbo.bin',
    sizeLabel: '约 1.6GB',
    urls: [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
      'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    ],
  },
  {
    key: 'belle',
    file: 'ggml-belle-large-v3-turbo-zh.bin',
    sizeLabel: '约 1.6GB',
    urls: [
      'https://huggingface.co/BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml/resolve/main/ggml-model.bin',
      'https://hf-mirror.com/BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml/resolve/main/ggml-model.bin',
    ],
  },
]

export function findCatalog(key) {
  return MODEL_CATALOG.find((m) => m.key === key) ?? null
}

/** ggml 文件魔数 0x67676d6c 按小端写入后的前 4 字节 */
function looksLikeGgml(buf) {
  return buf.length >= 4 && buf[0] === 0x6c && buf[1] === 0x6d && buf[2] === 0x67 && buf[3] === 0x67
}

const MIN_MODEL_BYTES = 1024 * 1024 // 任何正经模型都不可能小于 1MB

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

  /**
   * 开始一个下载任务。已在跑时直接返回 false，由 IPC 层决定怎么提示。
   * @returns {boolean}
   */
  start(key, destDir) {
    const entry = findCatalog(key)
    if (!entry) throw new Error(`未知的模型：${key}`)
    if (this.jobs.has(key)) return false

    const dest = path.join(destDir, entry.file)
    if (fs.existsSync(dest)) {
      this.emit({ key, status: 'done', already: true })
      return false
    }

    fs.mkdirSync(destDir, { recursive: true })
    const job = {
      key,
      entry,
      dest,
      part: `${dest}.part`,
      request: null,
      received: 0,
      total: 0,
      lastEmit: 0,
      aborted: false,
      canceled: false,
    }
    this.jobs.set(key, job)
    this.emit({ key, status: 'start' })
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
    for (let i = 0; i < job.entry.urls.length; i++) {
      if (job.canceled) break
      try {
        await this.tryOneSource(job, job.entry.urls[i], i > 0)
        if (job.canceled) break // 取消：保留 .part，下次继续
        if (!job.failed) return // 成功，不再换源
        // 失败了，换下一个源（续传基准保持不变：.part 还在）
      } catch (err) {
        job.failed = true
        job.error = err instanceof Error ? err.message : String(err)
      }
    }

    this.jobs.delete(job.key)
    if (job.canceled) {
      // 保留 .part，下次继续
      this.emit({ key: job.key, status: 'canceled', received: job.received })
      return
    }
    this.emit({
      key: job.key,
      status: 'error',
      message: job.error ?? '所有下载源都失败了',
    })
  }

  /**
   * 尝试一个源。成功（含换源前的可重试失败）时通过 job.failed 表达结果。
   */
  tryOneSource(job, url, isFallback) {
    return new Promise((resolve) => {
      const resumeSize = this.partSize(job.part)
      if (resumeSize > 0 && isFallback && job.received === 0) job.received = resumeSize

      const request = net.request({ url, method: 'GET' })
      request.setHeader('User-Agent', 'XBAOS-SubtitleGenerator')
      if (resumeSize > 0) request.setHeader('Range', `bytes=${resumeSize}-`)

      let fd = null
      let mode = resumeSize > 0 ? 'a' : 'w' // 206 续写；200 重写
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
          job.failed = true
          job.error = `下载源返回 HTTP ${status}${isFallback ? '' : '，将尝试镜像源'}`
          res.resume()
          finish()
          return
        }

        // 服务器忽略 Range 从头发了完整内容：改写而不是续写
        if (status === 200 && resumeSize > 0) mode = 'w'

        let total = job.received
        if (status === 206) {
          const range = res.headers['content-range']
          const match = Array.isArray(range) ? range[0] : range
          const parsed = typeof match === 'string' ? /\/(\d+)$/.exec(match) : null
          if (parsed) total = Number(parsed[1])
        } else {
          const len = res.headers['content-length']
          const raw = Array.isArray(len) ? len[0] : len
          total = raw ? Number(raw) : 0
          job.received = 0
        }
        job.total = total
        mode = status === 206 ? 'a' : 'w'

        try {
          fd = fs.openSync(job.part, mode === 'a' ? 'a' : 'w')
          if (mode === 'w') job.received = 0
        } catch (err) {
          job.failed = true
          job.error = `无法写入临时文件：${err instanceof Error ? err.message : String(err)}`
          finish()
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
            job.failed = true
            job.error = `写盘失败：${err instanceof Error ? err.message : String(err)}`
            return
          }
          job.received += chunk.length
          this.maybeEmitProgress(job)
        })

        res.on('end', () => {
          if (job.aborted) {
            finish()
            return
          }
          // ---- 完整性校验 ----
          if (job.total > 0 && job.received < job.total) {
            job.failed = true
            job.error = '下载不完整，连接被中断，可重试续传'
            finish()
            return
          }
          let head
          try {
            const f = fs.openSync(job.part, 'r')
            head = Buffer.alloc(4)
            fs.readSync(f, head, 0, 4, 0)
            fs.closeSync(f)
          } catch (err) {
            job.failed = true
            job.error = `校验失败：${err instanceof Error ? err.message : String(err)}`
            finish()
            return
          }
          const size = this.partSize(job.part)
          if (!looksLikeGgml(head) || size < MIN_MODEL_BYTES) {
            job.failed = true
            job.error = '下载的内容不是有效的模型文件（校验未通过），已丢弃'
            try {
              fs.unlinkSync(job.part)
            } catch {
              /* 删不掉就留着，下次重写 */
            }
            finish()
            return
          }

          try {
            fs.renameSync(job.part, job.dest)
          } catch (err) {
            job.failed = true
            job.error = `模型落盘失败：${err instanceof Error ? err.message : String(err)}`
            finish()
            return
          }

          this.jobs.delete(job.key)
          job.failed = false
          this.emit({
            key: job.key,
            status: 'done',
            received: job.received,
            total: job.total,
            dest: job.dest,
          })
          finish()
        })

        res.on('error', (err) => {
          if (job.canceled) {
            finish()
            return
          }
          job.failed = true
          job.error = `网络错误：${err.message}${isFallback ? '' : '，将尝试镜像源'}`
          finish()
        })
      })

      request.on('error', (err) => {
        if (job.canceled) {
          finish()
          return
        }
        job.failed = true
        job.error = `无法连接下载源：${err.message}${isFallback ? '' : '，将尝试镜像源'}`
        finish()
      })

      job.request = request
      request.end()
    })
  }

  partSize(part) {
    try {
      return fs.statSync(part).size
    } catch {
      return 0
    }
  }

  maybeEmitProgress(job) {
    const now = Date.now()
    if (now - job.lastEmit < 250 && job.received < job.total) return
    job.lastEmit = now
    this.emit({
      key: job.key,
      status: 'progress',
      received: job.received,
      total: job.total,
      percent:
        job.total > 0 ? Math.min(99.9, (job.received / job.total) * 100) : 0,
    })
  }

  /** 删除用户模型目录里的模型文件。只接受纯文件名，拒绝任何路径穿越 */
  async remove(fileName, destDir) {
    if (path.basename(fileName) !== fileName) {
      throw new Error('只允许删除模型目录下的文件')
    }
    const target = path.join(destDir, fileName)
    if (!target.startsWith(path.resolve(destDir) + path.sep)) {
      throw new Error('非法路径')
    }
    // 主文件可能不存在（比如上次取消后只剩 .part），此时只清理续传残留
    try {
      await fsp.unlink(target)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    try {
      await fsp.unlink(`${target}.part`)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    return true
  }
}
