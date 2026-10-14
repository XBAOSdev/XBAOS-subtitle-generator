/**
 * 识别引擎的通信协议类型。
 *
 * 与 `engine/README.md` 描述的行分隔 JSON 协议一一对应。
 * 引擎用 C++ 实现，这边是全手写的镜像 —— 改动协议时两边都要动。
 */

import type { InferenceBackend, PunctuationOptions, SubtitleSegment } from './index'

/** 引擎支持的推理后端清单，随编译配置变化 */
export type EngineBackendName = 'cpu' | 'vulkan'

// ------------------------------------------------------------------ 握手

export interface EnginePong {
  id: number
  type: 'pong'
  engine: string
  whisper: string
  backends: EngineBackendName[]
  modelLoaded: boolean
}

/** 引擎实际生效的后端。注意 'gpu' 是引擎侧的叫法，映射到界面统一显示为 Vulkan */
export type EngineActiveBackend = 'cpu' | 'gpu' | 'unknown'

// ---------------------------------------------------------------- 模型加载

export interface EngineLoaded {
  id: number
  type: 'loaded'
  /** 模型文件名，不含目录 */
  model: string
  backend: EngineActiveBackend
  /** 是否复用了已加载的模型（否则是本次新加载） */
  reused: boolean
  loadMs: number
}

/**
 * 后端回退通知。
 * 用户选了 Vulkan 但机器不支持（或驱动异常）时，引擎改走 CPU 并主动上报，
 * 界面必须提示 —— 否则用户会以为在用 GPU 加速。
 */
export interface EngineFallback {
  id: number | null
  type: 'fallback'
  from: string
  to: string
  reason: string
}

// ------------------------------------------------------------------ 识别

export interface EngineProgress {
  type: 'progress'
  /** 0–100 */
  percent: number
}

export interface EngineSegment {
  type: 'segment'
  /** 段序号，从 0 开始 */
  i: number
  /** 起始时间，秒 */
  start: number
  /** 结束时间，秒 */
  end: number
  text: string
  /** 该段是静音的概率，0–1。偏高说明这段可能是幻觉 */
  noSpeech: number
  /**
   * 平均对数概率，越接近 0 置信度越高。
   * 经验值：>-0.3 正常，-0.3 ~ -0.6 建议复核，< -0.6 基本是识别错误。
   * 注意 GPU（fp16）整体比 CPU（fp32）低 0.05–0.1，阈值判断要留余量。
   */
  avgLogprob: number
}

export interface EngineDone {
  id: number
  type: 'done'
  /** 共识别出多少段 */
  count: number
  /** 识别耗时，秒 */
  elapsed: number
  /** 音频时长，秒 */
  duration: number
  backend: EngineActiveBackend
  model: string
  /** 实际使用的语言，自动检测时是检测结果 */
  language: string
  /** 原始音频采样率 */
  sourceRate: number
  sourceChannels: number
  threads: number
  /** 静音切分后的识别块数（关掉 VAD 时为 1） */
  chunks?: number
  /** 被跨过的长静音段数 */
  skipped?: number
  /** 检测到的有效语音时长（秒） */
  speechSeconds?: number
  /** 全程平均对数概率，多遍识别打分用 */
  avgLogprob?: number
  /** 无语音段占比 0–1 */
  noSpeechRatio?: number
  /** 本次使用的采样温度 */
  temperature?: number
  /** 引擎给出的提醒（例如整段没人声） */
  warning?: string
}

/** 所有会终结一个请求的响应 */
export type EngineTerminalMessage =
  | EnginePong
  | EngineLoaded
  | EngineDone
  | { id: number; type: 'canceled' }
  | { id: number; type: 'error'; message: string }

/** 识别过程中可能流式收到的消息 */
export type EngineStreamMessage = EngineProgress | EngineSegment | EngineFallback

// ------------------------------------------------------- 渲染进程可见的封装

/** `engine:status` 的返回 */
export interface EngineStatusResult {
  ok: boolean
  backend?: EngineActiveBackend
  modelLoaded?: boolean
  backends?: EngineBackendName[]
  whisper?: string
  error?: string
}

/** `engine:transcribe` 返回 */
export interface TranscribeResult extends Partial<Omit<EngineDone, 'id' | 'type'>> {
  ok: boolean
  taskId: string
  /** 端到端耗时（含进程间往返），秒 */
  wallMs?: number
  canceled?: boolean
  message?: string
}

/** `engine:transcribe` 的入参 */
export interface TranscribeOptions {
  taskId?: string
  /** 音频文件绝对路径 */
  audio: string
  model?: string
  backend?: InferenceBackend
  /** 'auto' 或 ISO 639-1 语言码 */
  language?: string
  /** 热词提示（含内置词库拼出的提示词） */
  prompt?: string
  threads?: number
  translate?: boolean
  /**
   * 采样温度。多遍识别时每遍给一个略高的值以获得互补结果；
   * 0 表示默认的贪心解码（完全确定性，多跑几次结果一模一样）。
   */
  temperature?: number
  /** 束搜索宽度，>1 时启用（更准、更慢） */
  beamSize?: number
  /** 贪心采样的候选数，>1 时引擎内部多采样再挑最优 */
  bestOf?: number
  /** 静音检测与长音频切分（默认开） */
  vad?: boolean
  /** 识别前电平归一化（默认开） */
  normalize?: boolean
  /** 识别前高通滤波，切除 80Hz 以下低频噪声（默认开） */
  highPass?: boolean
  /**
   * VAD 切分参数（场景预设用）。只传需要覆盖的字段，
   * 未传的字段用引擎默认值。见 data/vadPresets.ts
   */
  vadOptions?: VadOptionsPayload
  /**
   * 只识别这些时间区间（秒），跳过 VAD。低置信度复核用：
   * 渲染层已经知道哪几秒不可信，直接把区间当刀口。
   */
  ranges?: { start: number; end: number }[]
}

/** VAD 切分参数（与引擎 vad.hpp 的 VadOptions 对应，均为可选字段） */
export interface VadOptionsPayload {
  /** 短于此的语音碎片丢弃（秒） */
  minSpeechSec?: number
  /** 短于此的间隔视为句内停顿合并（秒） */
  minSilenceSec?: number
  /** 长于此的静音直接跳过（秒） */
  longSilenceSec?: number
  /** 噪声底取 RMS 的百分位（0-1） */
  noisePercentile?: number
  /** 起判倍数 */
  startFactor?: number
  /** 判停倍数（必须不高于起判倍数） */
  stopFactor?: number
  /** 单块目标时长（秒），8-28 */
  targetSec?: number
  /** 硬切时的重叠时长（秒） */
  overlapSec?: number
}

export interface EngineStreamEvent {
  /** null 表示全局消息（后端回退），不属于任何具体任务 */
  taskId: string | null
  msg: EngineStreamMessage
}

/** 引擎 stderr 日志 */
export interface EngineLogEvent {
  level: 'info' | 'warn' | 'error' | 'engine'
  text: string
}

export interface EngineExitEvent {
  code: number | null
  signal: string | null
  crashed: boolean
}

/** 主进程给出的引擎位置信息，用于「关于」页与故障排查 */
export interface EngineLocation {
  exe: string
  source: 'env' | 'packaged' | 'dev' | 'missing'
  available: boolean
}

/**
 * 模型文件的来源。
 *   custom  —— 用户在设置里指定的模型目录
 *   bundled —— 安装目录内的 models/，只读；正式包不放模型，留给用户手动放置
 *   user    —— 默认用户数据目录，用户自己下载或放置的
 *   env     —— 环境变量 XBAOS_MODELS_DIR 指定的调试目录
 *   dev     —— 开发态仓库内的 models/
 */
export type ModelSource = 'env' | 'custom' | 'user' | 'bundled' | 'dev'

export interface ModelFileInfo {
  /** 文件名，如 ggml-small.bin */
  name: string
  /** 绝对路径 */
  path: string
  /** 所在目录 */
  dir: string
  source: ModelSource
  /** 字节数 */
  size: number
}

/** `models.onProgress` 推送的下载事件 */
export interface ModelDownloadEvent {
  /** 对应模型管理页的条目 key */
  key: string
  status: 'start' | 'progress' | 'done' | 'error' | 'canceled'
  /** 已接收字节数 */
  received?: number
  /** 总字节数（服务器未给时为 0） */
  total?: number
  /** 0–100，total 未知时为 0 */
  percent?: number
  /** 完成时写入的路径 */
  dest?: string
  /** done 事件附带 already=true 表示该模型本来就存在 */
  already?: boolean
  message?: string
}

/** `app:info` 的返回 */
export interface AppInfo {  version: string
  platform: string
  arch: string
  isPackaged: boolean
  isDev: boolean
  electron: string
  chrome: string
  node: string
  theme: 'dark' | 'light'
  engine: EngineLocation
  /** 所有能找到的模型。同名只保留优先级最高的一份 */
  models: ModelFileInfo[]
  /** 全部模型查找目录（按优先级拼接），诊断「为什么没找到模型」时看这个 */
  modelsDir: string
  /** 默认模型的文件名 */
  defaultModel: string
  paths: {
    userData: string
    /** 用户模型目录，将来「下载模型」的落点 */
    downloadDir: string
    downloads: string
    documents: string
    home: string
    temp: string
  }
}

/** 主进程暴露给渲染进程的完整接口 */
export interface XbaosBridge {
  isElectron: true
  platform: string
  appVersion: string

  info: () => Promise<AppInfo>
  onThemeChange: (cb: (payload: { theme: 'dark' | 'light' }) => void) => () => void

  /**
   * 应用级行为。关窗确认走「主进程请求 → 渲染进程裁决」：判断有没有未保存的
   * 内容需要看数据，而数据在渲染进程里。主进程侧有看门狗兜底。
   */
  app: {
    /** 任务栏进度，0–1；-1 清除 */
    setProgress: (value: number) => void
    /** 长任务跑完时请求提醒。闪不闪由主进程判断（窗口在前台就不闪） */
    flash: () => void
    onCloseRequest: (cb: () => void) => () => void
    ackCloseRequest: () => void
    forceClose: () => void
  }

  theme: {
    /** 主进程预算的首屏主题，空串表示不确定（按系统走） */
    initial: string
    /** 把外观设置同步给主进程，供下次启动画首屏底色 */
    persist: (mode: 'auto' | 'light' | 'dark') => void
  }

  /** 标题栏毛玻璃（Mica）。浏览器预览模式下整个桥不存在 */
  glass: {
    /** 主进程按「用户偏好 + 系统是否支持」预算出的首屏状态 */
    initial: boolean
    /** 开关变化时同步给主进程：存副本 + 即时切换窗口材质 */
    setEnabled: (enabled: boolean) => void
    /** 主进程回推实际生效状态（不支持的环境上开关开着也是 false） */
    onState: (cb: (state: { active: boolean }) => void) => () => void
  }

  window: {
    control: (action: 'minimize' | 'maximize' | 'close') => void
    onStateChange: (cb: (state: { maximized: boolean; fullScreen: boolean }) => void) => () => void
  }

  /** 拖放文件取真实路径；浏览器环境下恒返回空串 */
  pathForFile: (file: File) => string

  dialog: {
    pickAudio: () => Promise<string[]>
    pickSubtitle: () => Promise<string[]>
    pickDirectory: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>
    saveSubtitle: (options?: {
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }) => Promise<string | null>
    /** 返回被点按钮的索引 */
    confirm: (options?: {
      type?: 'none' | 'info' | 'error' | 'question' | 'warning'
      title?: string
      message?: string
      detail?: string
      buttons?: string[]
      defaultId?: number
      cancelId?: number
    }) => Promise<number>
  }

  fs: {
    exists: (p: string) => Promise<boolean>
    stat: (p: string) => Promise<{
      ok: boolean
      size?: number
      mtimeMs?: number
      isFile?: boolean
      isDir?: boolean
      error?: string
    }>
    readText: (p: string) => Promise<string>
    /** 编码自适应读取（BOM / UTF-8 / GBK）。encoding 是实际使用的编码，覆盖保存时应原样写回 */
    readTextAuto: (p: string) => Promise<{ text: string; encoding: 'utf-8' | 'utf-8-bom' | 'gbk' }>
    /** 读取整个文件的二进制内容，用于音频解码与播放 */
    readArrayBuffer: (p: string) => Promise<ArrayBuffer>
    /** 返回真正写入的路径 */
    writeText: (p: string, content: string) => Promise<string>
    /**
     * 写字幕文件，支持编码与 BOM。返回真实写入的路径。
     * encoding 由设置面板选择；GBK 转换在主进程完成。
     */
    writeSubtitle: (
      p: string,
      content: string,
      encoding: 'utf-8' | 'utf-8-bom' | 'gbk',
    ) => Promise<string>
    reveal: (p: string) => Promise<void>
    openPath: (p: string) => Promise<string>
    basename: (p: string) => Promise<string>
    dirname: (p: string) => Promise<string>
  }

  clipboard: {
    write: (text: string) => Promise<boolean>
    /** 读取剪贴板文本。AI 校对用它接回用户从网页版复制的结果 */
    readText: () => Promise<string>
  }

  /**
   * AI 校对辅助窗口。
   *
   * 走「剪贴板中转」：软件本身不联网，提示词由用户手工粘贴到网页版 AI，
   * 结果再复制回来。主窗口与辅助窗口是两个渲染进程，数据只能经主进程中转。
   */
  assist: {
    /** 主窗口侧：带数据打开辅助窗口 */
    open: (payload: AssistReviewPayload) => Promise<{ ok: boolean }>
    /** 辅助窗口侧：取回主窗口交过来的数据 */
    payload: () => Promise<AssistReviewPayload | null>
    setAlwaysOnTop: (value: boolean) => Promise<boolean>
    isAlwaysOnTop: () => Promise<boolean>
    /** 辅助窗口侧：提交校对结果，由主进程转给主窗口执行覆盖 */
    submit: (payload: AssistSubmitPayload) => void
    /** 关闭辅助窗口 */
    close: () => void
    /** 主窗口侧：把被别的窗口盖住的辅助窗口重新拉到最前 */
    focus: () => Promise<{ ok: boolean }>
    /** 主窗口侧：接收校对结果 */
    onResult: (cb: (payload: AssistSubmitPayload) => void) => () => void
    /** 主窗口侧：辅助窗口已关闭（主界面据此解除压暗） */
    onClosed: (cb: (payload: boolean) => void) => () => void
    /** 辅助窗口侧：窗口被重复打开时重新取一次数据 */
    onRefresh: (cb: (payload: boolean) => void) => () => void
  }

  /**
   * 录制音频窗口。
   *
   * 采集（系统声音 / 麦克风 / Web Audio 混音 / WAV 编码）全在渲染进程里做，
   * 主进程只提供三件渲染进程做不到的事：开窗、关窗裁决、把 WAV 写到用户选的位置。
   *
   * **保存好的文件不能由录音窗口自己入队**：主窗口与录音窗口是两个渲染进程，
   * Pinia store 不共享 —— 在录音窗口里 `addFiles` 只会加进它自己那份空工程，
   * 窗口一关就没了。所以走 `submit()` 递给主进程、再由主窗口接收（`onSaved`）。
   */
  record: {
    /** 主窗口侧：打开录音窗口 */
    open: () => Promise<{ ok: boolean }>
    /** 主窗口侧：把被别的窗口盖住的录音窗口重新拉到最前 */
    focus: () => Promise<{ ok: boolean }>
    close: () => void
    /** 录音窗口侧：录制中或有未保存编辑时，让用户在原生确认框里裁决 */
    confirmDiscard: (options: { message?: string; detail?: string }) => Promise<boolean>
    onCloseRequest: (cb: () => void) => () => void
    ackCloseRequest: () => void
    forceClose: () => void
    /** 录音窗口侧：保存 WAV。返回落盘路径，用户取消时返回 null */
    save: (payload: { data: Uint8Array; defaultName?: string }) => Promise<string | null>
    /** 录音窗口侧：把落盘路径交给主进程转发给主窗口入队 */
    submit: (filePath: string) => void
    /** 主窗口侧：收到录音窗口保存的文件，入队 */
    onSaved: (cb: (filePath: string) => void) => () => void
    /** 主窗口侧：录音窗口已关闭（主界面据此解除压暗） */
    onClosed: (cb: (payload: boolean) => void) => () => void
  }

  /** 模型管理：真实下载（断点续传 + 镜像回退）、删除与进度事件 */
  models: {
    catalog: () => Promise<{ key: string; file: string; sizeLabel: string }[]>
    download: (key: string) => Promise<{ ok: boolean }>
    cancelDownload: (key: string) => Promise<{ ok: boolean }>
    remove: (fileName: string) => Promise<{ ok: boolean }>
    /** 当前模型存储位置 */
    getDir: () => Promise<{ dir: string; defaultDir: string; custom: string }>
    /** 设置自定义模型目录（主进程会真写一个探针文件验证可写）。传空串恢复默认 */
    setDir: (dir: string) => Promise<{ ok: boolean; dir?: string; message?: string }>
    /** 在系统文件管理器里打开模型文件夹 */
    openDir: () => Promise<{ ok: boolean; message?: string }>
    /**
     * 这次实际会用哪个模型。传设置里的文件名，失效时主进程会回退到
     * 任一已装模型并告诉你是谁 —— 界面据此标「使用中」，不要自己拿名字比。
     */
    resolve: (
      file: string,
    ) => Promise<{ name: string; path: string; source: string } | null>
    onProgress: (cb: (payload: ModelDownloadEvent) => void) => () => void
  }

  /**
   * 更新检查。**只检查，不下载不安装** —— 主进程读一份 JSON 清单回来比版本号，
   * 剩下的交给界面提示，用户自己去官网下载。
   */
  update: {
    /** 读清单并比版本。永不 reject，失败信息在返回值里（见 UpdateCheckResult） */
    check: () => Promise<UpdateCheckResult>
    /** 用系统默认浏览器打开外部链接。只放行 https，其余一律拒绝 */
    openUrl: (url: string) => Promise<{ ok: boolean; message?: string }>
  }

  engine: {
    status: () => Promise<EngineStatusResult>
    load: (opts?: { model?: string; backend?: InferenceBackend }) => Promise<
      EngineLoaded & { ok: boolean; backend: EngineActiveBackend }
    >
    unload: () => Promise<{ ok: boolean }>
    transcribe: (opts: TranscribeOptions) => Promise<TranscribeResult>
    abort: () => Promise<{ ok: boolean }>
    onStream: (cb: (payload: EngineStreamEvent) => void) => () => void
    onLog: (cb: (payload: EngineLogEvent) => void) => () => void
    onExit: (cb: (payload: EngineExitEvent) => void) => () => void
  }
}

/** 一个待校对的文件 */
export interface AssistReviewTarget {
  /** 目标条目 id（可能是合并产物） */
  fileId: string
  fileName: string
  /** 时长（秒）：校验模型返回的时间码有没有跑飞，多文件时也用于提示词边界 */
  durationSec: number
  /** 已识别的条数，选择列表里展示 */
  segmentCount: number
  /** 待校对条目 */
  segments: SubtitleSegment[]
}

/**
 * 影响提示词措辞的设置快照。
 *
 * 提示词**不在主窗口构建** —— 用户要在辅助窗口第 1 步挑文件、贴文案，
 * 这些都决定提示词长什么样。所以只把「原料」送过去，现拼。
 */
export interface AssistReviewSettings {
  language: string
  autoDetectLanguage: boolean
  punctuation: PunctuationOptions
  maxCharsPerLine: number
  maxCharsPerLineEn: number
  maxLinesPerSegment: number
  maxSegmentDuration: number
  /** 手填热词（逗号或换行分隔） */
  promptTerms: string
  /** 勾选的词库 id，辅助窗口按字幕内容挑命中项 */
  lexiconIds: string[]
}

/**
 * 辅助窗口的任务类型。
 *
 * 校对与翻译共用同一个辅助窗口，因为两者的交互骨架完全一样（复制提示词 →
 * 粘贴结果 → 校验 → 回写），差别只在提示词措辞、校验规则与回写方式。
 * 再开一个窗口只会让「窗口管理、置顶、剪贴板中转」这些公共部分重复一遍。
 */
export type AssistTask = 'review' | 'translate'

/** 交给辅助窗口的数据（校对与翻译共用） */
export interface AssistReviewPayload {
  /** 可处理的文件。独立模式下可能是多个，合并模式下只有合并产物那一个 */
  targets: AssistReviewTarget[]
  settings: AssistReviewSettings
  /** 任务类型。缺省按 'review' 处理（老调用点不受影响） */
  task?: AssistTask
  /** 翻译的目标语言（自然语言，如「英语」）。task 为 translate 时有值 */
  targetLang?: string
}

/** 辅助窗口确认后回传给主窗口的结果 */
export interface AssistSubmitPayload {
  /** 回传任务类型，主窗口据此分派到「校对写回」还是「翻译写回」 */
  task?: AssistTask
  /** 翻译的目标语言码 */
  lang?: string
  /** 每个文件的结果，顺序与 payload.targets 中「被选中的」一致 */
  results: {
    fileId: string
    /** 校对结果：整条替换，时间码可重排 */
    cues?: { start: number; end: number; text: string }[]
    /** 翻译结果：按序号的译文，**不含时间码**，按位置贴回 */
    lines?: string[]
  }[]
}

// ---------------------------------------------------------------- 更新检查

/** 失败原因分类。界面按它决定显示 HTTP 三位码还是简短说明 */
export type UpdateFailReason = 'http' | 'network' | 'timeout' | 'format' | 'unknown'

/** 清单里的下载入口 */
export interface UpdateDownload {
  label: string
  url: string
}

/**
 * 更新检查的结果。
 *
 * `ok: false` 表示**没查到**（网络、HTTP、格式问题），不是「没有新版本」——
 * 后者是 `ok: true` 且 `state: 'latest'`。这个区分很重要：
 * 查不到时界面要显示原因，而不是假装「已是最新」。
 */
export interface UpdateCheckResult {
  ok: boolean
  state: 'latest' | 'update' | 'error'
  /** 本机版本 */
  current: string
  /* ---- ok: true ---- */
  /** 清单里的最新版本 */
  latest?: string
  /** 清单日期（优先 updated，退回 latest 那条发布的日期） */
  updated?: string
  /** 软件全名 */
  name?: string
  /** 官网地址。界面「前往官网更新」用它，缺失时退回内置品牌地址 */
  homepage?: string
  download?: UpdateDownload | null
  /* ---- ok: true 且 state: 'update' ---- */
  /** 一条概括 */
  highlight?: string
  /** 升级方式说明 */
  upgradeHint?: string
  /** 本次更新的条目，来自清单里 latest 对应的那条 releases */
  notes?: string[]
  /** 该条发布的标题 */
  releaseTitle?: string
  /* ---- ok: false ---- */
  reason?: UpdateFailReason
  /** HTTP 状态码。网络层失败（连不上、超时）时为 null */
  code?: number | null
  message?: string
}
