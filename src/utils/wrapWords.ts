/**
 * 断句词表合成。
 *
 * 折行要知道「哪几个字是一个词」，才有办法把切点放在词边界上。这个词表由
 * 四层来源合并而成，**全部只用于断句，一条都不会进入识别提示词**：
 *
 *   ① `COMMON_WORDS`        —— 内置常用词（人工整理、按语类分组），恒定生效
 *   ② `WRAP_DICT_RAW`       —— 通用词表（jieba 词典裁剪 7 万条），恒定生效
 *   ③ 选中领域词库的词条     —— 只在该词库被勾选时生效（core / extended / wrapWords）
 *   ④ 领域词设置里的词       —— 用户在设置页手填的术语，恒定生效
 *
 * 第 ③ 层刻意把 core / extended 也纳进来：那些专业术语正是最容易被横向切断的
 * 词（「固态硬盘」切成「固态硬 / 盘」）。反向不成立 —— 提示词只会读 core /
 * extended / style，wrapWords 与两张通用词表都进不去，所以往断句侧加词永远不会
 * 撑爆提示词预算。
 *
 * ## 为什么要有第 ② 层（2026-11-13 加）
 *
 * 第一层（断点模型改成「约束 + 字典序 + 全局 DP」）做完之后，实测剩下三分之
 * 一的切点仍然拿不到任何词典证据 —— 全是没收录的词（大小 / 编码 / 整条 /
 * 临时目录）。语义单元是词，没有词边界就只能按宽度猜，这是覆盖率问题，
 * 算法再好也救不了。三千个词覆盖不了日常口播，七万条才够。
 *
 * 代价已实测（500 条/批）：建表 4ms、常驻堆 1.2MB、折行耗时无差异
 * （查询次数只与「每字最多 6 个长度窗口」有关，与词表大小无关）。
 *
 * ## 缓存
 *
 * 合并结果按「词库勾选 + 手填术语」做单槽缓存。识别一批字幕调一次，同一套
 * 设置在整场会话里不变 —— 每次重建一个七万元素的 Set 要 4ms 且毫无必要。
 * 返回的数组是**共享的只读数据**，调用方不得原地修改。
 */

import { COMMON_WORDS } from '@/data/commonWords'
import { WRAP_DICT_RAW } from '@/data/wrapDict'
import { lexiconById } from '@/data/lexicons'

/** 成词才需要保护，单字没有「内部」可言；超过 6 字的组合命中率低且容易误伤 */
const MIN_LEN = 2
const MAX_LEN = 6

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

function isUsableWord(word: string): boolean {
  const len = Array.from(word).length
  if (len < MIN_LEN || len > MAX_LEN) return false
  // 纯英文/数字由分词器整体持有，不需要词表保护
  return CJK.test(word)
}

/** 通用词表拆成数组：模块级只做一次，7 万个词 */
let dictWords: string[] | null = null
function wrapDict(): string[] {
  if (!dictWords) {
    dictWords = WRAP_DICT_RAW.split(/\s+/).filter(isUsableWord)
  }
  return dictWords
}

/** 不随词库勾选变化的那部分（常用词 + 通用词表），同样只合一次 */
let baseWords: string[] | null = null
function base(): string[] {
  if (!baseWords) {
    baseWords = [...new Set([...COMMON_WORDS, ...wrapDict()])].filter(isUsableWord)
  }
  return baseWords
}

/** 通用词表的条数（设置页要报数，不必自己去拆字符串） */
export function wrapDictSize(): number {
  return wrapDict().length
}

let cachedKey: string | null = null
let cachedWords: string[] = []

/**
 * 合成断句词表。
 *
 * @param lexiconIds 已勾选的领域词库 id
 * @param terms 设置页「领域词」里手填的词（空格 / 逗号 / 顿号分隔）
 */
export function buildWrapWords(lexiconIds: readonly string[], terms: string): string[] {
  /*
   * 缓存键用 `\u0000` 分隔：词库 id 与术语都不可能含这个字符，拼接不会撞车。
   * 只留一槽 —— 用户改设置后第一份结果就是新的，没有「回到上一个组合」的场景。
   */
  const key = `${lexiconIds.join('\u0001')}\u0000${terms}`
  if (key === cachedKey) return cachedWords

  const set = new Set(base())

  for (const id of lexiconIds) {
    const lexicon = lexiconById(id)
    if (!lexicon) continue
    for (const word of lexicon.core) {
      if (isUsableWord(word)) set.add(word)
    }
    for (const word of lexicon.extended) {
      if (isUsableWord(word)) set.add(word)
    }
    for (const word of lexicon.wrapWords ?? []) {
      if (isUsableWord(word)) set.add(word)
    }
  }

  for (const word of terms.split(/[\s,，、;；]+/)) {
    if (word && isUsableWord(word)) set.add(word)
  }

  cachedKey = key
  cachedWords = Array.from(set)
  return cachedWords
}
