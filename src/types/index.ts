/** 字幕识别与编辑相关的核心数据结构 */

/** 文件在识别流程中的状态 */
export type FileStatus =
  /** 排队中，尚未识别 */
  | 'queued'
  /** 正在解码或识别 */
  | 'processing'
  /** 识别完成，尚未人工查看 */
  | 'pending'
  /** 已查看并通过 */
  | 'reviewed'
  /** 已查看且有手工编辑 */
  | 'edited'
  /** 存在校验问题 */
  | 'issue'
  /** 识别失败 */
  | 'failed'
  /** 格式不支持，未进入队列 */
  | 'unsupported'

/** 校验问题级别 */
export type IssueLevel = 'error' | 'warning' | 'info'

export interface SegmentIssue {
  level: IssueLevel
  /** 机器可读的问题码，如 OVERLAP / TOO_SHORT / CPS_HIGH */
  code: string
  /** 面向用户的中文说明 */
  message: string
}

/** 一条字幕 */
export interface SubtitleSegment {
  id: string
  /** 起始时间，单位秒 */
  start: number
  /** 结束时间，单位秒 */
  end: number
  /** 当前文本 */
  text: string
  /**
   * 该条首次呈现给用户时的文本，用于判断是否被人工改过。
   * 标点后处理的结果也算「原始文本」—— 用户看到的基线就是它。
   */
  origin: string
  /** 校验问题 */
  issues: SegmentIssue[]
  /**
   * 平均对数概率，越接近 0 置信度越高。人工新增/合并的条目没有这个值。
   * 引擎侧由 token 概率的几何平均算出。
   */
  avgLogprob?: number
  /**
   * 各语言译文：语言码 → 文本。
   *
   * 刻意做成「多语言映射」而不是单一的 `textAlt`：成本几乎为零（空对象不占
   * 什么），却省掉了将来加第三种语言时的数据迁移。**时间轴只有一份**（就是
   * 上面的 `start` / `end`），译文永远不可能与时间码脱钩 —— 这也是它比
   * 「另开一条译文轨道」更稳的根本原因。
   */
  translations?: Record<string, string>
  /**
   * 需要人工确认的文本槽位（`'source'` 表示原文，其余是语言码）。
   *
   * 分割一条双语字幕时，只有光标所在的那一侧会被真正切开，**另一侧的内容是
   * 整段复制到两段上的** —— 它在新段里不再精确对应，必须人工拆分。这些槽位
   * 在界面上标红，直到该槽位的文本被改动（判定方式与原文的 `origin` 一致：
   * 真的改了才算，进去看一眼没改不算）。
   *
   * ⚠️ 这个标记**不进校验结果列表、也不进状态栏计数** —— 它是「待确认」而不
   * 是「错误」，让它去污染校验信息只会把真正的错误淹掉。
   */
  staleSlots?: string[]
  /**
   * 用户已经「忽略」了这一条的告警。
   *
   * 校验结论（`issues`）是自动重算的，用户没法把一条真的抹掉；而有些告警是
   * 有意为之的（艺术处理的长句、故意压着上一条的衔接）。没有出口的话，这些
   * 条目会永远标红、永远被计数，用久了只会让人对红色脱敏 —— 那才是真正
   * 危险的事。所以给一个「我看过了，别再提醒」的开关。
   *
   * 语义是**整条**：置位后这条上的校验告警与译文「待确认」标红一并隐藏，
   * 也不再计入错误 / 警告条数。它是一个编辑器侧的批注，不写进字幕文件、
   * 也不进 `segmentsSignature`（否则忽略一下就会冒出「有未保存的修改」）。
   */
  acked?: boolean
  /**
   * 该条目来自哪个源文件。**只有合并产物上的条目会有这个字段。**
   *
   * 合并时间轴是「各文件的字幕按顺序拼接」的派生结果，但它同时是可编辑的
   * （编辑器唯一入口、导出以它为准）。带上来源标记之后，队列变化时重新拼接
   * 才知道每一条原先属于哪个文件 —— 否则只能整体推倒重来，用户在这个视图里
   * 做过的修改会被无声地丢掉。
   */
  originFileId?: string
}

/** 一个音频文件及其识别结果 */
export interface AudioFile {
  id: string
  /** 文件名，含扩展名 */
  name: string
  /** 完整路径 */
  path: string
  /** 所在目录 */
  dir: string
  /** 扩展名，小写，不含点 */
  ext: string
  /** 字节数 */
  sizeBytes: number
  /** 时长，单位秒。未解码时为 null */
  durationSec: number | null
  /** 状态 */
  status: FileStatus
  /** 字幕条目 */
  segments: SubtitleSegment[]
  /** 失败原因或提示信息 */
  message?: string
  /**
   * 来源是字幕文件时记录原格式（srt / vtt / ass），
   * 「覆盖保存」按它序列化写回。音频识别的条目没有这个字段。
   */
  subtitleFormat?: SubtitleFormat
  /** 导入时检测到的源文件编码，覆盖保存时原样写回 */
  sourceEncoding?: TextEncoding
  /**
   * 演示数据标记。浏览器预览模式（?demo=1）下没有真实音频文件，
   * 波形用合成峰值代替，播放走模拟计时器。
   */
  demo?: boolean
  /**
   * 合并模式下的虚拟产物标记。它不是真实音频文件，而是一条把多个音频的
   * 字幕按导入顺序拼接起来的时间轴；`path` / `dir` 取自第一个参与合并的
   * 音频，仅用于导出时的落点推断。
   */
  merged?: boolean
  /**
   * 合并产物里各源文件的起始偏移（fileId → 秒）。
   *
   * 队列变化后重新拼接时靠它算出每个文件整体平移了多少：已经保留的条目
   * 按这个差值同步移动，而不需要重新从源文件生成（那会丢掉用户的编辑）。
   */
  mergedOffsets?: Record<string, number>
}

/** 波形峰值数据（引擎下发，已降采样） */
export interface AudioPeaks {
  /** 每秒的峰值采样数 */
  peaksPerSecond: number
  /** 峰值数组，取值 0–1 */
  data: number[]
  /** 总时长，单位秒 */
  durationSec: number
}

/**
 * 编辑器里字幕文本的显示方式。
 *
 * 纯视图状态：只影响看，不影响数据，也不影响导出（导出按对话框里选的走）。
 */
export type SubtitleViewMode =
  /** 只显示原文 */
  | 'source'
  /** 原文一行 + 译文一行 */
  | 'bilingual'
  /** 只显示译文 */
  | 'translation'

/**
 * 导出字幕时的语言维度。
 *
 * 一条字幕上挂着原文与若干语言译文（见 `SubtitleSegment.translations`），
 * 但导出的文件里究竟写哪几种语言，是导出那一刻才定的事 —— 同一个工程
 * 既可能想要纯中文字幕，也可能想要中英双语或单独的英文字幕。
 */
export type ExportLangMode =
  /** 只导原文 */
  | 'source'
  /** 双语：同一个字幕块里的两行，共用一个时间码 */
  | 'both'
  /** 只导译文 */
  | 'translation'
  /** 分别导出：原文与译文各写一个文件，用语言后缀命名 */
  | 'separate'

/**
 * 单个字幕文件内部的语言组合。
 *
 * 是 `ExportLangMode` 去掉 `separate` 的结果 —— `separate` 不是「一个文件
 * 里怎么排」，而是「拆成两个文件」，落不到单个文件上，所以序列化接口
 * 只认这个更窄的类型。
 */
export type ExportLangBundle = 'source' | 'both' | 'translation'

/** 批量处理模式 */
export type BatchMode =
  /** 多文件合并为一条时间轴，输出单个字幕 */
  | 'merge'
  /** 多文件独立处理，输出多个字幕 */
  | 'separate'

/** 推理后端 */
export type InferenceBackend = 'auto' | 'cpu' | 'vulkan'

/** 主题模式 */
export type ThemeMode = 'auto' | 'light' | 'dark'

/** 导出格式 */
export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'txt'

/** 文本编码 */
export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'gbk'

/** 换行符 */
export type LineEnding = 'crlf' | 'lf'

/** 输出位置策略 */
export type OutputLocationMode =
  /** 跟随音频文件所在目录 */
  | 'follow-source'
  /** 统一输出到指定目录 */
  | 'unified'
  /** 每个文件分别指定 */
  | 'per-file'

/** 填充空隙参数 */
export interface GapFillOptions {
  /** 超过此间隔视为有意停顿，不填充。单位秒 */
  thresholdSec: number
  /** 填充后保留的间隙，防止播放器边界闪烁。单位秒 */
  keepGapSec: number
  /** 是否启用单条最长时长限制 */
  limitEnabled: boolean
  /** 单条最长时长上限，单位秒。默认 2 秒 */
  maxDurationSec: number
}

/**
 * 停顿标点的处理方式。
 *
 * 中文字幕的惯例是不带标点，并且以标点为界把一句话拆成两条；
 * 西文字幕的惯例是原样保留标点。所以两者的默认值不同，各自可调。
 */
export type PunctuationMode =
  /** 原样保留，不做任何处理 */
  | 'keep'
  /** 只去掉起停顿作用的标点，不切分 */
  | 'strip'
  /** 去掉停顿标点，并以此为界切成多条 */
  | 'strip-split'

export interface PunctuationOptions {
  /** 含中日韩字符的条目 */
  zh: PunctuationMode
  /** 纯西文的条目 */
  en: PunctuationMode
}
