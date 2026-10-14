/**
 * 停顿标点的后处理。
 *
 * 处理时机：识别结果写入编辑区**之前**。用户看到的第一眼就已经是处理过的
 * 结果，不需要再手动点一次工具。
 *
 * 只处理「起停顿作用」的标点。引号、括号、书名号、斜杠、连字符这些
 * 非停顿标点原样保留 —— 它们一旦被删掉，文本结构就坏了（引号还得成对）。
 *
 * 中文字幕的惯例是不带标点，并把一句话按标点断成两条；西文字幕的惯例是
 * 原样保留。所以中西文各自有独立的处理方式，默认值见 DEFAULT_SETTINGS。
 */

import type { PunctuationMode, PunctuationOptions, SubtitleSegment } from '@/types'
import { uid } from '@/utils/id'
import { T2S_TABLE } from '@/utils/t2sTable'

/**
 * 繁体转简体。
 *
 * whisper 的中文输出在部分权重 / GPU 精度下整段是繁体，用户要的一直是
 * 简体字幕。识别结果入库前统一转一遍；表是 OpenCC 的 TSCharacters
 * 单字表（3512 字），逐字替换，无歧义词组展开 —— 字形转换够用。
 */
export function toSimplified(text: string): string {
  let out = ''
  let changed = false
  for (const ch of text) {
    const mapped = T2S_TABLE[ch]
    if (mapped !== undefined) {
      out += mapped
      changed = true
    } else {
      out += ch
    }
  }
  return changed ? out : text
}

/** 中文侧要处理的停顿标点（全角为主，同时容忍模型输出的半角） */
export const PAUSE_PUNCT_ZH: readonly string[] = [
  '。',
  '，',
  '、',
  '；',
  '：',
  '？',
  '！',
  '…',
  '．',
  '—',
  ',',
  '.',
  ';',
  ':',
  '?',
  '!',
]

/** 西文侧要处理的停顿标点 */
export const PAUSE_PUNCT_EN: readonly string[] = ['.', ',', ';', ':', '?', '!', '…']

const SET_ZH = new Set(PAUSE_PUNCT_ZH)
const SET_EN = new Set(PAUSE_PUNCT_EN)

/** 设置页展示用的名单文案 */
export const PAUSE_PUNCT_LABELS: Record<'zh' | 'en', string> = {
  zh: '。 ， 、 ； ： ？ ！ … ——',
  en: '.  ,  ;  :  ?  !',
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 文本里是否含中日韩字符。含则按中文规则处理，否则按西文规则 */
export function hasCJK(text: string): boolean {
  return CJK.test(text)
}

/**
 * 文本里是否有「实际内容」——字母、数字或汉字。
 *
 * 用来剔除只有标点的空条目：whisper 在纯静音上偶尔会吐出一个孤零零的
 * 句号，这种条目既没有信息量，又会让用户以为「整段都没识别出来」。
 * 音乐符号单独放行，那是字幕里合法的内容标记。
 */
const CONTENT = /[\p{L}\p{N}]/u
const MUSIC_MARK = /[♪♫♬♩]/

export function hasContent(text: string): boolean {
  return CONTENT.test(text) || MUSIC_MARK.test(text)
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))
}

/**
 * 判断 text[i] 是否是一个真正起停顿作用的标点。
 *
 * 有几种半角符号「长得像标点但不是停顿」，误删会破坏数据：
 *   3.5      小数点
 *   1,000    千分位逗号
 *   U.S.A.   缩写点
 * 它们在处理时一律跳过。
 */
function isPauseAt(text: string, i: number, set: Set<string>): boolean {
  const ch = text[i]
  if (!set.has(ch)) return false

  const prev = text[i - 1]
  const next = text[i + 1]

  if ((ch === '.' || ch === ',') && isDigit(prev) && isDigit(next)) return false
  if (ch === '.' && isLetter(prev) && isLetter(next)) return false
  // 句点紧贴另一个句点（省略号被拆成 "..."）时，只当作一个停顿
  if (ch === '.' && (prev === '.' || next === '.')) return false

  return true
}

/** 去掉停顿标点，保留其余字符 */
export function stripPausePunctuation(text: string, set: Set<string>): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    if (isPauseAt(text, i, set)) continue
    out += text[i]
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/** 以停顿标点为界切分。切分点上的标点本身被丢弃 */
export function splitByPausePunctuation(text: string, set: Set<string>): string[] {
  const parts: string[] = []
  let buf = ''

  for (let i = 0; i < text.length; i += 1) {
    if (isPauseAt(text, i, set)) {
      const piece = buf.trim()
      if (piece) parts.push(piece)
      buf = ''
      continue
    }
    buf += text[i]
  }

  const tail = buf.trim()
  if (tail) parts.push(tail)

  return parts.length > 0 ? parts : [text.trim()].filter(Boolean)
}

function round(v: number): number {
  return Number(v.toFixed(3))
}

/**
 * 把 [start, end] 按各段的字符数比例分给若干段。
 * 最后一段强制收在原 end 上，避免浮点累积误差越拖越偏。
 */
function allocateTime(
  start: number,
  end: number,
  parts: string[],
): { start: number; end: number }[] {
  const span = Math.max(0.001, end - start)
  const weights = parts.map((p) => Math.max(1, [...p].length))
  const total = weights.reduce((a, b) => a + b, 0)

  const out: { start: number; end: number }[] = []
  let cursor = start
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1
    const next = isLast ? end : cursor + (span * weights[i]) / total
    out.push({ start: round(cursor), end: round(next) })
    cursor = next
  }
  return out
}

function setFor(mode: 'zh' | 'en'): Set<string> {
  return mode === 'zh' ? SET_ZH : SET_EN
}

/**
 * 对识别结果做标点后处理。
 *
 * 只返回新数组，不改动入参 —— 调用方拿到结果后再写回，方便做撤销。
 */
export function applyPunctuation(
  segments: SubtitleSegment[],
  options: PunctuationOptions,
): { segments: SubtitleSegment[]; splitCount: number; strippedCount: number } {
  const out: SubtitleSegment[] = []
  let splitCount = 0
  let strippedCount = 0

  for (const seg of segments) {
    // 第一步：繁转简（只影响中日韩文本，西文原样通过）
    const simplified = hasCJK(seg.text) ? toSimplified(seg.text) : seg.text
    const source: SubtitleSegment = simplified !== seg.text ? { ...seg, text: simplified } : seg

    const mode: PunctuationMode = hasCJK(source.text) ? options.zh : options.en

    if (mode === 'keep') {
      out.push(source)
      continue
    }

    const set = setFor(hasCJK(source.text) ? 'zh' : 'en')

    if (mode === 'strip') {
      const text = stripPausePunctuation(source.text, set)
      if (!text) {
        out.push(source)
        continue
      }
      if (text !== source.text) strippedCount += 1
      out.push({ ...source, text, origin: text, issues: [] })
      continue
    }

    // strip-split
    const parts = splitByPausePunctuation(source.text, set)

    if (parts.length <= 1) {
      const text = parts[0] ?? source.text
      if (!text) {
        out.push(source)
        continue
      }
      if (text !== source.text) strippedCount += 1
      out.push({ ...source, text, origin: text, issues: [] })
      continue
    }

    const times = allocateTime(source.start, source.end, parts)
    parts.forEach((text, i) => {
      out.push({
        id: uid('seg'),
        start: times[i].start,
        end: times[i].end,
        text,
        origin: text,
        issues: [],
        avgLogprob: source.avgLogprob,
      })
    })
    splitCount += parts.length - 1
  }

  return { segments: out, splitCount, strippedCount }
}
