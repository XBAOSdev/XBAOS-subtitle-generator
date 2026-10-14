/**
 * 自定义替换词表。
 *
 * 与「查找替换」的区别：查找替换是一次一组词、临时输入；词表是一组
 * 「错词 → 正词」的长期配置（典型用法是把识别常错的人名、术语、同音字
 * 一次配好），编辑器里一键批量纠正，不用每次现敲。
 *
 * 存储形态是**多行文本**而不是结构化数组：词表条目通常只有几十条，
 * 用户直接在里面改字最顺手，也省掉一套增删改的列表 UI。解析失败的行
 * 直接跳过，不让一个手滑的字符把整张表废掉。
 *
 * 格式（每行一条，`=` 或 `=>` 均可，两侧空白会被去掉）：
 *     帐号=账号
 *     视屏 => 视频
 *     # 以井号开头的是注释，不参与替换
 */

export interface ReplaceRule {
  /** 匹配到的原文 */
  from: string
  /** 替换成的写法 */
  to: string
}

/** 分隔符：`=>` 优先于 `=`，避免把「a=>b」拆成「a」和「>b」 */
const SEPARATOR = /=>|=/

/**
 * 解析词表文本。
 *
 * @returns 可用的替换规则，顺序即应用顺序
 */
export function parseReplaceDict(text: string | undefined | null): ReplaceRule[] {
  if (!text) return []

  const rules: ReplaceRule[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = SEPARATOR.exec(line)
    if (!match) continue

    const from = line.slice(0, match.index).trim()
    const to = line.slice(match.index + match[0].length).trim()

    // 空的一端没有意义：`=xx` 会把空字符串换成 xx（对每个字符之间都成立），
    // `xx=` 则是删除，虽然合法但更像误输入，一并跳过
    if (!from || !to) continue
    // 同一条错词只认第一次出现，避免后一条把前一条覆盖得莫名其妙
    if (seen.has(from)) continue

    seen.add(from)
    rules.push({ from, to })
  }

  return rules
}

/** 对单条文本按词表依次替换 */
export function applyReplaceRules(text: string, rules: ReplaceRule[]): string {
  let out = text
  for (const rule of rules) {
    if (!out.includes(rule.from)) continue
    out = out.split(rule.from).join(rule.to)
  }
  return out
}
