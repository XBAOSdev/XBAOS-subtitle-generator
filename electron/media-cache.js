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
 *   · **保留期 3 天**，按**最后一次使用**算：命中一次就把 mtime 刷到当下，
 *     所以「隔天还听一次的那份」永远不过期，「转过一次就再没碰过的」3 天后走
 *   · **总量上限 `CACHE_MAX_BYTES`**（1 GB）。上限与保留期是两条独立的线：
 *     过期看时间，超限看体积，谁先命中谁生效
 *   · 超限淘汰**随时可能发生**：转完一份新的就检查一次（`enforceLimit`），
 *     不等下次启动 —— 否则用户导一次大素材，磁盘当场多出几 GB
 *   · 但淘汰**跳过本次运行中用过的那些**（`touched`）：正在播的那份被删掉，
 *     下次点播放就得重新转一遍，等于让清理变成「卡一下」。所以「前台项目的
 *     缓存自己就超过 1 GB」时不删它们，留给下次启动（那时它们已经不在用）
 *   · 过期清理**只在软件启动时**做一次（`main.js` 的 `whenReady`），不存在常驻
 *     定时器。也就是说软件一直不开，过期缓存就会一直留在磁盘上，需要手动删目录
 *   · 启动清理可以带一份**豁免名单**（`exempt`）：双击 `.xbsgp` 打开时，那份
 *     工程要用的缓存虽然过了期也先留着，并把 mtime 刷新（3 天从头算）
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

/** 缓存保留期。按「最后一次使用」算，不是「生成时间」 */
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000

/**
 * 缓存总量上限。
 *
 * 3 天保留期管不住体积：这类缓存是**源采样率**的单声道 16 位 PCM，
 * 48kHz 一小时 345 MB。一天处理三小时素材就是 1 GB，三天就是 3 GB。
 * 所以再加一道硬边界，超了按最久未用淘汰。
 *
 * 1 GB 约等于 3 小时的 48kHz 素材。定得太小会让功能一上线就开始删用户
 * 刚转好的东西 —— 那比占盘更让人恼火。
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
         * 这是「3 天未用即清」能成立的前提：清理判据是 mtime，而命中不重写
         * 文件，mtime 会一直停在生成那一刻 —— 于是「隔天还在听的那份」也会
         * 在第 3 天被当成过期删掉。
         *
         * **每次命中都刷，不做节流**：这个函数一次加载只调一次（切文件、
         * 打开工程），不是每帧；一次 `utimes` 是元数据写，比「判断要不要刷」
         * 省下来的那点 IO 更值钱的是语义清楚 —— 保留期严格从最后一次使用算。
         */
        const now = Date.now()
        await fs.utimes(target, new Date(now), new Date(now)).catch(() => {})
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
    /*
     * 刚多了一份，立刻看有没有超限。
     *
     * 不等下次启动：用户导入一个大素材，从这一刻起磁盘就一直压在上限之上，
     * 而那恰恰是最该看体积的时刻。
     */
    void this.enforceLimit()
    return { ok: true, path: target, cached: false }
  }

  /** 记下「本次运行用过这份」，清理时据此避让 */
  markUsed(target, srcPath) {
    const name = path.basename(target)
    this.touched.add(name)
    this.sources.set(name, path.basename(srcPath))
  }

  /**
   * 清掉过期的那部分，再压到上限以内。
   *
   * 由 `main.js` 在 `whenReady` 里调一次，**不是定时器**：软件不启动就不会清，
   * 这是可接受的取舍（清理不是功能，攒着只是占盘）。失败一律不报错。
   *
   * @param {{ exempt?: Iterable<string> }} [options]
   *   `exempt` 是缓存文件名集合。这些文件**跳过过期判断**，并把 mtime 刷到
   *   当下（3 天从头算）。用途只有一个：双击 `.xbsgp` 冷启动时，那份工程
   *   要用的缓存可能刚好过了期，但用户马上要用它 —— 删了就得重新解码，
   *   打开工程凭空慢十几秒。
   */
  async prune(options = {}) {
    let entries
    try {
      entries = await this.list()
    } catch {
      return { removed: 0, bytes: 0, count: 0 } // 目录还不存在：正常
    }

    const now = Date.now()
    if (options.exempt) {
      for (const name of options.exempt) {
        await fs.utimes(path.join(this.cacheDir, name), new Date(now), new Date(now)).catch(() => {})
        // 豁免 = 马上要用，等同于「本次运行用过」，后面的淘汰也不许碰
        this.touched.add(name)
      }
    }

    let removed = 0
    for (const e of entries) {
      if (this.touched.has(e.name)) continue
      if (now - e.mtime > CACHE_TTL_MS && (await this.rm(e.name))) removed += 1
    }

    const rest = await this.enforceLimit()
    return { removed: removed + rest.removed, bytes: rest.bytes, count: rest.count }
  }

  /**
   * 压到上限以内：从最久没用的开始，一个一个删，直到不超限或者没有能删的。
   *
   * 两处调用：转出新缓存之后（`convert`）与启动清理（`prune`）。
   *
   * **跳过 `touched`**：跳过之后仍然超限，说明在用的那些自己就超过了上限 ——
   * 这时不能删。删了正在播的那份，用户下次点播放就得重新解码；留给下次启动，
   * 那时它们已经不在用了。这正是「前台项目的缓存大于 1 GB 也不动」的落点。
   */
  async enforceLimit() {
    let entries
    try {
      entries = await this.list()
    } catch {
      return { removed: 0, bytes: 0, count: 0 }
    }

    let bytes = entries.reduce((sum, e) => sum + e.bytes, 0)
    let removed = 0
    // list() 已按 mtime 升序，顺序扫就是「最老的先删」
    for (const e of entries) {
      if (bytes <= CACHE_MAX_BYTES) break
      if (this.touched.has(e.name)) continue
      if (await this.rm(e.name)) {
        bytes -= e.bytes
        removed += 1
      }
    }

    if (removed) {
      console.log(
        `[media] 超出上限，淘汰了 ${removed} 份播放缓存，现占 ${(bytes / 1048576).toFixed(0)}MB`,
      )
    }
    return { removed, bytes, count: entries.length - removed }
  }

  /**
   * 把一组源文件路径换算成缓存文件名。
   *
   * 冷启动「双击打开的那个工程要豁免自己那份缓存」时用：主进程手里只有
   * `.xbsgp` 里记的媒体路径，键必须在这里算 —— 哈希规则只此一份，别处
   * 再实现一遍迟早会算出不一样的值。文件不在了就跳过（本来也不会有缓存）。
   */
  async keysOf(paths) {
    const out = new Set()
    for (const p of paths ?? []) {
      if (typeof p !== 'string' || !p) continue
      try {
        const st = await fs.stat(p)
        out.add(path.basename(this.pathFor(p, st)))
      } catch {
        /* 文件不在了 */
      }
    }
    return out
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
