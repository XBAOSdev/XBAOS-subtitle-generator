<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useProjectStore, type ExportRecord } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useHistoryStore } from '@/stores/history'
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
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()
const editor = useEditorStore()
const history = useHistoryStore()
const settings = useSettingsStore()

/**
 * 当前视图条目。独立模式下是选中的那个文件，合并模式下是拼接产物 ——
 * 整个编辑器（波形 / 表格 / 工具栏 / 校验 / 导出）都只看它，这样
 * 「合并为一条时间轴」时界面上就只会有一条完整的时间轴。
 */
const activeFile = computed(() => project.viewFile)

/** 合并模式但还没识别：给出明确指引，而不是一片空白 */
const mergePending = computed(() => project.isMerge && !project.mergedFile)

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
const showFileTree = computed(
  () =>
    project.isMerge || project.files.length > 1 || project.unsupportedFiles.length > 0,
)

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
 * 走剪贴板中转：软件本身不联网，提示词由用户手工粘到网页版 AI 助手，
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
    const merged = project.mergedFile
    return merged && merged.segments.length > 0 ? [merged] : []
  }
  return project.supportedFiles.filter((f) => f.segments.length > 0)
})

const canAiReview = computed(() => reviewTargets.value.length > 0)

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

function openExport(): void {
  if (project.supportedFiles.length === 0) {
    ui.notify('info', '还没有可导出的字幕')
    return
  }
  // 合并模式的产物要等识别跑完才存在，提前导出会得到空文件
  if (project.isMerge && !project.mergedFile) {
    ui.notify('warning', '还没有可导出的字幕', '合并模式下需要先完成识别，才会生成拼接好的时间轴')
    return
  }
  ui.openDialog('export')
}

/* ---------------------------------------------------- 字幕文件的保存 */

/** 来源是字幕文件（而非音频识别）的条目 */
const isSubtitleSource = computed(() => !!activeFile.value?.subtitleFormat)

/**
 * 当前条目上一次导出的文件（内存记录，清空队列即释放）。
 *
 * 有了它，「导出完又改了几个字」就不必重走一遍导出对话框 —— 直接覆盖写回原位。
 * 可能是**多个**文件：「分别导出」会把原文与译文写成两个。
 */
const exportedRecords = computed(() => project.exportRecordsOf(project.viewFileId))

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
    <div class="editor__body">
      <FileTree v-if="showFileTree" />

      <div class="editor__center">
        <!-- 合并模式：明确说明正在编辑的是拼接产物，而不是某一个音频 -->
        <div v-if="project.isMerge" class="mergebar">
          <Icon name="layers" :size="13" />
          <span v-if="mergePending" class="mergebar__text">
            合并为一条时间轴：{{ project.supportedFiles.length }} 段音频已就绪，
            <strong>识别完成后</strong>此处将显示完整的时间轴。导出只产生一个字幕文件。
          </span>
          <span v-else class="mergebar__text">
            合并时间轴：{{ project.supportedFiles.length }} 段音频按导入顺序拼接，共
            <strong>{{ activeFile?.segments.length ?? 0 }}</strong> 条字幕，导出只产生一个字幕文件。
          </span>
        </div>

        <TimelineTrack />
        <SubtitleTable />
      </div>

      <aside class="editor__side scroll-y">
        <AudioPlayer />
        <hr class="divider" />
        <ToolPanel />
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
      </aside>
    </div>

    <footer class="editor__foot">
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

      <button
        class="btn btn--ai"
        type="button"
        :disabled="!canAiReview"
        :title="
          canAiReview
            ? '交给网页版 AI 助手校对。经剪贴板中转，本软件不联网'
            : '当前没有可校对的字幕'
        "
        @click="openAiReview"
      >
        <Icon name="spell-check" :size="15" />
        <span>AI 校对</span>
      </button>
      <button
        class="btn btn--ai"
        type="button"
        :disabled="!canAiTranslate"
        :title="
          canAiTranslate
            ? '交给网页版 AI 助手翻译成其他语言。经剪贴板中转，本软件不联网'
            : '当前没有可翻译的字幕'
        "
        @click="openAiTranslate"
      >
        <Icon name="globe" :size="15" />
        <span>AI 翻译</span>
      </button>
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
        <Icon name="save" :size="14" />
        <span>导出字幕</span>
      </button>
    </footer>
  </div>
</template>

<style scoped>
.editor {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.editor__body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.editor__center {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 合并模式说明条 */
.mergebar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-accent-subtle);
  color: var(--color-accent-text);
  font-size: 11px;
}

.mergebar__text {
  flex: 1;
  min-width: 0;
  line-height: var(--line-base);
}

.mergebar__text strong {
  font-variant-numeric: tabular-nums;
  font-weight: var(--weight-semibold);
}

.editor__side {
  width: 264px;
  flex: none;
  padding: var(--space-4);
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-surface);
}

.editor__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
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
