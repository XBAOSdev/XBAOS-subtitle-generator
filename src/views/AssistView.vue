<script setup lang="ts">
/**
 * 「AI 校对」辅助窗口。
 *
 * 这是一个**独立窗口**（Electron 里由主进程开，浏览器里用 ?window=assist 直达），
 * 因为它要陪用户跑完一段"跳出软件"的流程：准备提示词 → 去网页版 AI 粘贴 →
 * 把结果复制回来 → 在这个窗口里确认覆盖。窗口默认置顶，方便来回切换。
 *
 * 全程不联网：只读写剪贴板。网络请求由用户自己在浏览器里发起。
 *
 * 提示词在**这里**拼，不在主窗口 —— 因为第 1 步要让用户挑文件、贴原文稿，
 * 这两件事都会改变提示词的内容。主窗口只把「原料」送过来。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import type { AssistReviewPayload, AssistReviewTarget } from '@/types/engine'
import {
  parseModelOutput,
  parseTranslation,
  splitByFileMarks,
  summarizeReview,
  type ParseOutcome,
  type ReviewSummary,
} from '@/utils/llmResult'
import { buildReviewPrompt, buildTranslatePrompt, estimatePromptTokens } from '@/utils/llmPrompt'
import { pickPresentTerms, splitTerms } from '@/utils/prompt'
import { hasText } from '@/utils/segmentOps'
import { containmentSimilarity } from '@/utils/transcriptMerge'
import { formatDuration } from '@/utils/format'
import { toPlain } from '@/utils/plain'
import { branding } from '@/branding'
import Icon from '@/components/Icon.vue'

type Step = 'copy' | 'paste' | 'apply'

/* 只是为了让主题在辅助窗口也生效（store 初始化时会应用 data-theme） */
useSettingsStore()

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
 * 对照关系是位置关系：提示词里发出去的就是**有内容的条目**（`hasText` 过滤后），
 * 译文又按序号一一贴回，所以两边按下标对齐是稳的。
 */
function pairsOf(r: FileResult): { src: string; tr: string }[] {
  const target = targets.value.find((t) => t.fileId === r.fileId)
  const src = (target?.segments ?? [])
    .filter(hasText)
    .map((s) => s.text.replace(/\s*\n\s*/g, ' ').trim())
  return r.lines.map((tr, i) => ({ src: src[i] ?? '', tr }))
}
/** 单文件时的前后对照概览 */
const summary = ref<ReviewSummary | null>(null)
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
  let best = 0
  for (const t of list) {
    const text = t.segments.map((s) => s.text).join('')
    best = Math.max(best, containmentSimilarity(text, script))
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

/* --------------------------------------------------------- 提示词构建 */

/** 从手填热词与词库里挑出「这段内容真的出现过」的专有名词 */
function collectTerms(list: AssistReviewTarget[]): string[] {
  const config = payload.value?.settings
  if (!config) return []
  const out = splitTerms(config.promptTerms)
  if (config.lexiconIds.length > 0) {
    const text = list
      .map((t) => t.segments.map((s) => s.text).join(''))
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
  const list = selectedTargets.value
  if (list.length === 0) return null

  const mapped = list.map((t) => ({
    fileName: t.fileName,
    durationSec: t.durationSec,
    segments: t.segments,
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

function toggleSelect(fileId: string): void {
  selectedIds.value = selectedIds.value.includes(fileId)
    ? selectedIds.value.filter((id) => id !== fileId)
    : [...selectedIds.value, fileId]
}

function toggleSelectAll(): void {
  selectedIds.value = isAllSelected.value ? [] : targets.value.map((t) => t.fileId)
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
  const list = selectedTargets.value
  if (list.length === 0) {
    note('请先选择文件。', 'error')
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
      // 期望条数必须与提示词里实际发出去的行数一致 —— 提示词会剔掉空条目
      // （`usable()`），这里就得同样剔掉，否则空条目会让条数校验凭空多算。
      const out = parseTranslation(text, list.map((t) => t.segments.filter(hasText).length))
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
      summary.value = summarizeReview(outcome.cues, list[0].segments)
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
        summary: outcome.error ? null : summarizeReview(outcome.cues, list[i].segments),
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
        results: toPlain(ok.map((r) => ({ fileId: r.fileId, lines: r.lines }))),
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
      results: toPlain(ok.map((r) => ({ fileId: r.fileId, cues: r.outcome.cues }))),
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

          <!-- 文件选择：只有一个文件时不出现，免得白占地方 -->
          <div v-if="multi" class="block">
            <div class="block__head">
              <span class="block__title">
                <Icon name="list" :size="14" />
                {{ isTranslate ? '选择要翻译的文件' : '选择要校对的文件' }}
              </span>
              <button class="link" type="button" @click="toggleSelectAll">
                {{ isAllSelected ? '全部取消' : '全选' }}
              </button>
            </div>
            <ul class="pick">
              <li v-for="t in targets" :key="t.fileId">
                <label class="pick__row" :class="{ 'is-on': selectedIds.includes(t.fileId) }">
                  <input
                    class="pick__box"
                    type="checkbox"
                    :checked="selectedIds.includes(t.fileId)"
                    @change="toggleSelect(t.fileId)"
                  />
                  <span class="pick__name">{{ t.fileName }}</span>
                  <span class="pick__meta">
                    {{ t.segmentCount }} 条 | {{ formatDuration(t.durationSec) }}
                  </span>
                </label>
              </li>
            </ul>
            <p class="block__foot">
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

          <div v-if="!canCopy" class="warn">
            <Icon name="alert" :size="14" />
            <span>请至少选择一个文件。</span>
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

          <div class="pane__actions">
            <button
              class="btn btn--primary btn--lg"
              type="button"
              :disabled="busy || !canCopy"
              @click="copyPrompt"
            >
              <Icon name="copy" :size="15" />
              <span>复制提示词</span>
            </button>
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
                字幕内容会发送到你选择的 AI 服务，请注意隐私与版权。本软件不联网，
                也不会代为发送。
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

          <div class="pane__actions">
            <button class="btn" type="button" @click="restart">
              <Icon name="refresh" :size="14" />
              <span>回到上一步</span>
            </button>
            <button class="btn btn--primary btn--lg" type="button" @click="step = 'apply'">
              <span>我已复制结果，去取回</span>
              <Icon name="chevron-right" :size="15" />
            </button>
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

            <div v-if="results[0] && results[0].outcome.warnings.length > 0" class="warn warn--soft">
              <Icon name="alert" :size="14" />
              <span>
                时间码提示：{{ results[0].outcome.warnings.join('；') }}。可以继续应用，
                也可以在编辑器里再手工微调。
              </span>
            </div>

            <div v-if="summary.previews.length > 0" class="diffs">
              <div class="diffs__head">
                <span>变化明细（前 {{ summary.previews.length }} 处）</span>
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

          <div class="pane__actions">
            <button
              class="btn btn--primary btn--lg"
              type="button"
              :disabled="busy || submitted"
              @click="readClipboard"
            >
              <Icon name="import" :size="15" />
              <span>{{ results.length > 0 ? '重新读取剪贴板' : isTranslate ? '读取剪贴板并校验' : '读取剪贴板并应用' }}</span>
            </button>
            <button
              v-if="canApply"
              class="btn btn--lg btn--danger"
              type="button"
              @click="confirmApply"
            >
              <Icon name="check" :size="15" />
              <span>{{ isTranslate ? '载入译文（可撤回）' : '确认覆盖（可撤回）' }}</span>
            </button>
          </div>
        </section>
      </template>
    </div>

    <!-- 状态条：把结果和错误都摊在明面上，用户不用猜 -->
    <footer class="astatus" :class="`astatus--${noteKind}`">
      <Icon
        :name="noteKind === 'error' ? 'alert' : noteKind === 'success' ? 'check' : 'info'"
        :size="13"
      />
      <span>{{ noteText || '按上方步骤操作即可。全程不会上传任何内容。' }}</span>
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

.pane__actions {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-2);
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
  cursor: pointer;
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

/**
 * 多文件的结果清单里，行本身就是按钮（点了展开看内容），
 * 要把 button 的默认外观整个抹掉；第 1 步那些 <label> 行不受影响。
 */
button.pick__row {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
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
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.astatus--success {
  color: var(--color-success);
}

.astatus--error {
  color: var(--color-danger);
}
</style>
