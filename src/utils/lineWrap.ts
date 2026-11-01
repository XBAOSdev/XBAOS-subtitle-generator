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
 *
 * 硬切会留下「装满的行 + 一两个字」的零头，而单条只允许 1 行时零头就是
 * 独立的一条字幕、时间只能按宽度分到零点几秒。所以切完还要过一道
 * `balanceLines`，把零头匀回前一行。已含 `\n` 的文本按段处理，段间不再合并。
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

function atomsWidth(atoms: Atom[]): number {
  return atoms.reduce((sum, a) => sum + a.width, 0)
}

/** 需要空格分隔的原子（英文单词、数字），CJK 与空格本身不算 */
function isWordAtom(atom: Atom): boolean {
  return atom.text !== ' ' && !CJK.test(atom.text[0])
}

/**
 * 尾行过短时，从前一行尾部匀一部分原子过来。
 *
 * 硬切只会把文本切成「装满的行 + 零头」，零头常常只有一两个字；当
 * `maxLinesPerSegment` 为 1 时每个零头都会变成独立的一条字幕，时间按宽度
 * 占比只能分到零点几秒 —— 观众看到的就是「一条只有 0.17 秒的单字字幕」。
 *
 * 这里只做局部搬运：某行宽度不足半行时，从它前面那一行搬原子过来，直到
 * 接近两行的均值（且不超过容量）。行数、条数、总字数都不变，前一行至少
 * 留一个原子，所以搬完不会出现空行。两行都不满半行时不动 —— 那时搬了
 * 也不改善观感，反而把断句弄乱。
 */
function balanceLines(lines: Atom[][], capacity: number): Atom[][] {
  if (lines.length < 2) return lines
  const minWidth = capacity / 2
  // 原子数组会被 pop/unshift，逐行拷一份，别改到调用方的数据
  const out = lines.map((atomsOfLine) => atomsOfLine.slice())

  for (let i = out.length - 1; i >= 1; i -= 1) {
    const cur = out[i]
    const curW = atomsWidth(cur)
    if (curW >= minWidth) continue

    const prev = out[i - 1]
    const prevW = atomsWidth(prev)
    if (prevW <= minWidth) continue

    const target = Math.min(capacity, (prevW + curW) / 2)
    let filled = curW
    let remain = prevW
    while (filled < target && prev.length > 1) {
      const next = prev[prev.length - 1]
      // 标点属于前一句，搬到下一行开头会变成「，很多人」这种断句
      if (BREAK_AFTER.test(next.text)) break
      const spacer = isWordAtom(next) && cur.length > 0 && isWordAtom(cur[0]) ? 1 : 0
      const move = spacer + next.width
      // 搬过来会把这一行顶出容量上限时就不搬 —— 平衡的目的不是造超宽条目
      if (filled + move > capacity) break
      // 搬走之后前一行不能跌破半行，否则只是把短行从尾巴挪到了中间
      if (remain - move < minWidth) break
      prev.pop()
      remain -= next.width
      filled += move
      if (spacer) {
        // 英文单词紧挨英文单词时必须补空格，否则两个词会粘成一个
        cur.unshift({ text: ' ', width: 1 })
      }
      cur.unshift(next)
    }
  }

  return out
}

/**
 * 把一行文本按宽度上限切成若干行。
 * 断点从优到劣：中文标点后 > 空格 > 硬切（单词不从中间断，宁可超宽）。
 */
export function breakIntoLines(text: string, capacity: number): string[] {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return []
  const atoms = tokenize(flat)

  const lines: Atom[][] = []
  let line: Atom[] = []
  let lineW = 0

  const pushLine = (atomsOfLine: Atom[]): void => {
    if (render(atomsOfLine)) lines.push(atomsOfLine)
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

  // 硬切留下的零头（常常只有一两个字）在这里匀回前一行
  return balanceLines(lines, capacity).map(render)
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
    /*
     * 先按 `\n` 分段再切：手工调过的换行不该被当成空格重新切乱，也保证
     * 「重新断行」连点两次的结果稳定。段内超长照常再切，段间不做合并。
     */
    const parts = seg.text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    if (parts.length === 0) {
      out.push(seg)
      continue
    }

    const capacity = isCjkDominant(parts.join('')) ? capacityCjk : capacityEn
    const lines =
      parts.length === 1
        ? breakIntoLines(parts[0], capacity)
        : parts.flatMap((part) => breakIntoLines(part, capacity))
    if (lines.length === 1 && lines[0] === seg.text) {
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
