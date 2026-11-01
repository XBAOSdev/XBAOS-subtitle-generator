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
 * ## 断点怎么选
 *
 * 中文没有词间空格，按宽度硬切必然切进词里 —— 「二进制并不适合我 /
 * 们日常的计算和交流」。所以断点不是「装满就切」，而是**枚举容量内的每个
 * 原子边界、逐个打分取最高**，优先级从高到低：
 *
 *   ① 不落在词内部（靠 `wrapWords` 词表命中的区间判断）
 *   ② 行首不是后缀助词（们的了着过吗呢吧…）
 *   ③ 行尾不是前置虚词（第每哪不就还已被把…）与数词
 *   ④ 落在中文标点之后
 *   ⑤ 落在空格处
 *   ⑥ 宽度接近满行（纯粹的观感项，权重最低）
 *
 * 词表是可选输入：不传就退化成纯宽度折行（老行为），传了就按上面优先级走。
 * 词表只影响「切在哪里」，**不增删任何一个字** —— 行数、总字数恒等于输入。
 *
 * 已含 `\n` 的文本按段处理，段间不再合并，手工排版得以保留。
 */

import type { SubtitleSegment } from '@/types'
import { uid } from '@/utils/id'
import { markTranslationsStale } from '@/utils/segmentOps'
import { widthUnits } from '@/utils/validate'

/** 与 validate.ts 同一口径：汉字算 2 宽 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 这些标点之后是天然的断行点（从优到劣：句末 > 句中） */
const BREAK_AFTER = /^[。！？；，、：…）》」』”]/

/**
 * 行首禁则：后缀性助词与语气词。它们几乎不可能作为词的开头，出现在行首
 * 必然意味着上一个词被劈开了（「我们」→「我 / 们」）。
 */
const NO_LINE_START = new Set('们的了着过吗呢吧啊嘛呀哦')

/**
 * 行尾禁则：前置性虚词、副词与数词。这些字后面必须跟字才能成词
 * （「不就」「还」「第」「被」），作行尾同样是拆词信号。
 * 只收**单字用法占绝对多数**的字 —— 像「个」「为」「于」「和」虽然偶尔
 * 能结尾（一个 / 因为 / 总和），但误伤代价只是切点挪一格，仍值得收录。
 */
const NO_LINE_END = new Set('第每哪某不很太更最都也还就刚已被把让对向从这那些而但或')

/** 词表匹配窗口上限：常用词与术语最多 6 字，再长不收 */
const MAX_WORD_ATOMS = 6

export interface LineWrapSpec {
  /** 中文单行最大字数（宽度上限 = 字数 × 2） */
  maxCharsPerLine: number
  /** 英文单行最大字符数（宽度上限 = 字符数） */
  maxCharsPerLineEn: number
  /** 单条最多行数 */
  maxLinesPerSegment: number
  /**
   * 断句词表：落在这些词内部的切点会被强烈扣分。
   * 不传时退化为纯宽度折行。词表**只影响断点位置**，不改变任何文字。
   */
  wrapWords?: readonly string[]
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
      atoms.push({ text: ch, width: 2 })
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

/**
 * 标出「不可切」的位置：落在词表命中的词内部即为不可切。
 *
 * 只对单字原子（CJK）做匹配 —— 英文单词本身就是一个不可分的原子，
 * 天然不会被切开，不需要也不应该参与这里的判断。
 *
 * 采用最长匹配：同一位置能匹配到 4 字词时不再退去看 2 字词，否则
 * 「计算和交流」里的「计算」会被「和交」这样的假词干扰。
 */
function markWordCuts(atoms: Atom[], words: Set<string>): Set<number> {
  const bad = new Set<number>()
  const n = atoms.length
  let i = 0

  while (i < n) {
    let matched = 0
    const maxLen = Math.min(MAX_WORD_ATOMS, n - i)
    for (let len = maxLen; len >= 2; len -= 1) {
      let text = ''
      let usable = true
      for (let k = 0; k < len; k += 1) {
        const atom = atoms[i + k]
        // 空格与英文单词会打断中文词，不能跨过去匹配
        if (atom.text.length !== 1 || atom.text === ' ') {
          usable = false
          break
        }
        text += atom.text
      }
      if (!usable) continue
      if (words.has(text)) {
        matched = len
        break
      }
    }

    if (matched > 0) {
      for (let k = 1; k < matched; k += 1) bad.add(i + k)
      i += matched
    } else {
      i += 1
    }
  }

  return bad
}

/**
 * 给「在 cut 处断行」打分。分数越高越该在这里断。
 *
 * 权重是按「宁可两条宽度不匀，也不把词切开」定的：词边界与禁则的惩罚
 * 比宽度项高两个数量级，所以只要存在一个合法切点，就不会选到词内部去。
 */
function cutScore(
  atoms: Atom[],
  cut: number,
  capacity: number,
  prefix: number[],
  badWords: Set<number> | null,
): number {
  const last = atoms[cut - 1]
  const first = atoms[cut]
  const leftW = prefix[cut]
  const rightW = prefix[atoms.length] - prefix[cut]

  let score = 0

  if (BREAK_AFTER.test(last.text)) score += 800
  else if (last.text === ' ' || first.text === ' ') score += 400

  if (badWords && badWords.has(cut)) score -= 8000
  if (NO_LINE_START.has(first.text[0])) score -= 12000
  if (NO_LINE_END.has(last.text[last.text.length - 1])) score -= 2500

  // 一行只剩几个字，观感上同样是「断错了」—— 但代价远低于拆词
  if (Math.min(leftW, rightW) < capacity * 0.3) score -= 400

  /*
   * 宽度目标随剩余量变化：
   *   只剩两行 → 按均分，避免「第一行挤满、第二行只剩几个字」；
   *   还有三行以上 → 按装满，把容量留给后续行，否则越折越碎。
   */
  const restW = prefix[atoms.length]
  const ideal = restW <= capacity * 2 ? restW / 2 : capacity
  score -= Math.abs(leftW - ideal) * 5

  return score
}

/**
 * 按容量切行。词表为空时等价于「装满就切」的老行为。
 */
function breakAtoms(atoms: Atom[], capacity: number, words: Set<string> | null): string[] {
  const lines: string[] = []
  let rest = atoms

  while (atomsWidth(rest) > capacity) {
    const prefix: number[] = [0]
    for (const atom of rest) prefix.push(prefix[prefix.length - 1] + atom.width)
    const badWords = words && words.size > 0 ? markWordCuts(rest, words) : null

    let bestCut = 1
    let bestScore = -Infinity
    for (let cut = 1; cut < rest.length; cut += 1) {
      // 切点本身超出容量就没资格参与比较（超宽单词由 cut = 1 兜底）
      if (prefix[cut] > capacity) break
      const score = cutScore(rest, cut, capacity, prefix, badWords)
      if (score > bestScore) {
        bestScore = score
        bestCut = cut
      }
    }

    const line = render(rest.slice(0, bestCut))
    if (line) lines.push(line)
    rest = rest.slice(bestCut)
    // 行首空格带过来没有意义，丢掉
    while (rest.length > 0 && rest[0].text === ' ') rest = rest.slice(1)
  }

  const tail = render(rest)
  if (tail) lines.push(tail)
  return lines
}

/**
 * 把一行文本按宽度上限切成若干行。
 *
 * @param wrapWords 断句词表。不传则退化为纯宽度折行。
 */
export function breakIntoLines(
  text: string,
  capacity: number,
  wrapWords?: readonly string[],
): string[] {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return []
  const words = wrapWords && wrapWords.length > 0 ? new Set(wrapWords) : null
  return breakAtoms(tokenize(flat), capacity, words)
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
  // 词表只构一次：一批几百条字幕，逐条 new Set 会把这个开销放大几百倍
  const words = spec.wrapWords && spec.wrapWords.length > 0 ? new Set(spec.wrapWords) : null

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
    const lines = parts.flatMap((part) => breakAtoms(tokenize(part), capacity, words))
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
