/**
 * 音频格式支持策略
 *
 * 只内置无需付费授权、可自由分发的解码实现：
 *   WAV / AIFF  dr_wav       MP3  dr_mp3       FLAC  dr_flac
 *   OGG Vorbis  stb_vorbis   Opus  libopus
 *
 * ⚠️「不支持」必须分清是哪一类原因，别一律写成「专利尚未到期」：
 *   1) 专利仍在保护期内 —— AAC / M4A / MP4、WMA、AMR、DTS
 *   2) 专利已到期，但本软件**尚未内置对应解码器** —— AC-3、E-AC-3
 * 第 2 类不存在任何法律障碍，只是还没做，措辞上不能让它看起来像侵权风险。
 *
 * 事实核对（2026-10-08 复查，原先写错过一次）：
 *   AC-3    最后一项专利 2017-03-20 到期（Dolby 在其 S-1 文件中声明相关专利
 *           于 2008~2017 年间陆续到期），目前可自由使用
 *   E-AC-3  最后一项专利 US7516064 于 2026-01-30 到期
 *   MP3     核心专利 2017-04-16 到期，Fraunhofer 已终止授权项目
 *   DTS     专有技术，部分专利保护期可能持续到 2040 年前后
 *
 * 另外注意口径：「核心专利到期」不等于「不存在任何相关专利」。所以支持格式的
 * 说明按各格式实际情况分别写，不统一写成「绝对无专利风险」那种兜不住的绝对话。
 */

export interface FormatSpec {
  ext: string
  label: string
  supported: boolean
  /** 不支持的格式：原因。支持的格式：说明 */
  reason?: string
  /** 支持格式：解码实现（表格里展示） */
  impl?: string
  /** 支持格式：专利状态说明 */
  note?: string
}

export const SUPPORTED_FORMATS: FormatSpec[] = [
  { ext: 'mp3', label: 'MP3', supported: true, impl: 'dr_mp3', note: '核心专利 2017 年到期' },
  { ext: 'wav', label: 'WAV', supported: true, impl: 'dr_wav', note: '容器格式，本身不涉及编码专利' },
  {
    ext: 'flac',
    label: 'FLAC',
    supported: true,
    impl: 'dr_flac',
    note: '完全开放，免专利费',
  },
  {
    ext: 'ogg',
    label: 'OGG',
    supported: true,
    impl: 'stb_vorbis',
    note: 'Vorbis 编码完全开放，免专利费',
  },
  {
    ext: 'oga',
    label: 'OGG',
    supported: true,
    impl: 'stb_vorbis',
    note: 'Vorbis 编码完全开放，免专利费',
  },
  {
    ext: 'opus',
    label: 'Opus',
    supported: true,
    impl: 'libopus',
    note: '完全开放，免专利费',
  },
  {
    ext: 'aif',
    label: 'AIFF',
    supported: true,
    impl: 'dr_wav',
    note: '容器格式，本身不涉及编码专利',
  },
  {
    ext: 'aiff',
    label: 'AIFF',
    supported: true,
    impl: 'dr_wav',
    note: '容器格式，本身不涉及编码专利',
  },
]

export const UNSUPPORTED_FORMATS: FormatSpec[] = [
  {
    ext: 'm4a',
    label: 'M4A',
    supported: false,
    reason: '音轨使用 AAC 编码，该编码的部分专利尚未到期',
  },
  {
    ext: 'aac',
    label: 'AAC',
    supported: false,
    reason: '该编码的部分专利尚未到期',
  },
  {
    ext: 'mp4',
    label: 'MP4',
    supported: false,
    reason: '音轨通常为 AAC 编码',
  },
  {
    ext: 'wma',
    label: 'WMA',
    supported: false,
    reason: '微软专有编解码器',
  },
  {
    ext: 'amr',
    label: 'AMR',
    supported: false,
    reason: '包含多项专利的语音编码标准',
  },
  {
    ext: 'awb',
    label: 'AMR-WB',
    supported: false,
    reason: '包含多项专利的语音编码标准',
  },
  {
    ext: 'ac3',
    label: 'AC3',
    supported: false,
    reason: '专利已于 2017 年到期，但本软件尚未内置它的解码器',
  },
  {
    ext: 'eac3',
    label: 'EAC3',
    supported: false,
    reason: '专利已于 2026 年初到期，但本软件尚未内置它的解码器',
  },
  {
    ext: 'dts',
    label: 'DTS',
    supported: false,
    reason: '专有技术，专利保护期可能持续到 2040 年前后',
  },
]

/** 上传区展示用的支持格式标签（已去重） */
export const SUPPORTED_LABELS = ['MP3', 'WAV', 'FLAC', 'OGG', 'Opus', 'AIFF']

/** 可导入的字幕文件扩展名（ssa 是 ass 的旧名，一并接受） */
export const SUBTITLE_EXTS = ['srt', 'vtt', 'ass', 'ssa']

export function isSubtitleExt(ext: string): boolean {
  return SUBTITLE_EXTS.includes(ext.toLowerCase())
}

/** 上传区展示用的不支持格式标签（少量常用） */
export const UNSUPPORTED_LABELS = ['M4A (AAC)', 'WMA', 'AMR', 'AC3']

/** 文件选择对话框的过滤器 */
export const FILE_DIALOG_FILTERS = [
  {
    name: '音频文件',
    extensions: ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff'],
  },
  {
    name: '所有文件',
    extensions: ['*'],
  },
]

/** 取扩展名，小写，不含点 */
export function extOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

/** 该文件名或扩展名是否受支持 */
export function isSupported(nameOrExt: string): boolean {
  const ext = nameOrExt.includes('.') ? extOf(nameOrExt) : nameOrExt.toLowerCase()
  return SUPPORTED_FORMATS.some((f) => f.ext === ext)
}

/** 查格式规格 */
export function formatSpecOf(nameOrExt: string): FormatSpec | undefined {
  const ext = nameOrExt.includes('.') ? extOf(nameOrExt) : nameOrExt.toLowerCase()
  return (
    SUPPORTED_FORMATS.find((f) => f.ext === ext) ??
    UNSUPPORTED_FORMATS.find((f) => f.ext === ext)
  )
}

/** 不支持格式的说明文本，找不到时给出通用原因 */
export function unsupportedReason(nameOrExt: string): string {
  return formatSpecOf(nameOrExt)?.reason ?? '本软件没有为它内置解码器'
}

/** 不支持格式的显示名，如 M4A */
export function unsupportedLabel(nameOrExt: string): string {
  const ext = nameOrExt.includes('.') ? extOf(nameOrExt) : nameOrExt.toLowerCase()
  return formatSpecOf(ext)?.label ?? ext.toUpperCase()
}
