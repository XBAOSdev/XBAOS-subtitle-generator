import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { ReasoningDepth } from '@/utils/reasoningDepth'
import type {
  ExportLangMode,
  GapFillOptions,
  InferenceBackend,
  LineEnding,
  OutputLocationMode,
  PunctuationOptions,
  SubtitleFormat,
  SubtitleViewMode,
  TextEncoding,
  ThemeMode,
} from '@/types'

/**
 * 键名带版本号，默认值有调整时就升一版，避免旧键里残留的老默认值
 * 把新默认值盖掉（改了默认值却看不到效果，踩过）。
 *   v2 —— 配色整体改为中性灰阶，清掉更早的 auto 主题残留；
 *   v3 —— 默认外观由深色改为浅色，默认推理深度由标准改为增强；
 *   v4 —— 默认外观改为「跟随系统」，默认推理深度保持增强。
 *   v5 —— 新增字幕规格（英文单行 / 单条时长）与自定义模型目录；
 *         中文单行上限默认 20 → 16（行业惯例 14~16 字）。
 *   v6 —— 单条最多行数默认 2 → 1（中文视频里单条两行很少见，双语字幕才用）。
 */
const STORAGE_KEY = 'xbaos.settings.v6'

export interface SettingsSnapshot {
  /** 主题 */
  themeMode: ThemeMode
  /**
   * 标题栏毛玻璃（Mica 材质）。默认开启；Win11 22H2 以下与浏览器预览
   * 等不支持的环境上主进程会判掉，界面自动回退纯色，无副作用。
   */
  glassEnabled: boolean
  /** 推理后端 */
  backend: InferenceBackend
  /**
   * 识别用的模型文件名（如 ggml-base.bin）。空串表示用默认的随包模型。
   * 模型管理页「切换使用」写入；识别时随请求传给主进程解析。
   */
  modelFile: string
  /** 识别语言，zh 表示简体中文 */
  language: string
  /** 是否自动检测语言 */
  autoDetectLanguage: boolean
  /** 热词提示，逗号或换行分隔 */
  promptTerms: string
  /**
   * 勾选的内置词库 id。与热词提示一起拼成提示词注入引擎，
   * 拼装规则见 utils/prompt.ts（优先级：热词 > 风格句 > 精选词 > 核心词 > 扩展词）
   */
  lexiconIds: string[]
  /** 推理深度：标准 / 增强 / 深度，决定识别遍数与温度阶梯 */
  reasoningDepth: ReasoningDepth
  /** 静音检测与长音频切分（显著减少缺句漏句） */
  vadEnabled: boolean
  /** 识别前电平归一化（低电平录音提升明显） */
  normalizeAudio: boolean
  /** 识别前高通滤波，切除 80Hz 以下低频噪声（哼声、风噪） */
  highPassFilter: boolean
  /**
   * 束搜索（仅「深度」推理档生效）：深度档自动改用束搜索解码，
   * 更准但更慢。标准 / 增强档不受影响。
   */
  beamSearch: boolean
  /**
   * 低置信度复核：识别完成后，对置信度偏低的片段换用更高束宽
   * 单独重识别一遍，新结果更可信时才替换。
   */
  lowConfRescue: boolean
  /**
   * VAD 场景预设开关。关闭时用引擎默认参数；
   * 开启时按所选场景（vadScene）的整组参数切分。
   */
  vadSceneEnabled: boolean
  /** 所选 VAD 场景预设 id，见 data/vadPresets.ts */
  vadScene: string
  /** 束搜索宽度，1 表示贪心解码 */
  beamSize: number
  /** 贪心采样的候选数 */
  bestOf: number
  /**
   * 停顿标点后处理。在识别结果进入编辑器之前执行：
   * 中文默认去掉停顿标点并按标点切分，西文默认原样保留。
   */
  punctuation: PunctuationOptions
  /** 填充空隙参数 */
  gapFill: GapFillOptions
  /* ---- 字幕规格：同时决定 AI 校对的提示词与导出时的自动折行 ---- */
  /** 中文单行最大字数 */
  maxCharsPerLine: number
  /** 英文单行最大字符数（含空格） */
  maxCharsPerLineEn: number
  /** 单条最多行数 */
  maxLinesPerSegment: number
  /** 单条时长上限（秒）。0 表示不限 */
  maxSegmentDuration: number
  /* ---- 模型存储 ---- */
  /** 自定义模型目录。空串表示用默认位置（userData/models） */
  modelsDir: string
  /* ---- 更新 ---- */
  /**
   * 启动时自动检查更新。这是软件除「下载模型」外唯一会联网的地方，
   * 关掉之后只能从关于页手动点「检查更新」。
   */
  checkUpdateOnStart: boolean
  /** 输出位置策略 */
  outputMode: OutputLocationMode
  /** 统一输出目录 */
  unifiedOutputDir: string
  /** 导出格式 */
  exportFormat: SubtitleFormat
  /** 导出编码 */
  exportEncoding: TextEncoding
  /** 换行符 */
  exportLineEnding: LineEnding
  /** 导出后打开所在文件夹 */
  openFolderAfterExport: boolean
  /* ---- 自定义替换词表 ---- */
  /**
   * 「错词=正词」的替换词表，多行文本，每行一条（`=` 或 `=>` 分隔，
   * `#` 开头为注释）。编辑器工具面板的「词表替换」按它批量纠错。
   * 格式与解析见 `utils/dictReplace.ts`。
   */
  dictReplacements: string
  /* ---- 多语言字幕 ---- */
  /**
   * 编辑器里字幕的显示方式（仅原文 / 双语 / 仅译文）。
   * 默认双语：没有译文时译文行根本不渲染，所以这个默认值等价于「有译文就显示」。
   */
  subtitleView: SubtitleViewMode
  /**
   * 当前工作语言（译文的目标语言码，如 `en`）。
   * 翻译完成后由辅助窗口写回；三态切换里的「仅译文」与译文行都按它取内容。
   */
  translationLang: string
  /**
   * 导出时一个文件里写哪几种语言（仅原文 / 双语 / 仅译文 / 分别导出）。
   *
   * 默认**双语**而不是「仅原文」是刻意的：没有译文的工程里双语会自动
   * 退化成纯原文（序列化层处理），所以这个默认值对不用翻译的用户毫无影响；
   * 而翻译过的用户直接得到中英对照，不必先发现「原来还有个选项没选」。
   */
  exportLangMode: ExportLangMode
  /** 双语导出时的行序：原文在上（默认）还是译文在上 */
  exportLangSourceFirst: boolean
}

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  // 默认跟随系统：不预设用户的昼夜习惯，交给系统主题；浅色与深色仍可手动固定
  themeMode: 'auto',
  // 毛玻璃默认开：支持的环境直接得到效果，不支持的环境自动回退，两边都无需用户操心
  glassEnabled: true,
  backend: 'auto',
  modelFile: '',
  language: 'zh',
  autoDetectLanguage: false,
  promptTerms: '',
  lexiconIds: [],
  // 默认增强档：多跑两遍换来的准确率提升对交付质量更关键，标准档仍可选
  reasoningDepth: 'enhanced',
  vadEnabled: true,
  normalizeAudio: true,
  highPassFilter: true,
  /*
   * 实验性识别增强三件套：场景切分 / 束搜索 / 低置信度复核。
   * 实测对部分音频反而降低识别质量（2026-10-11），代码保留但**默认关闭且 UI 隐藏**
   * —— load() 里会无视旧存档强制复位，保证没有入口能把它们打开。
   */
  beamSearch: false,
  lowConfRescue: false,
  vadSceneEnabled: false,
  vadScene: 'general',
  beamSize: 1,
  bestOf: 1,
  punctuation: {
    zh: 'strip-split',
    en: 'keep',
  },
  // 最长时长限制默认开启，上限 2 秒（可在设置中调整）
  gapFill: {
    thresholdSec: 2,
    keepGapSec: 0,
    limitEnabled: true,
    maxDurationSec: 2,
  },
  // 字幕规格：行业惯例中文单行 14~16 字、英文 38~42 字符。
  // 单条默认只排一行 —— 中文视频里单条出现两行的情况很少见（双语字幕除外），
  // 需要两行的用户在设置里自行上调即可。
  maxCharsPerLine: 16,
  maxCharsPerLineEn: 42,
  maxLinesPerSegment: 1,
  // 单条超过 7 秒就该考虑拆开；0 表示不限
  maxSegmentDuration: 7,
  // 空串 = 默认位置（userData/models），非空时新下载的模型存到这里
  modelsDir: '',
  // 启动时静默检查一次更新。默认开 —— 不然「有新版本」这件事用户永远不会知道。
  // 注意这是**纯新增字段**，load() 是 {...DEFAULT_SETTINGS, ...parsed} 合并的，
  // 旧键里没有它自然会落到这个默认值，所以不需要升 STORAGE_KEY。
  checkUpdateOnStart: true,
  outputMode: 'follow-source',
  unifiedOutputDir: '',
  exportFormat: 'srt',
  exportEncoding: 'utf-8',
  exportLineEnding: 'crlf',
  openFolderAfterExport: true,
  // 默认空词表。纯新增字段，load() 是 {...DEFAULT_SETTINGS, ...parsed} 合并的，
  // 旧键里没有它自然会落到这里，所以不需要升 STORAGE_KEY
  dictReplacements: '',
  // 以下也是纯新增字段，同样不需要升键
  subtitleView: 'bilingual',
  translationLang: '',
  exportLangMode: 'both',
  exportLangSourceFirst: true,
}

function load(): SettingsSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(DEFAULT_SETTINGS)
    const parsed = JSON.parse(raw) as Partial<SettingsSnapshot>
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      punctuation: { ...DEFAULT_SETTINGS.punctuation, ...(parsed.punctuation ?? {}) },
      gapFill: { ...DEFAULT_SETTINGS.gapFill, ...(parsed.gapFill ?? {}) },
    }
    /*
     * 实验性识别增强（场景切分 / 束搜索 / 低置信度复核 / 手动束宽）在 UI 上已隐藏，
     * **强制复位**而不是走默认合并：旧存档里可能留着 true / 5，一旦放行，
     * 隐藏后的用户既享受不到也关不掉。等这几项重新验证有效后再恢复。
     */
    merged.beamSearch = false
    merged.lowConfRescue = false
    merged.vadSceneEnabled = false
    merged.beamSize = 1
    merged.bestOf = 1
    return merged
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const initial = load()

  const themeMode = ref<ThemeMode>(initial.themeMode)
  const glassEnabled = ref(initial.glassEnabled)
  const backend = ref<InferenceBackend>(initial.backend)
  const modelFile = ref(initial.modelFile)
  const language = ref(initial.language)
  const autoDetectLanguage = ref(initial.autoDetectLanguage)
  const promptTerms = ref(initial.promptTerms)
  const lexiconIds = ref<string[]>([...initial.lexiconIds])
  const reasoningDepth = ref<ReasoningDepth>(initial.reasoningDepth)
  const vadEnabled = ref(initial.vadEnabled)
  const normalizeAudio = ref(initial.normalizeAudio)
  const highPassFilter = ref(initial.highPassFilter)
  const beamSearch = ref(initial.beamSearch)
  const lowConfRescue = ref(initial.lowConfRescue)
  const vadSceneEnabled = ref(initial.vadSceneEnabled)
  const vadScene = ref(initial.vadScene)
  const beamSize = ref(initial.beamSize)
  const bestOf = ref(initial.bestOf)
  const punctuation = ref<PunctuationOptions>({ ...initial.punctuation })
  const gapFill = ref<GapFillOptions>({ ...initial.gapFill })
  const maxCharsPerLine = ref(initial.maxCharsPerLine)
  const maxCharsPerLineEn = ref(initial.maxCharsPerLineEn)
  const maxLinesPerSegment = ref(initial.maxLinesPerSegment)
  const maxSegmentDuration = ref(initial.maxSegmentDuration)
  const modelsDir = ref(initial.modelsDir)
  const checkUpdateOnStart = ref(initial.checkUpdateOnStart)
  const outputMode = ref<OutputLocationMode>(initial.outputMode)
  const unifiedOutputDir = ref(initial.unifiedOutputDir)
  const exportFormat = ref<SubtitleFormat>(initial.exportFormat)
  const exportEncoding = ref<TextEncoding>(initial.exportEncoding)
  const exportLineEnding = ref<LineEnding>(initial.exportLineEnding)
  const openFolderAfterExport = ref(initial.openFolderAfterExport)
  const dictReplacements = ref(initial.dictReplacements)
  const subtitleView = ref<SubtitleViewMode>(initial.subtitleView)
  const translationLang = ref(initial.translationLang)
  const exportLangMode = ref<ExportLangMode>(initial.exportLangMode)
  const exportLangSourceFirst = ref(initial.exportLangSourceFirst)

  function snapshot(): SettingsSnapshot {
    return {
      themeMode: themeMode.value,
      glassEnabled: glassEnabled.value,
      backend: backend.value,
      modelFile: modelFile.value,
      language: language.value,
      autoDetectLanguage: autoDetectLanguage.value,
      promptTerms: promptTerms.value,
      lexiconIds: [...lexiconIds.value],
      reasoningDepth: reasoningDepth.value,
      vadEnabled: vadEnabled.value,
      normalizeAudio: normalizeAudio.value,
      highPassFilter: highPassFilter.value,
      beamSearch: beamSearch.value,
      lowConfRescue: lowConfRescue.value,
      vadSceneEnabled: vadSceneEnabled.value,
      vadScene: vadScene.value,
      beamSize: beamSize.value,
      bestOf: bestOf.value,
      punctuation: { ...punctuation.value },
      gapFill: { ...gapFill.value },
      maxCharsPerLine: maxCharsPerLine.value,
      maxCharsPerLineEn: maxCharsPerLineEn.value,
      maxLinesPerSegment: maxLinesPerSegment.value,
      maxSegmentDuration: maxSegmentDuration.value,
      modelsDir: modelsDir.value,
      checkUpdateOnStart: checkUpdateOnStart.value,
      outputMode: outputMode.value,
      unifiedOutputDir: unifiedOutputDir.value,
      exportFormat: exportFormat.value,
      exportEncoding: exportEncoding.value,
      exportLineEnding: exportLineEnding.value,
      openFolderAfterExport: openFolderAfterExport.value,
      dictReplacements: dictReplacements.value,
      subtitleView: subtitleView.value,
      translationLang: translationLang.value,
      exportLangMode: exportLangMode.value,
      exportLangSourceFirst: exportLangSourceFirst.value,
    }
  }

  /**
   * 把主题应用到根元素。auto 时不写属性，交给 CSS 媒体查询。
   *
   * 顺手把偏好同步给主进程一份 —— 首屏底色是**窗口创建时**画的，那时页面还没
   * 跑起来，主进程读不到 localStorage。它需要一个极小的副本才能知道
   * 「固定浅色的用户不该先看到一块深色底」。
   */
  function applyTheme(mode: ThemeMode): void {
    const root = document.documentElement
    if (mode === 'auto') root.removeAttribute('data-theme')
    else root.dataset.theme = mode
    try {
      window.xbaos?.theme?.persist(mode)
    } catch {
      /* 浏览器预览模式没有桥，忽略即可 */
    }
  }

  watch(
    snapshot,
    (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        /* 存储不可用时静默忽略 */
      }
    },
    { deep: true },
  )

  watch(themeMode, applyTheme, { immediate: true })

  /*
   * 毛玻璃开关。这里只把「用户想要什么」发给主进程（存副本 + 即时切材质），
   * 实际生不生效由主进程回推（`app:glass`）—— Win10 上开着也无效，
   * html 上的 `glass` 类只按回推的真实状态挂。
   * 首帧前的初始状态在 `main.ts` 里从启动参数拿，不经过这里。
   */
  watch(glassEnabled, (enabled) => {
    try {
      window.xbaos?.glass?.setEnabled(enabled)
    } catch {
      /* 浏览器预览模式没有桥，忽略即可 */
    }
  })
  try {
    window.xbaos?.glass?.onState?.(({ active }) => {
      document.documentElement.classList.toggle('glass', active)
    })
  } catch {
    /* 同上 */
  }

  function resetAll(): void {
    const d = structuredClone(DEFAULT_SETTINGS)
    themeMode.value = d.themeMode
    glassEnabled.value = d.glassEnabled
    backend.value = d.backend
    modelFile.value = d.modelFile
    language.value = d.language
    autoDetectLanguage.value = d.autoDetectLanguage
    promptTerms.value = d.promptTerms
    lexiconIds.value = [...d.lexiconIds]
    reasoningDepth.value = d.reasoningDepth
    vadEnabled.value = d.vadEnabled
    normalizeAudio.value = d.normalizeAudio
    highPassFilter.value = d.highPassFilter
    beamSearch.value = d.beamSearch
    lowConfRescue.value = d.lowConfRescue
    vadSceneEnabled.value = d.vadSceneEnabled
    vadScene.value = d.vadScene
    beamSize.value = d.beamSize
    bestOf.value = d.bestOf
    punctuation.value = { ...d.punctuation }
    gapFill.value = { ...d.gapFill }
    maxCharsPerLine.value = d.maxCharsPerLine
    maxCharsPerLineEn.value = d.maxCharsPerLineEn
    maxLinesPerSegment.value = d.maxLinesPerSegment
    maxSegmentDuration.value = d.maxSegmentDuration
    modelsDir.value = d.modelsDir
    checkUpdateOnStart.value = d.checkUpdateOnStart
    outputMode.value = d.outputMode
    unifiedOutputDir.value = d.unifiedOutputDir
    exportFormat.value = d.exportFormat
    exportEncoding.value = d.exportEncoding
    exportLineEnding.value = d.exportLineEnding
    openFolderAfterExport.value = d.openFolderAfterExport
    dictReplacements.value = d.dictReplacements
    subtitleView.value = d.subtitleView
    translationLang.value = d.translationLang
    exportLangMode.value = d.exportLangMode
    exportLangSourceFirst.value = d.exportLangSourceFirst
  }

  return {
    themeMode,
    glassEnabled,
    backend,
    modelFile,
    language,
    autoDetectLanguage,
    promptTerms,
    lexiconIds,
    reasoningDepth,
    vadEnabled,
    normalizeAudio,
    highPassFilter,
    beamSearch,
    lowConfRescue,
    vadSceneEnabled,
    vadScene,
    beamSize,
    bestOf,
    punctuation,
    gapFill,
    maxCharsPerLine,
    maxCharsPerLineEn,
    maxLinesPerSegment,
    maxSegmentDuration,
    modelsDir,
    checkUpdateOnStart,
    outputMode,
    unifiedOutputDir,
    exportFormat,
    exportEncoding,
    exportLineEnding,
    openFolderAfterExport,
    dictReplacements,
    subtitleView,
    translationLang,
    exportLangMode,
    exportLangSourceFirst,
    resetAll,
  }
})
