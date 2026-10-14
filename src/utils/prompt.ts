/**
 * 提示词构建。
 *
 * whisper 的 initial_prompt 是「条件偏置」，不是强制替换：它能提高专有名词的
 * 出现概率，但预算很小（约 224 token，中文大致 1 字 1 token）。所以这里的核心
 * 不是「把词库塞进去」，而是：
 *
 *   1. 按优先级排序注入 —— 手填热词 > 词库风格句 > 两遍策略精选词 > 核心词 > 扩展词。
 *      注意力对靠前的内容更强，重要的必须放前面；
 *   2. 全程去重 —— 已出现过的词不再重复注入，一个字都不浪费；
 *   3. 预算守卫 —— 超出预算时按序截断并记录下来，界面可以提示用户；
 *   4. 两遍策略 —— 大词库只在「深度模式」下靠 pickPresentTerms 动态精选，
 *      只注入这段音频里真的出现过的词。
 */

import { LEXICONS, lexiconById } from '@/data/lexicons'

/**
 * 提示词预算（按汉字当量计）。
 * 引擎侧上限约 224 token，这里取 110 留足余量：提示词越长，
 * small 模型越容易陷入重复幻觉，且会挤占解码上下文。
 */
export const PROMPT_BUDGET_CHARS = 110

export interface PromptBuildOptions {
  /** 手填热词，逗号或换行分隔 */
  terms?: string
  /** 勾选的词库 id */
  lexiconIds?: string[]
  /** 两遍策略精选出的词（第一遍识别里确认出现过的），优先级高于核心词 */
  preferWords?: string[]
  /** 覆盖默认预算，测试用 */
  budget?: number
}

export interface PromptBuildResult {
  prompt: string
  /** 实际占用（汉字当量） */
  chars: number
  /** 实际注入的词（不含风格句） */
  usedTerms: string[]
  /** 被预算挡下的扩展词（正常现象：扩展词本来就靠深度模式精选） */
  dropped: string[]
  /** 被预算挡下的热词或核心词（这才是真正的「不够用」，界面要提示） */
  droppedCore: string[]
  /** 参与注入的词库 id */
  lexicons: string[]
  /** 是否发生了「核心词被截断」 */
  truncated: boolean
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 提示词开销估算：汉字算 1，其余可见字符算 0.5，分隔符不收费 */
export function promptCharCost(text: string): number {
  let cost = 0
  for (const ch of text) {
    if (CJK.test(ch)) cost += 1
    else if (/[\s、，,。.；;：:\-_/|]/.test(ch)) continue
    else cost += 0.5
  }
  return cost
}

/** 把「逗号 / 换行 / 分号」分隔的热词串拆成词条并去重 */
export function splitTerms(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[\s,，、;；\n\r\t]+/)) {
    const word = piece.trim()
    if (word && !out.includes(word)) out.push(word)
  }
  return out
}

/** 勾选词库的理论占用（核心词 + 风格句），界面上给用户看 */
export function estimateLexiconCost(lexiconIds: string[]): number {
  let cost = 0
  for (const id of lexiconIds) {
    const lex = lexiconById(id)
    if (!lex) continue
    cost += promptCharCost(lex.style)
    cost += promptCharCost(lex.core.join('、'))
  }
  return Math.round(cost * 10) / 10
}

/**
 * 构建提示词。
 * 返回的 prompt 为空串表示什么都不用注入（引擎会走无提示的默认路径）。
 */
export function buildPrompt(options: PromptBuildOptions = {}): PromptBuildResult {
  const budget = options.budget ?? PROMPT_BUDGET_CHARS
  const lexiconIds = options.lexiconIds ?? []
  const used: string[] = []
  const dropped: string[] = []
  const droppedCore: string[] = []
  const injected: string[] = []

  let chars = 0
  /** 尝试注入一段文本，预算不够就返回 false（不写进去） */
  const pushText = (text: string): boolean => {
    const trimmed = text.trim()
    if (!trimmed) return true
    const cost = promptCharCost(trimmed)
    if (chars + cost > budget) return false
    injected.push(trimmed)
    chars += cost
    return true
  }

  const seen = new Set<string>()
  const pushWord = (word: string, critical: boolean): void => {
    if (seen.has(word)) return
    if (!pushText(word)) {
      // critical 表示手填热词或核心词：被挡下才值得提示用户
      if (critical) droppedCore.push(word)
      else dropped.push(word)
      return
    }
    seen.add(word)
    used.push(word)
  }

  // 1. 手填热词：用户明确指定的，优先级最高，任何情况下都先满足
  const manual = splitTerms(options.terms ?? '')
  if (manual.length > 0) {
    const text = manual.join('、')
    if (!pushText(text)) {
      // 手填词本身就超预算：退化为逐个尽力注入，被挡下的要如实报告
      for (const word of manual) pushWord(word, true)
    } else {
      for (const word of manual) seen.add(word)
      used.push(...manual)
    }
  }

  const selected = lexiconIds
    .map((id) => lexiconById(id))
    .filter((lex): lex is NonNullable<typeof lex> => Boolean(lex))

  // 2. 风格描述句：一句自然语言比一串孤词更能定调，且开销小
  for (const lex of selected) pushText(lex.style)

  // 3. 两遍策略精选词（第一遍识别确认出现过的）
  for (const word of options.preferWords ?? []) pushWord(word, true)

  // 4. 核心词（恒定注入，被挡下要提示）
  for (const lex of selected) {
    for (const word of lex.core) pushWord(word, true)
  }

  // 5. 扩展词（预算还有余量才注入；被挡下属于正常，深度模式会按需精选）
  for (const lex of selected) {
    for (const word of lex.extended) pushWord(word, false)
  }

  // 提示词之间用顿号连接，但风格句自成一句，用句号断开
  const prompt = injected
    .map((text) => (/[。！？]$/.test(text) ? text : text))
    .join('、')
    .replace(/、([。！？])/g, '$1')

  return {
    prompt,
    chars: Math.round(chars * 10) / 10,
    usedTerms: used,
    dropped,
    droppedCore,
    lexicons: selected.map((lex) => lex.id),
    truncated: droppedCore.length > 0,
  }
}

/** 两个等长字符串是否只差一个字符（同音 / 形近误听的判定） */
function oneEditApart(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diff++
      if (diff > 1) return false
    }
  }
  return diff === 1
}

/**
 * 两遍策略的词条精选：从词库里挑出「这段音频里真的出现过」的词。
 *
 * 第一遍识别先不带词库跑，然后用这里的结果作为第二遍的提示词。
 * 好处是 token 全花在刀刃上（通常只要 10~30 个词），也避免大词库撑爆预算。
 *
 * 精确子串命中优先；对长度 ≥3 的词额外做一次「允许一个字符不同」的模糊匹配，
 * 用来捞回「模型已经错了一个字」的那些词（这恰恰是最需要提示的词）。
 */
export function pickPresentTerms(text: string, lexiconIds: string[], maxTerms = 30): string[] {
  if (!text) return []
  const candidates: string[] = []
  for (const id of lexiconIds) {
    const lex = lexiconById(id)
    if (!lex) continue
    // 长词信息量大，优先考虑
    const words = [...lex.core, ...lex.extended].sort((a, b) => b.length - a.length)
    for (const word of words) if (!candidates.includes(word)) candidates.push(word)
  }

  const hits: { word: string; score: number }[] = []
  for (const word of candidates) {
    if (text.includes(word)) {
      hits.push({ word, score: 2 + word.length })
      continue
    }
    if (word.length >= 3) {
      let fuzzy = false
      for (let i = 0; i + word.length <= text.length; i++) {
        if (oneEditApart(text.slice(i, i + word.length), word)) {
          fuzzy = true
          break
        }
      }
      if (fuzzy) hits.push({ word, score: 1 + word.length })
    } else if (word.length === 2) {
      // 双字词只做「首字相同 + 第二字不同」的锚定匹配。
      // 不加锚点的话任意双字组合都能碰上一个编辑距离为 1 的词，
      // 会把大量无关词拉进提示词、白占预算。
      let fuzzy = false
      for (let i = 0; i + 2 <= text.length; i++) {
        if (text[i] === word[0] && text[i + 1] !== word[1] && !/[，。、！？\s]/.test(text[i + 1])) {
          fuzzy = true
          break
        }
      }
      if (fuzzy) hits.push({ word, score: 1 + word.length })
    }
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, maxTerms).map((h) => h.word)
}

/** 全部内置词库的核心词总量，用于界面提示 */
export function totalCoreWords(): number {
  return LEXICONS.reduce((sum, lex) => sum + lex.core.length, 0)
}
