/**
 * 字幕文件序列化。
 *
 * 只做「把字幕条目拼成文本」这一件事，编码与换行符由主进程负责
 * —— GBK 需要 Node 的 ICU，渲染进程没有。
 */

import type {
  ExportLangBundle,
  LineEnding,
  SubtitleSegment,
  SubtitleFormat,
} from '@/types'

function pad(n: number, len = 2): string {
  return String(Math.floor(n)).padStart(len, '0')
}

/** 00:00:01,200（SRT） */
export function srtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(total % 1000, 3)}`
}

/** 00:00:01.200（VTT） */
export function vttTime(sec: number): string {
  return srtTime(sec).replace(',', '.')
}

/** 0:00:01.20（ASS，百分秒） */
export function assTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(total / 360_000)
  const m = Math.floor((total % 360_000) / 6000)
  const s = Math.floor((total % 6000) / 100)
  return `${h}:${pad(m)}:${pad(s)}.${pad(total % 100, 2)}`
}

/** 多行文本在 SRT/VTT 里原样保留，ASS 里必须转成 \N 并去掉花括号 */
function assEscape(text: string): string {
  return text
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N')
    .trim()
}

/* ------------------------------------------------------------ 语言维度 */

export interface SerializeOptions {
  /**
   * 一个文件里写哪几种语言。默认只导原文。
   *
   * 注意：`translationLang` 为空时，`both` / `translation` 会**整体退回**
   * 纯原文 —— 一条译文都没有的工程里，用户选双语不该得到一份空文件。
   */
  lang?: ExportLangBundle
  /** 译文语言码（如 `en`）。`both` / `translation` 时必须给 */
  translationLang?: string
  /**
   * 双语时原文是否排在前面。默认 true —— 中文视频的惯例是原文在上、
   * 译文在下（观众视线先落在母语上）。
   */
  sourceFirst?: boolean
}

/** 导出时的一条字幕：文本已按语言维度合好 */
export interface ExportLine {
  start: number
  end: number
  text: string
}

export interface ExportComposition {
  lines: ExportLine[]
  /**
   * 缺译文的条数 —— 它们只用原文顶上（见下面的说明）。
   *
   * 这个数字要透给界面：导完了才在播放器里发现「有几条还是中文」，
   * 比事先看到一行提示要难受得多。
   */
  missing: number
}

function segTexts(
  seg: SubtitleSegment,
  translationLang: string,
): { src: string; tr: string } {
  const src = seg.text.trim()
  const tr = translationLang ? (seg.translations?.[translationLang] ?? '').trim() : ''
  return { src, tr }
}

/**
 * 把条目合成「导出时实际要写出去的那些行」。
 *
 * 双语是**同一个字幕块里的两行**，不是两条字幕 —— 时间码只有一份，
 * 拆成两条会让播放器把它们当成连续两句话，原文还没读完就跳到译文上去了。
 *
 * 缺译文时**退回原文而不是丢掉这一条**：丢一条会在那个时间点留下一段
 * 完全没有字幕的空白；观众只会觉得「这里漏了」，而不会知道是缺译文。
 * 混进去的那句原文至少是能看懂的，而且 `missing` 会如实报出来。
 */
export function composeForExport(
  segments: SubtitleSegment[],
  opts: SerializeOptions = {},
): ExportComposition {
  const lang = opts.translationLang ?? ''
  // 没有目标语言就无所谓「导哪种语言」，一律当纯原文处理（也不会误报 missing）
  const mode: ExportLangBundle = lang ? (opts.lang ?? 'source') : 'source'

  const lines: ExportLine[] = []
  let missing = 0

  for (const seg of segments) {
    const { src, tr } = segTexts(seg, lang)
    let text: string

    if (mode === 'source') {
      text = src
    } else if (mode === 'translation') {
      if (!tr) missing += 1
      text = tr || src
    } else {
      if (!tr) missing += 1
      const parts = opts.sourceFirst === false ? [tr, src] : [src, tr]
      text = parts.filter(Boolean).join('\n')
    }

    if (text.trim() === '') continue
    lines.push({ start: seg.start, end: seg.end, text })
  }

  return { lines, missing }
}

/**
 * 原文的语言后缀。
 *
 * 「自动检测」时没有确定的码可用，返回 `und`（ISO 639-3 的 undetermined）
 * —— 编一个 `zh` 出来会让文件名说谎。
 */
export function sourceLangTag(language: string, autoDetect: boolean): string {
  if (autoDetect || !language || language === 'auto') return 'und'
  return language
}

/**
 * 一个文件对应的语言后缀。
 *
 * 双语用 `zh-en` 这种连写：`zh.en` 会被播放器读成「语言 zh、
 * 变体 en」，而 `bilingual` 又不是语言码，两者都不如连写直观。
 */
export function bundleLangTag(
  bundle: ExportLangBundle,
  srcTag: string,
  trTag: string,
): string {
  if (bundle === 'source') return srcTag
  if (bundle === 'translation') return trTag
  return `${srcTag}-${trTag}`
}

/* ---------------------------------------------------------- 各格式序列化 */

export function serializeSrt(
  segments: SubtitleSegment[],
  opts: SerializeOptions = {},
): string {
  const blocks = composeForExport(segments, opts).lines.map(
    (l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}`,
  )
  return blocks.join('\n\n') + (blocks.length > 0 ? '\n' : '')
}

export function serializeVtt(
  segments: SubtitleSegment[],
  opts: SerializeOptions = {},
): string {
  const body = composeForExport(segments, opts).lines.map(
    (l) => `${vttTime(l.start)} --> ${vttTime(l.end)}\n${l.text}`,
  )
  return `WEBVTT\n\n${body.join('\n\n')}${body.length > 0 ? '\n' : ''}`
}

/**
 * ASS。
 *
 * 字体写思源黑体，与本软件的界面字体一致；不嵌入字体文件，播放器找不到时
 * 会自行回退。分辨率按 1920×1080 标定。双语的第二行走 `\N` 换行 ——
 * 和 SRT 的「块内两行」在语义上是同一件事。
 */
export function serializeAss(
  segments: SubtitleSegment[],
  opts: SerializeOptions = {},
  title = 'XBAOS 字幕',
): string {
  const header = [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.601',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Source Han Sans SC,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,' +
      '0,0,0,0,100,100,0,0,1,2,1,2,60,60,48,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  const events = composeForExport(segments, opts).lines.map(
    (l) =>
      `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Default,,0,0,0,,${assEscape(l.text)}`,
  )

  return `${header.join('\n')}\n${events.join('\n')}${events.length > 0 ? '\n' : ''}`
}

/** 纯文本：只保留文本。双语时一条字幕占两行（无法再区分条目边界，这是 TXT 的固有限制） */
export function serializeTxt(
  segments: SubtitleSegment[],
  opts: SerializeOptions = {},
): string {
  const lines = composeForExport(segments, opts)
    .lines.map((l) => l.text)
    .filter(Boolean)
  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

export function serializeSubtitle(
  format: SubtitleFormat,
  segments: SubtitleSegment[],
  opts: SerializeOptions = {},
): string {
  switch (format) {
    case 'vtt':
      return serializeVtt(segments, opts)
    case 'ass':
      return serializeAss(segments, opts)
    case 'txt':
      return serializeTxt(segments, opts)
    default:
      return serializeSrt(segments, opts)
  }
}

/** 统一换行符 */
export function applyLineEnding(text: string, ending: LineEnding): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  return ending === 'lf' ? normalized : normalized.replace(/\n/g, '\r\n')
}

export const FORMAT_EXT: Record<SubtitleFormat, string> = {
  srt: 'srt',
  vtt: 'vtt',
  ass: 'ass',
  txt: 'txt',
}
