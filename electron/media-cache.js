/**
 * 「可播放音频」缓存。
 *
 * 起因是一处必然踩到的断层：软件包内的 `ffmpeg.dll` 是 **非专有构建**
 * （`downloadAlternateFFmpeg: true`，见 electron-builder.yml），它解不了 AAC。
 * 实测（2026-11-15，同一份 Electron 44.5.1 只替换这一个文件）：
 *   · 3.1MB 的 Electron 默认版：`decodeAudioData()` 能解 .m4a，7.36s / 2ch
 *   · 1.6MB 的非专有版：`EncodingError`；`<audio>` 更是直接
 *     `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`
 * 而编辑器的试听与波形都走 Chromium 的解码链路 —— 也就是说「引擎能识别」与
 * 「界面能听」是两条独立的路，前者靠系统解码器，后者只能靠一份 Chromium
 * 认得出来的数据。
 *
 * 所以这里做一件事：需要系统解码器的格式（m4a / m4b / mp4 / m4v / mov / aac /
 * mkv），在导入后让引擎（同样调系统解码器）解成一份 WAV 缓存，界面拿这份
 * WAV 试听与画波形。原始文件仍是识别源，一个字都不改。
 *
 * 视频容器走这条路还有个附带好处：只解音轨，视频轨根本不碰。
 *
 * 缓存策略：
 *   · 键 = 源路径 + 大小 + 修改时间，源文件被替换后自然失效
 *   · 位置 userData/media-cache，14 天未用即清（启动时顺手做一次，失败不管）
 *   · 同一文件并发请求共享同一个 Promise，不会把引擎拉起来两遍
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** 这些扩展名的音频，Chromium 解不了，必须先转（键一律小写） */
const SYSTEM_DECODER_EXTS = new Set(['m4a', 'm4b', 'mp4', 'm4v', 'mov', 'aac', 'mkv'])

/** 单次转换的上限。一小时素材解一遍是秒级，10 分钟足够，超时说明卡死了 */
const DECODE_TIMEOUT_MS = 10 * 60 * 1000

/** 缓存保留期 */
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export function needsSystemDecoder(ext) {
  return SYSTEM_DECODER_EXTS.has(String(ext ?? '').toLowerCase())
}

export class PlayableCache {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir      缓存目录（userData/media-cache）
   * @param {() => string} opts.engineExe 取引擎路径（每次现取：用户可能刚装了另一个架构的模型）
   */
  constructor({ cacheDir, engineExe }) {
    this.cacheDir = cacheDir
    this.engineExe = engineExe
    /** 在途任务：同一源文件只转一次 */
    this.jobs = new Map()
    /** 启动时的清理只做一次 */
    this.pruned = false
  }

  /** 缓存文件的绝对路径（不存在时也返回，供调用方判断） */
  pathFor(srcPath, stat) {
    const key = createHash('sha1')
      .update(`${srcPath}\u0000${stat.size}\u0000${stat.mtimeMs}`)
      .digest('hex')
      .slice(0, 24)
    return path.join(this.cacheDir, `${key}.wav`)
  }

  /**
   * 取（必要时生成）可播放的 WAV。
   *
   * @returns {Promise<{ ok: true, path: string, cached: boolean } | { ok: false, message: string }>}
   *   失败不抛异常：这条链路是「试听/波形」，失败只该让播放器说清原因，
   *   不该连带整条导入流程炸掉（识别照样能跑）。
   */
  async ensure(srcPath) {
    let stat
    try {
      stat = await fs.stat(srcPath)
    } catch {
      return { ok: false, message: `读不到文件：${srcPath}` }
    }

    const target = this.pathFor(srcPath, stat)
    try {
      const cached = await fs.stat(target)
      if (cached.size > 44) return { ok: true, path: target, cached: true }
    } catch {
      /* 没有缓存，继续转 */
    }

    const running = this.jobs.get(target)
    if (running) return running

    const job = this.convert(srcPath, target, stat).finally(() => this.jobs.delete(target))
    this.jobs.set(target, job)
    return job
  }

  async convert(srcPath, target, stat) {
    const exe = this.engineExe()
    if (!exe) {
      return { ok: false, message: '找不到识别引擎，无法解码这种格式的音频' }
    }

    await fs.mkdir(this.cacheDir, { recursive: true })
    if (!this.pruned) {
      this.pruned = true
      void this.prune()
    }

    // 先写临时名再改名：中途失败或被杀进程，不会留下一个看起来完好、
    // 实际半截的 WAV 被下次当成缓存命中
    const temp = `${target}.${process.pid}.tmp`

    const result = await runDecode(exe, srcPath, temp)
    if (!result.ok) {
      await fs.rm(temp, { force: true }).catch(() => {})
      return { ok: false, message: result.message }
    }

    try {
      const size = (await fs.stat(temp)).size
      if (size <= 44) {
        await fs.rm(temp, { force: true }).catch(() => {})
        return { ok: false, message: '解码结果为空，音轨可能损坏' }
      }
      await fs.rename(temp, target)
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => {})
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }

    // 顺手记一笔，排查「为什么这份没转」时有用
    console.log(
      `[media] 已生成可播放缓存 ${path.basename(target)}（源 ${(stat.size / 1048576).toFixed(1)}MB）`,
    )
    return { ok: true, path: target, cached: false }
  }

  /** 清掉 14 天没用过的缓存。失败不报错：这是清理，不是功能 */
  async prune() {
    try {
      const names = await fs.readdir(this.cacheDir)
      const now = Date.now()
      let removed = 0
      for (const name of names) {
        const full = path.join(this.cacheDir, name)
        try {
          const st = await fs.stat(full)
          if (now - st.mtimeMs > CACHE_TTL_MS) {
            await fs.rm(full, { force: true })
            removed += 1
          }
        } catch {
          /* 单个文件失败不影响其他 */
        }
      }
      if (removed) console.log(`[media] 清理了 ${removed} 份过期播放缓存`)
    } catch {
      /* 目录还不存在：正常 */
    }
  }
}

/**
 * 拉起引擎跑一次 `--decode`。
 *
 * 这是一次性进程：参数走命令行，结束后立刻退出，不参与 JSON-RPC 协议，
 * 所以不会和正在跑的识别抢状态。
 */
function runDecode(exe, srcPath, dstPath) {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const child = spawn(exe, ['--decode', srcPath, dstPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      done({ ok: false, message: '解码超时（超过 10 分钟），已中止' })
    }, DECODE_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      // 成功时这里是一行 JSON，失败原因一律走 stderr，所以正文不参与判断
      void chunk
    })
    // 引擎的 stderr 是 UTF-8 中文（它自己保证），直接当消息用
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      done({ ok: false, message: `无法启动引擎：${err.message}` })
    })
    child.on('close', (code) => {
      if (code === 0) {
        done({ ok: true })
        return
      }
      const detail = stderr.trim()
      done({
        ok: false,
        message: detail || `系统解码器处理失败（引擎退出码 ${code}）`,
      })
    })
  })
}
