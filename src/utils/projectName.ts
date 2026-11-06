/**
 * 项目命名与同名的判定。
 *
 * 这里的每一条都会变成磁盘上的文件名，所以规则必须集中在一处 —— 保存对话框
 * 的实时校验、写盘前的最后一道守、改名时的重名判断，三处读的必须是同一套
 * 函数，否则「对话框说可以、写盘却失败」这种事一定会出现。
 *
 * 全部是纯函数，能在 Node 里直接测。
 */

import { stemOf } from '@/utils/path'

/** 项目文件后缀，不带点 */
export const PROJECT_EXT = 'xbsgp'

/**
 * 项目名长度上限。
 *
 * 120 字符是给路径与后缀留余量的：Windows 单段文件名上限 255，
 * 项目名会变成 `<name>.xbsgp`，再留出 130 字符给目录路径。
 */
export const PROJECT_NAME_MAX = 120

/**
 * Windows 文件名里不能出现的字符：`\ / : * ? " < > |` 与控制字符。
 *
 * 只写成正则字面量而不做逐字符判断，是因为这套字符集是 Windows 的既定规则，
 * 不随产品变化；将来若要支持 Linux/macOS（那套只禁 `/` 与 NUL），
 * 收敛到这里改一处即可。
 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * 把名字里的非法字符替换成 `_`。
 *
 * 界面在输入时就要调它（边打边替换 + 轻提示），而不是等到保存才报错 ——
 * 用户打了十个字才发现整串不能用，那种体验会让人放弃改名。
 *
 * @returns `replaced` 为 true 表示确实动过，界面据此决定要不要提示
 */
export function sanitizeFileName(input: string): { value: string; replaced: boolean } {
  // 不用 `ILLEGAL_CHARS.test()` 先行判断：带 g 标志的正则每调一次都会推进
  // lastIndex，交替调用会得出一真一假。直接比替换前后的字符串最稳
  const stage1 = input.replace(ILLEGAL_CHARS, '_')
  // 结尾的点与空格在 Windows 上会被静默吞掉，导致「名字与文件名对不上」
  const stage2 = stage1.replace(/[. ]+$/, '')
  const value = stage2.length > PROJECT_NAME_MAX ? stage2.slice(0, PROJECT_NAME_MAX) : stage2
  return { value, replaced: value !== input }
}

/**
 * 项目默认名。
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 1 个子项目 | 该子项目名去扩展名 → `S03E12` |
 * | 多个子项目 | 第一个去扩展名 + ` 等` → `S03E12 等` |
 *
 * **去扩展名**的理由：项目名会变成磁盘文件名，留着 `.mp3` 会写出
 * `S03E12.mp3.xbsgp` 这种双重后缀，看起来像音频文件而不是工程。
 *
 * 只在建项目时算一次 —— 之后删掉第一个子项目、改子项目名，项目名都不再跟着变。
 */
export function defaultProjectName(itemNames: string[]): string {
  const first = itemNames[0]
  if (!first) return '未命名项目'
  // stemOf 收的是路径，这里传的是纯文件名，没有分隔符时它原样返回，行为一致
  const stem = stemOf(first).trim() || '未命名项目'
  return itemNames.length > 1 ? `${stem} 等` : stem
}

/** 项目名 → 磁盘文件名（后缀自动补，已经带了就不重复补） */
export function projectFileName(name: string): string {
  const clean = name.trim() || '未命名项目'
  return clean.toLowerCase().endsWith(`.${PROJECT_EXT}`) ? clean : `${clean}.${PROJECT_EXT}`
}

/** 是不是项目文件（按扩展名判断，不看内容） */
export function isProjectPath(p: string): boolean {
  return p.toLowerCase().endsWith(`.${PROJECT_EXT}`)
}

/**
 * 两个路径是否指向同一个文件。
 *
 * Windows 的文件系统不区分大小写，`D:\a\B.xbsgp` 与 `d:\A\b.xbsgp` 是同一个
 * 文件。重名判定如果按大小写敏感来比，会让用户在「只差一个字母大小写」时
 * 得到一个能点、但写盘必失败（或更糟：静默覆盖）的保存按钮。
 *
 * 分隔符也统一：`D:/A/x.xbsgp` 与 `D:\A\x.xbsgp` 是同一个。
 */
export function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  const norm = (p: string) => p.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
  return norm(a) === norm(b)
}
