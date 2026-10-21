/**
 * 解析 AI 助手返回的字幕文本。
 *
 * 输入是用户从网页版 AI 复制过来的东西 —— 它**不一定干净**：
 * 可能裹着 Markdown 代码块、可能有「好的，以下是校对后的字幕：」这样的开场白、
 * 可能结尾还有一句"希望对你有帮助"。所以这里先清洗再解析，最后校验时间码。
 *
 * 时间码不指望模型自律：P1 拍板允许大模型重排（删句、合并、拆分），
 * 那就必须自己检查「有没有重叠、有没有倒流、有没有超出原片长」，
 * 有问题的结果要显式告诉用户，而不是闷头写进去。
 */

import type { SubtitleSegment } from '@/types'
import { uid } from '@/utils/id'
import { clearStale, enforceMonotonicCues, hasText } from '@/utils/segmentOps'

export interface ParsedCue {
  start: number
  /** 单位秒 */
  end: number
  text: string
}

export interface ParseOutcome {
  cues: ParsedCue[]
  /** 致命问题：解析不出任何有效条目 */
  error: string | null
  /** 非致命问题：时间码重叠、超出片长等，展示给用户自行判断 */
  warnings: string[]
}

/** 时间码行：`00:00:01,200 --> 00:00:03,800`，毫秒分隔符逗号与点号都收 */
const TIME_RE =
  /^\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/

function toSec(h: string, m: string, s: string, ms: string): number {
  const milli = Number(ms.padEnd(3, '0').slice(0, 3))
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + milli / 1000
}

/**
 * 清洗。剥掉 BOM 与 Markdown 代码块围栏。
 * 围栏可能有多个（模型把内容分成几段贴），取最长的那一段 —— 通常就是字幕正文。
 */
export function stripNoise(raw: string): string {
  let text = (raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

  const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
  if (fences.length > 0) {
    const best = fences.reduce((a, b) => (b[1].length > a[1].length ? b : a))
    text = best[1]
  }
  return text
}

/** 逐行扫出 SRT 条目。容忍缺序号、多余空行、条间不留空行等常见变体 */
function parseCues(text: string): ParsedCue[] {
  const lines = text.split('\n')
  const cues: ParsedCue[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (trimmed === '') {
      i += 1
      continue
    }

    // 序号行：单独一行数字，且下一行是时间码
    let timeLine = trimmed
    if (/^\d{1,4}$/.test(trimmed) && TIME_RE.test(lines[i + 1] ?? '')) {
      i += 1
      timeLine = lines[i].trim()
    }

    const m = timeLine.match(TIME_RE)
    if (!m) {
      // 既不是序号也不是时间码 —— 多半是开场白，跳过
      i += 1
      continue
    }

    const start = toSec(m[1], m[2], m[3], m[4])
    const end = toSec(m[5], m[6], m[7], m[8])
    i += 1

    const body: string[] = []
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') break
      // 有的模型条与条之间不空行，撞到下一条的序号 + 时间码就收尾
      if (/^\d{1,4}$/.test(line.trim()) && TIME_RE.test(lines[i + 1] ?? '')) break
      // 还有模型干脆不写序号 —— 那么「本行就是时间码」同样是新条目的开始。
      // 少了这一条判断，上一条的正文会把下一条的时间码一起吞进去。
      if (TIME_RE.test(line)) break
      body.push(line.trim())
      i += 1
    }

    const value = body.join('\n').trim()
    if (value !== '') cues.push({ start, end, text: value })
  }

  return cues
}

/**
 * 解析并校验。
 *
 * @param raw 剪贴板里的原始文本
 * @param durationSec 原片时长（秒），用来判断时间码有没有跑飞
 */
export function parseModelOutput(raw: string, durationSec: number): ParseOutcome {
  const warnings: string[] = []
  const clean = stripNoise(raw)

  if (clean.trim() === '') {
    return { cues: [], error: '剪贴板里没有内容', warnings }
  }

  const cues = parseCues(clean)
  if (cues.length === 0) {
    return {
      cues: [],
      error: '没能从剪贴板里解析出字幕，请确认复制的是校对后的完整结果（应含序号与时间码）',
      warnings,
    }
  }

  // ---- 时间码校验
  let lastEnd = -1
  let overlap = 0
  let badRange = 0
  let maxEnd = 0

  for (const cue of cues) {
    if (cue.end <= cue.start) badRange += 1
    if (lastEnd >= 0 && cue.start < lastEnd - 0.05) overlap += 1
    lastEnd = Math.max(lastEnd, cue.end)
    maxEnd = Math.max(maxEnd, cue.end)
  }

  if (badRange > 0) warnings.push(`${badRange} 条的结束时间不晚于开始时间`)
  if (overlap > 0) warnings.push(`${overlap} 处时间码与前一条重叠`)
  if (durationSec > 0 && maxEnd > durationSec + 1) {
    const over = Math.round(maxEnd - durationSec)
    warnings.push(`最后一条比原片时长多出约 ${over} 秒`)
  }

  return { cues, error: null, warnings }
}

/**
 * 转成编辑器使用的字幕条目。
 *
 * `origin` 与 `text` 都设成校对后的文本：这一遍的结果就是用户看到的新基线，
 * 否则整屏都会挂上「已改动」标记，反而看不清哪些是原样保留的
 * （哪些被改了，确认面板里已经逐条列过）。
 * `issues` 一并清空 —— 旧条目的校验结论是针对旧文本的，留着会误导。
 */
export function cuesToSegments(
  cues: ParsedCue[],
  prev: SubtitleSegment[],
): SubtitleSegment[] {
  return cues.map((cue, i) => ({
    id: prev[i]?.id ?? uid('seg'),
    start: Number(cue.start.toFixed(3)),
    end: Number(cue.end.toFixed(3)),
    text: cue.text,
    origin: cue.text,
    issues: [],
  }))
}

/**
 * 把校对结果合并回**指定的那一段**，范围外一条都不动。
 *
 * 与 `cuesToSegments`（整份重建）的分工必须说清楚，混用就是数据丢失：
 *   - 整份重建只适用于「提示词里发了全部条目」。它按位置复用 id，AI 少返回几条
 *     就等于把文件截断 —— 用户分段校对时踩到的正是这个。
 *   - 分段校对时发出去的只是其中一段，AI 还可能合并或拆分条目，所以这里按
 *     **id 集合** 定位被替换的条目，新的 cue 按时间码归位，其余原样保留。
 *
 * @param ids 本次交给 AI 的条目 id（顺序即提示词序号）。不在其中的条目不动
 */
export function mergeCuesIntoSelection(
  segments: SubtitleSegment[],
  cues: ParsedCue[],
  ids: string[],
): SubtitleSegment[] {
  const replaced = new Set(ids)
  const kept = segments.filter((s) => !replaced.has(s.id))
  const built: SubtitleSegment[] = cues.map((cue) => ({
    id: uid('seg'),
    start: Number(cue.start.toFixed(3)),
    end: Number(cue.end.toFixed(3)),
    text: cue.text,
    origin: cue.text,
    issues: [],
  }))
  // 按时间码归位：合并/拆分后条数可能变，靠位置插回去一定会错位
  const merged = [...kept, ...built].sort((a, b) => a.start - b.start || a.end - b.end)
  // 段内重排后可能与相邻条重叠，用与识别管线相同的规则拉开
  return enforceMonotonicCues(merged)
}

/**
 * 多文件输出的分隔行：`【文件 1/3】xxx.wav`。全角斜杠、多余空格都容忍
 */
const FILE_MARK_RE = /^\s*【\s*文件\s*(\d+)\s*[/／]\s*(\d+)\s*】\s*(.*)$/

export interface FileBlock {
  /** 分隔行里写的序号（1 起），仅用于报错时定位 */
  index: number
  /** 分隔行里写的文件名 */
  name: string
  /** 该块内的 SRT 正文 */
  text: string
}

export interface SplitOutcome {
  blocks: FileBlock[]
  /** 有没有在文本里找到文件分隔行 */
  hasMarks: boolean
  /**
   * 第一个分隔行**之前**的内容。
   *
   * 模型很爱把输出开头的那个 `【文件 1/N】` 当成"标题"吞掉（用户实测踩到），
   * 于是第一个文件的正文会孤零零地落在第一个分隔行前面。这里把它原样留给
   * 调用方 —— 只有调用方知道「这段到底是不是正文」（校对与翻译的判据不同），
   * 所以由它决定要不要补成第一块。
   */
  leading: string
}

/**
 * 按 `【文件 k/N】文件名` 把多文件输出切成块。
 *
 * 分隔行是模型唯一必须原样保留的东西 —— 丢了它就没法把结果对应回各个文件，
 * 所以切不出来时上层要明确报错，而不是猜。
 */
export function splitByFileMarks(raw: string): SplitOutcome {
  const lines = stripNoise(raw).split('\n')
  const blocks: FileBlock[] = []
  const leading: string[] = []
  let current: FileBlock | null = null

  for (const line of lines) {
    const m = line.match(FILE_MARK_RE)
    if (m) {
      if (current) blocks.push(current)
      current = { index: Number(m[1]), name: m[3].trim(), text: '' }
      continue
    }
    if (current) current.text += `${line}\n`
    else leading.push(line)
  }
  if (current) blocks.push(current)

  return { blocks, hasMarks: blocks.length > 0, leading: leading.join('\n') }
}

export interface CuePreview {
  index: number
  before: string
  after: string
  changed: boolean
}

export interface ReviewSummary {
  before: number
  after: number
  /** 按位置比对，文本有出入的条数（重排后这个数字仅供参考） */
  changed: number
  previews: CuePreview[]
}

/* ------------------------------------------------------------------ 翻译 */

/** 一条译文的行首：`1. 文本`。容忍「1、」「1)」「1：」等变体 */
const TR_LINE_RE = /^\s*(\d{1,4})\s*[.、,，)）:：]\s*(.*)$/

/**
 * 逐行取出译文。
 *
 * 三种常见变体都要容忍：① 模型把某一条写成了两行（不以序号开头的行接到上一条
 * 后面）；② 模型整份都没写序号（那就纯按行顺序取）；③ 模型带着寒暄开场
 * （「好的，以下是译文：」），那不是译文，必须丢掉。这几种情况都不会改变
 * 「一共几条」这个最关键的数字 —— 它由调用方核对。
 */
function parseTranslationLines(text: string): string[] {
  // 空行与【文件 k/N】分隔行都不是译文，先滤掉，免得占条数
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !FILE_MARK_RE.test(l))
  if (lines.length === 0) return []

  const firstNumbered = lines.findIndex((l) => TR_LINE_RE.test(l))
  // 整份都没写序号：模型可能老老实实一行一条，那就按行顺序取
  if (firstNumbered === -1) return lines

  // 首个带序号的行**之前**的内容一律当开场白丢掉。不丢的话它会凭空多出一条，
  // 条数校验立刻假失败 —— 而模型在输出前面加一句寒暄实在太常见了。
  const out: string[] = []
  for (const t of lines.slice(firstNumbered)) {
    const m = t.match(TR_LINE_RE)
    if (m) {
      out.push(m[2].trim())
      continue
    }
    // 不以序号开头的行接回上一条（模型把一条写成了两行）。
    // out 此时必然非空 —— slice 的第一项就是带序号的，能进到这里的都不是首项。
    if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${t}`.trim()
    else out.push(t)
  }
  return out
}

export interface TranslationBlock {
  /** 第几个文件（1 起） */
  index: number
  /**
   * 分隔行里写的文件名。**只有在分隔行齐全、顺序对得上时才有值** —— 分组本身
   * 是按已知条数切的，不依赖它，所以缺了也不影响结果（只为报错信息与日志好看）。
   */
  name: string
  /** 按序号排好的译文 */
  lines: string[]
}

export interface TranslateOutcome {
  ok: boolean
  /** 每个文件一块。单文件时长度为 1 */
  blocks: TranslationBlock[]
  /** 失败原因，ok 为 false 时有值 */
  message?: string
}

/** 「条数必须 1:1」的统一措辞 —— 单文件与多文件共用，省得两处写法各漂各的 */
function countMessage(where: string, got: number, want: number): string {
  return (
    `${where}识别到 ${got} 条译文，需要 ${want} 条 —— ` +
    '条数必须与原文一一对应（不合并、不拆分、不增删），请重新生成'
  )
}

/**
 * 解析翻译输出并校验。
 *
 * **校验只有一条：条数必须 1:1。** 这是与校对最关键的差别 —— 校对允许大模型
 * 重排，所以可以"部分接受 + 提示核对"；翻译不行，译文是按**序号**贴回条目的，
 * 少一条或多一条会让它之后的所有译文整体错位一格，那种错误极难被发现
 * （读起来通顺，只是对不上号）。所以条数对不上就**整份拒绝**，不做部分回写。
 *
 * **多文件的分组不靠【文件 k/N】分隔行。** 分隔行恰恰是模型最容易搞丢的东西 ——
 * 用户实测：它把输出开头的第一个分隔行当"标题"吞掉，于是第一个文件的译文被当成
 * 开场白，整块作废。分组改用**输入本身**做依据：每个文件有多少条是已知的，而
 * 1:1 又保证了译文与原文同序，所以「按累计条数切」是唯一不需要猜的切法。
 * 分隔行降级成交叉核对 —— 齐全时用它把错误精确指到某个文件，也能挡住"文件
 * 整体调包"这种极端情况。
 *
 * @param expected 每个文件期望的译文条数（顺序与输入一致，**不含空条目**）
 */
export function parseTranslation(raw: string, expected: number[]): TranslateOutcome {
  const text = stripNoise(raw)

  // ---- 单文件：只有总条数要对
  if (expected.length <= 1) {
    const lines = parseTranslationLines(text)
    const want = expected[0] ?? -1
    if (lines.length !== want) {
      return { ok: false, blocks: [], message: countMessage('这份字幕', lines.length, want) }
    }
    return { ok: true, blocks: [{ index: 1, name: '', lines }] }
  }

  const total = expected.reduce((n, v) => n + v, 0)
  const all = parseTranslationLines(text)

  if (all.length !== total) {
    return {
      ok: false,
      blocks: [],
      message:
        `识别到 ${all.length} 条译文，需要 ${total} 条（${expected.length} 个文件合计）—— ` +
        '条数必须与原文一一对应（不合并、不拆分、不增删），请重新生成',
    }
  }

  // 分隔行齐全时顺带核对每个文件的条数：这是更强的信号，报错也能指到具体文件
  const marked = splitByFileMarks(text).blocks
  const aligned = marked.length === expected.length
  if (aligned) {
    const counts = marked.map((b) => parseTranslationLines(b.text).length)
    const bad = counts.findIndex((c, i) => c !== expected[i])
    if (bad !== -1) {
      const name = marked[bad].name || '未命名'
      return {
        ok: false,
        blocks: [],
        message: countMessage(`第 ${bad + 1} 个文件（${name}）`, counts[bad], expected[bad]),
      }
    }
  }

  const names = aligned ? marked.map((b) => b.name) : []
  const blocks: TranslationBlock[] = []
  let cursor = 0
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i]
    blocks.push({ index: i + 1, name: names[i] ?? '', lines: all.slice(cursor, cursor + want) })
    cursor += want
  }
  return { ok: true, blocks }
}

/**
 * 把译文按序号贴回条目。
 *
 * 调用方必须**先**校验过条数（`parseTranslation` 返回 ok）—— 这里按位置贴，
 * 不做任何对齐，条数不齐时贴出来的就是错位的垃圾。
 *
 * **空条目跳过**：它没进提示词（见 `hasText`），也就不该占一个序号；不跳的话
 * 从它之后的所有译文都会整体错一格。
 *
 * 贴完顺手清掉该语言原来的「待确认」标红：整份译文都被替换过了，
 * 那条标记自然失效。
 */
export function applyTranslation(
  segments: SubtitleSegment[],
  lang: string,
  lines: string[],
  ids?: string[],
): SubtitleSegment[] {
  // 指定了 id 就只给这些条目写译文（分段翻译），其余条目的译文原样留着。
  // 按位置贴回只适用于「整份翻译」—— 位置在分段场景下毫无意义。
  if (ids && ids.length > 0) {
    const byId = new Map(ids.map((id, i) => [id, lines[i] ?? '']))
    return segments.map((s) => {
      if (!byId.has(s.id)) return s
      const next: SubtitleSegment = {
        ...s,
        translations: { ...(s.translations ?? {}), [lang]: byId.get(s.id) ?? '' },
      }
      return clearStale(next, lang)
    })
  }

  let cursor = 0
  return segments.map((s) => {
    if (!hasText(s)) return s
    const next: SubtitleSegment = {
      ...s,
      translations: { ...(s.translations ?? {}), [lang]: lines[cursor] ?? '' },
    }
    cursor += 1
    return clearStale(next, lang)
  })
}

/**
 * 生成确认面板用的概览。
 *
 * 按位置逐条对比，而不是做序列对齐：大模型可能整体重排，位置对应关系本来就会漂，
 * 强行对齐出来的"精确 diff"反而更误导。这里只回答两个问题 ——
 * 条数从多少变成多少、大概有多少条动过 —— 再给一小段前后对照让人过目。
 */
export function summarizeReview(
  cues: ParsedCue[],
  prev: SubtitleSegment[],
  previewLimit = 12,
): ReviewSummary {
  const count = Math.max(cues.length, prev.length)
  let changed = 0
  const previews: CuePreview[] = []

  for (let i = 0; i < count; i += 1) {
    const before = prev[i]?.text.trim() ?? ''
    const after = cues[i]?.text.trim() ?? ''
    const isChanged = before !== after
    if (isChanged) changed += 1
    if (i < previewLimit && isChanged) {
      previews.push({ index: i + 1, before, after, changed: true })
    }
  }

  return { before: prev.length, after: cues.length, changed, previews }
}
