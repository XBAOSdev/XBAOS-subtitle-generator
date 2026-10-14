/**
 * 字幕文件解析（SRT / VTT / ASS / SSA）。
 *
 * 与序列化端（subtitle.ts）成对，但解析端必须比生成端宽容得多：
 * 真实世界的字幕来自几十种工具，时间戳分隔符、行尾、标签风格五花八门。
 * 这里按「尽力解析、坏行跳过」的思路处理：
 *   - 时间戳逗号（SRT 惯例）与点号（VTT 惯例）都接受；
 *   - VTT 的 WEBVTT 头、NOTE 块、 cue 序号与样式设置行全部跳过；
 *   - ASS 的字段顺序从 Format 行读，不写死；
 *   - {\...} 覆盖标签剥掉，\N \n \h 还原成换行 / 空格；
 *   - 解析不出时间的行直接忽略，不让一个坏块毁掉整个文件。
 */

import type { SubtitleFormat, SubtitleSegment } from '@/types'

export interface ParsedSubtitle {
  format: SubtitleFormat
  segments: SubtitleSegment[]
}

/** 00:01:02,500 / 0:01:02.500 / 01:02.5 都能吃，统一转秒 */
function parseTime(raw: string): number {
  const t = raw.trim().replace(',', '.')
  const parts = t.split(':')
  if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) return NaN
  let sec = 0
  for (const p of parts) sec = sec * 60 + Number(p)
  return sec
}

function newSegment(start: number, end: number, text: string, index: number): SubtitleSegment {
  return {
    id: `seg_${Date.now().toString(36)}_${index.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    start,
    end,
    text,
    origin: text,
    issues: [],
  }
}

function sortAndClean(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments
    .filter((s) => s.text.trim() !== '' && Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start)
    .map((s) => ({
      ...s,
      text: s.text.replace(/\s+$/, '').replace(/^\s+/, ''),
    }))
}

// ---------------------------------------------------------------- SRT / VTT

/** SRT 与 VTT 共用：找「时间 --> 时间」行，上下文都是文本 */
function parseCueList(text: string): SubtitleSegment[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const segments: SubtitleSegment[] = []
  const arrow = /-->/i
  const re = /([\d:.,]+)\s*-->\s*([\d:.,]+)/

  let i = 0
  let index = 0
  while (i < lines.length) {
    const m = re.exec(lines[i])
    if (!m || !arrow.test(lines[i])) {
      i += 1
      continue
    }
    const start = parseTime(m[1])
    const end = parseTime(m[2])
    i += 1
    const body: string[] = []
    // 文本行一直吃到空行（或文件尾）
    while (i < lines.length && lines[i].trim() !== '') {
      body.push(lines[i])
      i += 1
    }
    segments.push(newSegment(start, end, body.join('\n').trim(), index))
    index += 1
  }
  return segments
}

function parseSrt(text: string): SubtitleSegment[] {
  return parseCueList(text)
}

function parseVtt(text: string): SubtitleSegment[] {
  return parseCueList(text)
}

// ------------------------------------------------------------------ ASS/SSA

/** {\i1}这类覆盖标签整体剥掉；\N、\n 是换行，\h 是不换行空格 */
function assUnescape(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N|\\n/g, '\n')
    .replace(/\\h/g, ' ')
}

/**
 * ASS 的 Dialogue 字段顺序由 [Events] 的 Format 行声明，各家工具不保证一致，
 * 所以先记 Format 再解析。Start/End 是 0:00:01.20（百分秒）。
 */
function parseAss(text: string): SubtitleSegment[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const segments: SubtitleSegment[] = []
  let fields: string[] | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.toLowerCase().startsWith('format:')) {
      // [Events] 的 Format 行含 Start；[V4+ Styles] 的不含，用它区分两处
      const names = trimmed
        .slice(7)
        .split(',')
        .map((s) => s.trim().toLowerCase())
      if (names.includes('start')) fields = names
      continue
    }
    if (fields && trimmed.toLowerCase().startsWith('dialogue:')) {
      const values = trimmed.slice(9).split(',')
      const startIdx = fields.indexOf('start')
      const endIdx = fields.indexOf('end')
      const textIdx = fields.indexOf('text')
      if (startIdx < 0 || endIdx < 0 || textIdx < 0 || values.length <= textIdx) continue

      // 文本本身可能含逗号：Text 是最后一个字段，多余的逗号全归它
      const head = values.slice(0, textIdx)
      const tail = values.slice(textIdx).join(',')

      const start = parseTime(head[startIdx] ?? '')
      const end = parseTime(head[endIdx] ?? '')
      const body = assUnescape(tail)
      segments.push(newSegment(start, end, body, segments.length))
    }
  }
  return segments
}

// -------------------------------------------------------------------- 入口

export function parseSubtitle(text: string, ext: string): ParsedSubtitle {
  const e = ext.toLowerCase()
  if (e === 'ass' || e === 'ssa') {
    return { format: 'ass', segments: sortAndClean(parseAss(text)) }
  }
  if (e === 'vtt') {
    return { format: 'vtt', segments: sortAndClean(parseVtt(text)) }
  }
  // 未知扩展名时先按 SRT 试：SRT 的解析器最宽容
  return { format: 'srt', segments: sortAndClean(parseSrt(text)) }
}
