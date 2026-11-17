/**
 * 音频格式支持策略
 *
 * 一共两条解码路径，边界必须写清楚 —— 它同时决定了许可口径和报错文案：
 *
 *   1) **自带实现**（代码在本仓库里，均可免费商用）
 *      WAV / AIFF  dr_wav   MP3  dr_mp3   FLAC  dr_flac
 *      OGG Vorbis  stb_vorbis   Opus  libopus
 *
 *   2) **调用 Windows 自带的解码器**（Media Foundation）
 *      M4A / M4B / MP4 / M4V / MOV / AAC（ADTS）/ MKV
 *      本软件**不含这些容器里音轨的解码实现**：容器解析与音频解码都由系统
 *      MFT 完成，实现者与分发者都是微软。AAC 的专利义务落在「制造或销售 AAC
 *      产品」上，而这条路上本软件交付的是「调用操作系统的程序」，不是 AAC 实现。
 *      代价不在体积（系统组件不随包走），而在依赖：Windows N 版或精简镜像
 *      缺媒体功能时解不了，需要装「媒体功能包」。
 *
 *      视频容器一律**只读第一条音轨**，视频轨不解码 —— 也就不涉及视频编码许可。
 *      能否解出来取决于音轨编码是否为系统内置（AAC / MP3 / PCM / AC-3 / FLAC 可以，
 *      DTS / Opus / xHE-AAC 不行），解不了时会明确报错而不是给出错误字幕。
 *
 *      AVI 与 WebM 刻意留在「不支持」里：前者系统能解析容器、但纯音频 AVI 的
 *      取值始终验不通；后者音轨几乎都是 Opus / Vorbis，系统多半没有解码器。
 *      这两个都属于「宣布支持却常常解不出来」，不如提前说清。
 *
 * ⚠️「不支持」必须分清是哪一类原因，别一律写成「专利尚未到期」：
 *   1) 第三方专有编码，且没接系统解码器 —— WMA、AMR、DTS
 *   2) 专利已到期，只是还没接 —— AC-3、E-AC-3
 * 第 2 类不存在任何法律障碍，措辞上不能让它看起来像侵权风险。
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
  /*
   * 下面四个走系统解码器。`impl` 一栏故意写成「Windows 系统解码器」而不是某个库名：
   * 这一栏就是「谁在解」的答案，本软件没有可写的库名。
   */
  {
    ext: 'aac',
    label: 'AAC',
    supported: true,
    impl: 'Windows 系统解码器',
    note: '专利原因，AAC 由 Windows 解码，本软件不含实现',
  },
  {
    ext: 'm4a',
    label: 'M4A',
    supported: true,
    impl: 'Windows 系统解码器',
    note: '专利原因，基于 AAC 编码的 M4A 由 Windows 解码，本软件不含实现',
  },
  {
    ext: 'm4b',
    label: 'M4B',
    supported: true,
    impl: 'Windows 系统解码器',
    note: '有声书的 M4A 变体，同上',
  },
  {
    ext: 'mp4',
    label: 'MP4',
    supported: true,
    impl: 'Windows 系统解码器',
    note: '仅读取第一条音轨',
  },
  {
    ext: 'm4v',
    label: 'M4V',
    supported: true,
    impl: 'Windows 系统解码器',
    note: 'MP4 容器的变体，仅解码音轨',
  },
  {
    ext: 'mov',
    label: 'MOV',
    supported: true,
    impl: 'Windows 系统解码器',
    note: 'QuickTime 容器，仅解码音轨',
  },
  {
    ext: 'mkv',
    label: 'MKV',
    supported: true,
    impl: 'Windows 系统解码器',
    note: '仅支持 AAC / MP3 音轨',
  },
]

export const UNSUPPORTED_FORMATS: FormatSpec[] = [
  {
    ext: 'avi',
    label: 'AVI',
    supported: false,
    reason: '纯音频 AVI 的兼容性不稳定，暂不接入',
  },
  {
    ext: 'webm',
    label: 'WebM',
    supported: false,
    reason:
      'Windows 系统解码不支持 Opus/Vorbis',
  },
  {
    ext: 'wma',
    label: 'WMA',
    supported: false,
    reason: '微软专有编码，本软件尚未接入',
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
    reason: '专利已于 2017 年到期，但本软件尚未接入它的解码器',
  },
  {
    ext: 'eac3',
    label: 'EAC3',
    supported: false,
    reason: '专利已于 2026 年初到期，但本软件尚未接入它的解码器',
  },
  {
    ext: 'dts',
    label: 'DTS',
    supported: false,
    reason: '专有技术，专利保护期可能持续到 2040 年前后',
  },
]

/** 上传区展示用的支持格式标签（已去重） */
export const SUPPORTED_LABELS = ['MP3', 'WAV', 'FLAC', 'OGG', 'Opus', 'AIFF', 'M4A', 'AAC', 'MP4', 'MKV', 'MOV']

/** 可导入的字幕文件扩展名（ssa 是 ass 的旧名，一并接受） */
export const SUBTITLE_EXTS = ['srt', 'vtt', 'ass', 'ssa']

export function isSubtitleExt(ext: string): boolean {
  return SUBTITLE_EXTS.includes(ext.toLowerCase())
}

/** 上传区展示用的不支持格式标签（少量常用） */
export const UNSUPPORTED_LABELS = ['WMA', 'AMR', 'AC3', 'DTS', 'AVI', 'WebM']

/** 文件选择对话框的过滤器 */
export const FILE_DIALOG_FILTERS = [
  {
    name: '音频与视频文件',
    extensions: [
      'mp3',
      'wav',
      'flac',
      'ogg',
      'oga',
      'opus',
      'aif',
      'aiff',
      'm4a',
      'm4b',
      'aac',
      'mp4',
      'm4v',
      'mov',
      'mkv',
    ],
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
