/**
 * 按热词做同音纠正。
 *
 * 解决的是提示词管不到的那一段：whisper 的 initial_prompt 只有两百多个 token
 * 的预算，词库稍大就必须截断；SenseVoice 干脆不支持提示词。而识别完之后，
 * 文本已经拿到手了 —— 这一步用全量热词在**结果文本**上做替换，
 * 与模型能力无关，两套架构、所有模型都能用。
 *
 * ## 判定规则（全部必须满足才替换）
 *
 *   1. **等长**：只替换字数相同的片段。这条保证了时间码完全不用动 ——
 *      改一个字的时间轴，等于让字幕和声音对不上，代价远大于改对一个词。
 *   2. **逐字同音**：允许不同的位置，必须读音有交集（带声调）。
 *   3. **至少一个字面相同**：整段都不同的片段不改。这一条挡住了绝大多数
 *      跨词误伤 ——「事实 / 实施」这种完全不共享文字的，根本进不了候选。
 *   4. **原文片段不能本身是热词或常见词**：热词表里有「事实」时，文本里的
 *      「事实」不会被「实施」改写；内置常见词表里的「必须 / 单位 / 学位」也
 *      一律不动 —— 拼音表收了生僻古音（「百」与「跑」都有 bo2、「位」与「机」
 *      都有 wei4），只靠「同音」会把这些正确的词改坏。识别结果已经是个通顺的
 *      常用词时，改它的风险远大于收益。
 *   5. **不跨词边界**：只在连续汉字串内部滑动，遇到标点、数字、英文就断开。
 *   6. **歧义跳过**：同一位置能对上两个不同的热词时，一个字都不改。
 *
 * ## 为什么坚持带声调
 *
 * 去掉声调后「事实 shí shí / 实施 shí shī」「现存 xiàn cún / 显存 xiǎn cún」
 * 都成了同音，而它们都是合法词汇 —— 改错一次就把原意写反了。
 * 带声调后这两组自动被规则 2 挡住，代价是「卷积 / 卷集」这类跨声调的错误
 * 纠正不了。这是刻意的取舍：**宁可漏，不能错**。
 *
 * 单字热词一律不参与：改一个字的收益太小，而误伤面太大。
 */

import { PINYIN_RAW } from '@/data/pinyin'
import { COMMON_WORDS } from '@/data/commonWords'
import { lexiconById } from '@/data/lexicons'
import { splitTerms } from '@/utils/prompt'
import type { SubtitleSegment } from '@/types'

/** 单字热词不参与 —— 一个字的替换几乎无法保证语义不变 */
const MIN_TERM_LEN = 2

/** 汉字判定：只在连续汉字段内匹配，遇到标点 / 数字 / 字母就断开 */
const HAN = /^[\u3400-\u9fff\uf900-\ufaff]$/

export interface TermFixHit {
  from: string
  to: string
}

export interface TermFixResult {
  segments: SubtitleSegment[]
  /** 逐处替换记录，调用方用来提示「纠正了几处」 */
  hits: TermFixHit[]
}

interface TermMatcher {
  /** 候选词长，从长到短 —— 先试长的，「直播带货」不会被「直播」抢走 */
  lengths: number[]
  /** 首字音节 → 以该音节开头的热词。按音节索引而不是按字，才能命中首字也读错的词 */
  bySyllable: Map<string, string[]>
  /** 热词字面集合：原文片段本身是热词时不许动 */
  literal: Set<string>
}

let syllableTable: Map<string, string[]> | null = null
let matcherCache: { key: string; matcher: TermMatcher | null } | null = null
let commonWords: Set<string> | null = null

/**
 * 两种写法都成立、只能靠语境区分的词。
 *
 * 「登陆月球」与「登陆网站」哪个该改成「登录」，拼音规则判不了；
 * 「订金」与「定金」在法律上含义不同，改错是要出事的。这类词一律跳过，
 * 把选择权留给用户手动编辑 —— 误识纠正的收益不值得冒改错原意的风险。
 */
const AMBIGUOUS_WORDS = [
  // 同音异形、但两种写法都合法的一组：写成对，两侧都保护
  '登陆', '登录', '帐号', '账号', '订金', '定金', '权力', '权利',
  '必需', '必须', '学位', '学历', '渡过', '度过', '暴发', '爆发',
  '漫延', '蔓延', '截至', '截止', '反应', '反映', '制订', '制定',
  '法治', '法制', '一齐', '一起', '须要', '需要', '竖立', '树立',
  '变幻', '变换',
]

/** 内置常见词表 + 歧义词：它们本身就是合法结果，不许被同音规则改写 */
function commonSet(): Set<string> {
  if (!commonWords) commonWords = new Set([...COMMON_WORDS, ...AMBIGUOUS_WORDS])
  return commonWords
}

/**
 * 汉字 → 全部读音（带调，`mang2` 形式）。
 *
 * 表是 30KB 的纯文本，启动时解析一次即可；不在模块顶层执行，
 * 免得没用热词的用户也付这份开销。
 */
function syllables(): Map<string, string[]> {
  if (syllableTable) return syllableTable
  const table = new Map<string, string[]>()
  for (const line of PINYIN_RAW.split('\n')) {
    const sep = line.indexOf(' ')
    if (sep <= 0) continue
    const syllable = line.slice(0, sep)
    const chars = line.slice(sep + 1)
    for (const ch of chars) {
      const list = table.get(ch)
      if (!list) table.set(ch, [syllable])
      else if (!list.includes(syllable)) list.push(syllable)
    }
  }
  syllableTable = table
  return table
}

function readingsOf(ch: string): string[] | undefined {
  return syllables().get(ch)
}

/**
 * 热词能否参与替换。
 *
 * 含英文、数字、符号的直接放弃（拼音对它们没有意义）；
 * 只要有一个字查不到读音就整条放弃 —— 缺一个字的读音，就判不了那一位
 * 到底算同音还是不同音，与其猜，不如不动。
 */
function usableTerm(word: string): boolean {
  if (Array.from(word).length < MIN_TERM_LEN) return false
  for (const ch of word) {
    if (!HAN.test(ch)) return false
    if (!readingsOf(ch)) return false
  }
  return true
}

function buildMatcher(terms: string[]): TermMatcher | null {
  const words = [...new Set(terms)].filter(usableTerm)
  if (words.length === 0) return null

  const lengths = [...new Set(words.map((w) => Array.from(w).length))].sort((a, b) => b - a)
  const bySyllable = new Map<string, string[]>()
  for (const word of words) {
    const first = readingsOf(word[0]) ?? []
    for (const syllable of first) {
      const list = bySyllable.get(syllable)
      if (!list) bySyllable.set(syllable, [word])
      else if (!list.includes(word)) list.push(word)
    }
  }
  return { lengths, bySyllable, literal: new Set(words) }
}

/** 两个片段是否「逐字同音、且至少一个字面相同」 */
function similarAt(chars: string[], start: number, word: string): boolean {
  const wordChars = Array.from(word)
  let anchor = 0
  for (let j = 0; j < wordChars.length; j++) {
    const mine = chars[start + j]
    const its = wordChars[j]
    if (mine === its) {
      anchor += 1
      continue
    }
    const a = readingsOf(mine)
    const b = readingsOf(its)
    if (!a || !b) return false
    if (!a.some((s) => b.includes(s))) return false
  }
  // 整段都不一样说明压根不是同一个词的误识，改它没有依据
  return anchor > 0
}

/** 在 start 处按长度 len 找一个能替换的热词；有歧义就返回 null */
function matchAt(
  chars: string[],
  start: number,
  len: number,
  matcher: TermMatcher,
): string | null {
  const end = start + len
  if (end > chars.length) return null
  for (let i = start; i < end; i++) {
    if (!HAN.test(chars[i])) return null
  }

  const slice = chars.slice(start, end).join('')
  // 原文本身就是某个热词，或者是内置词表里的常见词：这就是正确结果，
  // 不允许被别的词覆盖。后一条尤其关键，见文件头的规则 4。
  if (matcher.literal.has(slice) || commonSet().has(slice)) return null

  const firstReadings = readingsOf(chars[start]) ?? []
  let hit: string | null = null
  const seen = new Set<string>()

  for (const syllable of firstReadings) {
    for (const word of matcher.bySyllable.get(syllable) ?? []) {
      if (seen.has(word)) continue
      seen.add(word)
      if (Array.from(word).length !== len) continue
      if (word === slice) continue
      if (!similarAt(chars, start, word)) continue
      // 两个不同的热词都能对上 —— 没有任何依据二选一，原地不动
      if (hit !== null && hit !== word) return null
      hit = word
    }
  }
  return hit
}

/**
 * 把词表编译成一个「文本 → 文本」的函数。
 *
 * 对外暴露这个而不是直接暴露 matcher，是为了让单测能脱离分段结构验证规则。
 */
export function createTermFixer(
  terms: string[],
): (text: string) => { text: string; hits: TermFixHit[] } {
  const key = terms.join('\u0000')
  if (matcherCache?.key !== key) {
    matcherCache = { key, matcher: buildMatcher(terms) }
  }
  const matcher = matcherCache.matcher

  return (text: string) => {
    if (!matcher || !text) return { text, hits: [] }

    const chars = Array.from(text)
    const out: string[] = []
    const hits: TermFixHit[] = []
    let i = 0

    while (i < chars.length) {
      let replaced: string | null = null
      for (const len of matcher.lengths) {
        replaced = matchAt(chars, i, len, matcher)
        if (replaced) break
      }
      if (replaced) {
        hits.push({ from: chars.slice(i, i + replaced.length).join(''), to: replaced })
        out.push(replaced)
        i += Array.from(replaced).length
        continue
      }
      out.push(chars[i])
      i += 1
    }

    return { text: out.join(''), hits }
  }
}

/**
 * 对一批分段做同音纠正。
 *
 * 只改 `text`，不动 `origin` —— 识别流程最后会用 `alignOrigin` 把两者对齐，
 * 若在这里写 origin，编辑器会认为「这些条目被人改过」而挂上改动标记。
 */
export function applyTermFix(segments: SubtitleSegment[], terms: string[]): TermFixResult {
  if (terms.length === 0 || segments.length === 0) return { segments, hits: [] }

  const fixer = createTermFixer(terms)
  const hits: TermFixHit[] = []
  let changed = false

  const next = segments.map((seg) => {
    const result = fixer(seg.text)
    if (result.hits.length === 0) return seg
    changed = true
    hits.push(...result.hits)
    return { ...seg, text: result.text }
  })

  return { segments: changed ? next : segments, hits }
}

/**
 * 参与纠正的全量词表：手填热词 + 勾选词库的核心词与扩展词。
 *
 * **不受提示词预算约束** —— 提示词只能塞两百多个 token，剩下的词在这里
 * 才有机会发挥作用。`wrapWords` 不参与：那些是「这一代」「实际体验」之类的
 * 普通搭配，只用来决定断句切点，按它们改文本等于把正常的话改坏。
 */
export function collectFixTerms(rawTerms: string, lexiconIds: string[]): string[] {
  const out = splitTerms(rawTerms)
  const seen = new Set(out)
  for (const id of lexiconIds) {
    const lexicon = lexiconById(id)
    if (!lexicon) continue
    for (const word of [...lexicon.core, ...lexicon.extended]) {
      if (seen.has(word)) continue
      seen.add(word)
      out.push(word)
    }
  }
  return out
}
