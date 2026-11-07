<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useProjectStore, type ExportRecord } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useHistoryStore } from '@/stores/history'
import { useSpeakerStore } from '@/stores/speakers'
import { formatDuration } from '@/utils/format'
import { serializeSubtitle, applyLineEnding } from '@/utils/subtitle'
import { mergeSelected } from '@/utils/segmentOps'
import { countIssues, visibleIssues } from '@/utils/validate'
import { isTypingTarget } from '@/utils/typing'
import { useSplitAtPlayhead } from '@/composables/useSplitAtPlayhead'
import { translationLangsOf } from '@/utils/exportPlan'
import { confirmDestructive } from '@/utils/confirm'
import { toPlain } from '@/utils/plain'
import FileTree from '@/components/FileTree.vue'
import TimelineTrack from '@/components/TimelineTrack.vue'
import SubtitleTable from '@/components/SubtitleTable.vue'
import AudioPlayer from '@/components/AudioPlayer.vue'
import ToolPanel from '@/components/ToolPanel.vue'
import SpeakerPanel from '@/components/SpeakerPanel.vue'
import Icon from '@/components/Icon.vue'
import UiMenu from '@/components/UiMenu.vue'

const project = useProjectStore()
const ui = useUiStore()
const editor = useEditorStore()
const history = useHistoryStore()
const settings = useSettingsStore()
const speakerStore = useSpeakerStore()

/**
 * 当前视图条目。独立模式下是选中的那个文件，合并模式下是拼接产物 ——
 * 整个编辑器（波形 / 表格 / 工具栏 / 校验 / 导出）都只看它，这样
 * 「合并为一条时间轴」时界面上就只会有一条完整的时间轴。
 */
const activeFile = computed(() => project.viewFile)

/**
 * 音频对不上的子项目（缺失或被换过）。
 *
 * 提示条只留一个动作入口，每次处理第一个：修好一个，这一条就少一个，
 * 用户能看着数字往下走到 0。一次列出十几行按钮反而让人不知道从哪下手。
 */
const audioBad = computed(() => project.audioProblemFiles)

function fixAudio(): void {
  const first = audioBad.value[0]
  if (first) ui.openDialog('audio-map', { fileId: first.id })
}

/* -------------------------------------------------------- 全局快捷键 */
/* 挂在 window 上而不是表格根节点：焦点落在工具栏、波形、侧栏上时
   撤销重做和播放快捷键也得能用。编辑文本时让位给输入框自身的行为。 */

function onKeydown(event: KeyboardEvent): void {
  if (!activeFile.value) return
  const key = event.key
  const mod = event.ctrlKey || event.metaKey

  // 撤销 / 重做（编辑态由输入框自己处理历史，全局不抢）
  if (mod && !event.shiftKey && (key === 'z' || key === 'Z')) {
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    const file = activeFile.value
    const restored = history.undo(file.id, file.segments)
    if (restored) {
      file.segments = restored
      editor.clearSelection()
    }
    return
  }
  if (mod && (key === 'y' || key === 'Y' || (event.shiftKey && (key === 'z' || key === 'Z')))) {
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    const file = activeFile.value
    const restored = history.redo(file.id, file.segments)
    if (restored) {
      file.segments = restored
      editor.clearSelection()
    }
    return
  }

  // Ctrl+S 就地保存：字幕来源的条目，或导出过的条目（编辑文本时也允许保存）
  if (mod && !event.shiftKey && (key === 's' || key === 'S')) {
    event.preventDefault()
    if (canSaveInPlace.value) void saveInPlace()
    return
  }

  if (editor.editingId) return

  /*
   * Ctrl+B 分割。
   *
   * 这里是**未编辑**时的那一半：以时间轴播放头为刀口把当前条一分为二，
   * 文本整段复制、两段标红。编辑中的那一半在 SubtitleTable 的输入框里
   * （`onEditorKeydown`），以**文本光标**为界 —— 两者互斥、不会同时触发：
   * 编辑态时本函数在第 83 行就返回了。
   *
   * 为什么不合并成一套逻辑：用户指着的东西不一样。指着时间轴上的一个点时，
   * 我们从时间根本推不出它对应文本的第几个字；指着文本里的一个字符时，
   * 时间又该按字符比例分。硬凑成一条路径必然有一边是错的。
   */
  if (mod && !event.shiftKey && (key === 'b' || key === 'B')) {
    /*
     * 从输入框里冒出来的 Ctrl+B 一律不管：那是「按文本光标分割」，归文本框自己。
     * 光靠上面那句 `if (editor.editingId) return` 拦不住 —— splitAtCaret 会先退出
     * 编辑态（它必须退，否则 textarea 的 v-model 还指着旧条目），等事件冒泡到
     * window 时 editingId 已经空了。于是同一次按键会在这里再按播放头切一刀。
     * 输入框那边已经 stopPropagation，这里是第二道防线。
     */
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    splitAtPlayhead()
    return
  }

  // Ctrl+↑/↓ 切换上 / 下一个文件（帮助面板里一直列着，之前没实现）
  //
  // 与上面几条同一个道理：焦点在输入框里时让位。时间码框是一个真正的 <input>，
  // 它不经过 `editor.editingId`（那句只认字幕文本框），少了这道判断，
  // 在时间码里按 Ctrl+↑ 会一边没人管、一边把文件切走。
  if (mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    switchFile(key === 'ArrowUp' ? -1 : 1)
    return
  }

  // Ctrl+M 合并选中
  if (mod && (key === 'm' || key === 'M')) {
    event.preventDefault()
    const file = activeFile.value
    const result = mergeSelected(file.segments, editor.selectedIds)
    if (result) {
      history.commit(file.id, file.segments, '合并字幕', () => {
        file.segments = result.list
        editor.select(result.merged.id, 'replace', result.list.map((s) => s.id))
      })
    }
    return
  }

  // Ctrl+A 全选（表格语境）
  if (mod && (key === 'a' || key === 'A')) {
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    editor.selectedIds = activeFile.value.segments.map((s) => s.id)
    return
  }

  // Ctrl+H 查找替换
  if (mod && (key === 'h' || key === 'H')) {
    event.preventDefault()
    ui.openDialog('find-replace')
    return
  }

  // Space 播放 / 暂停
  if (key === ' ' || key === 'Spacebar') {
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    if ((activeFile.value?.durationSec ?? 0) > 0) editor.togglePlay()
    return
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/**
 * 按时间轴播放头分割字幕（Ctrl+B 的另一半语义，仅在未编辑文本时生效）。
 *
 * 实现放在 `useSplitAtPlayhead`：工具栏的「分割」按钮走的是同一份逻辑，
 * 免得出现「按钮亮着、点下去却按另一套规则切」。这里只负责快捷键这一侧。
 */
const { splitAtPlayhead } = useSplitAtPlayhead()

/** Ctrl+↑/↓ 在文件之间跳。合并模式下只有一条拼接产物，没有「下一个文件」 */
function switchFile(direction: -1 | 1): void {
  if (project.isMerge) return
  const list = project.supportedFiles
  if (list.length < 2) return
  const at = list.findIndex((f) => f.id === project.viewFileId)
  if (at < 0) return
  const next = list[(at + direction + list.length) % list.length]
  if (next) project.setActiveFile(next.id)
}

/** 左栏只在多文件、合并模式或存在不支持的文件时出现 */
/** 左栏：只要开着项目就显示（项目条 + 子项目行是导航的主入口） */
const showFileTree = computed(() => project.drafts.length > 0)

/**
 * 校验结果列表。
 *
 * 用 `visibleIssues` 而不是裸的 `seg.issues`：用户已经整条「忽略」的条目不该
 * 再出现在这里 —— 他按下那个按钮的意思就是「我看过了，别再提醒」。数据层的
 * issues 不动，取消忽略后列表照旧。
 */
const issues = computed(() =>
  (activeFile.value?.segments ?? [])
    .map((seg, index) => ({ seg, index }))
    .filter((item) => visibleIssues(item.seg).length > 0),
)

/**
 * 当前文件的告警条数（本页底栏用）。
 *
 * 与底部状态栏的分工：**这里只算当前这一份**，状态栏算整个工程。两个数字
 * 长得一样时容易被当成重复渲染，其实口径不同 —— 用户正在编辑哪个文件，
 * 就该在这里看到那个文件的数。只有工程里确实只有一个字幕文件时二者必然
 * 相等，那种情况下重复是合理的，不必刻意错开。
 */
const fileIssues = computed(() => countIssues(activeFile.value?.segments ?? []))

function gotoSegment(id: string, start: number): void {
  const list = activeFile.value?.segments ?? []
  editor.select(id, 'replace', list.map((s) => s.id))
  editor.setPlayhead(start)
}

/**
 * AI 校对：把「提示词 + 当前条目」交给辅助窗口。
 *
 * 走剪贴板中转：软件不代用户发起请求，提示词由用户手工粘到网页版 AI 助手，
 * 结果再由用户复制回来。所以这里只负责准备数据并开窗。
 */
/**
 * 可校对的文件集合。
 *
 * 合并模式下只有拼接产物那一条（时间轴已经是全局的，不存在"多个文件"）；
 * 独立模式下是所有已经识别出内容的文件 —— 用户可能一次只想校对其中几个，
 * 所以交给辅助窗口第 1 步去勾选。
 */
const reviewTargets = computed(() => {
  if (project.isMerge) {
    const view = project.viewFile
    return view && view.segments.length > 0 ? [view] : []
  }
  return project.supportedFiles.filter((f) => f.segments.length > 0)
})

const canAiReview = computed(() => reviewTargets.value.length > 0)

/**
 * 「AI 校对」引导气泡要不要显示。
 *
 * 四个条件缺一不可：
 *   - 设置里的总开关开着；
 *   - 用户没点过「不再提示」（那是永久决定，写进设置）；
 *   - 这一次运行里没被「×」关掉（只存内存，重开软件还会再提示一次）；
 *   - 当前确实有字幕可校对 —— 没有字幕时按钮本身就是灰的，气泡指着它毫无意义。
 */
const showAiTip = computed(
  () =>
    settings.aiReviewTipEnabled &&
    !settings.aiReviewTipDismissed &&
    !ui.aiTipClosed &&
    canAiReview.value,
)

/** 气泡右上角的「×」：只关这一次，不写盘 */
function closeAiTip(): void {
  ui.aiTipClosed = true
}

/** 气泡左上角的「不再提示」：写进设置，之后永远不出现 */
function muteAiTip(): void {
  settings.aiReviewTipDismissed = true
  ui.aiTipClosed = true
}

/**
 * 选中范围里已经存在的译文语言。
 *
 * 用来在开窗之前提醒后果 —— 两个 AI 功能都会动到译文：校对会整体重建字幕
 * （译文一并消失），翻译会覆盖同语言的那一份。
 */
const existingTrLangs = computed(() =>
  translationLangsOf(reviewTargets.value.flatMap((f) => f.segments)),
)

async function openAiReview(): Promise<void> {
  const bridge = window.xbaos
  const list = reviewTargets.value
  if (list.length === 0) {
    ui.notify('info', '当前没有可校对的字幕')
    return
  }
  if (!bridge?.assist?.open) {
    ui.notify('info', '浏览器预览模式不支持 AI 校对', '请在桌面应用中使用')
    return
  }

  // 已有译文必须先说清楚：校对结果是**整体替换**字幕，译文不会保留，
  // 而这件事在窗口里是看不出来的（那边只看得到原文）。
  const langs = existingTrLangs.value
  if (langs.length > 0) {
    const ok = await confirmDestructive({
      title: '继续校对会清除已有译文',
      message: `这些字幕已有译文（${langs.join(' / ')}）。AI 校对按校对结果重建字幕，译文不会保留。`,
      detail: '校对结果里不含译文。若仍需要译文，请在校对完成后再翻译一次。本次改动可用 Ctrl+Z 撤回。',
      confirmLabel: '仍然校对',
    })
    if (!ok) return
  }

  // 开窗失败必须有反馈：否则点下去毫无动静，用户只会以为按钮坏了
  try {
    await bridge.assist.open({
      // 必须是纯数据：另一个渲染进程拿不到 store，而 Pinia 里的条目是
      // Vue 深度代理，直接扔给 IPC 会被 structuredClone 拒收
      // （`An object could not be cloned.`）。展开运算符解不掉嵌套的 issues 数组。
      targets: toPlain(
        list.map((f) => ({
          fileId: f.id,
          fileName: f.name,
          durationSec: f.durationSec ?? 0,
          segmentCount: f.segments.length,
          segments: f.segments,
        })),
      ),
      // 提示词要到辅助窗口才拼 —— 用户会在那边挑文件、贴文案
      settings: toPlain({
        language: settings.language,
        autoDetectLanguage: settings.autoDetectLanguage,
        punctuation: settings.punctuation,
        maxCharsPerLine: settings.maxCharsPerLine,
        maxCharsPerLineEn: settings.maxCharsPerLineEn,
        maxLinesPerSegment: settings.maxLinesPerSegment,
        maxSegmentDuration: settings.maxSegmentDuration,
        promptTerms: settings.promptTerms,
        lexiconIds: settings.lexiconIds,
      }),
    })
  } catch (err) {
    ui.notify('error', '打不开 AI 校对窗口', String((err as Error)?.message ?? err))
    return
  }
  // 窗口开起来了就把主界面锁上，直到它关闭
  ui.setAssistActive(true)
}

/* ---------------------------------------------------- AI 翻译 */

/**
 * 可翻译的文件集合：与校对完全相同。
 *
 * 单独留一个 computed 而不是直接复用 `reviewTargets`，是为了让「只翻某些文件」
 * 这类规则以后单独变化时，不会顺手把校对那一侧也改了。
 */
const translateTargets = computed(() => reviewTargets.value)

const canAiTranslate = computed(() => translateTargets.value.length > 0)

/**
 * AI 翻译：与校对走同一条中转链路（辅助窗口 + 剪贴板），只是任务类型不同。
 *
 * 目标语言**不在主窗口选** —— 与「文案参考」同理，那是用户在辅助窗口第 1 步
 * 边看字幕边定的事。主窗口只管把条目送过去。
 */
async function openAiTranslate(): Promise<void> {
  const bridge = window.xbaos
  const list = translateTargets.value
  if (list.length === 0) {
    ui.notify('info', '当前没有可翻译的字幕')
    return
  }
  if (!bridge?.assist?.open) {
    ui.notify('info', '浏览器预览模式不支持 AI 翻译', '请在桌面应用中使用')
    return
  }

  // 已有译文时先说清后果。这里能说的很具体：同语言替换、异语言并存 ——
  // 用户最容易误解成「译文只能有一份，再翻一次就把旧的丢了」。
  const langs = existingTrLangs.value
  if (langs.length > 0) {
    const ok = await confirmDestructive({
      title: '这些字幕已有译文',
      message: `继续翻译时，选择同一种语言会整体替换那份译文；选择其他语言则与现有译文并存。`,
      detail: `现有译文：${langs.join(' / ')}。无论哪种情况，本次改动都可用 Ctrl+Z 撤回。`,
      confirmLabel: '继续翻译',
    })
    if (!ok) return
  }

  // 开窗失败必须有反馈：否则点下去毫无动静，用户只会以为按钮坏了
  try {
    await bridge.assist.open({
      task: 'translate',
      // 目标语言留空，由辅助窗口里现场选
      targetLang: '',
      targets: toPlain(
        list.map((f) => ({
          fileId: f.id,
          fileName: f.name,
          durationSec: f.durationSec ?? 0,
          segmentCount: f.segments.length,
          segments: f.segments,
        })),
      ),
      settings: toPlain({
        language: settings.language,
        autoDetectLanguage: settings.autoDetectLanguage,
        punctuation: settings.punctuation,
        maxCharsPerLine: settings.maxCharsPerLine,
        maxCharsPerLineEn: settings.maxCharsPerLineEn,
        maxLinesPerSegment: settings.maxLinesPerSegment,
        maxSegmentDuration: settings.maxSegmentDuration,
        promptTerms: settings.promptTerms,
        lexiconIds: settings.lexiconIds,
      }),
    })
  } catch (err) {
    ui.notify('error', '打不开 AI 翻译窗口', String((err as Error)?.message ?? err))
    return
  }
  ui.setAssistActive(true)
}

/** 有未保存改动的项目（侧栏的多项目都在这里，活动项目读活引用） */
const dirtyDrafts = computed(() =>
  project.drafts.filter((d) =>
    d.id === project.activeDraftId ? project.projectDirty : d.dirty,
  ),
)

/**
 * 保存项目（方案 5.3）：主按钮只存**当前**这一个。
 * 同时开着多个、不止一个脏的时候，按钮右侧出小三角，展开「保存全部项目」——
 * 按一下主按钮就把别人也写了，属于意料之外的副作用。
 */
function saveProjectFile(): void {
  if (project.projectPath) void project.saveProject()
  else ui.openDialog('save-project')
}

const saveMenu = ref<{ x: number; y: number } | null>(null)

function openSaveMenu(event: MouseEvent): void {
  saveMenu.value = { x: event.clientX, y: event.clientY }
}

function onSaveMenuPick(key: string): void {
  saveMenu.value = null
  if (key === 'save-all') void project.saveAllProjects()
}

const saveAllItems = computed(() => [
  {
    key: 'save-all',
    label: '保存全部项目',
    hint: `${dirtyDrafts.value.length} 个`,
  },
])

/** 悬停提示：没保存过的项目要说明「这一下会问你存哪」 */
const saveProjectHint = computed(() =>
  project.projectPath
    ? `保存到 ${project.projectPath}`
    : '保存为项目文件（.xbsgp），下次可以直接打开继续编辑',
)

function openExport(): void {
  if (project.supportedFiles.length === 0) {
    ui.notify('info', '还没有可导出的字幕')
    return
  }
  // 项目视图要等有字幕内容才值得打开导出（空时间轴导出去只会是空文件）
  if ((project.viewFile?.segments.length ?? 0) === 0) {
    ui.notify('warning', '还没有可导出的字幕', '合并模式下需要先完成识别，才会有拼接好的时间轴')
    return
  }
  ui.openDialog('export')
}

/* ---------------------------------------------------- 字幕文件的保存 */

/**
 * 只有一个子项目时，视图与那一份文件完全重合。
 *
 * 拼接视图本身不携带 `subtitleFormat` / 导出落点（那两样都属于具体文件），
 * 但项目里只有一份的时候，「这条时间轴」和「那个文件」是同一件事 —— 不认这
 * 一层，导出一个单文件项目之后底栏不会出现「保存」，用户只能再走一遍导出。
 * 多子项目时刻意**不认**：那时底栏保存写的是整条拼接时间轴，往其中任意一份
 * 的路径上写会把别人的内容盖掉。
 */
const soloFile = computed(() => (project.files.length === 1 ? project.files[0] : null))

/** 来源是字幕文件（而非音频识别）的条目 */
const isSubtitleSource = computed(
  () => !!(activeFile.value?.subtitleFormat ?? soloFile.value?.subtitleFormat),
)

/**
 * 当前条目上一次导出的文件（内存记录，清空队列即释放）。
 *
 * 有了它，「导出完又改了几个字」就不必重走一遍导出对话框 —— 直接覆盖写回原位。
 * 可能是**多个**文件：「分别导出」会把原文与译文写成两个。
 */
const exportedRecords = computed(() => {
  const own = project.exportRecordsOf(project.viewFileId)
  if (own.length > 0) return own
  return soloFile.value ? project.exportRecordsOf(soloFile.value.id) : []
})

/**
 * 能否就地保存。
 *
 * 合并产物是个例外：它的 `path` 借用的是第一个音频，拿它当保存目标会把字幕
 * 写到那个音频旁边，看起来像是另一个文件的产物。所以合并模式下只有「明确
 * 导出过」才提供保存。
 *
 * （原来的「另存为」已去掉：它和「导出字幕」功能重叠，而导出能选目录、格式、
 * 编码与文件名模板，能力更全。）
 */
const canSaveInPlace = computed(() => {
  if (project.isMerge) return exportedRecords.value.length > 0
  return isSubtitleSource.value || exportedRecords.value.length > 0
})

const saveHint = computed(() => {
  const list = exportedRecords.value
  if (list.length === 1) return `覆盖保存到上次导出的文件：${list[0].path}`
  if (list.length > 1) {
    return `覆盖保存到上次导出的 ${list.length} 个文件：${list.map((r) => r.path).join('、')}`
  }
  return `覆盖保存回原字幕文件：${activeFile.value?.path ?? ''}`
})

/**
 * 把当前视图的条目写成字幕文件。
 *
 * 格式优先跟随源文件（字幕导入的条目带 `subtitleFormat`）；音频识别出来的条目
 * 没有「原格式」，就跟随导出设置。编码同理：字幕导入时检测到的编码优先，
 * 保证不悄悄换码。
 */
async function writeSubtitleTo(path: string, record?: ExportRecord): Promise<void> {
  const file = activeFile.value
  const bridge = window.xbaos
  if (!file || !bridge) return
  const fmt = file.subtitleFormat ?? settings.exportFormat
  // 带 record 时要**照它原来导出的样子重写**：一份中英对照的字幕，
  // 不该因为按了一次保存就变成纯中文
  const body = serializeSubtitle(fmt, file.segments, {
    lang: record?.bundle ?? 'source',
    translationLang: record?.lang ?? '',
    sourceFirst: settings.exportLangSourceFirst,
    // 导出时带了讲话人标签，就地保存也必须带 —— 否则按一次保存就把标签抹掉了
    speakerPrefix: settings.speakerPrefixEffective,
    speakerNames: speakerStore.namesOf(file.id),
    // 编号是子项目本地的：按条目自己的来源查称呼，别拿一张平表硬套
    speakerNameOf: (seg) =>
      speakerStore.nameOf(seg.originFileId ?? file.id, seg.speaker ?? -1),
  })
  const content = applyLineEnding(body, settings.exportLineEnding)
  await bridge.fs.writeSubtitle(path, content, file.sourceEncoding ?? settings.exportEncoding)
}

/** 就地保存：优先写回上次导出的那些文件，没有就写回字幕源文件 */
async function saveInPlace(): Promise<void> {
  const file = activeFile.value
  if (!file || !canSaveInPlace.value) return

  // 有导出记录就照记录整份重写（分别导出时是多个文件，都要跟上）；
  // 没有记录时走的是「字幕文件导入」那条路径，写回它自己的原文件
  const records = exportedRecords.value
  const targets: ExportRecord[] =
    records.length > 0 ? records : [{ path: file.path } as ExportRecord]
  const valid = targets.filter((t) => t.path)
  if (valid.length === 0) return

  try {
    for (const target of valid) {
      await writeSubtitleTo(target.path, records.length > 0 ? target : undefined)
    }
    // 登记「这一版内容已经落盘」，关窗时才不会误报未保存
    project.markSaved(file.id, file.segments)
    ui.notify(
      'success',
      '已保存',
      valid.length === 1 ? valid[0].path : `${valid.length} 个文件`,
    )
  } catch (err) {
    ui.notify('error', '保存失败', err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div class="editor">
    <FileTree v-if="showFileTree" />

    <!--
      还没有任何子项目：不摆一堆空控件，直接说明这里能干什么。
      这个页面现在**任何时刻都能进来**（侧栏不再因识别中而灰掉），
      所以第一次进来很可能什么都没识别完 —— 空态必须是句人话。
    -->
    <div v-if="!project.hasFiles" class="editor__empty">
      <Icon name="list" :size="22" class="editor__empty-icon" />
      <p class="editor__empty-title">还没有可编辑的字幕</p>
      <p class="editor__empty-text">
        导入音频并完成识别，或者直接打开一个 .srt / .vtt / .ass 字幕文件。
      </p>
      <button class="btn btn--primary" type="button" @click="ui.navigate('home')">
        去导入
      </button>
    </div>

    <div v-else class="editor__body">
      <div class="editor__center">
        <!-- 音频对不上：路径失效或被换过。不给提示的话，用户先看到的是
             一片空波形，然后以为软件坏了 -->
        <div v-if="audioBad.length > 0" class="audbar">
          <Icon name="alert" :size="13" />
          <span class="audbar__text">
            <strong>{{ audioBad.length }}</strong> 个子项目的音频对不上：
            {{ audioBad[0].name }}{{ audioBad.length > 1 ? ' 等' : '' }}
          </span>
          <button class="btn btn--sm" type="button" @click="fixAudio">音频映射</button>
        </div>

        <TimelineTrack />
        <SubtitleTable />
      </div>

      <aside class="editor__side">
        <!--
          播放控制区**不在滚动区里**：它是这一列的第一段，天生固定。
          以前用 sticky 压在滚动内容上，顶边和右边会露出底下的颜色（滚动条还从旁边穿过）；
          改成两段之后，滚动只发生在下面那一段，边界由布局给定，不靠浮层盖。
        -->
        <div class="editor__side-top">
          <AudioPlayer />
        </div>

        <div class="editor__side-scroll scroll-y">
          <ToolPanel />

          <!-- AI 功能：与「讲话人」分开成组，两个入口都靠剪贴板中转 -->
          <hr class="divider" />
          <div class="aiside">
            <div class="aiside__head">
              <span class="aiside__title">AI 功能</span>
            </div>
            <div class="aiside__row">
              <button
                class="btn btn--ai"
                type="button"
                :disabled="!canAiReview"
                :title="
                  canAiReview
                    ? '交给网页版 AI 助手校对。经剪贴板中转，软件不代你发送'
                    : '当前没有可校对的字幕'
                "
                @click="openAiReview"
              >
                <Icon name="spell-check" :size="14" />
                <span>AI 校对</span>
              </button>
              <button
                class="btn btn--ai"
                type="button"
                :disabled="!canAiTranslate"
                :title="
                  canAiTranslate
                    ? '交给网页版 AI 助手翻译成其他语言。经剪贴板中转，软件不代你发送'
                    : '当前没有可翻译的字幕'
                "
                @click="openAiTranslate"
              >
                <Icon name="globe" :size="14" />
                <span>AI 翻译</span>
              </button>
            </div>

            <!-- 引导放在按钮下方、随内容走：侧栏只有 232px，浮层压不住也不该压住别的面板 -->
            <div v-if="showAiTip" class="aitip" role="note">
              <p class="aitip__text">AI 校对能减少识别里的小错误。</p>
              <div class="aitip__acts">
                <button class="aitip__never" type="button" @click="muteAiTip">不再提示</button>
                <button
                  class="aitip__close"
                  type="button"
                  aria-label="关闭提示"
                  @click="closeAiTip"
                >
                  <Icon name="x" :size="11" />
                </button>
              </div>
            </div>
          </div>

          <!-- 讲话人：只有当前文件真的有讲话人（或手动新增过）时才出现，自带上方分隔线 -->
          <SpeakerPanel />
          <hr class="divider" />

          <div class="issues">
            <div class="issues__head">
              <span class="issues__title">校验结果</span>
              <span class="issues__count">
                {{
                  issues.length > 0
                    ? `${issues.length} 条待处理`
                    : '未发现问题'
                }}
              </span>
            </div>

            <ul v-if="issues.length > 0" class="issues__list">
              <li v-for="item in issues.slice(0, 12)" :key="item.seg.id">
                <button
                  class="issues__row"
                  type="button"
                  @click="gotoSegment(item.seg.id, item.seg.start)"
                >
                  <span
                    class="issues__dot"
                    :class="`issues__dot--${item.seg.issues[0].level}`"
                  />
                  <span class="issues__index mono">#{{ item.index + 1 }}</span>
                  <span class="issues__text">{{ item.seg.issues[0].message }}</span>
                </button>
              </li>
              <li v-if="issues.length > 12" class="issues__more">
                还有 {{ issues.length - 12 }} 条未列出
              </li>
            </ul>
          </div>
        </div>
      </aside>
    </div>

    <footer v-if="project.hasFiles" class="editor__foot">
      <span class="editor__stat">
        共 <strong>{{ activeFile?.segments.length ?? 0 }}</strong> 条
      </span>
      <span class="editor__sep" aria-hidden="true">|</span>
      <span class="editor__stat">
        时长 <strong>{{ formatDuration(activeFile?.durationSec) }}</strong>
      </span>
      <span class="editor__sep" aria-hidden="true">|</span>
      <span
        class="editor__stat editor__stat--warn"
        title="当前这个文件的校验结果；底部状态栏给的是整个工程的合计"
      >
        {{ fileIssues.errors }} 条错误，{{ fileIssues.warnings }} 条警告
      </span>

      <span class="spacer" />

      <!-- 保存：主按钮 + 小三角拼成一组。三角单独立着像个走丢的方块，
           合并之后一眼看出「更多保存方式」属于保存这一个动作 -->
      <span class="btngroup">
        <button
          class="btn"
          type="button"
          :title="saveProjectHint"
          :disabled="project.supportedFiles.length === 0"
          @click="saveProjectFile"
        >
          <Icon name="save" :size="14" />
          <span>保存项目</span>
          <span v-if="project.projectDirty" class="editor__dot" aria-hidden="true" />
        </button>
        <button
          v-if="dirtyDrafts.length > 1"
          class="btn"
          type="button"
          title="更多保存方式"
          @click="openSaveMenu"
        >
          <Icon name="chevron-down" :size="12" />
        </button>
      </span>
      <button
        v-if="canSaveInPlace"
        class="btn"
        type="button"
        :title="saveHint"
        @click="saveInPlace"
      >
        <Icon name="check" :size="14" />
        <span>保存</span>
      </button>
      <button class="btn" type="button" @click="openExport">
        <Icon name="download" :size="14" />
        <span>导出字幕</span>
      </button>
    </footer>

    <UiMenu
      v-if="saveMenu"
      :x="saveMenu.x"
      :y="saveMenu.y"
      :items="saveAllItems"
      @close="saveMenu = null"
      @pick="onSaveMenuPick"
    />
  </div>
</template>

<style scoped>
/*
 * 页面骨架：两列两行。
 *
 * ```
 * ┌──────────┬──────────────────────┐
 * │ 侧栏      │ 中间 + 右侧（body）    │
 * │（跨两行） ├──────────────────────┤
 * │          │ 底栏（只属于右半边）    │
 * └──────────┴──────────────────────┘
 * ```
 *
 * 底栏原来横跨整个窗口，读的却是**当前这个项目**的文件数 / 字数 / 告警。
 * 一行「当前项目」的数字铺满全宽，位置又在最外一层，看起来就像在说全局 ——
 * 切项目时它整行跟着变，但视觉上没有任何东西提示「这只跟你选的那个项目有关」。
 * 让侧栏落到底、底栏缩回右半边之后，层级自己就说清楚了。
 */
.editor {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
}

/* 侧栏从顶部一路落到底：它是「项目列表」，属于整个页面 */
.editor > :deep(.filetree) {
  grid-column: 1;
  grid-row: 1 / span 2;
  /* 自己那一列宽 232px；grid 的 auto 列跟着它走 */
  min-height: 0;
}

.editor__body {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  /*
   * 窗口很窄时（三栏挤在一起）中间区会被压成一条缝 —— 780px 宽时只剩
   * 七十几个像素，表格里除复选框什么都放不下。给中间区一个下限，
   * 不足的部分由这一行**整体横滑**补上：右边的工具面板会被推出去，
   * 滑一下就能回来，而字幕本身至少还是可读的宽度。
   *
   * 表格自己还有一层横滑（min-width 620），那是「列」的层面；
   * 这里是「三个面板」的层面，两者不冲突。
   */
  overflow-x: auto;
  overflow-y: hidden;
}

.editor__empty {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-10) var(--space-6);
  text-align: center;
}

.editor__empty-icon {
  margin-bottom: var(--space-1);
  color: var(--color-text-disabled);
}

.editor__empty-title {
  font-size: var(--font-size-md);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

.editor__empty-text {
  max-width: 34em;
  font-size: var(--font-size-sm);
  line-height: var(--line-base);
  color: var(--color-text-tertiary);
}

.editor__empty > .btn {
  margin-top: var(--space-2);
}

/*
 * 「有未保存改动」的小圆点，挂在「保存项目」的文字后面。
 *
 * 曾经这里是一个纯图标按钮（`layers` + 一个点），因为文字版会把右边的
 * 「AI 翻译」挤出可视区。P4 之后侧栏接了多项目，这一排的构成变了，
 * 图标版反而让人认不出它是保存 —— 现在是「图标 + 文字」。
 */
.editor__dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-left: 1px;
  border-radius: 50%;
  background: var(--color-accent);
}

/* 「保存项目」右侧的小三角：只在多项目都有改动时出现 */
.editor__center {
  flex: 1;
  /* 中间区的下限：窗口再窄也不把字幕压成一条缝（见 .editor__body 的注释） */
  min-width: 360px;
  display: flex;
  flex-direction: column;
}

/* 合并模式说明条 */
/* 音频对不上的提示条：用警告色，与合并说明区分开（那是常态，这是要处理的） */
.audbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-warning-subtle);
  color: var(--color-warning);
  font-size: 11px;
}

.audbar__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.audbar__text strong {
  font-variant-numeric: tabular-nums;
  font-weight: var(--weight-semibold);
}

.editor__side {
  width: 264px;
  flex: none;
  /* 两段式：上面播放区不滚、下面工具区自己滚，内边距交给两段各自给 */
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-surface);
}

/*
 * 右栏的播放控制区：**滚动区之外**的一段，天生固定。
 *
 * 不 sticky、不铺浮层底色、不加阴影：它在布局里就占着这个位置，下面的内容
 * 在自己的滚动段里滚，永远不会从它身下穿过 —— 也就没有「顶边和右边漏出底色」
 * 这回事（那是 sticky 压在 padding 里必然留下的缝，滚动条还会从旁边穿过去）。
 */
.editor__side-top {
  flex: none;
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border-subtle);
}

/* 工具 / AI / 讲话人 / 校验结果：只有这一段滚，滚动条也只在这一段里出现 */
.editor__side-scroll {
  flex: 1;
  min-height: 0;
  padding: var(--space-4);
}

.editor__foot {
  /* 只占右半边：左边那列是贯穿到底的项目侧栏 */
  grid-column: 2;
  grid-row: 2;
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  /*
   * 按钮多了之后必须允许换行：底栏不换行时，窗口一窄就把右边的按钮整个
   * 挤出可视区（不是被压窄，是直接看不到，也没有滚动条）。同时禁止按钮被
   * 压 —— 中文按钮被压窄会变成一列竖排的字。
   */
  flex-wrap: wrap;
  row-gap: var(--space-2);
  /*
   * 换行之后底栏会变高，不许它把上面的编辑区挤掉。
   *
   * 这里**不能用百分比**：底栏现在是 grid 的一格，`max-height: 40%` 会按
   * 「这一行的高度」算（约 49px × 0.4 ≈ 20px），把整条底栏压成一条 20px 的缝，
   * 按钮溢在里面只能竖着滚。给一个绝对上限（两行按钮 + 内边距）。
   */
  max-height: 120px;
  overflow-y: auto;
}

.editor__foot > .btn {
  flex: none;
}

.editor__stat strong {
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
  font-weight: var(--weight-medium);
}

.editor__stat--warn {
  color: var(--color-warning);
}

.editor__sep {
  color: var(--color-border-strong);
}

/**
 * AI 校对入口的辨识度靠颜色、留白与投影，不靠高度 ——
 * 底部这一排控件（状态徽章 / AI 校对 / 保存 / 导出字幕）高度一律走
 * .btn 基类的 --control-height(32px)，否则一排里混着 20/32/38px 会很乱。
 * 这里只加宽内边距让入口更醒目。
 */
.editor__foot .btn--ai {
  padding: 0 var(--space-4);
  box-shadow: 0 2px 8px -2px var(--color-ai-border);
}

.editor__foot .btn--ai:disabled {
  box-shadow: none;
}

/*
 * AI 功能小节。
 *
 * 两个入口从底栏搬到了侧栏：底栏那一排要留给「保存 / 导出」这类有先后顺序的
 * 动作，AI 是随手可用的辅助能力，跟「讲话人」一样属于侧栏的加工工具。
 */
.aiside {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.aiside__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.aiside__title {
  flex: none;
  white-space: nowrap;
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}

.aiside__row {
  display: flex;
  gap: var(--space-2);
}

/* 两个按钮等宽平分：并排的两个入口看不出主次，宽度不一致只会显得没对齐 */
.aiside__row > .btn {
  flex: 1;
  min-width: 0;
  padding: 0 var(--space-2);
}

/* 一次性提示：随内容走，不浮在别的面板上 */
.aitip {
  position: relative;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-ai-border);
  border-radius: var(--radius-md);
  background: var(--color-ai-subtle, var(--color-bg-subtle));
  font-size: var(--font-size-xs);
  line-height: var(--line-base);
}

.aitip__acts {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--space-2);
}

.aitip__never {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.aitip__never:hover {
  color: var(--color-text-primary);
  text-decoration: underline;
}

.aitip__close {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
}

.aitip__close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.aitip__text {
  color: var(--color-text-primary);
}

/* 校验列表 */
.issues {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.issues__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.issues__title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}

.issues__count {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.issues__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.issues__row {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.issues__row:hover {
  background: var(--color-bg-hover);
}

.issues__dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 5px;
  border-radius: 50%;
}

.issues__dot--error {
  background: var(--color-danger);
}

.issues__dot--warning {
  background: var(--color-warning);
}

.issues__dot--info {
  background: var(--color-info);
}

.issues__index {
  flex: none;
  color: var(--color-text-tertiary);
}

.issues__text {
  flex: 1;
  min-width: 0;
  line-height: var(--line-base);
}

.issues__more {
  padding: var(--space-1) var(--space-2);
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
