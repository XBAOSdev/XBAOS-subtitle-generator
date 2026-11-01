/**
 * AI 校对提示词的构建。
 *
 * 走的是「剪贴板中转」路线：软件不代用户发起请求，把提示词交给用户，
 * 由用户粘贴到任意网页版 AI 助手里，再把结果复制回来。
 * 因此这里的提示词可以写得比较充分 —— 不受本地模型上下文限制。
 *
 * 设计要点：
 *   - 指令写成「可以做的事 / 不能做的事 / 输出格式」三段，模型更容易照做；
 *   - 提示词**按本地设置动态生成** —— 标点处理方式、字幕规格、热词与词库、
 *     识别语言都会影响措辞。写死会自相矛盾：设置里明确「中文不要标点」，
 *     提示词却写着「补齐标点」，AI 就会拼命加标点（真踩过，用户报的）；
 *   - 允许大模型**重排**：删除无意义的重复句与错句、合并拆分的条目，
 *     并重新对齐时间码（本地识别确实会多出毫无意义的句子）；
 *   - 支持**一次校对多个文件**：每个文件单独成段、序号各自从 1 开始、
 *     时间码用文件内相对时间，段与段之间用 `【文件 k/N】文件名` 强分隔。
 *     不做全局时间轴 —— 那样模型偏 1 秒就会串到隔壁文件，容错太差；
 *   - 可选**原文案参考**，用来纠正同音字与专有名词；
 *   - 时间码合法性、文件分隔行是否保留，都不指望模型自律，
 *     回来之后由 llmResult 逐条校验。
 */

import type {
  PunctuationMode,
  PunctuationOptions,
  ScriptStrength,
  SubtitleSegment,
} from '@/types'
import { hasText } from '@/utils/segmentOps'
import { strengthOption } from '@/data/scriptStrength'
import { serializeSrt, srtTime } from '@/utils/subtitle'

/** 超过这个字符数就提示可能超出对话类模型的输入上限（不做分批，只提示） */
export const PROMPT_CHAR_WARN = 12000

/** 一个待校对的文件 */
export interface ReviewPromptTarget {
  fileName: string
  /** 该文件时长（秒）。多文件时用来告诉模型时间码的边界 */
  durationSec: number
  segments: SubtitleSegment[]
}

/** 影响提示词措辞的本地设置快照（从 settings store 抽出来，保持本模块是纯函数） */
export interface ReviewPromptOptions {
  /** 识别语言，zh 表示中文 */
  language: string
  /** 是否自动检测语言 */
  autoDetectLanguage: boolean
  /** 停顿标点处理方式 */
  punctuation: PunctuationOptions
  /** 中文单行最大字数 */
  maxCharsPerLine: number
  /** 英文单行最大字符数（含空格） */
  maxCharsPerLineEn: number
  /** 单条最多行数 */
  maxLinesPerSegment: number
  /** 单条时长上限（秒），0 表示不限 */
  maxSegmentDuration: number
  /** 专有名词（手填热词 + 词库里命中的术语），已去重 */
  terms?: string[]
  /** 原文案参考。调用方需先过相似度门槛，别把无关文案塞进来 */
  script?: string
  /** 原文案参考的强度，缺省按「平衡」（2）走 */
  scriptStrength?: ScriptStrength
}

export interface ReviewPromptInput {
  targets: ReviewPromptTarget[]
  options: ReviewPromptOptions
}

export interface ReviewPromptResult {
  prompt: string
  /** 提示词总字符数 */
  charCount: number
  /** 字幕正文的字符数 */
  bodyChars: number
  segmentCount: number
  fileCount: number
  /** 是否超过建议上限（界面上要提示用户换用支持长文本的服务） */
  overLimit: boolean
}

/** 只保留有内容的条目 —— 空条目塞进提示词只会浪费 token 并诱导模型填空 */
function usable(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments.filter(hasText)
}

/** 是否按「中文」措辞。自动检测时也按中文走 —— 用户是中文用户，中文措辞更贴合 */
function isChinese(options: ReviewPromptOptions): boolean {
  return options.autoDetectLanguage || options.language.startsWith('zh')
}

/**
 * 「可以做的事」里的标点那一条 —— 必须跟本地设置一致。
 * 这是用户明确报过的问题：设置是去标点，提示词却在要 AI 补标点。
 */
function punctuationClause(mode: PunctuationMode, zh: boolean): string {
  if (mode === 'keep') {
    return `补齐或修正标点符号，使其符合${zh ? '中文' : '该语言'}书写规范。`
  }
  const base =
    '在语义停顿处正确断句。涉及标点时不添加标点符号 —— 本软件的设置是去除停顿标点，' +
    '加上去也会被后续处理删掉，属于无效改动。'
  return mode === 'strip-split'
    ? `${base}如果一句话里包含两个停顿较久的短句，应当拆成两条，而不是用逗号连起来。`
    : base
}

/** 「不能做的事」里按标点设置追加的那一条 */
function punctuationBan(mode: PunctuationMode): string | null {
  return mode === 'keep' ? null : '不要给字幕添加任何标点符号（逗号、句号、问号、顿号等）。'
}

/** 【字幕规格】段落 —— 合并力度过大的问题就靠这里给边界 */
function specClause(options: ReviewPromptOptions): string {
  const lines = Math.max(1, options.maxLinesPerSegment)
  const zhLine = options.maxCharsPerLine
  const enLine = options.maxCharsPerLineEn
  // 混排取折中：1 个汉字约等于 2 个英文字符，所以落在「中文 2 倍」与「英文上限」之间
  const mixedLine = Math.round((zhLine * 2 + enLine) / 2)

  const rows = [
    `- 中文条目：每一行不超过 ${zhLine} 字，一条最多 ${lines} 行（即单条不超过 ${zhLine * lines} 字）。`,
    `- 英文条目：每一行不超过 ${enLine} 个字符（含空格），一条最多 ${lines} 行（即单条不超过 ${enLine * lines} 字符）。`,
    `- 中英混排：按「1 个汉字约等于 2 个字符」折算，每一行不超过 ${mixedLine} 当量。`,
  ]
  if (options.maxSegmentDuration > 0) {
    rows.push(`- 单条持续时间不超过 ${options.maxSegmentDuration} 秒。`)
  }
  rows.push(
    '- **合并条目时必须守住这些上限**：宁可不合并，也不要产出一条超长字幕。' +
      '原文本来就是两条的，只要各自读得通，就不要合并。',
  )
  return rows.join('\n')
}

/** 【输出格式】段落 */
function formatClause(multi: boolean, duration: string): string {
  const rows = [
    '- 只输出校对后的字幕正文，不要任何解释、说明、前言、结语。',
    '- 保持标准 SRT 格式：每一条为序号（从 1 开始连续递增）+ 换行 + 时间码' +
      '（形如 00:00:01,200 --> 00:00:03,800）+ 换行 + 文字，条目之间空一行。',
    '- 时间码要重新对齐：经过删除、合并、拆分之后，后一条的开始时间要顺延跟进，' +
      '不允许出现时间重叠、时间倒流。',
  ]
  if (multi) {
    rows.push(
      '- 输出必须按下面的分段结构组织，**原样保留每一个「【文件 k/N】文件名」行** ——' +
        '一个都不能少、不能改、不能删、不能合并。',
      '- 每个文件内部的时间码是它自己的**相对时间**，从 00:00:00 开始，不要跨文件累计。',
      '- 每个文件的序号各自从 1 开始。',
    )
  } else {
    rows.push(
      `- 全片总时长不要超过 ${duration}。如果某一条被删除，它占用的时间应并入相邻条目，不要留下空洞。`,
      '- 保留下来、位置未变的条目，时间码应尽量贴近原文对应的位置。',
    )
  }
  return rows.join('\n')
}

/** 【专有名词参照】段落 —— 没有词就不出现 */
function termsClause(terms: string[]): string | null {
  if (terms.length === 0) return null
  return [
    '【专有名词参照】',
    '下面这些是本段内容可能涉及的专有名词。识别结果里如果出现读音相近但写法不同的词，',
    '优先按这里的写法修正；不确定时保持原样，不要硬套。',
    terms.join('、'),
  ].join('\n')
}

/**
 * 【原文案参考】段落 —— 文案纠偏的核心，锚点那句比一长串规则更管用。
 *
 * 强度（`ScriptStrength`）改变的是**「文稿与识别结果不一致时谁说了算」**，
 * 而不是「要不要用文稿」。四档各有一套允许/不允许清单，末尾再用一句话钉住：
 * 模型对一长串并列规则记不住，但会照着最后那句总结的调子走。
 *
 * 三档共有的底线（哪一档都不许破）：时间码以识别结果为准、不按文稿重排条目、
 * 不越过【字幕规格】的长度上限。这三条写死在每档里，不指望模型自己推。
 */
function scriptClause(script: string, strength: ScriptStrength): string {
  const option = strengthOption(strength)

  const allow: Record<ScriptStrength, string[]> = {
    0: [
      '识别结果与文稿写法不同的地方，**一律以文稿为准**：同音字、专有名词、数字、词序、整句措辞都算在内。',
      '文稿里有、识别结果漏掉的字词，补回**对应的那一条**里（不要为此新建条目）。',
      '识别结果里多出来、而文稿里根本没有的内容，如果读起来像是识别噪声，可以删掉；' +
        '如果明显是朗读时临时加的口语，保留。',
    ],
    1: [
      '同一个位置对得上、只是用词有出入时，以文稿的用词为准（同音字、专有名词、数字、明显不同的措辞）。',
      '识别结果比文稿多出个别字、或语序略有出入时，按文稿收拢。',
    ],
    2: [
      '遇到识别结果与文稿「读音相同或相近、但写法不同」的地方，以文稿的写法为准' +
        '（主要用于修正同音字、专有名词、人名、数字）。',
      '识别结果与文稿在同一位置用词不同、但意思一致时，可以按文稿的用词修正。',
    ],
    3: [
      '只借用文稿里**专有名词的写法**（人名、品牌、产品名、术语、缩写、数字与单位）。',
      '识别结果把专有名词写错时，按文稿改回去。',
    ],
  }

  const forbid: Record<ScriptStrength, string[]> = {
    0: [
      '不要按文稿重排或合并条目 —— 条目结构仍以识别结果为基础。',
      '不要把文稿里的两句话硬塞进一条字幕，仍然要守住【字幕规格】的长度上限。',
      '不要按文稿的字数重新分配时间码：时间码一律以识别结果为准。',
    ],
    1: [
      '不要因为文稿里没写，就把朗读里确实说了的内容删掉。',
      '整句都与文稿对不上、而识别结果本身读得通的地方，保留识别结果。',
      '不要把文稿里有、但能看出没被朗读的段落补进字幕。',
      '不要按文稿重排或合并条目。',
    ],
    2: [
      '不要把文稿里有、但朗读中没有的内容补进字幕 —— 字幕必须对应实际说了什么。',
      '不要因为文稿里没写，就把朗读中确实说了的内容删掉。',
      '不要按文稿重排或合并条目，条目结构仍然以识别结果为基础。',
      '文稿与识别结果差异过大的地方（整句都不一样），说明那是朗读时的即兴发挥，' +
        '保持识别结果的原样，不要强行改成文稿的写法。',
    ],
    3: [
      '除专有名词外，不要用文稿替换识别结果的任何用词。',
      '不要因为文稿措辞不同就改写句子，哪怕你认为文稿写得更好。',
      '不要增删任何内容。',
      '不要按文稿重排或合并条目。',
    ],
  }

  return [
    '【原文案参考】',
    option.prompt,
    '',
    '允许你做：',
    ...allow[strength].map((s, i) => `${i + 1}. ${s}`),
    '',
    '不允许你做：',
    ...forbid[strength].map((s, i) => `${i + 1}. ${s}`),
    '',
    `一句话原则：${SUMMARY[strength]}`,
    '',
    '【原文案正文】',
    script.trim(),
  ].join('\n')
}

/** 每档的一句话总结 —— 模型对这一句的遵从度高于上面所有条目 */
const SUMMARY: Record<ScriptStrength, string> = {
  0: '文稿是标准答案，字幕要还原文稿，而不是还原识别结果。',
  1: '文稿定用词，朗读定内容。',
  2: '文稿用来纠正「写错的字」，不用来改变「说了什么」。',
  3: '只认专有名词，其余的都不动。',
}

/**
 * 构建校对提示词。
 *
 * @param input.targets 待校对的文件（合并模式下就一项，即合并产物）
 * @param input.options 影响措辞的本地设置
 */
export function buildReviewPrompt(input: ReviewPromptInput): ReviewPromptResult {
  const options = input.options
  const zh = isChinese(options)
  const multi = input.targets.length > 1
  const punctMode = zh ? options.punctuation.zh : options.punctuation.en

  const targets = input.targets.map((t) => ({
    fileName: t.fileName,
    durationSec: t.durationSec,
    segments: usable(t.segments),
  }))

  const segmentCount = targets.reduce((n, t) => n + t.segments.length, 0)

  // ---- 正文 ----
  const blocks: string[] = []
  if (multi) {
    targets.forEach((t, i) => {
      blocks.push(`【文件 ${i + 1}/${targets.length}】${t.fileName}`)
      blocks.push(serializeSrt(t.segments))
    })
  } else if (targets.length === 1) {
    blocks.push(serializeSrt(targets[0].segments))
  }
  const body = blocks.join('\n\n')

  // ---- 单文件才写得出「全片时长」 ----
  const single = targets.length === 1 ? targets[0] : null
  const lastSeg = single?.segments[single.segments.length - 1]
  const duration = lastSeg ? srtTime(lastSeg.end) : '00:00:00,000'

  const role =
    `你是一位专业的${zh ? '中文字幕' : '多语言字幕'}编辑。` +
    '下面是一段由语音识别自动生成的字幕，格式为 SRT，由「序号 / 时间码 / 文字」三部分构成。' +
    '识别结果可能存在这些问题：错别字与同音字错误、标点缺失或误用、断句不当、' +
    '数字与单位写法不统一、语气词与口头禅冗杂，以及识别产生的无意义重复句或整句错误。'

  const canDo = [
    '1. 修正错别字、同音字错误。需结合上下文判断，拿不准的保持原样。',
    `2. ${punctuationClause(punctMode, zh)}`,
    '3. 统一数字与单位的写法（例如「三十」根据语境写成「30」）。',
    '4. 删除完全没有意义的内容：识别造成的重复句、明显错误的句子、纯语气词的堆砌。',
    '5. 在不破坏原意的前提下，可以合并或拆分条目 —— 但必须严格守住下面的【字幕规格】上限。',
    '6. 在不改变原意的前提下，顺一顺明显的语病。',
  ]

  const cannotDo = [
    '不要改变原意，不要新增原文里没有的信息。',
    '不要把口语润色成书面语，保留原本的表达习惯，并统一使用**简体中文**输出。',
    '不要输出任何解释、说明、前言、结语。',
    '不要使用 Markdown 代码块包裹（不要输出反引号）。',
  ]
  const ban = punctuationBan(punctMode)
  if (ban) cannotDo.push(ban)

  const sections: string[] = [
    role,
    '',
    '请通读全文，做一次系统性校对与整理。',
    '',
    '【可以做的事】',
    canDo.join('\n'),
    '',
    '【不能做的事】',
    cannotDo.map((s) => `- ${s}`).join('\n'),
    '',
    '【字幕规格】',
    specClause(options),
    '',
  ]

  const terms = termsClause(options.terms ?? [])
  if (terms) sections.push(terms, '')

  if (options.script && options.script.trim()) {
    sections.push(scriptClause(options.script, options.scriptStrength ?? 2), '')
  }

  sections.push('【输出格式】', formatClause(multi, duration), '', '【待校对的字幕】', body)

  const prompt = sections.join('\n')

  return {
    prompt,
    charCount: prompt.length,
    bodyChars: body.length,
    segmentCount,
    fileCount: targets.length,
    overLimit: prompt.length > PROMPT_CHAR_WARN,
  }
}

/**
 * 提示词正文的字符数换算成大概的 token 量，仅用于界面提示。
 * 中文约 1 字 1 token，英文约 4 字符 1 token，这里按偏保守的 1.6 字符/token 估。
 */
export function estimatePromptTokens(charCount: number): number {
  return Math.round(charCount / 1.6)
}

/* ------------------------------------------------------------------ 翻译 */

export interface TranslatePromptInput {
  /** 待翻译的文件（合并模式下就一项，即合并产物） */
  targets: ReviewPromptTarget[]
  /** 目标语言，用户填的自然语言（如「英语」「日语」「繁体中文」） */
  targetLang: string
}

/**
 * 翻译用的正文：**只有序号与文字，不带时间码**。
 *
 * 这是与校对最本质的一处区别。校对允许大模型重排，所以必须把时间码喂给它，
 * 回来才好对齐；翻译反过来 —— 时间码一旦出现在输入里，模型就有机会去"顺手
 * 修正"它，而译文根本不该改变时间轴。不给它，就断掉了这个念头。
 *
 * 每条的文本压成单行（把内部换行换成空格）：字幕规格的折行本来就由目标语言
 * 另行决定，保留原文的换行反而会让"一条一行"的输出格式变得不确定。
 */
function translateBody(segments: SubtitleSegment[]): string {
  return usable(segments)
    .map((s, i) => `${i + 1}. ${s.text.replace(/\s*\n\s*/g, ' ').trim()}`)
    .join('\n')
}

/**
 * 构建翻译提示词。
 *
 * 指令的核心只有一句：**条数必须 1:1，不许合并、拆分、增删**。其余都是围绕
 * 这句话的加固 —— 序号要保留、一条不要跨多行、不要输出时间码。
 */
export function buildTranslatePrompt(input: TranslatePromptInput): ReviewPromptResult {
  const targets = input.targets.map((t) => ({
    fileName: t.fileName,
    durationSec: t.durationSec,
    segments: usable(t.segments),
  }))

  const multi = targets.length > 1
  const segmentCount = targets.reduce((n, t) => n + t.segments.length, 0)
  const lang = input.targetLang.trim() || '英语'

  const blocks: string[] = []
  if (multi) {
    targets.forEach((t, i) => {
      blocks.push(`【文件 ${i + 1}/${targets.length}】${t.fileName}`)
      blocks.push(translateBody(t.segments))
    })
  } else if (targets.length === 1) {
    blocks.push(translateBody(targets[0].segments))
  }
  const body = blocks.join('\n\n')

  const must = [
    `一条原文对应一条译文，**条数必须与输入完全一致**（共 ${segmentCount} 条）—— 不允许合并、拆分、删除或新增任何一条。`,
    '每一行就是完整的一条，**不要一条跨多行**，也不要一行里塞两条。',
    '**断句位置必须与原文一致**：原文在哪一条断开，译文也在那一条断开。' +
      '不要为了凑成一个完整的句子而挪动条目的边界。',
    '序号原样保留，不要跳号，也不要重新编号。',
    '**不要输出时间码。**',
    `译文要符合${lang}字幕的惯用表达：口语、简洁，不要逐字直译。`,
    '专有名词、数字、单位，以及 [音乐]、[掌声] 这类方括号标记按目标语言的惯例处理，语义要保留。',
    '语气词与口头禅按目标语言的惯例取舍，该省则省，但不要把整条内容翻没了。',
    '不要输出任何解释、说明、前言、结语。',
    '不要使用 Markdown 代码块包裹（不要输出反引号）。',
  ]

  /*
   * 这一节是用户实测报上来的问题：整份英文译文里，**每一条都首字母大写、
   * 每一条结尾都有一个句点** —— 于是原本一句话被切成三段的字幕，读起来成了
   * 三个没头没尾的短句。
   *
   * 根因不在模型的翻译能力，在输入形态：喂进去的是「一条一行、彼此独立」的
   * 编号列表，模型自然按「每一行是一个完整句子」来处理。而字幕的断句是按停顿
   * 切的，一句话横跨三四条是常态。所以必须显式告诉它这件事，并且给出反例对照。
   */
  const crossLine = [
    '【断句与标点：最容易出错的地方】',
    '下面这些条目是语音识别按**停顿**切出来的，不是按句子切的。相邻的好几条往往属于同一句话。',
    '',
    '- 先按整段语义翻译，再按原文的断条位置切回同样条数。',
    '- 一句话没说完就结束的条目：结尾**不加任何句末标点**（句号、问号、感叹号），可以用逗号，也可以什么都不加。',
    '- 承接上一条继续的部分：**首字母小写**，不要在开头另起一个大写。',
    '- 只有这一条确实讲完了一整句时，才用句末标点，并把首字母大写。',
    '- 专有名词、语言名、人称代词 I 等按该语言规则该大写的，照常大写，不受上面限制。',
    '',
    '不要把每一条都翻成一个独立的完整句子 —— 那样每行看着都通顺，连起来却是断的。',
    '',
  ]

  const sections: string[] = [
    '你是一位专业的字幕翻译。下面是一份按序号排列的字幕文本（只有编号与文字，没有时间码）。',
    `请把它翻译成【${lang}】。`,
    '',
    '【必须遵守】',
    must.map((s) => `- ${s}`).join('\n'),
    '',
    ...crossLine,
  ]

  if (multi) {
    sections.push(
      `输入包含 ${targets.length} 个文件，用【文件 k/N】分隔。请在每个文件内**独立**按序号输出，` +
        '并把每一个【文件 k/N】行**原样保留**在输出里（含第一个）。',
      '',
    )
  }

  /*
   * 格式示例用目标语言的真实写法，而不是「第一句的译文」这种中文占位符：
   * 占位符看不出大小写与句末标点该怎么处理，而这两件事正是上面那一节要教的。
   * 示例是英语，别的语言按该语言的大写规则与句读替换即可（已在下面注明）。
   */
  const EXAMPLE = [
    '1. First, a quick question.',
    '2. How many MB is 1 GB?',
    '3. Many of you would say 1024 MB,',
    '4. but if we open the calculator on the computer,',
    '5. we will see that 1 GB is actually 1000 MB.',
  ]

  const formatRows: string[] = [
    '【输出格式】',
    '- 每条一行：**序号 + 一个英文句点 `.` + 一个空格 + 译文**。',
    '- 序号后面那个 `.` 是**序号分隔符**，不是句子的结束符 —— 不要在译文末尾重复加一个句点。',
    '',
    '下面用英语演示断句与大小写（其他语言按该语言的大写规则与句读处理，规则相同）：',
    ...EXAMPLE,
    '',
    '注意第 2 条以问号结尾是因为它本身就是一句话；而第 3、4 条结尾是逗号、第 4 条首字母小写，' +
      '因为它们都只是同一句话的一部分。同样的断句，如果翻成「每条一个句号」，读起来就会变成五个残句。',
    '',
  ]
  if (multi) {
    // 把分隔行直接摆进格式示例，而不是只在上面用文字要求 —— 模型很爱把
    // 输出开头的【文件 1/N】当成"标题"吞掉（用户实测踩到），示例里露过面它才照抄。
    formatRows.push(
      `每个文件前面写一行【文件 k/${targets.length}】文件名（k 从 1 开始），再跟这个文件的译文行。例如：`,
      `【文件 1/${targets.length}】xxx.mp3`,
      '1. Opening line of the first file.',
      '2. Second line of the same file,',
      '',
      `【文件 2/${targets.length}】yyy.mp3`,
      '1. Opening line of the second file.',
      '',
      '**输出的第一行就是【文件 1/N】那一行，前面不要有任何内容。**',
      '',
    )
  }
  formatRows.push(
    `只输出这些行，不要有其他内容。总条数必须等于输入（${segmentCount} 条）。`,
    '',
    '【待翻译的字幕】',
    body,
  )
  sections.push(...formatRows)

  const prompt = sections.join('\n')

  return {
    prompt,
    charCount: prompt.length,
    bodyChars: body.length,
    segmentCount,
    fileCount: targets.length,
    overLimit: prompt.length > PROMPT_CHAR_WARN,
  }
}
