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
 * 们日常的计算和交流」。所以断点不是「装满就切」，而是在容量内**择优选边界**。
 *
 * 这里曾经用「加权求和打分」：词内 −8000、行首禁则 −12000、宽度每单位 −5。
 * 它有两个致命缺陷，无论词表加多少词都治不好：
 *
 *   ① **只做排除，不做背书**。只有「切进已收录词内部」才扣分，而切在词边界
 *      与切在无人认领的位置**得分完全相同**，于是宽度项决定一切。实测语料里
 *      52.9% 的切点位置没有任何词典证据，也就是说一半以上的刀是凭字数猜的。
 *   ② **不同性质的因素互相抵消**。为了避开行首一个「们」（−12000），可以
 *      切进另一个词（−8000 再加宽度项）—— 硬约束被软惩罚打败了。
 *
 * 现在改成**约束 + 字典序**：
 *
 *   硬约束：不切进已收录词内部（只要容量内存在别的候选就绝不切词）
 *   比较顺序（逐项比，不是加权）：词内 → 行过短 → 断点强度 → 行首禁则
 *                                → 行尾禁则 → 是否有词典背书 → 末行过短 → 宽度
 *
 * 「断点强度」由证据决定，从强到弱：句末标点 > 停顿 ≥0.3s > 句中标点 >
 * 空格 > 停顿 ≥0.12s。没有证据的位置排在最后 —— 它不是错，只是没把握。
 *
 * 求的是**整段最优**（动态规划），不是逐行贪心：贪心只对当前行最优，最后
 * 一行常常剩三五个字，这正是「尾巴被扔到下一条」的另一半来源。
 *
 * 词表是可选输入：不传就退化成「按标点与宽度折行」（老行为），传了才用得上
 * 词边界这条证据。词表只影响「切在哪里」，**不增删任何一个字** —— 行数、
 * 总字数恒等于输入。
 *
 * 已含 `\n` 的文本按段处理，段间不再合并，手工排版得以保留。
 */

import type { SubtitleSegment } from '@/types'
import { uid } from '@/utils/id'
import { charSpanOf, markTranslationsStale } from '@/utils/segmentOps'
import { widthUnits } from '@/utils/validate'

/** 与 validate.ts 同一口径：汉字算 2 宽 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

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

/**
 * 排版禁则：标点不能落在行首，开引号与开括号不能落在行尾。
 *
 * 与上面两组（按词法推断）不同，这两条是排版规矩，没有例外 —— 「…逐字降级 /
 * 。界面图标…」这种把句号甩到下一行开头的断法，一眼就是错的。
 */
const NO_LINE_START_PUNCT = new Set('。，、；：！？…）〉》」』”’')
const NO_LINE_END_OPEN = new Set('（〈《「『“‘')

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

interface CutMask {
  /** 落在已收录词内部的位置：切在这里必然把一个词劈成两半 */
  inWord: Set<number>
  /** 某个已收录词在此结束 */
  endAt: Set<number>
  /** 某个已收录词在此开始 */
  startAt: Set<number>
}

/**
 * 扫一遍原子序列，标出「不可切」「词尾」「词首」三类位置。
 *
 * 与旧实现（最长贪心、匹配到就整段跳过）的区别有两处，都是刻意的：
 *
 *   ① **不跳过**。同一位置把所有长度的窗口都试一遍，因此长短词重叠时
 *      「计算」和「计算和交流」都能被看见；贪心匹配会把靠后的词永久漏掉。
 *   ② **同时记「可以切」**。只记「不能切」是上一版最大的问题：切在词边界与
 *      切在无人认领的位置得分相同，宽度项就替用户做了决定。
 *
 * 词尾与词首分成两个集合，是因为「一侧有词」不等于「这里是词与词的交界」：
 * 「…专有 | 编解码器…」里「专有」确实在此结束，但右边那个「编」只是某个
 * 未收录词（编码）的前半个字，切在这里仍然把词劈开。只有**两侧都有词**
 * 才是真正的交界，所以这里要分三档而不是两档。
 *
 * 只对单字原子（CJK）做匹配 —— 英文单词本身就是一个不可分的原子，
 * 天然不会被切开，不需要也不应该参与这里的判断。
 */
function analyzeCuts(atoms: Atom[], words: Set<string>): CutMask {
  const mask: CutMask = { inWord: new Set(), endAt: new Set(), startAt: new Set() }
  const n = atoms.length

  for (let i = 0; i < n; i += 1) {
    const head = atoms[i]
    // 空格与英文词会打断中文词，不能跨过去匹配
    if (head.text.length !== 1 || head.text === ' ') continue

    // 逐字向外扩，边扩边查表：窗口文本是增量拼的，不必为每个长度重拼一遍
    let text = head.text
    const maxLen = Math.min(MAX_WORD_ATOMS, n - i)
    for (let len = 2; len <= maxLen; len += 1) {
      const atom = atoms[i + len - 1]
      if (atom.text.length !== 1 || atom.text === ' ') break
      text += atom.text
      if (!words.has(text)) continue
      mask.startAt.add(i)
      mask.endAt.add(i + len)
      for (let k = 1; k < len; k += 1) mask.inWord.add(i + k)
    }
  }

  return mask
}

/** 句末标点：切在它后面，两条字幕之间天然是一个完整的句子 */
const SENTENCE_PUNCT = /[。！？…]/
/** 句中标点：次于句末，但仍是最可靠的证据 */
const CLAUSE_PUNCT = /[，、；：,;:]/
/** 收尾性符号：跟在标点之后，强度与它前面那个标点同档 */
const CLOSING_MARK = /[）》」』”’"']/

/** 停顿分档：0.3 秒以上几乎一定是换气，0.12 秒以上是可用的弱证据 */
const PAUSE_STRONG = 0.3
const PAUSE_WEAK = 0.12

/** 断点强度的上限，代价里用「6 − 强度」记缺口 */
const MAX_STRENGTH = 6

/**
 * 断点强度：这个位置有多像「一句话在这里断开」。
 *
 * 6 句末标点 · 5 大停顿 · 4 句中标点 · 3 空格 · 2 小停顿 · 0 无证据。
 * 停顿排在句中标点前面一位、又低于句末标点，是因为口播里「没写标点的换气」
 * 往往比「顺手敲的逗号」更接近断句意图，但两者都不如句号确定。
 */
function cutStrength(atoms: Atom[], cut: number, pause: number): number {
  const prev = atoms[cut - 1]
  const prevText = prev ? prev.text : ''

  // 「。」「」」这类组合要跨过收尾符号再看一眼，否则句号会被降成句中标点
  let head = prevText
  if (CLOSING_MARK.test(head) && cut >= 2) head = atoms[cut - 2].text

  if (SENTENCE_PUNCT.test(head)) return 6
  if (pause >= PAUSE_STRONG) return 5
  if (CLAUSE_PUNCT.test(head)) return 4
  const next = atoms[cut]
  if (prevText === ' ' || (next && next.text === ' ')) return 3
  if (pause >= PAUSE_WEAK) return 2
  return 0
}

/**
 * 一行代价的各维度，数组下标即比较的优先级。逐项比较（字典序），不做加权求和：
 * 加权只能靠手调权重让不同性质的因素勉强平衡，一旦某个因素被另一个抵消，
 * 硬约束就失效了 —— 上一版正是「为了避开行首一个助词而切进另一个词」。
 *
 *   0 切进了已收录词内部    唯一真正不能接受的结果，压过其它一切
 *   1 有行过短（< 20% 容量） 末尾只剩一两个字，单独闪一下就没有了
 *   2 断点强度不足          句末标点 > 大停顿 > 句中标点 > 空格 > 小停顿
 *   3 行首是后缀助词         「我 / 们」那种一眼可见的事故
 *   4 行尾是前置虚词
 *   5 可信度与宽度的合成    切点证据折算成「偏了几个字」，与宽度偏差相加
 *
 * 短行只挡「一两个字」这一档：门槛按 0.3 算会把「使用编码，」这种四字加标点的
 * 正常短行也否掉，于是拐去更靠后的位置切开「进入」这类词 —— 短不是错，劈词才是。
 *
 * 最后一维把「切点有多可信」与「行宽有多接近理想」放在同一把尺子上：
 * 证据不够强，就按「相当于偏了 x 个字」折算成距离。这样「宁可这边短两格」和
 * 「宁可这边多猜一处」才有可比性 —— 分成两维做字典序会得出「任何一处半证据
 * 都值得把行切到五个字」这种结论，实测短行会翻十倍。
 */
const COST_DIM = 6
const C_IN_WORD = 0
const C_SHORT = 1
const C_STRENGTH = 2
const C_START_BAD = 3
const C_END_BAD = 4
const C_BALANCE = 5

/**
 * 本行最短占容量的比例。0.2 而不是 0.3：四个字加一个标点的短行在字幕里
 * 完全正常（「使用编码，」），按 0.3 判就会被否决，于是拐去更靠后的位置切开
 * 「进入」这类词。真正要挡的是一两个字的行，不是短行。
 */
const MIN_LINE_RATIO = 0.2

/**
 * 切点证据折算成「宽度偏差」的当量（1 字 = 2 宽 = 20 个内部单位）。
 *
 * 只有两侧都被词典认出来才算「真交界」，抵扣 0；其余一律按猜的算，抵扣相当于
 * 偏了 2 个字 —— 也就是说，一个真交界最多值得把行挪短两格，再远就不如按宽度来。
 *
 * 只认两侧，是因为「一侧有词」几乎不提供信息：「…专有 | 编解码器…」里「专有」
 * 确实在此结束，右边那个「编」却是未收录词「编码」的头半个字；反过来
 * 「大 | 小生成」也一样，右侧「生成」是词，左侧「大小」却被劈开。
 * 实测把半证据也算证据（抵扣 2 字 → 1 字）会把短行翻四倍，正确率没提高。
 */
const EVIDENCE_GUESS = 20

function addCost(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(COST_DIM)
  for (let k = 0; k < COST_DIM; k += 1) out[k] = a[k] + b[k]
  return out
}

function lessThan(a: readonly number[], b: readonly number[]): boolean {
  for (let k = 0; k < COST_DIM; k += 1) {
    if (a[k] !== b[k]) return a[k] < b[k]
  }
  return false
}

/**
 * 评估「第 i 个原子到第 j 个原子排成一行」的代价。
 *
 * `j` 落在最后一个原子时（末行）没有断点，只判「末行是否过短」；
 * 其余情况才分析 j 处的断点证据。
 */
function lineCost(
  atoms: Atom[],
  i: number,
  j: number,
  capacity: number,
  prefix: number[],
  total: number,
  mask: CutMask | null,
  pauses?: number[],
): number[] {
  const out = new Array<number>(COST_DIM).fill(0)
  const leftW = prefix[j] - prefix[i]
  const restW = total - prefix[i]
  const minW = capacity * MIN_LINE_RATIO
  let evidence = 0

  if (j < atoms.length) {
    const last = atoms[j - 1]
    const first = atoms[j]
    const pause = pauses && j < pauses.length ? pauses[j] : 0
    out[C_STRENGTH] = MAX_STRENGTH - cutStrength(atoms, j, pause)

    if (mask) {
      /*
       * 三档而非两档：两侧都有词才是真正的词交界，见 analyzeCuts 的注释。
       * 落在词内部是硬否决，走单独一维；剩下两档按「猜的代价」折算成宽度。
       */
      if (mask.inWord.has(j)) out[C_IN_WORD] = 1
      else if (!mask.endAt.has(j) || !mask.startAt.has(j)) evidence = EVIDENCE_GUESS
    }

    const head = first.text[0]
    const tail = last.text[last.text.length - 1]
    if (NO_LINE_START.has(head) || NO_LINE_START_PUNCT.has(head)) out[C_START_BAD] = 1
    if (NO_LINE_END.has(tail) || NO_LINE_END_OPEN.has(tail)) out[C_END_BAD] = 1
    if (leftW < minW) out[C_SHORT] = 1
  } else if (i > 0 && leftW < minW) {
    // 末行同样不许只剩一两个字：它单独成条，闪一下就没有
    out[C_SHORT] = 1
  }

  /*
   * 宽度目标随剩余量变化：
   *   只剩两行 → 按均分，避免「第一行挤满、第二行只剩几个字」；
   *   还有三行以上 → 按装满，把容量留给后续行，否则越折越碎。
   */
  const target = restW <= capacity * 2 ? restW / 2 : capacity
  // 放大十倍取整：内部单位是 0.1 宽，够用且避免浮点比较的抖动
  out[C_BALANCE] = Math.round(Math.abs(leftW - target) * 10) + evidence
  return out
}

/** 一个字符占几个码点：英文词可能不止一个，逐字时间轴按码点排 */
function atomChars(atom: Atom): number {
  return [...atom.text].length
}

/**
 * 把一段原子切成分行，返回每行覆盖的原子区间 `[start, end)`。
 *
 * 动态规划求整段最优：`cost[l][i]` 是「用 l 行排完前 i 个原子」的最小代价
 * （代价是向量，见 `lineCost` 的注释），转移时枚举这一行的终点。
 *
 * 三处刻意的选择：
 *
 *   ① **行数上限 = 最少行数 + 1**。多给一行是为了「宁可多一条字幕也不切词」，
 *      但不无限放宽 —— 否则极端句子会被切成一行两个字。
 *   ② **一行必须装得下**，唯一的例外是单个英文词本身就比容量宽（没有解法，
 *      放行比死循环好）。
 *   ③ **取全局最小而不是最早到达末行**：少一行只会少一处断点代价，所以
 *      正常情况下一定选行数最少的那个解，除非多一行能避开切词。
 *
 * 词表为空时退化成「按标点与宽度折行」，与旧行为一致但不再逐行贪心。
 */
function layoutLines(
  atoms: Atom[],
  capacity: number,
  words: Set<string> | null,
  pauses?: number[],
): { start: number; end: number }[] {
  const n = atoms.length
  if (n === 0) return []

  const prefix: number[] = [0]
  for (const atom of atoms) prefix.push(prefix[prefix.length - 1] + atom.width)
  const total = prefix[n]
  const mask = words && words.size > 0 ? analyzeCuts(atoms, words) : null

  const maxLines = Math.ceil(total / capacity) + 1
  const cost: (number[] | null)[][] = Array.from({ length: maxLines + 1 }, () =>
    new Array<number[] | null>(n + 1).fill(null),
  )
  const from: number[][] = Array.from({ length: maxLines + 1 }, () =>
    new Array<number>(n + 1).fill(-1),
  )
  cost[0][0] = new Array<number>(COST_DIM).fill(0)

  for (let line = 1; line <= maxLines; line += 1) {
    for (let i = 0; i < n; i += 1) {
      const prev = cost[line - 1][i]
      if (!prev) continue
      for (let j = i + 1; j <= n; j += 1) {
        const width = prefix[j] - prefix[i]
        if (width > capacity && j > i + 1) break
        const sum = addCost(prev, lineCost(atoms, i, j, capacity, prefix, total, mask, pauses))
        const cur = cost[line][j]
        if (!cur || lessThan(sum, cur)) {
          cost[line][j] = sum
          from[line][j] = i
        }
      }
    }
  }

  let best = -1
  for (let line = 1; line <= maxLines; line += 1) {
    const c = cost[line][n]
    if (!c) continue
    if (best < 0 || lessThan(c, cost[best][n] as number[])) best = line
  }
  if (best < 0) return [{ start: 0, end: n }]

  const lines: { start: number; end: number }[] = []
  let cursor = n
  for (let line = best; line >= 1; line -= 1) {
    const prev = from[line][cursor]
    // 行首空格带过来没有意义，丢掉（只影响这一行的起点，不动后面的行）
    let start = prev
    while (start < cursor && atoms[start].text === ' ') start += 1
    lines.push({ start, end: cursor })
    cursor = prev
  }
  return lines.reverse()
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
  const atoms = tokenize(flat)
  return layoutLines(atoms, capacity, words)
    .map((r) => render(atoms.slice(r.start, r.end)))
    .filter(Boolean)
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
  // 折行会给文本加上 `\n`，字符数与逐字时间轴对不上了；这里之后也用不到它
  delete derived.charTimes
  // 文本变了，原译文不再逐字对应 —— 标红交给用户确认（与分割/合并同一语义）
  return markTranslationsStale(derived)
}

/**
 * 逐字时间轴 → 「切点处的停顿」查表（下标是原子边界）。
 *
 * `charAt[i]` 是第 i 个原子之前的字符数。停顿 = 该字符的起始时间 − 前一个
 * 字符的结束时间；没有时间轴或下标越界就是 0（不参与打分）。
 */
function pausesOf(ct: number[] | undefined, charAt: number[]): number[] | undefined {
  if (!ct) return undefined
  const out = new Array<number>(charAt.length).fill(0)
  for (let i = 1; i < charAt.length; i += 1) {
    const j = charAt[i]
    if (j <= 0 || j * 2 > ct.length) continue
    out[i] = Math.max(0, ct[j * 2] - ct[j * 2 - 1])
  }
  return out
}

/** 取 [from, to) 这段字符的真实时间窗；拿不到就返回 null 交给按宽度摊派 */

/**
 * 按字幕规格折行 / 拆分一批条目。
 *
 * 放得下的条目只改文本（按 `\n` 分行）；放不下的拆成多条。
 *
 * 拆条的时间有两条路：
 *   ① 识别刚结束、`charTimes` 还在 → 直接读切点那个字的真实起止；
 *   ② 没有逐字时间（重新断行工具、whisper 引擎、旧草稿）→ 按宽度占比摊派。
 * 路 ① 是「时间码对得上嘴」的关键：按字数摊派时，语速一快一慢就错开半秒，
 * 而且误差在整句里累积，越靠句尾越明显。
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

    /*
     * 逐字时间只在「一个自然段」时才用得上：文本里已经有手工换行、或者空格
     * 被压实过，字符下标就与引擎那份对不上了。
     */
    const flat = parts.join('\n') === seg.text ? seg.text : ''
    const ct =
      flat && seg.charTimes && seg.charTimes.length === [...flat].length * 2
        ? seg.charTimes
        : undefined

    // 每个自然段各自切行；逐字时间的下标需要跨段累加，所以按段推进
    const lines: string[] = []
    const spans: { from: number; to: number }[] = []
    let base = 0
    for (const part of parts) {
      const atoms = tokenize(part)
      const charAt: number[] = [0]
      for (const atom of atoms) charAt.push(charAt[charAt.length - 1] + atomChars(atom))
      const ranges = layoutLines(atoms, capacity, words, parts.length === 1 ? pausesOf(ct, charAt) : undefined)
      for (const r of ranges) {
        const text = render(atoms.slice(r.start, r.end))
        if (!text) continue
        lines.push(text)
        spans.push({ from: base + charAt[r.start], to: base + charAt[r.end] })
      }
      base += [...part].length
    }

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

    // 装不下：按 maxLines 一组拆成多条
    const chunks: string[][] = []
    const chunkChar: { from: number; to: number }[] = []
    for (let i = 0; i < lines.length; i += maxLines) {
      const slice = lines.slice(i, i + maxLines)
      chunks.push(slice)
      chunkChar.push({ from: spans[i].from, to: spans[i + slice.length - 1].to })
    }

    const span = Math.max(0.001, seg.end - seg.start)
    const widths = chunks.map((c) => Math.max(1, widthUnits(c.join('\n'))))
    const totalW = widths.reduce((a, b) => a + b, 0)

    let cursor = seg.start
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      /*
       * 时间优先取逐字时间轴上这一段的真实边界；首条起见与末条收尾仍夹在
       * 原条目的 start/end 内，避免相邻两条之间出现缝隙或重叠。
       */
      const exact = charSpanOf(ct, chunkChar[i].from, chunkChar[i].to)
      let end = isLast ? seg.end : round3(cursor + (span * widths[i]) / totalW)
      if (exact && !isLast) end = round3(Math.min(seg.end, Math.max(cursor + 0.02, exact.end)))
      const text = chunks[i].join('\n')
      if (i === 0) {
        // 第一条沿用原时间轴起点，避免浮点误差把首条挪出去
        out.push(deriveSegment(seg, text, seg.start, end))
      } else {
        const start = exact ? round3(Math.max(seg.start, Math.min(exact.start, end - 0.02))) : cursor
        out.push(deriveSegment(seg, text, start, end))
        splitCount += 1
      }
      cursor = end
    }
    rewrapped += 1
  }

  return { segments: out, rewrapped, splitCount }
}
