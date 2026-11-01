<script setup lang="ts">
/**
 * 「AI 校对」辅助窗口。
 *
 * 这是一个**独立窗口**（Electron 里由主进程开，浏览器里用 ?window=assist 直达），
 * 因为它要陪用户跑完一段"跳出软件"的流程：准备提示词 → 去网页版 AI 粘贴 →
 * 把结果复制回来 → 在这个窗口里确认覆盖。窗口默认置顶，方便来回切换。
 *
 * 本窗口自身不发起任何网络请求，只读写剪贴板。离开本机的网络请求由用户自己在浏览器里发起。
 *
 * 提示词在**这里**拼，不在主窗口 —— 因为第 1 步要让用户挑文件、贴原文稿，
 * 这两件事都会改变提示词的内容。主窗口只把「原料」送过来。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import type { AssistReviewPayload, AssistReviewTarget } from '@/types/engine'
import type { SubtitleSegment } from '@/types'
import {
  parseModelOutput,
  parseTranslation,
  splitByFileMarks,
  summarizeReview,
  type ParseOutcome,
  type ReviewSummary,
} from '@/utils/llmResult'
import { buildReviewPrompt, buildTranslatePrompt, estimatePromptTokens } from '@/utils/llmPrompt'
import {
  SCRIPT_STRENGTH_OPTIONS,
  normalizeStrength,
  strengthOption,
} from '@/data/scriptStrength'
import { pickPresentTerms, splitTerms } from '@/utils/prompt'
import { hasText } from '@/utils/segmentOps'
import { containmentSimilarityPrepared, prepareText } from '@/utils/transcriptMerge'
import { formatDuration } from '@/utils/format'
import { toPlain } from '@/utils/plain'
import { branding } from '@/branding'
import Icon from '@/components/Icon.vue'

type Step = 'copy' | 'paste' | 'apply'

/* 主题（store 初始化时会应用 data-theme）+ AI 相关偏好，两者都在本窗口直接用 */
const settings = useSettingsStore()

const bridge = window.xbaos
const params = new URLSearchParams(window.location.search)
const isDemo = import.meta.env.DEV && params.has('demo')

const step = ref<Step>('copy')

const payload = ref<AssistReviewPayload | null>(null)

/**
 * 任务类型。缺省是校对。
 *
 * 翻译与校对共用这个窗口：交互骨架（复制提示词 → 粘贴结果 → 校验 → 回写）
 * 完全一样，差别只在提示词措辞、校验规则与回写方式。再开一个窗口只会让
 * 「窗口管理、置顶、剪贴板中转」这些公共部分重复一遍。
 */
const isTranslate = computed(() => payload.value?.task === 'translate')

/** 三个步骤的标题，步骤条靠 stepIndex 决定高亮与打勾 */
const STEP_LABELS = computed(() =>
  isTranslate.value
    ? ['准备提示词', '粘贴到 AI 助手', '取回译文']
    : ['准备提示词', '粘贴到 AI 助手', '取回结果'],
)
// 不默认置顶：这段流程本身就要求用户切到浏览器里的 AI 助手，长期钉在最前
// 只会挡住别的窗口。初始值以真实窗口状态为准（见 loadPayload），这里只是兜底。
const onTop = ref(false)
const busy = ref(false)
const noteText = ref('')
const noteKind = ref<'info' | 'error' | 'success'>('info')
const submitted = ref(false)
const showFullPrompt = ref(false)

/** 选中的文件 id。默认全选 —— 用户大概率就是要把这一批一起校对 */
const selectedIds = ref<string[]>([])

/** 原文案参考（可选）。粘贴即生效，不需要点按钮。**只有校对任务用得到** */
const scriptText = ref('')

/* ------------------------------------------------------------ 目标语言 */

/**
 * 常用语言。`code` 是写进数据的语言码（也是导出文件的语言后缀），
 * `name` 是写进提示词、给大模型看的自然语言名称。
 */
const LANG_PRESETS = [
  { code: 'en', name: '英语' },
  { code: 'ja', name: '日语' },
  { code: 'ko', name: '韩语' },
  { code: 'zh-TW', name: '繁体中文' },
  { code: 'fr', name: '法语' },
  { code: 'de', name: '德语' },
  { code: 'es', name: '西班牙语' },
  { code: 'ru', name: '俄语' },
]

/** 选中的语言码；`custom` 表示自己填一个 */
const langPick = ref('en')
/** 自定义目标语言的名称（同时用作语言码） */
const customLang = ref('')

/** 实际写入数据的语言码 */
const targetLangCode = computed(() =>
  langPick.value === 'custom' ? customLang.value.trim() : langPick.value,
)

/** 实际写进提示词的语言名称 */
const targetLangName = computed(() => {
  if (langPick.value === 'custom') return customLang.value.trim() || '目标语言'
  return LANG_PRESETS.find((l) => l.code === langPick.value)?.name ?? '英语'
})

/** 空结果：翻译任务没有时间码，`outcome` 只用来承载「有没有出错」 */
const EMPTY_OUTCOME: ParseOutcome = { cues: [], error: null, warnings: [] }

/** 每个文件的解析结果 */
interface FileResult {
  fileId: string
  fileName: string
  /**
   * 校对的解析结果。
   * 翻译任务里它恒为空壳 —— 译文没有时间码，条数校验在 `parseTranslation` 里完成。
   */
  outcome: ParseOutcome
  /** 翻译结果：按序号的译文。校对任务时为空 */
  lines: string[]
  /** 该文件的前后对照概览（解析失败时为 null）。多文件时展开行看它 */
  summary: ReviewSummary | null
}
const results = ref<FileResult[]>([])

/** 这一份结果「有多少条」：校对看条目数，翻译看译文条数 */
function countOf(r: FileResult): number {
  return isTranslate.value ? r.lines.length : r.outcome.cues.length
}

/**
 * 译文列表用的「原文 ↔ 译文」配对。
 *
 * 对照关系是位置关系：提示词里发出去的就是**所选范围内的有内容条目**，
 * 译文又按序号一一贴回，所以两边按下标对齐是稳的。
 */
function pairsOf(r: FileResult): { src: string; tr: string }[] {
  const target = targets.value.find((t) => t.fileId === r.fileId)
  const src = (target ? pickedOf(target) : []).map((s) => s.text.replace(/\s*\n\s*/g, ' ').trim())
  return r.lines.map((tr, i) => ({ src: src[i] ?? '', tr }))
}
/** 单文件时的前后对照概览 */
const summary = ref<ReviewSummary | null>(null)

/**
 * 所有文件的解析提示（时间码重叠、倒流、超出片长……）。
 *
 * 原来这块挂在 `v-if="summary"` 里面，而 `summary` 只在**单文件校对**时才赋值 ——
 * 多文件时警告一条都露不出来，用户看到的是「读取成功」，然后时间码坏了也没人告诉。
 * 现在摊平成一份列表，多文件时带上文件名，一个不漏。
 */
const warningItems = computed(() =>
  results.value
    .filter((r) => !r.outcome.error && r.outcome.warnings.length > 0)
    .map((r) => ({ fileId: r.fileId, fileName: r.fileName, text: r.outcome.warnings.join('；') })),
)

/** 多文件时当前展开查看的是哪个文件（null = 全部收起） */
const expandedId = ref<string | null>(null)
/** 多文件切块失败等原因的整体错误 */
const parseError = ref('')

function toggleExpand(fileId: string): void {
  expandedId.value = expandedId.value === fileId ? null : fileId
}

const targets = computed<AssistReviewTarget[]>(() => payload.value?.targets ?? [])
const multi = computed(() => targets.value.length > 1)
const selectedTargets = computed(() =>
  targets.value.filter((t) => selectedIds.value.includes(t.fileId)),
)
const isAllSelected = computed(
  () => targets.value.length > 0 && selectedIds.value.length === targets.value.length,
)

/* ------------------------------------------------------------- 处理范围 */

/**
 * 一个文件里**真正会发给 AI** 的字幕。
 *
 * 必须与提示词构建器的 `usable()` 用同一个判据（`hasText`）：那边剔掉的空条目，
 * 这边要是算进范围里，序号就会整体错位一格 —— 而这类错位读起来完全通顺，
 * 极难发现。所以「范围」的下标一律建立在这个列表上。
 */
function usableOf(t: AssistReviewTarget): SubtitleSegment[] {
  return t.segments.filter(hasText)
}

/**
 * 每个文件的勾选状态（布尔数组，下标对齐 `usableOf` 的结果）。
 *
 * 用布尔数组而不是「下标集合」有两个原因：逐条判定是 O(1)，且与条目一一对应，
 * 条数变了（主窗口改了内容再打开本窗口）只要长度对不上就整体退回「全选」，
 * 不会出现「勾了一半却错位」那种谁也看不懂的局面。
 *
 * **整体替换**赋值（`{ ...old, [id]: next }`）而不是原地改：ref 包着的对象
 * 原地改不会触发依赖，界面会「点了复选框没反应」。
 */
const pickedFlags = ref<Record<string, boolean[]>>({})

function flagsOf(t: AssistReviewTarget): boolean[] {
  const n = usableOf(t).length
  const stored = pickedFlags.value[t.fileId]
  if (!stored || stored.length !== n) return new Array<boolean>(n).fill(true)
  return stored
}

function isPicked(t: AssistReviewTarget, index: number): boolean {
  return flagsOf(t)[index] !== false
}

function setFlags(t: AssistReviewTarget, flags: boolean[]): void {
  pickedFlags.value = { ...pickedFlags.value, [t.fileId]: flags }
}

/** 点某一条的复选框 */
function toggleCue(t: AssistReviewTarget, index: number): void {
  const next = [...flagsOf(t)]
  next[index] = next[index] === false
  setFlags(t, next)
  syncFileSelection(t)
}

/** 该文件全选 / 全不选 */
function setAllCues(t: AssistReviewTarget, on: boolean): void {
  setFlags(t, new Array<boolean>(usableOf(t).length).fill(on))
  syncFileSelection(t)
}

/** 这个文件里被勾中的条目（顺序即提示词里的顺序） */
function pickedOf(t: AssistReviewTarget): SubtitleSegment[] {
  const flags = flagsOf(t)
  return usableOf(t).filter((_, i) => flags[i] !== false)
}

function pickedCount(t: AssistReviewTarget): number {
  return pickedOf(t).length
}

/** 全选 = 走原来的整份重建路径，行为保持不变 */
function isFullPick(t: AssistReviewTarget): boolean {
  return pickedCount(t) >= usableOf(t).length
}

/** 勾了一部分（文件行的复选框显示成「半选」） */
function isPartlyPick(t: AssistReviewTarget): boolean {
  const n = pickedCount(t)
  return n > 0 && n < usableOf(t).length
}

/** 恢复全部：清掉所有勾选状态，缺省即全选 */
function resetPicks(): void {
  pickedFlags.value = {}
}

/** 展开查看哪个文件的字幕清单（null = 全部收起） */
const openPick = ref<string | null>(null)

function togglePick(fileId: string): void {
  openPick.value = openPick.value === fileId ? null : fileId
}

/**
 * 真正会被发出去的文件：勾了文件、且文件里至少有一条被勾中。
 *
 * 提示词、条数校验、回写三处必须用同一份列表 —— 否则「提示词里发了 2 个文件、
 * 校验时却按 3 个算」这种错位会直接表现为「整份拒绝」。
 */
const activeTargets = computed(() =>
  selectedTargets.value.filter((t) => pickedOf(t).length > 0),
)

/** 有条目被排除在外的文件，用于第 3 步说明「这次只覆盖哪些」 */
const scopedTargets = computed(() =>
  activeTargets.value.filter((t) => !isFullPick(t)),
)

/**
 * 处理范围这块要不要显示。
 *
 * 判据是「有没有文件可选」，**不是「有没有文件被选中」**。曾经写成
 * `selectedTargets.some(...)`，于是点一次「全部取消」，文件清单连同勾选框一起
 * 消失 —— 用户再也没法把它选回来，只能关掉窗口重开。空选的后果应该由
 * 区块底部那句「还没有选择文件」来承担，而不是把操作入口本身收走。
 */
const pickEditable = computed(() => targets.value.some((t) => usableOf(t).length > 0))

/** 第 3 步那句「本次只覆盖 …」的文字 */
const scopeSummary = computed(() =>
  scopedTargets.value
    .map((t) => `${t.fileName} 已选 ${pickedCount(t)} / ${usableOf(t).length} 条`)
    .join('；'),
)


/** 当前处于第几步（0 起）。步骤条用它算高亮与打勾 */
const stepIndex = computed(() => (step.value === 'copy' ? 0 : step.value === 'paste' ? 1 : 2))

/* ------------------------------------------------------- 原文案相似度 */

/** 去空白后的文案，只用来数字数（换行/空格不该算进去） */
const normalizedScript = computed(() => scriptText.value.replace(/\s+/g, '').trim())

/**
 * 文案与选中文件的吻合度：取所有选中文件里最高的那一个。
 *
 * 用的是**覆盖率**而不是对称相似度 —— 用户的稿子常常比识别结果长得多
 * （整期旁白 vs 其中一段），对称相似度会被长度差直接压死，见 `containmentSimilarity`。
 * 归一化（繁转简、去标点空白、小写）在那个函数内部做。
 */
const scriptSimilarity = computed<number | null>(() => {
  const script = scriptText.value.trim()
  if (!script) return null
  const list = selectedTargets.value
  if (list.length === 0) return null
  // 文案那一侧只准备一次：它对每个文件都相同，放进循环就是白算 N 遍
  const prepared = prepareText(script)
  let best = 0
  for (const t of list) {
    // 用**整个文件**的文本比对，不看处理范围：这一步回答的是「有没有选错文件」，
    // 范围再小也不该让一份正确的稿子被误判成「对不上」
    const text = t.segments.map((s) => s.text).join('')
    best = Math.max(best, containmentSimilarityPrepared(text, prepared))
  }
  return best
})

const SCRIPT_GOOD = 0.7
const SCRIPT_WEAK = 0.35

/**
 * 文案状态：
 *   none    —— 没填，正常走
 *   ok      —— 吻合，写进提示词
 *   weak    —— 吻合度偏低，仍然写进去，但提醒用户确认没拿错文件
 *   blocked —— 吻合度过低，**不写进提示词**。否则 AI 会拿着完全无关的文案把字幕改烂
 */
const scriptState = computed<'none' | 'ok' | 'weak' | 'blocked'>(() => {
  const s = scriptSimilarity.value
  if (s === null) return 'none'
  if (s < SCRIPT_WEAK) return 'blocked'
  if (s < SCRIPT_GOOD) return 'weak'
  return 'ok'
})

const scriptPercent = computed(() =>
  scriptSimilarity.value === null ? 0 : Math.round(scriptSimilarity.value * 100),
)

/**
 * 原文案参考强度。
 *
 * 它读的是**设置里的人偏好**，不是窗口里的临时开关：用户在第 1 步调过一次之后，
 * 下次开窗还是这一档（也正因如此，设置页里那一项与本处是同一个值，改任一处都变）。
 * 只有贴了文稿才有意义，所以没贴时滑块禁用 —— 不禁用会让人以为它在改别的东西。
 */
const activeStrength = computed(() => strengthOption(settings.aiScriptStrength))

function onStrengthInput(event: Event): void {
  settings.aiScriptStrength = normalizeStrength(Number((event.target as HTMLInputElement).value))
}

/* --------------------------------------------------------- 提示词构建 */

/** 从手填热词与词库里挑出「这段内容真的出现过」的专有名词 */
function collectTerms(list: AssistReviewTarget[]): string[] {
  const config = payload.value?.settings
  if (!config) return []
  const out = splitTerms(config.promptTerms)
  if (config.lexiconIds.length > 0) {
    const text = list
      .map((t) =>
        pickedOf(t)
          .map((s) => s.text)
          .join(''),
      )
      .join('\n')
    for (const word of pickPresentTerms(text, config.lexiconIds)) {
      if (!out.includes(word)) out.push(word)
    }
  }
  return out
}

const promptResult = computed(() => {
  const p = payload.value
  if (!p) return null
  // 必须用 activeTargets（勾了文件且至少有一条被勾中）而不是 selectedTargets：
  // 提示词里发出去几份、取回时就按几份校验，两边口径一旦不同就是「整份拒绝」
  const list = activeTargets.value
  if (list.length === 0) return null

  const mapped = list.map((t) => ({
    fileName: t.fileName,
    durationSec: t.durationSec,
    // 只发所选范围内的条目 —— 这是「分批校对」能成立的前提：
    // 提示词里没有的条目，AI 也不可能返回，取回时自然只覆盖这一段
    segments: pickedOf(t),
  }))

  if (isTranslate.value) {
    return buildTranslatePrompt({ targets: mapped, targetLang: targetLangName.value })
  }

  // 相似度太低时把文案拦在门外 —— 宁可少一份参考，也不要让 AI 乱改
  const script = scriptState.value === 'blocked' ? undefined : scriptText.value.trim() || undefined

  return buildReviewPrompt({
    targets: mapped,
    options: {
      language: p.settings.language,
      autoDetectLanguage: p.settings.autoDetectLanguage,
      punctuation: p.settings.punctuation,
      maxCharsPerLine: p.settings.maxCharsPerLine,
      maxCharsPerLineEn: p.settings.maxCharsPerLineEn,
      maxLinesPerSegment: p.settings.maxLinesPerSegment,
      maxSegmentDuration: p.settings.maxSegmentDuration,
      terms: collectTerms(list),
      script,
      scriptStrength: normalizeStrength(settings.aiScriptStrength),
    },
  })
})

const promptText = computed(() => promptResult.value?.prompt ?? '')
const tokenEstimate = computed(() =>
  promptResult.value ? estimatePromptTokens(promptResult.value.charCount) : 0,
)
const canCopy = computed(() => !!promptResult.value && promptResult.value.segmentCount > 0)

/** 提示词预览：默认只给一段，避免一屏全是字；要看全文可以展开 */
const previewText = computed(() => {
  const prompt = promptText.value
  if (showFullPrompt.value || prompt.length <= 800) return prompt
  return `${prompt.slice(0, 800)}\n……`
})

function note(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  noteText.value = text
  noteKind.value = kind
}

/**
 * 文件级的勾选跟着逐条状态一起走：有任何一条被勾中就算选中，一条都没有就不算。
 *
 * 这两处状态（`selectedIds` 与 `pickedFlags`）本来是各改各的，于是很容易出现
 * 「文件勾着、却 0 / 28 条」这种自相矛盾的行 —— 底栏还写着「已选 3 / 3 个文件」，
 * 而提示词里其实只有 2 个文件。谁都不算错，只是两边没说同一件事。
 */
function syncFileSelection(t: AssistReviewTarget): void {
  const on = pickedCount(t) > 0
  const listed = selectedIds.value.includes(t.fileId)
  if (on && !listed) selectedIds.value = [...selectedIds.value, t.fileId]
  else if (!on && listed) selectedIds.value = selectedIds.value.filter((id) => id !== t.fileId)
}

/**
 * 勾选 / 取消一个文件。
 *
 * 取消时**保留**逐条状态（大概率只是临时让开看看别的），但重新勾上时如果这个文件
 * 已经被清空过，就恢复全选 —— 否则勾了还是 0 条，看起来像按钮坏了。
 */
function toggleSelect(fileId: string): void {
  if (selectedIds.value.includes(fileId)) {
    selectedIds.value = selectedIds.value.filter((id) => id !== fileId)
    return
  }
  const t = targets.value.find((item) => item.fileId === fileId)
  if (t && pickedCount(t) === 0) setAllCues(t, true)
  // setAllCues 可能已经顺势把这个文件勾上了，别重复塞
  if (!selectedIds.value.includes(fileId)) selectedIds.value = [...selectedIds.value, fileId]
}

/**
 * 全选 / 全部取消（文件级）。
 *
 * 「全选」承诺的是「所有文件的所有条目」，所以连逐条状态一起复位 ——
 * 只把文件 id 塞回去的话，之前被清空过的文件会以「勾着但 0 条」的样子回来。
 */
function toggleSelectAll(): void {
  if (isAllSelected.value) {
    selectedIds.value = []
    return
  }
  resetPicks()
  selectedIds.value = targets.value.map((t) => t.fileId)
}

/* ------------------------------------------------------------ 数据装载 */

const DEMO_PAYLOAD: AssistReviewPayload = {
  targets: [
    {
      fileId: 'demo-1',
      fileName: '示例音频 1.wav',
      durationSec: 42,
      segmentCount: 2,
      segments: [
        { id: 'd1', start: 0, end: 3, text: '大家好欢迎来到本期节目', origin: '', issues: [] },
        { id: 'd2', start: 3, end: 7, text: '今天我们聊一聊显卡这个东西', origin: '', issues: [] },
      ],
    },
    {
      fileId: 'demo-2',
      fileName: '示例音频 2.wav',
      durationSec: 30,
      segmentCount: 1,
      segments: [
        { id: 'd3', start: 0, end: 4, text: '先说说它为什么这么贵', origin: '', issues: [] },
      ],
    },
  ],
  settings: {
    language: 'zh',
    autoDetectLanguage: false,
    punctuation: { zh: 'strip-split', en: 'keep' },
    maxCharsPerLine: 16,
    maxCharsPerLineEn: 42,
    maxLinesPerSegment: 1,
    maxSegmentDuration: 7,
    promptTerms: '',
    lexiconIds: [],
  },
}

async function loadPayload(): Promise<void> {
  const api = bridge?.assist
  if (api) {
    try {
      payload.value = await api.payload()
      onTop.value = await api.isAlwaysOnTop()
    } catch {
      payload.value = null
    }
  }
  // DEV 直达：`?window=assist&demo=1&task=translate` 用来调试翻译那一侧
  // （真机上 task 由主窗口经主进程传进来，这里只是给浏览器预览与探针一个入口）
  // `&files=1` 把演示数据裁成单文件 —— 第 3 步的单文件与多文件走的是**两条不同的渲染分支**，
  // 光靠多文件数据测不到单文件那条。
  if (!payload.value && isDemo) {
    const n = Number(params.get('files'))
    const base =
      Number.isFinite(n) && n >= 1
        ? { ...DEMO_PAYLOAD, targets: DEMO_PAYLOAD.targets.slice(0, n) }
        : DEMO_PAYLOAD
    payload.value = params.has('task') ? { ...base, task: 'translate' } : base
  }
  selectedIds.value = payload.value ? payload.value.targets.map((t) => t.fileId) : []
  resetPicks()
  openPick.value = null
}

/* ------------------------------------------------------------ 第 1 步 */

async function copyPrompt(): Promise<void> {
  if (!canCopy.value) return
  busy.value = true
  try {
    if (bridge?.clipboard) {
      await bridge.clipboard.write(promptText.value)
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(promptText.value)
    } else {
      note('当前环境无法访问剪贴板，请手动全选提示词复制', 'error')
      return
    }
    step.value = 'paste'
    note('提示词已复制。', 'success')
  } catch (err) {
    note(err instanceof Error ? err.message : '复制失败', 'error')
  } finally {
    busy.value = false
  }
}

/* ------------------------------------------------------------ 第 3 步 */

const failedFiles = computed(() => results.value.filter((r) => r.outcome.error))

const canApply = computed(
  () => results.value.length > 0 && failedFiles.value.length === 0 && !submitted.value,
)

async function readClipboard(): Promise<void> {
  // 与提示词用同一份列表：发出去 2 份就按 2 份校验，多一份少一份都会假失败
  const list = activeTargets.value
  if (list.length === 0) {
    note('请先勾选要处理的文件与字幕。', 'error')
    return
  }

  busy.value = true
  noteText.value = ''
  results.value = []
  summary.value = null
  expandedId.value = null
  parseError.value = ''

  try {
    let text = ''
    if (bridge?.clipboard) {
      text = await bridge.clipboard.readText()
    } else if (navigator.clipboard?.readText) {
      text = await navigator.clipboard.readText()
    } else {
      note('当前环境无法读取剪贴板', 'error')
      return
    }

    if (!text.trim()) {
      note(
        isTranslate.value
          ? '剪贴板为空。请先在 AI 助手中复制其输出的译文。'
          : '剪贴板为空。请先在 AI 助手中复制其输出的字幕。',
        'error',
      )
      return
    }

    // 翻译：条数必须 1:1 是唯一的硬要求，不满足就整份拒绝。
    // 单文件与多文件在这里没有分岔 —— parseTranslation 自己会按分隔行切块。
    if (isTranslate.value) {
      if (!targetLangCode.value) {
        note('请先选择目标语言。', 'error')
        return
      }
      // 期望条数必须与提示词里实际发出去的行数一致 —— 提示词只含所选范围内的
      // 有内容条目，这里就得按同一个范围数，否则条数校验会凭空多算。
      const out = parseTranslation(
        text,
        list.map((t) => pickedOf(t).length),
      )
      if (!out.ok) {
        parseError.value = out.message ?? '译文的格式不对'
        note(parseError.value, 'error')
        return
      }
      // 条数已被校验成 1:1，这里按位置一一对应即可
      results.value = out.blocks.map((block, i) => ({
        fileId: list[i].fileId,
        fileName: list[i].fileName,
        outcome: EMPTY_OUTCOME,
        lines: block.lines,
        summary: null,
      }))
      const total = results.value.reduce((n, r) => n + r.lines.length, 0)
      note(`读取成功：${results.value.length} 个文件共 ${total} 条译文。确认后点「载入译文」。`, 'success')
      return
    }

    if (list.length === 1) {
      const outcome = parseModelOutput(text, list[0].durationSec)
      results.value = [
        { fileId: list[0].fileId, fileName: list[0].fileName, outcome, lines: [], summary: null },
      ]
      if (outcome.error) {
        note(outcome.error, 'error')
        return
      }
      summary.value = summarizeReview(outcome.cues, pickedOf(list[0]))
      note(`读取成功：解析出 ${outcome.cues.length} 条字幕。请核对下方变化。`, 'success')
      return
    }

    // 多文件：按「【文件 k/N】文件名」切块。切不出来就老实报错，不猜
    const split = splitByFileMarks(text)
    let blocks = split.blocks
    // 模型常把输出开头的【文件 1/N】当成"标题"吞掉，第一个文件的正文就孤零零地
    // 落在第一个分隔行前面。少一块、而前面那段确实解析得出字幕 —— 那就是它，补到队首。
    if (blocks.length === list.length - 1 && split.leading.trim() !== '') {
      const lead = parseModelOutput(split.leading, list[0].durationSec)
      if (lead.cues.length > 0) {
        blocks = [{ index: 1, name: list[0].fileName, text: split.leading }, ...blocks]
      }
    }
    if (blocks.length !== list.length) {
      parseError.value =
        `只识别到 ${blocks.length} 个文件，但你选择了 ${list.length} 个。` +
        '请确认 AI 的回复原样保留了每一行「【文件 k/N】文件名」，再重新复制完整结果。'
      note(parseError.value, 'error')
      return
    }

    results.value = blocks.map((block, i) => {
      const outcome = parseModelOutput(block.text, list[i].durationSec)
      return {
        fileId: list[i].fileId,
        fileName: list[i].fileName,
        outcome,
        lines: [],
        // 每个文件单独算对照，展开时才有内容可看
        summary: outcome.error ? null : summarizeReview(outcome.cues, pickedOf(list[i])),
      }
    })

    if (failedFiles.value.length > 0) {
      note(`${failedFiles.value.length} 个文件的输出无法解析出字幕，详见下方。`, 'error')
      return
    }
    const total = results.value.reduce((n, r) => n + r.outcome.cues.length, 0)
    note(`读取成功：${results.value.length} 个文件共 ${total} 条字幕。确认后点「确认覆盖」。`, 'success')
  } catch (err) {
    note(err instanceof Error ? err.message : '读取剪贴板失败', 'error')
  } finally {
    busy.value = false
  }
}

function confirmApply(): void {
  const api = bridge?.assist
  if (!api) {
    note('浏览器预览模式无法写回编辑器，请在桌面应用中使用', 'error')
    return
  }

  /** 勾选范围里那些条目的 id（顺序即提示词里的顺序） */
  const idsOf = (fileId: string): string[] => {
    const t = targets.value.find((x) => x.fileId === fileId)
    return t ? pickedOf(t).map((s) => s.id) : []
  }
  const fullOf = (fileId: string): boolean => {
    const t = targets.value.find((x) => x.fileId === fileId)
    return !t || isFullPick(t)
  }

  // 翻译：提交译文（按序号），主窗口据此「只换文本、不动时间码」
  if (isTranslate.value) {
    const ok = results.value.filter((r) => r.lines.length > 0)
    if (ok.length === 0) {
      note('没有可载入的译文。', 'error')
      return
    }
    try {
      api.submit({
        task: 'translate',
        lang: targetLangCode.value,
        // 带上 id：只给这一段写译文，范围外条目的译文原样留着
        results: toPlain(
          ok.map((r) => ({ fileId: r.fileId, lines: r.lines, ids: idsOf(r.fileId) })),
        ),
      })
    } catch (err) {
      note(`提交失败：${String((err as Error)?.message ?? err)}`, 'error')
      return
    }
    submitted.value = true
    note('已提交，正在写回编辑器……', 'success')
    return
  }

  const ok = results.value.filter((r) => !r.outcome.error)
  if (ok.length === 0) {
    note('没有可写回的结果。', 'error')
    return
  }
  // cues 存在 ref 里，同样是 Vue 深度代理；不纯化会在 send 时同步抛
  // `An object could not be cloned.`，表现为「确认后没有任何反应」
  try {
    api.submit({
      results: toPlain(
        ok.map((r) => ({
          fileId: r.fileId,
          cues: r.outcome.cues,
          // 只有「选了部分范围」才带 id：全量时保持原来的整份重建语义，
          // 免得把既有行为（按位置复用 id）也一起改掉
          ids: fullOf(r.fileId) ? undefined : idsOf(r.fileId),
        })),
      ),
    })
  } catch (err) {
    note(`提交失败：${String((err as Error)?.message ?? err)}`, 'error')
    return
  }
  submitted.value = true
  note('已提交，正在写回编辑器……', 'success')
}

function restart(): void {
  results.value = []
  summary.value = null
  parseError.value = ''
  noteText.value = ''
  step.value = 'copy'
}

/* ------------------------------------------------------------ 窗口控制 */

async function toggleTop(): Promise<void> {
  const api = bridge?.assist
  if (!api) {
    onTop.value = !onTop.value
    return
  }
  onTop.value = await api.setAlwaysOnTop(!onTop.value)
}

function windowControl(action: 'minimize' | 'maximize' | 'close'): void {
  const api = bridge?.window
  if (api) {
    api.control(action)
    return
  }
  if (action === 'close') window.close()
}

const isMaximized = ref(false)
let offState: (() => void) | undefined
let offRefresh: (() => void) | undefined

onMounted(async () => {
  await loadPayload()
  offState = bridge?.window?.onStateChange((state) => {
    isMaximized.value = state.maximized || state.fullScreen
  })
  offRefresh = bridge?.assist?.onRefresh(() => {
    void loadPayload().then(() => {
      submitted.value = false
      results.value = []
      summary.value = null
      parseError.value = ''
      step.value = 'copy'
    })
  })
})

onBeforeUnmount(() => {
  offState?.()
  offRefresh?.()
})
</script>

<template>
  <div class="assist">
    <!-- 自绘标题栏：与主窗口同款，无边框窗口靠这一条拖动 -->
    <header class="abar">
      <div class="abar__brand">
        <span class="abar__mark" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="14" height="14">
            <rect x="1.2" y="9" width="2.4" height="2.3" fill="#F2EADB" />
            <rect x="1.2" y="11.3" width="2.4" height="3.7" fill="#4A7BA6" />
            <rect x="5" y="6" width="2.4" height="3.4" fill="#C08A5F" />
            <rect x="5" y="9.4" width="2.4" height="5.6" fill="#4A7BA6" />
            <rect x="8.8" y="3.8" width="2.4" height="4.2" fill="#F2EADB" />
            <rect x="8.8" y="8" width="2.4" height="7" fill="#4A7BA6" />
            <rect x="12.6" y="7" width="2.4" height="3.1" fill="#C08A5F" />
            <rect x="12.6" y="10.1" width="2.4" height="4.9" fill="#4A7BA6" />
            <rect x="16.4" y="10" width="2.4" height="1.9" fill="#F2EADB" />
            <rect x="16.4" y="11.9" width="2.4" height="3.1" fill="#4A7BA6" />
            <rect x="1.2" y="17.2" width="9.9" height="1.6" fill="#4A7BA6" />
            <rect x="11.9" y="17.2" width="3.8" height="1.6" fill="#F2EADB" />
            <rect x="16.5" y="17.2" width="2.3" height="1.6" fill="#C08A5F" />
          </svg>
        </span>
        <span class="abar__name">{{ isTranslate ? 'AI 翻译' : 'AI 校对' }}</span>
      </div>

      <div class="abar__center">
        <span class="abar__sub">{{ branding.shortName }}</span>
      </div>

      <div class="abar__right">
        <button
          class="abar__btn abar__btn--pin"
          :class="{ 'is-on': onTop }"
          type="button"
          :title="onTop ? '已置顶，点击取消' : '点击置顶窗口'"
          :aria-pressed="onTop"
          @click="toggleTop"
        >
          <Icon name="pin" :size="14" />
          <span class="abar__pin-label">{{ onTop ? '已置顶' : '置顶' }}</span>
        </button>

        <span class="abar__sep" aria-hidden="true" />

        <button class="abar__icon" type="button" title="最小化" @click="windowControl('minimize')">
          <Icon name="window-min" :size="15" />
        </button>
        <button
          class="abar__icon"
          type="button"
          :title="isMaximized ? '还原' : '最大化'"
          @click="windowControl('maximize')"
        >
          <Icon :name="isMaximized ? 'window-restore' : 'window-max'" :size="15" />
        </button>
        <button class="abar__icon abar__icon--close" type="button" title="关闭" @click="windowControl('close')">
          <Icon name="x" :size="15" />
        </button>
      </div>
    </header>

    <!-- 步骤指示：走过的步骤打勾，当前位置高亮 -->
    <ol class="steps">
      <li
        v-for="(label, i) in STEP_LABELS"
        :key="label"
        class="steps__item"
        :class="{ 'is-active': stepIndex === i, 'is-done': stepIndex > i }"
      >
        <span class="steps__no">
          <Icon v-if="stepIndex > i" name="check" :size="11" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="steps__label">{{ label }}</span>
      </li>
    </ol>

    <div class="assist__body scroll-y">
      <p v-if="!payload" class="empty">
        未获取到字幕数据。请回到主窗口，在「预览与编辑」页重新打开本窗口。
      </p>

      <template v-else>
        <!-- ── 第 1 步 ── -->
        <section v-if="step === 'copy'" class="pane">
          <h2 class="pane__title">第 1 步：准备提示词</h2>
          <p class="pane__lead">
            <template v-if="isTranslate">
              下方的提示词会把选中的字幕交给 AI 翻译，目标语言在下面选择。
              本软件只按序号收回译文，不会改动时间轴。
            </template>
            <template v-else-if="multi">
              下方的提示词会把选中的文件一并交给 AI 校对。先确认要校对哪几个文件；
              如有原始文稿，可在下方补充。
            </template>
            <template v-else-if="targets.length === 1">
              提示词已包含这段音频的
              <strong>{{ targets[0].segmentCount }} 条字幕</strong>
              （时长约 {{ formatDuration(targets[0].durationSec) }}）与校对要求。
            </template>
          </p>

          <!-- 目标语言：只有翻译任务需要。校对用的提示词里没有语言这一维 -->
          <div v-if="isTranslate" class="block">
            <div class="block__head">
              <span class="block__title"><Icon name="globe" :size="14" /> 翻译成哪种语言</span>
            </div>
            <div class="langpick">
              <select v-model="langPick" class="select">
                <option v-for="l in LANG_PRESETS" :key="l.code" :value="l.code">
                  {{ l.name }}
                </option>
                <option value="custom">其他（自己填）</option>
              </select>
              <input
                v-if="langPick === 'custom'"
                v-model="customLang"
                class="input"
                type="text"
                placeholder="例如：意大利语"
                spellcheck="false"
              />
            </div>
            <p v-if="langPick === 'custom' && !customLang.trim()" class="hint">
              填语言名称即可。它会写入提示词，并作为导出文件的语言后缀。
            </p>
          </div>

          <!--
            处理范围：文件勾选 + 逐条字幕勾选合成一个功能区。

            原来这里是两块 —— 上面「选择要翻译/校对的文件」一排复选框，下面
            「处理范围」每个文件两个下拉（起止条目）。两个下拉只表达得了闭区间，
            而实际需求经常是「这 30 条里跳过中问那 5 条标错的」，下拉根本做不到；
            更要紧的是同一件事被拆成两个区块，用户得先想「我该动上面还是下面」。
            合并后只有一处：文件行勾「这个文件要不要处理」，右侧箭头展开逐条勾选。
          -->
          <div v-if="pickEditable" class="block">
            <div class="block__head">
              <span class="block__title"><Icon name="list" :size="14" /> 处理范围</span>
              <button class="link" type="button" @click="toggleSelectAll">
                {{ isAllSelected ? '全部取消' : '全选' }}
              </button>
            </div>
            <p class="block__hint">
              默认全部处理。条目太多、AI 一次吃不下时可以分批：只勾这一段，取回时也只覆盖这一段，
              其余字幕保持原样。
            </p>

            <ul class="pick" :class="{ 'pick--open': openPick !== null }">
              <li v-for="t in targets" :key="t.fileId" class="pick__item">
                <div class="pick__row" :class="{ 'is-on': selectedIds.includes(t.fileId) }">
                  <label class="pick__main">
                    <input
                      class="pick__box"
                      type="checkbox"
                      :checked="selectedIds.includes(t.fileId)"
                      :indeterminate.prop="isPartlyPick(t)"
                      @change="toggleSelect(t.fileId)"
                    />
                    <span class="pick__name">{{ t.fileName }}</span>
                  </label>
                  <span class="pick__meta">
                    {{ pickedCount(t) }} / {{ usableOf(t).length }} 条
                  </span>
                  <button
                    class="pick__more"
                    type="button"
                    :aria-expanded="openPick === t.fileId"
                    :aria-label="`展开 ${t.fileName} 的字幕清单`"
                    @click="togglePick(t.fileId)"
                  >
                    <Icon
                      :name="openPick === t.fileId ? 'chevron-up' : 'chevron-down'"
                      :size="14"
                    />
                  </button>
                </div>

                <div v-if="openPick === t.fileId" class="cues">
                  <div class="cues__head">
                    <span class="cues__tip">
                      {{ isTranslate ? '只翻译勾选的条目' : '只校对勾选的条目' }}，其余保持原样
                    </span>
                    <button class="link" type="button" @click="setAllCues(t, true)">全选</button>
                    <button class="link" type="button" @click="setAllCues(t, false)">清空</button>
                  </div>
                  <ul class="cues__list scroll-y">
                    <li v-for="(s, i) in usableOf(t)" :key="s.id">
                      <label class="cue" :class="{ 'is-off': !isPicked(t, i) }">
                        <input
                          class="cue__box"
                          type="checkbox"
                          :checked="isPicked(t, i)"
                          @change="toggleCue(t, i)"
                        />
                        <span class="cue__no mono">{{ i + 1 }}</span>
                        <span class="cue__text">{{ s.text }}</span>
                      </label>
                    </li>
                  </ul>
                </div>
              </li>
            </ul>

            <!-- 一行都没选时不留「已选 0 / 3 个文件」这种读不出指令的账，直接说下一步该做什么 -->
            <p v-if="activeTargets.length === 0" class="block__foot block__foot--empty">
              <Icon name="info" :size="13" />
              <span>还没有选择文件。勾上文件左侧的方框，或点右上角「全选」。</span>
            </p>
            <p v-else class="block__foot">
              已选 {{ selectedTargets.length }} / {{ targets.length }} 个文件，共
              <strong>{{ promptResult?.segmentCount ?? 0 }}</strong> 条字幕
            </p>
          </div>

          <!-- 原文案参考（可选）。翻译用不到它 —— 那是「按同一份稿子校正」的辅助输入，
               对「换一种语言重写」没有参考价值，留着只会让人以为要填 -->
          <div v-if="!isTranslate" class="block">
            <div class="block__head">
              <span class="block__title"><Icon name="type" :size="14" /> 原文案参考（可选）</span>
              <button v-if="scriptText" class="link" type="button" @click="scriptText = ''">
                清空
              </button>
            </div>
            <p class="block__hint">
              粘贴原始文稿可帮助 AI 修正同音字、专有名词与数字。留空不影响校对。
            </p>
            <textarea
              v-model="scriptText"
              class="script"
              rows="4"
              placeholder="在此粘贴原始文稿"
            ></textarea>

            <!--
              参考强度：同一份文稿，用法可以差很多 —— 逐字念稿的视频里，字幕与文稿
              不一致就是识别错了；只写了提纲随口讲的视频里，硬按文稿改反而会让字幕
              与声音对不上。所以这一维交给用户，默认「平衡」。
            -->
            <div class="strength">
              <div class="strength__row">
                <span class="strength__label">参考强度</span>
                <span class="strength__value">{{ activeStrength.label }}</span>
              </div>
              <div class="levels">
                <input
                  class="levels__input"
                  type="range"
                  min="0"
                  max="3"
                  step="1"
                  :value="settings.aiScriptStrength"
                  :disabled="!scriptText.trim()"
                  aria-label="原文案参考强度"
                  @input="onStrengthInput"
                />
                <div class="levels__ticks">
                  <button
                    v-for="item in SCRIPT_STRENGTH_OPTIONS"
                    :key="item.value"
                    class="levels__tick"
                    :class="{ 'is-on': settings.aiScriptStrength === item.value }"
                    type="button"
                    :disabled="!scriptText.trim()"
                    @click="settings.aiScriptStrength = item.value"
                  >
                    {{ item.label }}
                  </button>
                </div>
              </div>
              <p class="block__hint">
                {{ scriptText.trim() ? activeStrength.hint : '粘贴文稿后可调整：越靠左越以文稿为准，越靠右越宽松。' }}
              </p>
            </div>
            <p v-if="scriptText.trim()" class="script__stat" :class="`script__stat--${scriptState}`">
              <Icon
                :name="scriptState === 'blocked' ? 'alert' : scriptState === 'weak' ? 'info' : 'check'"
                :size="13"
              />
              <span>
                已粘贴 {{ normalizedScript.length }} 字，识别内容约 {{ scriptPercent }}% 能在文案里找到。
                <template v-if="scriptState === 'ok'">吻合度良好，这份文稿会一并交给 AI 参考。</template>
                <template v-else-if="scriptState === 'weak'">
                  吻合度偏低，仍会交给 AI 参考，请先确认没有选错文件。
                </template>
                <template v-else>
                  吻合度过低，可能不是同一段内容。为避免改坏字幕，这份文稿
                  <strong>不会</strong>交给 AI。
                </template>
              </span>
            </p>
          </div>

          <!-- 处理范围区块能自己说明「还没选文件」时就别再下面重说一遍；
               只有整块都没渲染出来（所有文件都没有可处理的字幕）时才由这里兜底 -->
          <div v-if="!canCopy && !pickEditable" class="warn">
            <Icon name="alert" :size="14" />
            <span>没有可处理的字幕，请检查所选文件。</span>
          </div>

          <div v-if="promptResult?.overLimit" class="warn">
            <Icon name="alert" :size="14" />
            <span>
              内容较长（约 {{ tokenEstimate }} 字）。部分 AI 助手有输入长度上限，
              若被提示过长，可改用支持长文本的助手，或减少选中的文件后重试。
            </span>
          </div>

          <div class="prompt">
            <div class="prompt__head">
              <span class="prompt__label">提示词预览</span>
              <span class="prompt__meta">{{ promptResult?.charCount ?? 0 }} 字符</span>
              <span class="spacer" />
              <button class="link" type="button" @click="showFullPrompt = !showFullPrompt">
                {{ showFullPrompt ? '收起' : '展开全文' }}
              </button>
            </div>
            <pre class="prompt__body">{{ previewText }}</pre>
          </div>
        </section>

        <!-- ── 第 2 步 ── -->
        <section v-else-if="step === 'paste'" class="pane">
          <h2 class="pane__title">第 2 步：粘贴到 AI 助手</h2>

          <ol class="howto">
            <li>打开任意一个 AI 助手的网页版。</li>
            <li>新建对话，把刚复制的提示词粘贴进输入框并发送。</li>
            <li>等它输出{{ isTranslate ? '译文' : '校对后的字幕' }}，通常需要数秒到一两分钟。</li>
            <li>复制 AI 回复里的<strong>全部内容</strong>。</li>
            <li>回到本窗口，点击读取剪贴板的按钮。</li>
          </ol>

          <div class="tips">
            <div class="tips__row">
              <Icon name="info" :size="14" />
              <span>
                只复制 AI 的回答即可。若读入结果异常，通常是复制时带上了网页中的其他文字，
                重新选中回答复制一次即可。
              </span>
            </div>
            <div class="tips__row">
              <Icon name="info" :size="14" />
              <span>建议选择支持长文本输入的助手。</span>
            </div>
            <div class="tips__row">
              <Icon name="shield" :size="14" />
              <span>
                字幕内容会发送到你选择的第三方 AI 服务，请注意隐私与版权。本软件不会代你发送，
                也不接收、不存储这些内容。
              </span>
            </div>
            <div class="tips__row">
              <Icon name="alert" :size="14" />
              <span v-if="isTranslate">
                AI 可能漏译或合并条目。因此条数一旦对不上，本软件会整份拒绝并请你重新生成，
                不会勉强贴入。
              </span>
              <span v-else>AI 可能改错或漏改，取回后请核对变化明细再确认覆盖。</span>
            </div>
          </div>
        </section>

        <!-- ── 第 3 步 ── -->
        <section v-else class="pane">
          <h2 class="pane__title">
            {{ isTranslate ? '第 3 步：取回译文并载入' : '第 3 步：取回结果并覆盖' }}
          </h2>
          <p class="pane__lead">
            <template v-if="isTranslate">
              确认已复制 AI 输出的译文，然后点击下方按钮。软件会读取剪贴板，并核对译文条数
              与字幕条数是否<strong>一一对应</strong>；对不上则整份拒绝，避免整体错位。
            </template>
            <template v-else>
              确认已复制 AI 输出的字幕，然后点击下方按钮。软件会读取并解析剪贴板内容，
              核对无误后才覆盖。
            </template>
          </p>

          <p v-if="scopedTargets.length > 0" class="scope">
            <Icon name="info" :size="13" />
            <span>
              本次只覆盖 {{ scopeSummary }}，这些条目之外的字幕不会被改动。
            </span>
          </p>

          <!-- 时间码提示。放在 summary 之外：多文件时 summary 恒为 null，警告会整片消失 -->
          <div v-if="!isTranslate && warningItems.length > 0" class="warn warn--soft">
            <Icon name="alert" :size="14" />
            <div class="warn__body">
              <template v-if="warningItems.length === 1">
                时间码提示：{{ warningItems[0].text }}。可以继续应用，也可以在编辑器里再手工微调。
              </template>
              <template v-else>
                <p>时间码提示（{{ warningItems.length }} 个文件）：</p>
                <p v-for="w in warningItems" :key="w.fileId">{{ w.fileName }}：{{ w.text }}</p>
                <p>可以继续应用，也可以在编辑器里再手工微调。</p>
              </template>
            </div>
          </div>

          <!-- 单文件：前后对照概览 -->
          <div v-if="summary" class="review">
            <div class="review__stat">
              <div class="review__cell">
                <span class="review__num mono">{{ summary.before }}</span>
                <span class="review__cap">条（原文）</span>
              </div>
              <Icon name="arrow-right" :size="16" class="review__arrow" />
              <div class="review__cell">
                <span class="review__num mono">{{ summary.after }}</span>
                <span class="review__cap">条（结果）</span>
              </div>
              <div class="review__cell review__cell--wide">
                <span class="review__num mono">{{ summary.changed }}</span>
                <span class="review__cap">处有变化</span>
              </div>
            </div>

            <div v-if="summary.previews.length > 0" class="diffs">
              <div class="diffs__head">
                <span>变化明细（共 {{ summary.previews.length }} 处）</span>
                <span class="diffs__hint">AI 可能整体重排，序号仅供参考</span>
              </div>
              <ul class="diffs__list">
                <li v-for="item in summary.previews" :key="item.index" class="diff">
                  <span class="diff__no mono">#{{ item.index }}</span>
                  <div class="diff__body">
                    <p class="diff__before">{{ item.before || '（原来没有）' }}</p>
                    <p class="diff__after">{{ item.after || '（已被删除）' }}</p>
                  </div>
                </li>
              </ul>
            </div>

            <p v-else class="review__same">解析结果与原文一致，未检测到变化。</p>
          </div>

          <!--
            单文件 + 翻译：译文是全新内容，没有「前后对照」可言，所以上方的 summary 块不适用；
            而下面的多文件展开块又要求 multi —— 单文件时两块都不成立，界面会整片空白
            （用户报过：剪贴板读成功了、状态条也报了条数，但下面什么都没有）。
            这里直接列出逐条译文，不需要点开。
            守卫用 `!multi`（任务里的文件数）而不是 `results.length === 1`：后者在
            「2 个文件只勾 1 个」时也成立，会和下面那块同时渲染，同一份译文出现两遍。
          -->
          <div v-if="isTranslate && !multi && results.length === 1" class="review">
            <div class="diffs__head">
              <span>译文预览</span>
              <span class="diffs__hint">
                共 {{ results[0].lines.length }} 条 | {{ targetLangName }}
              </span>
            </div>
            <ul class="diffs__list">
              <li v-for="(pair, i) in pairsOf(results[0])" :key="i" class="diff">
                <span class="diff__no mono">#{{ i + 1 }}</span>
                <div class="diff__body">
                  <p class="pair__src">{{ pair.src || '（原文为空）' }}</p>
                  <p class="pair__dst">{{ pair.tr || '（译文为空）' }}</p>
                </div>
              </li>
            </ul>
          </div>

          <!-- 多文件：逐个文件展开查看校对结果 -->
          <div v-if="multi && results.length > 0" class="block">
            <div class="block__head">
              <span class="block__title"><Icon name="list" :size="14" /> 各文件的解析结果</span>
              <span class="block__hint">点文件名可展开</span>
            </div>
            <ul class="pick" :class="{ 'pick--open': expandedId !== null }">
              <li v-for="r in results" :key="r.fileId">
                <button
                  class="pick__row"
                  :class="{ 'is-bad': !!r.outcome.error, 'is-on': expandedId === r.fileId }"
                  type="button"
                  @click="!r.outcome.error && toggleExpand(r.fileId)"
                >
                  <Icon :name="r.outcome.error ? 'alert' : 'check'" :size="14" />
                  <span class="pick__name">{{ r.fileName }}</span>
                  <span class="pick__meta">
                    {{ r.outcome.error ? r.outcome.error : `${countOf(r)} 条` }}
                  </span>
                  <Icon
                    v-if="!r.outcome.error"
                    :name="expandedId === r.fileId ? 'chevron-up' : 'chevron-down'"
                    :size="14"
                    class="pick__caret"
                  />
                </button>

                <div v-if="expandedId === r.fileId && r.summary" class="result">
                  <p class="result__stat">
                    {{ r.summary.before }} 条 → {{ r.summary.after }} 条，
                    <template v-if="r.summary.changed > 0">
                      {{ r.summary.changed }} 处有变化
                    </template>
                    <template v-else>与原文完全一致</template>
                  </p>
                  <ul v-if="r.summary.previews.length > 0" class="diffs__list">
                    <li v-for="item in r.summary.previews" :key="item.index" class="diff">
                      <span class="diff__no mono">#{{ item.index }}</span>
                      <div class="diff__body">
                        <p class="diff__before">{{ item.before || '（原来没有）' }}</p>
                        <p class="diff__after">{{ item.after || '（已被删除）' }}</p>
                      </div>
                    </li>
                  </ul>
                  <p v-else class="block__hint">与原文一致，无变化。</p>
                </div>

                <!-- 翻译任务：展开看逐条译文，原文一并列出便于对照 -->
                <div v-else-if="expandedId === r.fileId && isTranslate" class="result">
                  <p class="result__stat">共 {{ r.lines.length }} 条译文</p>
                  <ul class="diffs__list">
                    <li v-for="(pair, i) in pairsOf(r)" :key="i" class="diff">
                      <span class="diff__no mono">#{{ i + 1 }}</span>
                      <div class="diff__body">
                        <p class="pair__src">{{ pair.src || '（原文为空）' }}</p>
                        <p class="pair__dst">{{ pair.tr || '（译文为空）' }}</p>
                      </div>
                    </li>
                  </ul>
                </div>
              </li>
            </ul>
          </div>

          <div v-if="parseError" class="warn">
            <Icon name="alert" :size="14" />
            <span>{{ parseError }}</span>
          </div>

          <div v-if="failedFiles.length > 0" class="warn">
            <Icon name="alert" :size="14" />
            <span>
              有 {{ failedFiles.length }} 个文件的输出无法解析出{{ isTranslate ? '译文' : '字幕' }}，
              暂不能{{ isTranslate ? '载入' : '覆盖' }}。请检查 AI 输出是否完整、分隔行是否被改动。
            </span>
          </div>
        </section>
      </template>
    </div>

    <!--
      底部横条：左边摊开当前状态，右边是本步骤的动作按钮。

      按钮从「内容区最下方」搬到这里，是因为它们本来就属于「这一屏的出口」，
      而不是内容的一部分 —— 第 1 步的内容（勾选区 + 文稿区 + 提示词预览）一长，
      按钮就被推到滚动区最深处，用户得先滚到底才看得到。搬到固定横条后，
      三步的按钮位置完全一致，进下一步时整条按钮一起换掉，不需要重新找。

      状态文案留在同一条里而不是单独一行：两行灰条上下叠着等于白占 30px 高度。
    -->
    <footer class="astatus" :class="`astatus--${noteKind}`">
      <Icon
        class="astatus__icon"
        :name="noteKind === 'error' ? 'alert' : noteKind === 'success' ? 'check' : 'info'"
        :size="13"
      />
      <span class="astatus__text">
        {{ noteText || '按上方步骤操作即可。全程不会上传任何内容。' }}
      </span>

      <div class="pane__actions">
        <!-- 第 1 步：唯一的出口是复制 -->
        <button
          v-if="step === 'copy'"
          class="btn btn--primary"
          type="button"
          :disabled="busy || !canCopy"
          @click="copyPrompt"
        >
          <Icon name="copy" :size="15" />
          <span>复制提示词</span>
        </button>

        <!-- 第 2 步：可以回退，也可以声明「已复制，去取回」 -->
        <template v-else-if="step === 'paste'">
          <button class="btn" type="button" @click="restart">
            <Icon name="refresh" :size="14" />
            <span>回到上一步</span>
          </button>
          <button class="btn btn--primary" type="button" @click="step = 'apply'">
            <span>我已复制结果，去取回</span>
            <Icon name="chevron-right" :size="15" />
          </button>
        </template>

        <!-- 第 3 步：先读取校验，校验通过才出现「确认」 -->
        <template v-else>
          <button
            class="btn"
            type="button"
            :disabled="busy || submitted"
            @click="readClipboard"
          >
            <Icon name="import" :size="15" />
            <span>
              {{ results.length > 0 ? '重新读取剪贴板' : isTranslate ? '读取剪贴板并校验' : '读取剪贴板并应用' }}
            </span>
          </button>
          <button
            v-if="canApply"
            class="btn btn--primary"
            type="button"
            @click="confirmApply"
          >
            <Icon name="check" :size="15" />
            <span>{{ isTranslate ? '载入译文（可撤回）' : '确认覆盖（可撤回）' }}</span>
          </button>
        </template>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.assist {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-base);
  color: var(--color-text-primary);
}

/* ---- 自绘标题栏 ---- */
.abar {
  height: var(--titlebar-height);
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-left: var(--space-4);
  background: var(--color-bg-surface);
  border-bottom: 1px solid var(--color-border);
  user-select: none;
  -webkit-app-region: drag;
}

.abar button {
  -webkit-app-region: no-drag;
}

.abar__brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.abar__mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  background: #2e3236;
  border-radius: var(--radius-sm);
}

.abar__name {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-semibold);
  white-space: nowrap;
}

.abar__center {
  flex: 1;
  display: flex;
  justify-content: center;
  min-width: 0;
}

.abar__sub {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.abar__right {
  display: flex;
  align-items: center;
  height: 100%;
}

.abar__btn,
.abar__icon {
  display: grid;
  place-items: center;
  height: var(--titlebar-height);
  color: var(--color-text-secondary);
  transition: background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.abar__icon {
  width: 40px;
}

.abar__icon:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.abar__icon--close:hover {
  background: var(--color-danger);
  color: var(--color-text-inverse);
}

/* 置顶开关：带文字，别让用户猜这个图钉是干嘛的 */
.abar__btn--pin {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-xs);
}

.abar__btn--pin:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.abar__btn--pin.is-on {
  color: var(--color-accent-text);
  background: var(--color-accent-subtle);
}

.abar__pin-label {
  white-space: nowrap;
}

.abar__sep {
  width: 1px;
  height: 16px;
  margin: 0 var(--space-1);
  background: var(--color-border);
}

/* ---- 步骤条 ---- */
.steps {
  flex: none;
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border-subtle);
}

.steps__item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  min-width: 0;
}

.steps__item.is-done {
  color: var(--color-text-secondary);
  border-color: var(--color-border-strong);
}

.steps__item.is-active {
  border-color: var(--color-accent);
  background: var(--color-accent-subtle);
  color: var(--color-accent-text);
  font-weight: var(--weight-medium);
}

.steps__no {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--color-bg-subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.steps__item.is-active .steps__no {
  background: var(--color-accent);
  /* 用反色令牌而不是写死白字：深色主题下 --color-accent 是浅灰，
     白字会变成「浅灰底 + 白字」，对比度只有 1.5:1，等于看不见 */
  color: var(--color-text-inverse);
}

.steps__item.is-done .steps__no {
  background: var(--color-success-subtle);
  color: var(--color-success);
}

.steps__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 主体 ---- */
.assist__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-5);
}

.empty {
  padding: var(--space-10) var(--space-6);
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.pane__title {
  font-size: var(--font-size-lg, 1rem);
  font-weight: var(--weight-semibold);
}

.pane__lead {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: var(--line-loose, 1.7);
}

.pane__lead strong {
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
}

/* 动作区：现在固定住在底部横条的右端，不再跟着内容滚走。
   不给 margin-top（那是内容区里的写法），靠横条的 align-items 对齐即可 */
.pane__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
}

/* ---- 区块（文件选择 / 文案输入 / 结果清单共用外壳）---- */
.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.block__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}

.block__title :deep(.icon) {
  color: var(--color-text-tertiary);
}

.block__hint,
.block__foot {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.block__foot strong {
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
}

/* 空选提示：与计数同一位置（视线不用挪），用 info 色说明「这里还差一步」 */
.block__foot--empty {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-secondary);
}

/* ---- 目标语言（翻译任务） ---- */
.langpick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.langpick .select {
  width: 200px;
}

.langpick .input {
  flex: 1;
  min-width: 0;
}

/* ---- 文件勾选 ---- */
.pick {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}

.pick__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
}

.pick__row:hover {
  background: var(--color-bg-hover);
}

.pick__row.is-on {
  background: var(--color-accent-subtle);
}

.pick__row.is-bad {
  color: var(--color-danger);
}

.pick__box {
  flex: none;
  accent-color: var(--color-accent);
}

.pick__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}

.pick__meta {
  margin-left: auto;
  flex: none;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 处理范围：一行一个文件（勾选框 + 文件名 + 已选条数 + 展开箭头），
   展开后是这个文件的全部字幕。整行不再是 label —— 右侧那个箭头必须是独立按钮，
   否则点它会连带把文件勾选一起切掉。 */
.pick__item {
  display: flex;
  flex-direction: column;
}

.pick__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
}

.pick__more {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

.pick__more:hover {
  background: var(--color-bg-active);
  color: var(--color-text-primary);
}

/* 展开的字幕清单：贴齐文件行，左侧缩进表示从属关系 */
.cues {
  margin: 0 0 var(--space-2) 22px;
  padding: var(--space-1) 0 var(--space-1) var(--space-3);
  border-left: 2px solid var(--color-border);
}

.cues__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-1);
}

.cues__tip {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.cues__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* 一个文件几百条时不能把整个区块撑开 */
  max-height: 260px;
  overflow-y: auto;
}

.cue {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 3px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.cue:hover {
  background: var(--color-bg-hover);
}

/* 取消勾选的条目压暗 + 去掉删除线以外的强调，一眼能扫出「哪些不发出去」 */
.cue.is-off .cue__text,
.cue.is-off .cue__no {
  color: var(--color-text-tertiary);
}

.cue__box {
  flex: none;
  margin-top: 3px;
  accent-color: var(--color-accent);
}

.cue__no {
  flex: none;
  min-width: 22px;
  text-align: right;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.cue__text {
  min-width: 0;
  color: var(--color-text-primary);
  line-height: var(--line-base);
  overflow-wrap: anywhere;
}

/* 参考强度：标题行 + 滑块 + 解释，三段贴在一起 */
.strength {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px dashed var(--color-border-subtle);
}

.strength__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  /* 与滑块同宽：否则「平衡」两个字会被推到区块最右边，和它描述的控件差出一大截 */
  max-width: 360px;
}

.strength__label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.strength__value {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

/* 第 3 步顶部那句「本次只覆盖 …」 */
.scope {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-accent-subtle);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: var(--line-base);
}

.scope svg {
  flex: none;
  margin-top: 2px;
}

/**
 * 多文件的结果清单里，行本身就是按钮（点了展开看内容），
 * 要把 button 的默认外观整个抹掉；第 1 步那些 <label> 行不受影响。
 */button.pick__row {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.pick__caret {
  flex: none;
  color: var(--color-text-tertiary);
}

/* 展开后不要再限制高度，否则 200px 的滚动区里塞不下对照明细 */
.pick--open {
  max-height: none;
}

/* ---- 多文件展开的结果预览 ---- */
.result {
  margin: 0 0 var(--space-2) var(--space-5);
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--color-border);
}

.result__stat {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

/* ---- 文案输入 ---- */
.script {
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: var(--font-size-xs);
  line-height: var(--line-base);
  resize: vertical;
}

.script:focus {
  outline: none;
  border-color: var(--color-accent);
}

.script__stat {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--font-size-xs);
  line-height: var(--line-base);
}

.script__stat :deep(.icon) {
  flex: none;
  margin-top: 1px;
}

.script__stat--ok {
  color: var(--color-success);
}

.script__stat--weak {
  color: var(--color-warning);
}

.script__stat--blocked {
  color: var(--color-danger);
}

/* ---- 提示 / 警告 ---- */
.warn {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-warning-subtle);
  color: var(--color-warning);
  font-size: var(--font-size-xs);
  line-height: var(--line-base);
}

.warn--soft {
  margin-top: var(--space-3);
}

/* 多文件时一行一个文件，靠 grid 的 gap 撑开行距（全局 p 的 margin 是 0）。
   min-width: 0 是必须的：flex 子项的默认最小宽度是内容宽度，长文件名会把整块顶出容器 */
.warn__body {
  display: grid;
  gap: 2px;
  min-width: 0;
}

/* ---- 提示词预览 ---- */
.prompt {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.prompt__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-inset);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-xs);
}

.prompt__label {
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
}

.prompt__meta {
  color: var(--color-text-tertiary);
}

.prompt__body {
  margin: 0;
  padding: var(--space-3);
  max-height: 320px;
  overflow: auto;
  background: var(--color-bg-surface);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.65;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.link {
  font-size: var(--font-size-xs);
  color: var(--color-accent-text);
}

/* ---- 分步说明 ---- */
.howto {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-left: var(--space-5);
  list-style: decimal;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: var(--line-loose, 1.7);
}

.tips {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
}

.tips__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  line-height: var(--line-base);
}

.tips__row :deep(.icon) {
  flex: none;
  margin-top: 1px;
  color: var(--color-text-tertiary);
}

/* ---- 校对概览 ---- */
.review {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.review__stat {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.review__cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.review__cell--wide {
  margin-left: auto;
  text-align: right;
}

.review__num {
  font-size: 22px;
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
}

.review__cap {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.review__arrow {
  color: var(--color-text-tertiary);
}

.review__same {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.diffs {
  border-top: 1px solid var(--color-border-subtle);
  padding-top: var(--space-3);
}

.diffs__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-2);
}

.diffs__hint {
  color: var(--color-text-tertiary);
}

.diffs__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 300px;
  overflow-y: auto;
}

.diff {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
}

.diff__no {
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding-top: 2px;
}

.diff__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.diff__before,
.diff__after,
.pair__src,
.pair__dst {
  font-size: var(--font-size-xs);
  line-height: var(--line-base);
  overflow-wrap: anywhere;
}

.diff__before {
  color: var(--color-text-tertiary);
  text-decoration: line-through;
  text-decoration-color: var(--color-border-strong);
}

.diff__after {
  color: var(--color-text-primary);
}

/* 译文对照：原文是参照物（弱化），译文是待确认的对象（正常） */
.pair__src {
  color: var(--color-text-tertiary);
}

.pair__dst {
  color: var(--color-text-primary);
}

/* ---- 底部状态条 ---- */
.astatus {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.astatus__icon {
  flex: none;
}

/*
 * 状态文案可以很长（「只识别到 1 个文件，但你选择了 2 个…」），必须能缩，
 * 否则会把右侧的按钮挤出窗口 —— flex 子项默认最小宽度就是内容宽度。
 */
.astatus__text {
  flex: 1;
  min-width: 0;
}

.astatus--success {
  color: var(--color-success);
}

.astatus--error {
  color: var(--color-danger);
}
</style>
