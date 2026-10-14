/**
 * 字幕折行与超长拆分。
 *
 * 「单行最大字数 / 单条最多行数」过去只在导出与校验里起作用：识别结果本身
 * 不受它约束，于是表格里满是超长条目；而「重新断行」工具的处理方式是
 * `lines.length < maxLines` 时截断循环 —— 放不下的文字被**静默丢掉**，
 * 这两条路都是错的。
 *
 * 本文件把规格变成唯一的数据操作入口，两个语义：
 *   ① **折行**：一条的文本能装进 maxLines 行 → 原条目文本改为用 `\n` 分行；
 *   ② **拆分**：折不完 → 按宽度比例切时间，拆成多条字幕（每条内部仍分行）。
 *
 * 断点偏好：优先在中文标点后断行，其次空格，都没有才硬切（CJK 逐字断，
 * 英文单词绝不从中间断）。宽度口径与 validate.ts 一致：汉字 2、其余 1。
 */

import type { SubtitleSegment } from '@/types'
import { uid } from '@/utils/id'
import { markTranslationsStale } from '@/utils/segmentOps'
import { widthUnits } from '@/utils/validate'

/** 与 validate.ts 同一口径：汉字算 2 宽 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 这些标点之后是天然的断行点（从优到劣：句末 > 句中） */
const BREAK_AFTER = /^[。！？；，、：…）》」』”]/

export interface LineWrapSpec {
  /** 中文单行最大字数（宽度上限 = 字数 × 2） */
  maxCharsPerLine: number
  /** 英文单行最大字符数（宽度上限 = 字符数） */
  maxCharsPerLineEn: number
  /** 单条最多行数 */
  maxLinesPerSegment: number
}

export interface LineWrapResult {
  /** 处理后的条目数组（未动的条目保持原引用） */
  segments: SubtitleSegment[]
  /** 只改了换行的条数 */
  rewrapped: number
  /** 因折不下而**新增**的条数（不含被拆的原条） */
  splitCount: number
}

interface Atom {
  text: string
  width: number
}

/** 中文（含标点）占比是否过半 —— 决定用中文还是英文的行宽规格 */
function isCjkDominant(text: string): boolean {
  let cjk = 0
  let units = 0
  for (const ch of text) {
    const w = CJK.test(ch) ? 2 : 1
    units += w
    if (w === 2) cjk += 2
  }
  return units > 0 && cjk * 2 >= units
}

/** 把文本切成不可再分的原子：英文单词保持完整，CJK 逐字，空格单独 */
function tokenize(text: string): Atom[] {
  const atoms: Atom[] = []
  let word = ''
  let wordWidth = 0

  const flush = (): void => {
    if (word) {
      atoms.push({ text: word, width: wordWidth })
      word = ''
      wordWidth = 0
    }
  }

  for (const ch of text) {
    if (ch === ' ') {
      flush()
      // 连续空格压成一个；行首空格在渲染时再去
      if (atoms.length > 0 && atoms[atoms.length - 1].text !== ' ') {
        atoms.push({ text: ' ', width: 1 })
      }
      continue
    }
    if (CJK.test(ch)) {
      flush()
      atoms.push({ text: ch, width: CJK.test(ch) ? 2 : 1 })
      continue
    }
    word += ch
    wordWidth += 1
  }
  flush()
  return atoms
}

function render(atoms: Atom[]): string {
  return atoms
    .map((a) => a.text)
    .join('')
    .replace(/^ +| +$/g, '')
}

/**
 * 把一行文本按宽度上限切成若干行。
 * 断点从优到劣：中文标点后 > 空格 > 硬切（单词不从中间断，宁可超宽）。
 */
export function breakIntoLines(text: string, capacity: number): string[] {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return []
  const atoms = tokenize(flat)

  const lines: string[] = []
  let line: Atom[] = []
  let lineW = 0

  const pushLine = (atomsOfLine: Atom[]): void => {
    const rendered = render(atomsOfLine)
    if (rendered) lines.push(rendered)
  }

  for (const atom of atoms) {
    const overflow = lineW + atom.width > capacity && line.length > 0

    if (overflow && atom.text === ' ') {
      // 空格处断行最干净：当前行收尾，空格不带入下一行
      pushLine(line)
      line = []
      lineW = 0
      continue
    }

    if (overflow) {
      // 从尾部往回找断点：上一个原子是中文标点 → 在它后面断；否则硬切
      let cut = line.length
      for (let i = line.length; i >= 1; i--) {
        if (BREAK_AFTER.test(line[i - 1].text)) {
          cut = i
          break
        }
      }
      pushLine(line.slice(0, cut))
      line = line.slice(cut)
      lineW = line.reduce((sum, a) => sum + a.width, 0)
    }

    line.push(atom)
    lineW += atom.width
  }
  pushLine(line)

  return lines
}

function round3(v: number): number {
  return Number(v.toFixed(3))
}

/** 由原条目派生一条新条目：文本替换、时间给定、译文整份带入并标红待确认 */
function deriveSegment(
  seg: SubtitleSegment,
  text: string,
  start: number,
  end: number,
): SubtitleSegment {
  const derived: SubtitleSegment = {
    ...seg,
    id: uid('seg'),
    start,
    end,
    text,
    issues: [],
    translations: seg.translations ? { ...seg.translations } : undefined,
  }
  // 文本变了，原译文不再逐字对应 —— 标红交给用户确认（与分割/合并同一语义）
  return markTranslationsStale(derived)
}

/**
 * 按字幕规格折行 / 拆分一批条目。
 *
 * 放得下的条目只改文本（按 `\n` 分行）；放不下的按「宽度占比」切时间拆成
 * 多条 —— 时长与字数成正比是拆条能做的最诚实假设，比全部塞在原时间里强。
 */
export function applyLineWrap(
  segments: SubtitleSegment[],
  spec: LineWrapSpec,
): LineWrapResult {
  const capacityCjk = Math.max(4, spec.maxCharsPerLine) * 2
  const capacityEn = Math.max(8, spec.maxCharsPerLineEn)
  const maxLines = Math.max(1, spec.maxLinesPerSegment)

  const out: SubtitleSegment[] = []
  let rewrapped = 0
  let splitCount = 0

  for (const seg of segments) {
    const flat = seg.text.replace(/\s+/g, ' ').trim()
    if (!flat) {
      out.push(seg)
      continue
    }

    const capacity = isCjkDominant(flat) ? capacityCjk : capacityEn
    const lines = breakIntoLines(flat, capacity)
    if (lines.length <= 1 && flat === seg.text) {
      out.push(seg)
      continue
    }

    // 装得下：原条目内部分行
    if (lines.length <= maxLines) {
      const text = lines.join('\n')
      if (text === seg.text) {
        out.push(seg)
        continue
      }
      out.push(deriveSegment(seg, text, seg.start, seg.end))
      rewrapped += 1
      continue
    }

    // 装不下：按 maxLines 一组拆成多条，时间按宽度占比分
    const chunks: string[][] = []
    for (let i = 0; i < lines.length; i += maxLines) {
      chunks.push(lines.slice(i, i + maxLines))
    }

    const span = Math.max(0.001, seg.end - seg.start)
    const widths = chunks.map((c) => Math.max(1, widthUnits(c.join('\n'))))
    const totalW = widths.reduce((a, b) => a + b, 0)

    let cursor = seg.start
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      const end = isLast ? seg.end : round3(cursor + (span * widths[i]) / totalW)
      const text = chunks[i].join('\n')
      if (i === 0) {
        // 第一条沿用原时间轴起点，避免浮点误差把首条挪出去
        out.push(deriveSegment(seg, text, seg.start, end))
      } else {
        out.push(deriveSegment(seg, text, cursor, end))
        splitCount += 1
      }
      cursor = end
    }
    rewrapped += 1
  }

  return { segments: out, rewrapped, splitCount }
}
