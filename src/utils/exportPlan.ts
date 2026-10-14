/**
 * 导出规划：把「来源文件 + 导出选项」算成一份明确的输出清单。
 *
 * 抽成纯函数是为了能直接单测 —— 这里的规则已经不止是「起个文件名」了：
 * 一条来源可能要拆成两个文件、双语要换一种排序、缺译文要退回原文、
 * 语言后缀要按行业惯例摆到正确的位置上。这些判断散在组件的 computed 里
 * 就只能靠人眼看，出错了也说不清是哪儿错的。
 */

import type { ExportLangBundle, ExportLangMode, SubtitleSegment } from '@/types'
import {
  bundleLangTag,
  composeForExport,
  sourceLangTag,
  type SerializeOptions,
} from '@/utils/subtitle'

/** 一个来源（识别结果 / 字幕文件 / 合并产物） */
export interface PlanSource {
  /** 条目 id。合并产物用 `MERGED_FILE_ID` */
  id: string
  /** 清单里展示的来源名 */
  name: string
  /** 源文件所在目录（清单里作对照用） */
  dir: string
  /** 文件名模板里 `{原名}` 的取值（已去掉扩展名） */
  baseName: string
  /** 已由位置策略解析好的输出目录 */
  outputDir: string
  segments: SubtitleSegment[]
}

export interface ExportPlanOptions {
  langMode: ExportLangMode
  /** 双语时原文是否排在前面 */
  sourceFirst: boolean
  /** 识别语言（zh / en / auto / …） */
  sourceLanguage: string
  autoDetectLanguage: boolean
  /** 工作语言码。为空时按各文件自己的译文语言取 */
  preferredLang: string
  /** 文件名模板 */
  template: string
  /** 格式扩展名，不含点 */
  ext: string
  /** `{日期}` 的取值，形如 20261009 */
  date: string
}

/** 规划结果里的一项，也就是「会写出一个字幕文件」 */
export interface ExportPlanEntry {
  fileId: string
  sourceName: string
  sourceDir: string
  outputDir: string
  outputName: string
  /** 这个文件里装哪种语言组合 */
  bundle: ExportLangBundle
  /** `bundle` 为 both / translation 时的语言码 */
  lang: string
  /** 该文件缺译文的条数（退回原文顶上的那些） */
  missing: number
  /** 实际写出去的条数 */
  lineCount: number
  /**
   * 是不是同一条来源产出的第一个文件。
   *
   * 界面按「一个来源一行」给用户填输出目录，分别导出时同一条来源有两行，
   * 目录输入框只画在第一个上面 —— 两个框绑同一个值，打字时另一个会跟着动，
   * 看着像是出了 bug。
   */
  firstOfSource: boolean
}

/**
 * 这批条目里出现过的译文语言（有实际内容才算）。
 *
 * 「有键但值为空」不算 —— 用户清空一条译文时那个键还留着，把它当成
 * 一种语言会让导出对话框冒出一个空选项。
 */
export function translationLangsOf(segments: SubtitleSegment[]): string[] {
  const set = new Set<string>()
  for (const s of segments) {
    for (const [code, text] of Object.entries(s.translations ?? {})) {
      if ((text ?? '').trim() !== '') set.add(code)
    }
  }
  return [...set]
}

/**
 * 一个文件该用哪种译文语言。
 *
 * 优先工作语言；该文件里没有这个语言时退回它自己的第一种。
 *
 * 这条退回规则是为「同一个软件里先后做过两种语言的翻译」准备的：工作语言
 * 是全局的（上次翻译成日语就记着日语），若死守它，早先那个英文工程导出时
 * 会因为找不到日语译文而整体退回纯原文 —— 用户完全看不出为什么。
 */
export function pickTranslationLang(
  segments: SubtitleSegment[],
  preferred: string,
): string {
  const langs = translationLangsOf(segments)
  if (langs.length === 0) return ''
  if (preferred && langs.includes(preferred)) return preferred
  return langs[0]
}

function buildOutputName(
  template: string,
  baseName: string,
  index: number,
  date: string,
  tag: string,
  appendTag: boolean,
  ext: string,
): string {
  const name = template
    .replace(/\{原名\}/g, baseName)
    .replace(/\{序号\}/g, String(index + 1).padStart(2, '0'))
    .replace(/\{日期\}/g, date)
    .replace(/\{语言\}/g, tag)
  return `${name}${appendTag ? `.${tag}` : ''}.${ext}`
}

export function planExport(
  sources: PlanSource[],
  opts: ExportPlanOptions,
): ExportPlanEntry[] {
  const srcTag = sourceLangTag(opts.sourceLanguage, opts.autoDetectLanguage)
  /** 模板里已经写了 {语言} 就把位置交给用户，不再自动追加 */
  const userPlacedTag = opts.template.includes('{语言}')
  const out: ExportPlanEntry[] = []

  sources.forEach((source, index) => {
    const trLang = pickTranslationLang(source.segments, opts.preferredLang)

    // 一条译文都没有时，任何模式都退化成「只导原文」。
    // 这样「双语」在一份纯中文工程里得到的就是一份干净的中文字幕，
    // 而不是空文件，也不是顶着一个 .zh-en 后缀的怪名字。
    let bundles: { bundle: ExportLangBundle; lang: string }[]
    if (!trLang || opts.langMode === 'source') {
      bundles = [{ bundle: 'source', lang: '' }]
    } else if (opts.langMode === 'both') {
      bundles = [{ bundle: 'both', lang: trLang }]
    } else if (opts.langMode === 'translation') {
      bundles = [{ bundle: 'translation', lang: trLang }]
    } else {
      bundles = [
        { bundle: 'source', lang: '' },
        { bundle: 'translation', lang: trLang },
      ]
    }

    // 「一个来源拆成多个文件」或「文件里不止原文」时语言后缀是必需的：
    // 否则 a.srt 与 a.srt 撞名（只能靠 -2 兜着，看不出谁是谁），
    // 或者一份英文文件顶着个中文名字。
    const needsTag = bundles.length > 1 || bundles[0].bundle !== 'source'
    /** 已经写出过至少一个文件（决定目录输入框画在哪一行） */
    let pinned = false

    for (const item of bundles) {
      const serializeOpts: SerializeOptions = {
        lang: item.bundle,
        translationLang: item.lang,
        sourceFirst: opts.sourceFirst,
      }
      const composed = composeForExport(source.segments, serializeOpts)
      // 这个文件里一条都写不出来（例如只导译文、而所有译文都被清空了）
      // 就不要在清单里占一行，否则会导出一个 0 字节的文件
      if (composed.lines.length === 0) continue

      const tag = bundleLangTag(item.bundle, srcTag, trLang)
      out.push({
        fileId: source.id,
        sourceName: source.name,
        sourceDir: source.dir,
        outputDir: source.outputDir,
        outputName: buildOutputName(
          opts.template,
          source.baseName,
          index,
          opts.date,
          tag,
          needsTag && !userPlacedTag && tag !== '',
          opts.ext,
        ),
        bundle: item.bundle,
        lang: item.lang,
        missing: composed.missing,
        lineCount: composed.lines.length,
        firstOfSource: !pinned,
      })
      pinned = true
    }
  })

  return out
}
