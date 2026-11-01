/**
 * 断句词表合成。
 *
 * 折行要知道「哪几个字是一个词」，才有办法把切点放在词边界上。这个词表由
 * 三层来源合并而成，**全部只用于断句，一条都不会进入识别提示词**：
 *
 *   ① `COMMON_WORDS`        —— 内置常用词，恒定生效
 *   ② 选中领域词库的词条     —— 只在该词库被勾选时生效（core / extended / wrapWords）
 *   ③ 领域词设置里的词       —— 用户在设置页手填的术语，恒定生效
 *
 * 第 ② 层刻意把 core / extended 也纳进来：那些专业术语正是最容易被横向切断的
 * 词（「固态硬盘」切成「固态硬 / 盘」）。反向不成立 —— 提示词只会读 core /
 * extended / style，wrapWords 与常用词库都进不去，所以往断句侧加词永远不会
 * 撑爆提示词预算。
 */

import { COMMON_WORDS } from '@/data/commonWords'
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

/**
 * 合成断句词表。
 *
 * @param lexiconIds 已勾选的领域词库 id
 * @param terms 设置页「领域词」里手填的词（空格 / 逗号 / 顿号分隔）
 */
export function buildWrapWords(lexiconIds: readonly string[], terms: string): string[] {
  const set = new Set<string>(COMMON_WORDS)

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

  return Array.from(set)
}
