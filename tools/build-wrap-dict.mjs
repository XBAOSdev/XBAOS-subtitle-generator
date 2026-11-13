/**
 * 生成 `src/data/wrapDict.ts`（断句用的通用词表）。
 *
 * 用法：
 *   node tools/build-wrap-dict.mjs <jieba.dict.utf8 的路径>
 *
 * 数据源是 jieba 的 `dict.txt`（cppjieba 仓库里叫 `dict/jieba.dict.utf8`，
 * 每行「词 词频 词性」）。**词表只在构建期读一次**，产物是仓库里的纯文本模块，
 * 运行时不依赖任何第三方包。
 *
 * 为什么要这张表：字幕按宽度折行时，中文没有词间空格可依赖，断点只能落在
 * 词边界上才不别扭。内置的 `commonWords.ts` 只有三千多词，剩下的大量切点
 * 拿不到任何词典证据，等于按字数瞎猜 —— 这是覆盖率问题，算法救不了。
 *
 * 裁剪规则（三条都是为了「宁可少收，不可收错」）：
 *   ① 剔除专名类词性 nr / nrt / nrfg / ns / nt / nz / eng / x / m / mq / url
 *      —— 既符合项目「不收品牌名、公司名、人名」的既有红线，也因为专名在
 *      通用口播里出现得少，收进来只会增加误伤。
 *   ② 只留 2–6 个汉字（与 `lineWrap.ts` 的 `MAX_WORD_ATOMS` 一致）。单字没有
 *      「内部」可言，再长的组合命中率低。
 *   ③ 按词频降序保留 `KEEP` 条。jieba 的词频是「越大越常用」，取前 7 万条
 *      已经覆盖到很生僻的词，再往下只剩古籍与方言。
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** 保留条数：覆盖率与产物体积的折中，见文件头注释 */
const KEEP = 70000
/** 最低词频，`KEEP` 截断后用它兜底，避免同频词被随意切开 */
const MIN_FREQ = 1

/** 专名与非常用类别（jieba 词性标注） */
const DROP_POS = new Set(['nr', 'nrt', 'nrfg', 'ns', 'nt', 'nz', 'eng', 'x', 'm', 'mq', 'url', 'w'])

const CJK_ONLY = /^[\u4e00-\u9fff]+$/

const source = process.argv[2]
if (!source) {
  console.error('用法: node tools/build-wrap-dict.mjs <jieba.dict.utf8>')
  process.exit(1)
}

const rows = readFileSync(source, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

const kept = []
for (const row of rows) {
  const [word, freqText, pos] = row.split(' ')
  if (!word || !CJK_ONLY.test(word)) continue
  if (DROP_POS.has(pos)) continue
  const len = [...word].length
  if (len < 2 || len > 6) continue
  const freq = Number.parseInt(freqText, 10)
  if (!Number.isFinite(freq) || freq < MIN_FREQ) continue
  kept.push({ word, freq })
}

// 同频词按拼音序兜底，保证同一份输入每次生成的结果一致（可 diff）
kept.sort((a, b) => (b.freq - a.freq) || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
const picked = kept.slice(0, KEEP)
const words = [...new Set(picked.map((k) => k.word))]

/*
 * 产物排成每行 24 个词：一行一条 diff，改动看得见。
 * 词之间用单空格分隔，读取端 `split(/\s+/)` 即可，不需要 JSON 的引号与逗号
 * （七万个词加引号会多出十几万字符）。
 */
const perLine = 24
const lines = []
for (let i = 0; i < words.length; i += perLine) {
  lines.push('  ' + words.slice(i, i + perLine).join(' ') + ' ')
}

const header = `/**
 * 断句通用词表（自动生成，请勿手工编辑）。
 *
 * 数据来源：jieba 分词词典 \`dict.txt\`（cppjieba 仓库 \`dict/jieba.dict.utf8\`，
 * 每行「词 词频 词性」，MIT 许可，见 \`licenses/THIRD-PARTY.md\`）。
 * 生成脚本：\`node tools/build-wrap-dict.mjs <jieba.dict.utf8>\`
 *
 * 只保留了**词**这一个层级的字符串与词频排序，不含任何释义、例句、标注体系；
 * 已剔除专名类词性（人名 / 地名 / 机构 / 其他专名 / 外文），符合项目「不收
 * 品牌名、公司名、人名」的红线。见 \`docs/DEVLOG.md\` 的「断句第二层」。
 *
 * 用途只有一个：给折行提供「这里是词边界」的证据。它**不进识别提示词**，
 * 不改变任何识别结果，也不参与纠错。
 *
 * 共 ${words.length} 条，按词频由高到低排列（顺序无实际作用，只方便人工抽查）。
 */

/** 空格分隔的词串；读取端用 \`split(/\\s+/)\` 拆开 */
export const WRAP_DICT_RAW = \`
`

const body = header + lines.join('\n') + '\n`.trim()\n'

const out = new URL('../src/data/wrapDict.ts', import.meta.url)
writeFileSync(out, body, 'utf8')

const bytes = Buffer.byteLength(body, 'utf8')
console.log(`源 ${rows.length} 行 → 可用 ${kept.length} 条 → 收录 ${words.length} 条`)
console.log(`产物 ${(bytes / 1024).toFixed(0)} KB（最低词频 ${picked[picked.length - 1]?.freq}）`)
