import { defineStore } from 'pinia'
import { ref, watch, computed } from 'vue'
import type { ReasoningDepth } from '@/utils/reasoningDepth'
import type {
  ExportLangMode,
  GapFillOptions,
  InferenceBackend,
  LineEnding,
  OutputLocationMode,
  PunctuationOptions,
  ScriptStrength,
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
   * 标题栏毛玻璃（Acrylic 材质，不是 Mica）。默认开启；Win11 22H2 以下与浏览器预览
   * 等不支持的环境上主进程会判掉，界面自动回退纯色，无副作用。
   */
  glassEnabled: boolean
  /** 推理后端 */
  backend: InferenceBackend
  /**
   * 识别用的模型**标识**：文件型是文件名（ggml-base.bin），目录型是目录名
   * （sensevoice-small）。空串表示让主进程按兜底顺序自己挑一个。
   *
   * 字段沿用旧名字是为了不丢老用户的既有选择 —— 取值空间本来就是「一个字符串」，
   * 改名的收益抵不上迁移风险。架构不在这里记：那要读模型内容，由主进程判定
   * 并记住（见 electron/models.js）。
   *
   * 「使用中」的判定同样以主进程 `models:active` 的返回为准，不要拿这个字段
   * 自己比 —— 用户可能从软件外部删掉文件，这个字段不会跟着变。
   */
  modelFile: string
  /** 识别语言，zh 表示简体中文 */
  language: string
  /** 是否自动检测语言 */
  autoDetectLanguage: boolean
  /** 热词提示，逗号或换行分隔 */
  promptTerms: string
  /**
   * 识别完成后按热词做同音纠正（见 utils/termFix.ts）。
   *
   * 与提示词是两条独立通道：提示词有 200 多 token 的预算、且只对 whisper 有效；
   * 这一步在结果文本上跑，全量热词参与，两套架构都能用。
   * 只在「字数相同、读音一致、至少一个字面相同」时才动，且热词为空时完全不生效。
   */
  termFix: boolean
  /**
   * 说话人分离：识别完成后按音色判断「谁在什么时候说话」，给每条字幕打上说话人编号。
   *
   * 默认**关**。它与识别是两条独立流水线（同一份音频、两个随包小模型），
   * 开不开都不影响字幕本身，但会让每次识别多花约 8% 的时间，属于「需要的人
   * 才要」的能力，不该默认塞给所有人。
   *
   * 与识别模型架构无关：whisper 与 SenseVoice 识别的结果，用的是同一份分离结果。
   */
  speakerDiarization: boolean
  /**
   * 已知的说话人数。0 = 自动判断。
   *
   * 自动判断靠聚类阈值猜，人多了容易拆多、人少了容易合并；知道人数时直接填
   * 会让结果稳得多，所以把它做成设置项而不是藏起来。
   */
  speakerCount: number
  /** 导出字幕时给每条加上讲话人标签（默认不加，避免污染原始文本） */
  speakerPrefix: boolean
  /**
   * 用户是否**手动**改过「导出讲话人标签」。
   *
   * 没有这个标记，「按需默认勾上」和「记住用户的选择」就分不开：
   * 开了区分讲话人的用户，导出时理应默认带上标签；但要是把这份默认值
   * 当成用户的选择写回磁盘，下次他就再也关不掉了 —— 而且分不清
   * 「这是默认」还是「这是他选的」。
   *
   * 所以默认值的来源单独记一个标记：没动过就按需给默认，动过就听他的。
   * 纯新增字段，load() 合并即可，不需要升 STORAGE_KEY。
   */
  speakerPrefixUserSet: boolean
  /**
   * 讲话人称呼跨文件共用。
   *
   * 默认关：分离是对每份音频各跑一遍的，A 里的 0 号与 B 里的 0 号不必是同一个人。
   * 只有同一场录制被拆成多个文件时，把它们当成同一批人才对 —— 那种情况下
   * 开着它，改一次称呼所有文件一起变。
   *
   * 默认值**只由批量处理模式决定**：合并为一条时间轴时开启，独立处理时关闭；
   * 切换模式即重置（`project.setBatchMode`）。不落盘，见 `persist`。
   */
  speakerNamesShared: boolean
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
  /* ---- AI 辅助 ---- */
  /**
   * 「原文案参考」的强度，0 严格 → 3 宽松，默认 2（平衡）。
   * 没贴原文稿时它不起作用，所以不需要单独一个「启用」开关。
   * 分档语义见 `types/index.ts` 的 `ScriptStrength`。
   */
  aiScriptStrength: ScriptStrength
  /**
   * 编辑器页「AI 校对」按钮上方的引导气泡。这是**总开关**：
   * 关掉之后气泡永远不出现，用户想再看回来打开即可。
   */
  aiReviewTipEnabled: boolean
  /**
   * 用户点过气泡上的「不再提示」。
   *
   * 与上面的开关分开存，是因为两者语义不同：一个是「我现在不想看」，
   * 一个是「我永远不想看」。重新打开开关会把它一并复位 ——
   * 否则用户打开了开关却什么都看不到，只会以为功能坏了。
   */
  aiReviewTipDismissed: boolean
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
  // 默认开：热词为空时它完全不生效，填了热词才动手；误改可整份 Ctrl+Z 撤回
  termFix: true,
  // 默认关：分离是可选能力，多花约 8% 的识别时间，不该默认塞给所有人
  speakerDiarization: false,
  /** 0 = 自动判断人数（阈值 0.7）；填了人数就按它聚类 */
  speakerCount: 0,
  /** 默认不写前缀：字幕文本要保持干净，需要的人自己开 */
  speakerPrefix: false,
  /** 用户还没手动改过上面那项，默认值可以随「区分讲话人」按需给 */
  speakerPrefixUserSet: false,
  /** 默认每个文件各自一套称呼；只有合并成一条时间轴时由模式自动打开 */
  speakerNamesShared: false,
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
  // AI 辅助同样是纯新增字段，不需要升键
  // 默认「平衡」：只借文稿纠同音字与专名，是四档里最不容易把字幕改坏的
  aiScriptStrength: 2,
  aiReviewTipEnabled: true,
  aiReviewTipDismissed: false,
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
    /*
     * 启动时批量模式恒为「独立处理」，所以「共用一套称呼」必须是关的。
     * 旧存档里可能留着 true（上一版在合并模式下被自动打开后写进了盘），
     * 放行就会看到「独立处理却共用一套称呼」—— 勾选框自己勾着，用户没点过。
     */
    merged.speakerNamesShared = false
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
  const termFix = ref(initial.termFix)
  const speakerDiarization = ref(initial.speakerDiarization)
  const speakerCount = ref(initial.speakerCount)
  const speakerPrefix = ref(initial.speakerPrefix)
  const speakerPrefixUserSet = ref(initial.speakerPrefixUserSet)
  const speakerNamesShared = ref(initial.speakerNamesShared)

  /**
   * 导出时**实际生效**的「写讲话人标签」。
   *
   * 用户手动改过就听他的；没改过、但开了「区分不同的讲话人」，就默认带上 ——
   * 分离出来的标签不写进字幕等于白分离。
   *
   * 这份「实际生效值」是唯一口径：导出弹窗的勾选、导出的内容、
   * 就地保存的内容都读它。三处各判一次迟早会打架（导出带标签、
   * 按一次保存就把标签抹掉）。
   */
  const speakerPrefixEffective = computed(() =>
    speakerPrefixUserSet.value
      ? speakerPrefix.value
      : speakerPrefix.value || speakerDiarization.value,
  )
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
  const aiScriptStrength = ref<ScriptStrength>(initial.aiScriptStrength)
  const aiReviewTipEnabled = ref(initial.aiReviewTipEnabled)
  const aiReviewTipDismissed = ref(initial.aiReviewTipDismissed)

  function snapshot(): SettingsSnapshot {
    return {
      themeMode: themeMode.value,
      glassEnabled: glassEnabled.value,
      backend: backend.value,
      modelFile: modelFile.value,
      language: language.value,
      autoDetectLanguage: autoDetectLanguage.value,
      promptTerms: promptTerms.value,
      termFix: termFix.value,
      speakerDiarization: speakerDiarization.value,
      speakerCount: speakerCount.value,
      speakerPrefix: speakerPrefix.value,
      speakerPrefixUserSet: speakerPrefixUserSet.value,
      /**
       * **不落盘**：启动时批量模式恒为「独立处理」，这个开关的默认值由模式给，
       * 存下来只会在下次启动时留下一个「独立处理却共用一套称呼」的状态。
       * 已踩过：在合并模式下被自动打开 → 写盘 → 重启后勾选框还是勾着的。
       */
      speakerNamesShared: false,
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
      aiScriptStrength: aiScriptStrength.value,
      aiReviewTipEnabled: aiReviewTipEnabled.value,
      aiReviewTipDismissed: aiReviewTipDismissed.value,
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
   * 重新打开「AI 校对引导」时，把「不再提示」一并复位。
   *
   * 这两件事看起来是一件，其实不是：开关是「这个功能我关掉了」，
   * 不再提示是「我永远不想看」。如果只改开关不动标记，用户打开开关后
   * 依然什么都看不到 —— 那是标准的「设置了没用」。
   */
  watch(aiReviewTipEnabled, (on) => {
    if (on) aiReviewTipDismissed.value = false
  })

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
    termFix.value = d.termFix
    speakerDiarization.value = d.speakerDiarization
    speakerCount.value = d.speakerCount
    speakerPrefix.value = d.speakerPrefix
    speakerPrefixUserSet.value = d.speakerPrefixUserSet
    speakerNamesShared.value = d.speakerNamesShared
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
    aiScriptStrength.value = d.aiScriptStrength
    aiReviewTipEnabled.value = d.aiReviewTipEnabled
    aiReviewTipDismissed.value = d.aiReviewTipDismissed
  }

  return {
    themeMode,
    glassEnabled,
    backend,
    modelFile,
    language,
    autoDetectLanguage,
    promptTerms,
    termFix,
    speakerDiarization,
    speakerCount,
    speakerPrefix,
    speakerPrefixUserSet,
    speakerPrefixEffective,
    speakerNamesShared,
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
    aiScriptStrength,
    aiReviewTipEnabled,
    aiReviewTipDismissed,
    resetAll,
  }
})
