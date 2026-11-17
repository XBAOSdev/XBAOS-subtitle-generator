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
 *   · 位置 `userData/media-cache`（即 `%APPDATA%\xbaos-subtitle-generator\media-cache`）
 *   · 保留期 14 天，按**最后一次使用**算：命中时把 mtime 往前推，所以
 *     「天天听的那份」不会被误删，「半年前转过一次的」才会走
 *   · **总量上限 `CACHE_MAX_BYTES`**（1 GB）：超了按「最久未用」淘汰。
 *     单靠 14 天是不够的 —— 48kHz 单声道是 345 MB/小时，一天处理两小时视频，
 *     两周就能涨到 9 GB。上限是硬边界，过期是软边界，两个都要
 *   · 淘汰**跳过本次运行中用过的那些**：正在播的那份被删掉，下次点播放就得
 *     重新转一遍，等于让清理变成「卡一下」。跳过之后若仍超限（说明在用的
 *     就超过了上限），留给下次启动再清 —— 那时它们已经不在用
 *   · 清理**只在软件启动时**做一次（`main.js` 的 `whenReady`），不存在常驻定时器。
 *     也就是说软件一直不开，过期缓存就会一直留在磁盘上，需要手动删目录
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

/**
 * 命中后多久才值得把 mtime 往前推一次。
 *
 * 每次播放都 `utimes` 是没必要的写操作；隔一天一次足够表达「这份还在用」，
 * 而 14 天的保留期是按天算的，精度损失可以忽略。
 */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * 缓存总量上限。
 *
 * 14 天保留期管不住体积：这类缓存是**源采样率**的单声道 16 位 PCM，
 * 48kHz 一小时 345 MB。一周处理十小时素材就是 3.4 GB，用户会觉得
 * 「硬盘莫名其妙满了」。所以再加一道硬边界，超了按最久未用淘汰。
 *
 * 1 GB 约等于 3 小时的 48kHz 素材（当前开发机上已有 421 MB，留两倍余量）。
 * 定得太小会让功能一上线就开始删用户刚转好的东西 —— 那比占盘更让人恼火。
 */
const CACHE_MAX_BYTES = 1024 * 1024 * 1024

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
    /**
     * 本次运行中用过的缓存（文件名）。
     *
     * 清理时跳过它们：正被播放器引用的那份一旦删掉，用户下次点播放就要等
     * 重新解码。软件一重启这个集合就空了，该清的都会清掉。
     */
    this.touched = new Set()
    /** 文件名 → 源文件名，只用于设置页显示「这份是谁的」。重启后为空，无妨 */
    this.sources = new Map()
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
      if (cached.size > 44) {
        /*
         * 命中即算「用过」，把 mtime 推到当下。
         *
         * 这一步是「14 天未用即清」能否成立的前提：清理判据是 mtime，
         * 而命中不重写文件，mtime 会一直停在生成那一刻 —— 于是
         * 「天天在听的这份」也会在第 15 天被当成过期删掉。
         * 隔一天推一次，既省写操作，也不会误删。
         */
        const now = Date.now()
        if (now - cached.mtimeMs > TOUCH_INTERVAL_MS) {
          await fs.utimes(target, new Date(now), new Date(now)).catch(() => {})
        }
        this.markUsed(target, srcPath)
        return { ok: true, path: target, cached: true }
      }
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
    this.markUsed(target, srcPath)
    return { ok: true, path: target, cached: false }
  }

  /** 记下「本次运行用过这份」，清理时据此避让 */
  markUsed(target, srcPath) {
    const name = path.basename(target)
    this.touched.add(name)
    this.sources.set(name, path.basename(srcPath))
  }

  /**
   * 清掉过期与超额的那部分。
   *
   * 由 `main.js` 在 `whenReady` 里调一次，**不是定时器**：软件不启动就不会清，
   * 这是可接受的取舍（清理不是功能，攒着只是占盘）。失败一律不报错。
   *
   * 两轮：先按 14 天过期删，再按总量上限从最久未用开始删。第二轮只看
   * 未在本次运行中用过的那些 —— 正在播的一份被删掉，用户下次点播放就得
   * 重新转一遍，清理就成了「卡一下」。
   */
  async prune() {
    let entries
    try {
      entries = await this.list()
    } catch {
      return { removed: 0, bytes: 0, count: 0 } // 目录还不存在：正常
    }

    const now = Date.now()
    let removed = 0
    const keep = []
    for (const e of entries) {
      if (this.touched.has(e.name)) {
        keep.push(e)
        continue
      }
      if (now - e.mtime > CACHE_TTL_MS) {
        if (await this.rm(e.name)) removed += 1
      } else {
        keep.push(e)
      }
    }

    // 第二轮：超上限就按最久未用删。keep 已按 mtime 升序排
    let bytes = keep.reduce((sum, e) => sum + e.bytes, 0)
    for (const e of keep) {
      if (bytes <= CACHE_MAX_BYTES) break
      if (this.touched.has(e.name)) continue
      if (await this.rm(e.name)) {
        bytes -= e.bytes
        removed += 1
      }
    }

    if (removed) {
      console.log(`[media] 清理了 ${removed} 份播放缓存，现占 ${(bytes / 1048576).toFixed(0)}MB`)
    }
    return { removed, bytes, count: keep.length }
  }

  /**
   * 列出缓存文件，**按 mtime 升序**（最久未用的在前，方便淘汰取头部）。
   *
   * 只认 `.wav`：目录里可能还有转码中途留下的 `.tmp`（进程被杀时），
   * 那不是可用缓存，也不该出现在设置页的列表里。
   */
  async list() {
    const names = await fs.readdir(this.cacheDir)
    const out = []
    for (const name of names) {
      if (!name.endsWith('.wav')) continue
      try {
        const st = await fs.stat(path.join(this.cacheDir, name))
        out.push({
          name,
          bytes: st.size,
          mtime: st.mtimeMs,
          source: this.sources.get(name) ?? '',
        })
      } catch {
        /* 单个文件读不到就算了 */
      }
    }
    out.sort((a, b) => a.mtime - b.mtime)
    return out
  }

  /** 设置页与底栏用的统计。`files` 按时间倒序（新的在上，符合「看最近转了什么」） */
  async stats() {
    let entries = []
    try {
      entries = await this.list()
    } catch {
      entries = []
    }
    const bytes = entries.reduce((sum, e) => sum + e.bytes, 0)
    return {
      bytes,
      count: entries.length,
      limit: CACHE_MAX_BYTES,
      dir: this.cacheDir,
      files: entries
        .map((e) => ({
          name: e.name,
          bytes: e.bytes,
          mtime: e.mtime,
          source: e.source,
          inUse: this.touched.has(e.name),
        }))
        .reverse(),
    }
  }

  /**
   * 删一个缓存文件。
   *
   * 名字来自渲染进程，必须先 `basename` 再校验后缀：`../../Windows/System32/x.wav`
   * 这种拼法如果直接 `path.join` 就能删到目录外面去。这里两道都上。
   */
  async rm(name) {
    const base = path.basename(String(name))
    if (base !== name || !base.endsWith('.wav')) return false
    try {
      await fs.rm(path.join(this.cacheDir, base), { force: true })
      this.touched.delete(base)
      this.sources.delete(base)
      return true
    } catch {
      return false
    }
  }

  /**
   * 手动清空（设置页的「全部清除」）。
   *
   * 与 `prune` 不同，这里**不避让**正在用的那些：用户明确点了清除，
   * 就该清干净。删掉只影响下次播放要重新转一次，不会损坏任何工程数据。
   */
  async clearAll() {
    let entries = []
    try {
      entries = await this.list()
    } catch {
      return 0
    }
    let removed = 0
    for (const e of entries) {
      if (await this.rm(e.name)) removed += 1
    }
    return removed
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
