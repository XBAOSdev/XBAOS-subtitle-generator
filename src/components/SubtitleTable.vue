<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useSettingsStore } from '@/stores/settings'
import { useHistoryStore, MAX_STEPS } from '@/stores/history'
import type { SubtitleSegment, SubtitleViewMode } from '@/types'
import {
  SOURCE_SLOT,
  clearStale,
  insertRangeAt,
  makeEmptySegment,
  markTranslationsStale,
  mergeSelected,
  moveContentTo,
  pickViewLang,
  removeIds,
  slotText,
  splitSegment,
} from '@/utils/segmentOps'
import { MAX_LANES, exceedsLaneLimit } from '@/utils/timelineLayout'
import { visibleIssues } from '@/utils/validate'
import { noticeBlocked } from '@/utils/confirm'
import { isTypingTarget } from '@/utils/typing'
import { useSplitAtPlayhead } from '@/composables/useSplitAtPlayhead'
import { useSegmentMenu } from '@/composables/useSegmentMenu'
import { useUiStore } from '@/stores/ui'
import { useSpeakerStore } from '@/stores/speakers'
import TimecodeInput from '@/components/TimecodeInput.vue'
import UiMenu from '@/components/UiMenu.vue'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const editor = useEditorStore()
const settings = useSettingsStore()
const history = useHistoryStore()
const ui = useUiStore()
const speakerStore = useSpeakerStore()

/** 滚动容器。编辑态取输入框、后续「播放时自动滚动到当前句」都基于它 */
const bodyRef = ref<HTMLDivElement | null>(null)
/** 正文的横向滚动量，表头靠它跟平 */
const scrollLeft = ref(0)

const segments = computed(() => project.viewFile?.segments ?? [])

/**
 * 分界线的落点：`index → true`（在这个下标之前插一条 1px 线）。
 *
 * 只在「一个项目里有两段以上」时才有内容。判断依据是 `itemLayout` 里各子项目
 * 的起始下标，而不是拿相邻两条的 `originFileId` 比 —— 后者在空子项目（识别
 * 失败、字幕全删）上会漏掉边界：它一条都没有，前后两条自然"同属一段"。
 *
 * 线上下**不写名字**（5.1.1 初版写过上下各一个小字，实机上很吵）：此刻在看
 * 哪一段由侧栏的选中态表达 —— 滚动到哪一段，侧栏那一个子项目就亮起来。
 */
const seps = computed(() => {
  const set = new Set<number>()
  const layout = project.itemLayout
  for (let i = 1; i < layout.length; i += 1) set.add(layout[i].firstIndex)
  return set
})

/** 下标 → 它属于哪个子项目（分界与滚动跟随共用一张表） */
const itemAt = computed(() => {
  const layout = project.itemLayout
  const arr: string[] = []
  layout.forEach((item) => {
    for (let i = 0; i < item.count; i += 1) arr.push(item.itemId)
  })
  return arr
})

/*
 * 整张表里只要有一条带讲话人编号（或者用户手动新增过一位），才腾出一列。
 *
 * 常驻一列 92px 对没开分离的用户是纯粹的空间浪费 —— 那一列永远是空的，
 * 还要用户自己猜它为什么空着。列随数据出现，比「灰着等你去开启」干净。
 */
const hasSpeakers = computed(
  () =>
    segments.value.some((s) => typeof s.speaker === 'number') ||
    speakerStore.speakersOf(project.viewFileId ?? '', segments.value).length > 0,
)
const allIds = computed(() => segments.value.map((s) => s.id))

const allChecked = computed(
  () => segments.value.length > 0 && editor.selectedIds.length === segments.value.length,
)

/**
 * 选中集合。
 *
 * 模板里每行要判两次「选没选中」，直接用数组就是每行一次 `includes`。
 * 全选 2000 条时退化成 400 万次比较 —— 这是「Ctrl+A 之后界面卡一下」的来源。
 * 用 Set 之后每行是 O(1)，代价只是选中变化时重建一次（本来就是 O(k)）。
 */
const selectedSet = computed(() => new Set(editor.selectedIds))

function toggleAll(): void {
  if (allChecked.value) editor.clearSelection()
  else editor.selectedIds = [...allIds.value]
}

function onCheck(id: string): void {
  editor.select(id, 'toggle', allIds.value)
}

/**
 * 注意这两个函数**收条目对象而不是 id**。
 *
 * 早先的写法是 `isEdited(seg.id)` + 内部 `segments.find(...)`，模板里每行要调用
 * 5 次（class 三处 + 标记两处）—— 2000 行就是每次重渲染上万次全表扫描，
 * 上千万次比较，选中一条就能感到卡。改成直接吃模板里已有的 `seg`，降到 O(1)。
 *
 * 也不要把它们挪进「一次性算好的行数组」里：那样任何一次输入都会让整个数组
 * 换新对象，`v-for` 会把 2000 行全部重新 patch。现在这样保持细粒度依赖，
 * 打字只影响当前那一行。
 */

/** 编辑内容是否与识别原文不同 */
function isEdited(seg: SubtitleSegment): boolean {
  return seg.text !== seg.origin
}

/**
 * 这一条的告警级别（决定行左侧那根色条）。
 *
 * 用 `visibleIssues` 而不是裸的 `issues`：用户已经整条忽略过的条目不该
 * 继续染红 —— 他按下那个动作的意思就是「我看过了」。
 */
function worstLevel(seg: SubtitleSegment): 'error' | 'warning' | 'info' | null {
  const list = visibleIssues(seg)
  if (list.length === 0) return null
  if (list.some((i) => i.level === 'error')) return 'error'
  if (list.some((i) => i.level === 'warning')) return 'warning'
  return 'info'
}

/* ---------------------------------------------------------- 撤销 / 重做 */

/*
 * 两个按钮住进工具栏而不是右侧工具面板：它们作用的对象是「这张表」，
 * 手指已经在表上，眼睛不用横跨整个窗口去找。侧栏那两块位置让给了工具
 * 与 AI 功能（那些是「做一件事」，撤销是「退回去」）。
 *
 * 「每个文件最多保留 15 步」不再当常驻文字占一行 —— 它是**限制说明**，
 * 不是操作提示，放悬停提示里，想看的人看得到，其余人不必每天读一遍。
 */
const undoHint = computed(
  () => `撤销上一步编辑（Ctrl+Z）\n历史按文件分别记录，每个文件最多保留 ${MAX_STEPS} 步`,
)
const canUndo = computed(() => history.canUndoFile(project.viewFileId))
const canRedo = computed(() => history.canRedoFile(project.viewFileId))

function undo(): void {
  const file = project.viewFile
  if (!file) return
  const restored = history.undo(file.id, file.segments)
  if (!restored) return
  file.segments = restored
  editor.clearSelection()
  editor.endEdit()
}

function redo(): void {
  const file = project.viewFile
  if (!file) return
  const restored = history.redo(file.id, file.segments)
  if (!restored) return
  file.segments = restored
  editor.clearSelection()
  editor.endEdit()
}

function onRowClick(event: MouseEvent, id: string): void {
  const mode = event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace'
  editor.select(id, mode, allIds.value)
}

/* ------------------------------------------------------------ 讲话人 */

/**
 * 这一条该显示什么称呼（未标记时返回空串）。
 *
 * 编号是**子项目本地**的，称呼也按子项目存（`byFile[子项目 id]`）—— 所以要用
 * 条目自己的 `originFileId` 去查，不能一律按 `__merged__` 查。按后者查的话，
 * 侧栏面板（挂活动子项目）改完名字，表格里还是「讲话人 N」，两处对不上。
 */
function speakerText(seg: SubtitleSegment): string {
  if (typeof seg.speaker !== 'number') return ''
  const id = seg.originFileId ?? project.viewFileId ?? ''
  return speakerStore.nameOf(id, seg.speaker)
}

/**
 * 右键菜单与「更换讲话人」下拉统一由 `useSegmentMenu` 提供。
 *
 * 时间轴上的字幕条用的是同一份实现 —— 两个组件各写一遍的话，迟早会出现
 * 「表格里能合并、时间轴上合并是灰的」这种说不清原因的差异。
 * 只有表格给得起 `beginEdit`：这里有一个真的输入框能把光标放进去。
 */
const {
  menu,
  openAt,
  openSpeakerAt,
  onPick: onMenuPick,
  close: closeMenu,
} = useSegmentMenu({
  beginEdit: (seg) => void beginEdit(seg.id, SOURCE_SLOT),
})

/**
 * 右键一行。坐标交给 composable 自己去夹取，这里只把事件翻成「弹在哪、对谁」，
 * 顺手拦掉浏览器自己的页面菜单。
 */
function openRowMenu(event: MouseEvent, seg: SubtitleSegment): void {
  event.preventDefault()
  openAt(event.clientX, event.clientY, seg)
}

/**
 * 点讲话人那一格：就地换人。
 *
 * 必须 stopPropagation —— 否则这一次点击会冒泡到行上，被当成「选中这一行」，
 * 而它真正想表达的是「我要改这一条的讲话人」。选中由 composable 顺手做掉。
 */
function openSpeakerMenu(event: MouseEvent, seg: SubtitleSegment): void {
  event.stopPropagation()
  openSpeakerAt(event.clientX, event.clientY, seg)
}

/* ------------------------------------------------------------ 时间码 */

/**
 * 改一条时间码。
 *
 * 两件事必须在这里做，不能交给 `v-model` 直接写字段：
 *  1. **上限拦截**。时间码是可以手输的，「同一时刻重叠 6 条」这种数据在
 *     数据层造得出来 —— 拦在输入那一刻，比事后让用户对着一个糊成一团的
 *     时间轴发愁有用得多。
 *  2. **进撤销栈**。以前 `v-model="seg.start"` 是直接改字段，手输的时间码
 *     根本没入历史，按 Ctrl+Z 会跳过它撤到更早的操作，看起来像「撤销撤错了」。
 *
 * 用 `commitIfChanged`：输入框失焦时也会 commit 一次，值没变就不该占一格历史。
 */
function setTimecode(seg: SubtitleSegment, edge: 'start' | 'end', value: number): void {
  const file = project.viewFile
  if (!file) return
  const next = edge === 'start' ? { ...seg, start: value } : { ...seg, end: value }
  if (next.start === seg.start && next.end === seg.end) return

  if (exceedsLaneLimit(file.segments, { id: seg.id, start: next.start, end: next.end })) {
    void noticeBlocked({
      title: `同一时刻最多 ${MAX_LANES} 条字幕`,
      message: '这个时间码会让同一时刻重叠的字幕超过上限，改动没有生效。',
      detail: '先把挤在一起的字幕挪开或者删掉几条，再改这一个。',
    })
    return
  }

  history.commitIfChanged(
    file.id,
    () => file.segments,
    edge === 'start' ? '修改开始时间' : '修改结束时间',
    () => {
      // 视图的 `segments` 是 getter，读到的每条都是拷贝 —— 找到再改字段等于
      // 改了一份临时对象。整份换掉才会走 setter 拆回各子项目。
      file.segments = file.segments.map((s) =>
        s.id === seg.id ? { ...s, [edge]: value } : s,
      )
    },
  )
}

/* ------------------------------------------------------- 拖动调整顺序 */

/**
 * 拖动排序：把某一条的**内容**搬到另一个序号的时间槽上。
 *
 * 这是用户拍板的语义 —— 时间码留在原地，动的是「第几个格子里装的是哪句话」。
 * 换一种做法（时间码跟着内容一起走）会把整条时间轴搅乱，而用户拖这一下
 * 想要的其实只是「这段话应该排在那句前面」。
 *
 * 用原生 HTML5 拖放而不是指针模拟：列表里每一行都是普通 DOM，HTML5 自带
 * 「拖到哪儿」的语义与跨元素拼接，比自己算坐标稳。
 */
const dragFrom = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

function onReorderStart(event: DragEvent, index: number): void {
  dragFrom.value = index
  dragOverIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 有些环境不给 dataTransfer 就认为「没东西可拖」，随便塞一个占位值
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onReorderOver(event: DragEvent, index: number): void {
  if (dragFrom.value === null) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverIndex.value = index
}

function onReorderEnd(): void {
  dragFrom.value = null
  dragOverIndex.value = null
}

function onReorderDrop(event: DragEvent, index: number): void {
  event.preventDefault()
  const from = dragFrom.value
  onReorderEnd()
  if (from === null || from === index) return

  const file = project.viewFile
  if (!file) return
  const list = moveContentTo(file.segments, from, index)
  if (!list) return

  history.commit(file.id, file.segments, '调整字幕顺序', () => {
    file.segments = list
  })
  ui.notify(
    'success',
    `已把第 ${from + 1} 条的内容移到第 ${index + 1} 条的时间码上`,
    '时间码没有改动，换的是每个时间格子里的内容',
  )
}

/**
 * 取点击位置在文本中的字符偏移。
 * 文本节点里 \n 也是普通字符，因此这个偏移可直接用于 textarea 的
 * setSelectionRange —— 编辑框和展示文本共用同一份内容。
 */
function caretOffsetFrom(event: MouseEvent): number | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY)
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null
  return range.startOffset
}

/* ------------------------------------------------------ 文本编辑与历史 */

/* ------------------------------------------------ 文本槽位与编辑态 key */

/**
 * 一条字幕上有多个可编辑的文本槽位：原文（`source`）与各语言译文。
 *
 * 编辑态因此不能只存条目 id —— 原文行与译文行会互相认为「对方正在编辑」，
 * 后进入的那一行会把前一行的编辑态直接顶掉（这与「编辑 A 切 B 时 A 的 blur
 * 杀掉 B」是同一类问题，只是换成了同一条目的两个槽位）。
 */
function editKey(id: string, slot: string): string {
  return `${id}:${slot}`
}

/** 从复合 key 解出条目 id 与槽位。条目 id 里不含冒号，所以从右边切 */
function parseEditKey(key: string): { id: string; slot: string } {
  const at = key.lastIndexOf(':')
  if (at < 0) return { id: key, slot: SOURCE_SLOT }
  return { id: key.slice(0, at), slot: key.slice(at + 1) }
}

/**
 * 条目数组的深快照。
 *
 * `translations` / `staleSlots` 是引用类型，只做 `{ ...s }` 会让快照与现状
 * 共享同一份数据 —— 那样「这个槽位改过没有」的比较永远是「没改」，
 * 标红去不掉，历史也会认为什么都没发生。理由与 `history.ts` 的 cloneOne 相同。
 */
function snapshotSegments(): SubtitleSegment[] {
  return segments.value.map((s) => ({
    ...s,
    issues: [...s.issues],
    ...(s.translations ? { translations: { ...s.translations } } : {}),
    ...(s.staleSlots ? { staleSlots: [...s.staleSlots] } : {}),
  }))
}

/** 进入编辑前的快照。确认时若内容有变，推入撤销栈 */
let editSnapshot: SubtitleSegment[] | null = null
/** 编辑中的光标位置，分割字幕以它为界 */
const caretPos = ref(0)

function trackCaret(event: Event): void {
  const el = event.target as HTMLTextAreaElement
  caretPos.value = el.selectionStart
}

/* ------------------------------------------------ 译文行 */

/**
 * 当前展示的语言（译文的目标语言码）。没翻译过时为空，译文行整行不渲染。
 *
 * 用 `pickViewLang` 而不是直接读设置：撤销一次翻译之后数据会退回上一版语言，
 * 而设置里记的还是新的那个 —— 直接读会让译文行整片消失。
 */
const trLang = computed(() => pickViewLang(segments.value, settings.translationLang))

/** 条目的译文文本 */
function trTextOf(seg: SubtitleSegment): string {
  const lang = trLang.value
  return lang ? (seg.translations?.[lang] ?? '') : ''
}

/**
 * 该条目要不要显示译文行。
 *
 * 判据是「这个语言的键在不在」，而不是「译文是不是空」—— 用户把译文清空到
 * 一个字不剩时，行不能跟着消失（那就没法再输入了）。
 */
function hasTrRow(seg: SubtitleSegment): boolean {
  const lang = trLang.value
  if (!lang) return false
  return seg.translations?.[lang] !== undefined || isStale(seg, lang)
}

/**
 * 这个槽位是不是「待确认」（分割时另一侧整段复制过来、还没人拆过）。
 *
 * 整条忽略之后一律返回 false：忽略按钮的语义是「这一条我看过了」，
 * 里面哪一段还带着待确认标记也得一并闭嘴，否则按钮按下去什么都没变。
 */
function isStale(seg: SubtitleSegment, slot: string): boolean {
  if (seg.acked) return false
  return (seg.staleSlots ?? []).includes(slot)
}

/** 译文编辑：与原文的 v-model 同一套「改到一半也即时反映到数据」的行为 */
function onTrInput(seg: SubtitleSegment, event: Event): void {
  const lang = trLang.value
  if (!lang) return
  /*
   * 不能对着 `seg` 直接写：它是 `concatSegments()` 拷出来的行对象，
   * `seg.translations = {}` 只落在那一份临时拷贝上（有内容时改的是共享的
   * 那个对象，才碰巧生效）。走 store 换一整条，两种情形都对。
   */
  project.replaceSegment({
    ...seg,
    translations: { ...(seg.translations ?? {}), [lang]: (event.target as HTMLTextAreaElement).value },
  })
}

/**
 * 原文编辑。
 *
 * 表格里的 `seg` 是项目拼接视图拷出来的一行，`v-model="seg.text"` 写的是
 * **那份拷贝**：屏幕上字变了，存储层一个字都没动，失焦时比对「快照 vs 现状」
 * 还会得出「没改过」，于是改动连撤销记录都没有。必须每次输入都换一整条。
 */
function onSrcInput(seg: SubtitleSegment, event: Event): void {
  const text = (event.target as HTMLTextAreaElement).value
  if (text === seg.text) return
  project.replaceSegment({ ...seg, text })
}

const VIEW_OPTIONS: { value: SubtitleViewMode; label: string; title: string }[] = [
  { value: 'source', label: '仅原文', title: '只显示原文行' },
  { value: 'bilingual', label: '双语', title: '原文与译文各占一行' },
  { value: 'translation', label: '仅译文', title: '只显示译文行' },
]

/** 一条译文都没有时，三态切换没有意义，整组禁用 */
const hasAnyTranslation = computed(() =>
  segments.value.some((s) => Object.keys(s.translations ?? {}).length > 0),
)

const showSourceRow = computed(() => settings.subtitleView !== 'translation')

/**
 * 进入文本编辑。单击文本即触发，光标落在点击处；
 * 由 F2 / Enter 触发时没有坐标，光标落在末尾。
 *
 * 输入框从 bodyRef 里现取，不用模板 ref：它位于 v-for 内部，
 * 模板 ref 会被收集成数组，取值时机不稳。
 */
async function beginEdit(id: string, slot: string, event?: MouseEvent): Promise<void> {
  const key = editKey(id, slot)
  if (editor.editingId === key) return
  const offset = event ? caretOffsetFrom(event) : null

  // 编辑前的快照：确认改动后推入历史
  editSnapshot = snapshotSegments()

  editor.beginEdit(key)
  editor.select(id, 'replace', allIds.value)
  await nextTick()

  const el = bodyRef.value?.querySelector<HTMLTextAreaElement>('.row__editor')
  if (!el) return
  el.focus()
  const pos = offset === null ? el.value.length : Math.min(offset, el.value.length)
  el.setSelectionRange(pos, pos)
  caretPos.value = pos
}

/**
 * 失焦结束编辑。
 *
 * 必须校验「失焦的是当前编辑的那一个」：从编辑 A 直接切到编辑 B 时
 * （例如点添加按钮后自动进入新条目的编辑），A 的卸载会触发 blur，
 * 无条件清空 editingId 会把 B 刚建立的编辑态一起杀掉。
 */
function endEdit(id: string, slot: string): void {
  if (editor.editingId !== editKey(id, slot)) return
  const file = project.viewFile
  if (file && editSnapshot) {
    // 「待确认」标红只有在该槽位**真的改过**之后才消。进去看一眼没改、
    // 或者改了又改回原样，都还算没确认过 —— 这正是用户要的语义。
    const before = editSnapshot.find((s) => s.id === id)
    const now = file.segments.find((s) => s.id === id)
    if (before && now && slotText(before, slot) !== slotText(now, slot)) {
      // 走 store：视图的 `segments` 是 getter 返回的拷贝，
      // 直接对其下标赋值改的是那份临时数组，不会有任何效果
      let next = clearStale(now, slot)
      if (slot === SOURCE_SLOT) next = markTranslationsStale(next)
      project.replaceSegment(next)
    }
    history.pushSnapshot(file.id, segments.value, editSnapshot, '编辑文本')
  }
  editSnapshot = null
  editor.endEdit()
}

/* ------------------------------------------------------ 滚动跟随 */

/**
 * 把某条字幕滚进视口。
 *
 * 选中可能来自表格内点击（本来就在视口里，不需要动），也可能来自右侧
 * 「校验结果」列表 —— 那一条常常落在视口之外，只给高亮是看不见的。
 * block:'nearest' 保证已经在视口内时不产生额外跳动。
 */
async function scrollToSegment(id: string): Promise<void> {
  await nextTick()
  const body = bodyRef.value
  if (!body) return
  const row = [...body.querySelectorAll<HTMLElement>('.row')].find(
    (el) => el.dataset.segId === id,
  )
  row?.scrollIntoView({ block: 'nearest' })
}

watch(
  () => editor.selectedIds[0],
  (id) => {
    if (id) void scrollToSegment(id)
  },
)

/* ------------------------------------------------ 顶部那条属于哪个子项目 */

/**
 * 视口顶部那一行是第几条。
 *
 * 行按时间顺序排列，所以二分找「第一条底边还在容器顶部之下的行」——
 * 逐行量位置在几百条时会明显拖慢滚动，二分只要 log₂n 次。
 */
function topRowIndex(body: HTMLElement): number {
  const rows = body.querySelectorAll<HTMLElement>('.row')
  if (rows.length === 0) return -1
  const top = body.getBoundingClientRect().top
  let lo = 0
  let hi = rows.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].getBoundingClientRect().bottom <= top + 1) lo = mid + 1
    else {
      found = mid
      hi = mid - 1
    }
  }
  // 全部滚过头了（极端情况下容器比内容还高）：算最后一条
  return found === -1 ? rows.length - 1 : found
}

/**
 * 滚动即切换「当前子项目」。
 *
 * 侧栏的选中态跟着视口顶部走 —— 用户滚到第二段，侧栏第二个子项目就亮起来，
 * 不用再去数分界线。只在跨过边界时写一次 `activeFileId`，不是每帧都写：
 * 那个值是「当前在看哪一段」，每帧改会让讲话人面板之类的整块重算。
 */
let followRaf = 0
/**
 * 刚从侧栏跳过来的一小段时间里不认「顶部是谁」。
 *
 * 最后一个子项目往往只有几条，滚不到顶端（容器到底就停住），这时顶部那一行
 * 仍然属于上一段 —— 按规则算会把用户刚点的那一条的选中态又抢走。跳过来的
 * 400ms 内以点击为准，之后交回滚动跟随。
 */
let followLockUntil = 0

function onBodyScroll(): void {
  const body = bodyRef.value
  if (!body) return
  /*
   * 横向偏移喂给表头。窗口窄到需要左右滑时，表头必须跟着正文走 ——
   * 否则「开始 / 结束 / 字幕文本」会停在原地，跟下面的内容对不上。
   * 这里只写一个数字、由样式做 transform，不触发重排。
   */
  if (body.scrollLeft !== scrollLeft.value) scrollLeft.value = body.scrollLeft
  // 位置每次滚动都记，切项目回来才停在原处
  project.rememberScrollTop(project.activeDraftId, body.scrollTop)
  if (followRaf) return
  followRaf = requestAnimationFrame(() => {
    followRaf = 0
    if (Date.now() < followLockUntil) return
    const index = topRowIndex(bodyRef.value as HTMLElement)
    const id = index >= 0 ? itemAt.value[index] : ''
    if (id && project.activeFileId !== id) project.setActiveFile(id)
  })
}

/** 侧栏点某个子项目 → 跳到它第一行（跨项目时 `revealItem` 已经先切过来了） */
watch(
  () => project.revealRequest,
  async (req) => {
    if (!req) return
    await nextTick()
    await nextTick()
    const body = bodyRef.value
    if (!body) return
    const at = project.itemLayout.find((i) => i.itemId === req.itemId)
    if (at === undefined) return
    const row = body.querySelectorAll<HTMLElement>('.row')[at.firstIndex]
    if (!row) return
    followLockUntil = Date.now() + 400
    const delta = row.getBoundingClientRect().top - body.getBoundingClientRect().top
    body.scrollTop += delta - 6
  },
)

/**
 * 换项目：先把上一个项目停在哪记下来，再把这一份停过的地方还原。
 *
 * 两份工程之间来回对照是常态，每次都从顶部开始等于让用户重新找一遍刚才那一行。
 *
 * 盯 `activeDraftId` 而不是 `viewFileId`：拼接视图的 id 恒为 `__merged__`，
 * 项目之间根本没有变化，那个 watch 从来不会因为切项目而触发（曾经写错过一次，
 * 表现是「切回来总是回到顶部」）。
 */
let lastDraftId = project.activeDraftId
watch(
  () => project.activeDraftId,
  () => {
    const body = bodyRef.value
    const left = lastDraftId
    const keep = body?.scrollTop ?? 0
    lastDraftId = project.activeDraftId
    if (left) project.rememberScrollTop(left, keep)
    void nextTick().then(() => {
      if (!bodyRef.value) return
      bodyRef.value.scrollTop = project.scrollTopOf(project.activeDraftId)
    })
  },
)

/* ------------------------------------------------------ 增删合并分割 */

/** 在当前条之后插入一条空字幕。时间码撑满空位，受填充空隙参数约束 */
function addSegment(): void {
  const file = project.viewFile
  if (!file) return
  const index = editor.selectedIds[0]
    ? allIds.value.indexOf(editor.selectedIds[0])
    : segments.value.length - 1

  const range = insertRangeAt(segments.value, Math.max(0, index), settings.gapFill)
  if (!range) {
    window.alert('这里没有足够的空位放一条新字幕')
    return
  }

  const created = makeEmptySegment(range)
  history.commit(file.id, file.segments, '添加字幕', () => {
    // 走 store：它会把这条按前一条的归属落进对应的子项目，并把绝对时间码
    // 换算成那个子项目本地的坐标。直接 splice 视图数组不会有任何效果
    project.insertSegmentAfter(Math.max(0, index), created)
    // 全选用**现场**的视图（getter 每次现拼），不能用 `segments` 这个 computed ——
    // 它的缓存还没被这次插入失效，取到的是少一条的旧数组
    editor.select(created.id, 'replace', (project.viewFile?.segments ?? []).map((s) => s.id))
  })

  // 编辑启动必须等 DOM 更新完：在 mutate 里同步编排会与 Vue 的渲染
  // 时序竞态（textarea 还没挂上去就去 focus，焦点落回 BODY）
  void nextTick().then(() => {
    void beginEdit(created.id, SOURCE_SLOT)
  })
}

function removeSelected(): void {
  const file = project.viewFile
  if (!file || !editor.hasSelection) return
  const ids = [...editor.selectedIds]

  history.commit(file.id, file.segments, '删除字幕', () => {
    file.segments = removeIds(file.segments, ids)
    editor.clearSelection()
  })
}

/** 合并选中的字幕：按顺序头尾相接，间隙被覆盖 */
function mergeSel(): void {
  const file = project.viewFile
  if (!file) return
  const result = mergeSelected(file.segments, editor.selectedIds)
  if (!result) return

  history.commit(file.id, file.segments, '合并字幕', () => {
    file.segments = result.list
    editor.select(result.merged.id, 'replace', result.list.map((s) => s.id))
  })
}

/** 以编辑光标为界分割当前字幕，时间按字数比例分配 */
function splitAtCaret(): void {
  const file = project.viewFile
  if (!file || !editor.editingId) return
  // 在**光标所在的这个槽位**上切。另一侧（另一种语言）的内容整段复制到两段上
  // 并标红待确认 —— 两种语言在同一时间区间里的字符分布不成比例，硬按比例猜
  // 断点几乎必然是错的。
  const { id, slot } = parseEditKey(editor.editingId)
  const result = splitSegment(file.segments, id, caretPos.value, slot)
  if (!result) return

  history.commit(file.id, file.segments, '分割字幕', () => {
    file.segments = result.list
    editor.select(result.b.id, 'replace', result.list.map((s) => s.id))
  })

  // 分割本身已作为独立历史步骤提交。必须退出编辑并丢弃未确认的文本快照：
  // 不退出的话 textarea 的 v-model 还指着旧条目，之后 blur 会把「分割前 +
  // 编辑前」的重复快照再压一层历史。
  editSnapshot = null
  editor.endEdit()
}

const canMerge = computed(
  () => editor.selectedIds.length >= 2 && mergeSelected(segments.value, editor.selectedIds) !== null,
)

/** 以文本光标为界能不能切（长度取的是**当前正在编辑的那个槽位**，译文上编辑时按译文算） */
const canSplitAtCaret = computed(() => {
  if (!editor.editingId) return false
  const { id, slot } = parseEditKey(editor.editingId)
  const seg = segments.value.find((s) => s.id === id)
  if (!seg) return false
  const len = [...slotText(seg, slot)].length
  return len > 0 && caretPos.value > 0 && caretPos.value < len
})

/**
 * 按播放头分割的那一半由 composable 提供 ——
 * 与 EditorView 的 Ctrl+B 共用一份实现，按钮与快捷键不会各切各的。
 */
const {
  canSplit: canSplitAtPlayhead,
  targetCount: playheadSplitCount,
  splitAtPlayhead,
} = useSplitAtPlayhead()

/**
 * 「分割」按钮当前指向哪一种分割。
 *
 * 一个按钮两种语义，靠**用户手上的状态**分流，而不是让他先选模式：
 *   - 正在编辑文本 → 以文本光标为界（刀口是字符位置）；
 *   - 没在编辑     → 以时间轴播放头为界（刀口是时间）。
 * 这也正是 Ctrl+B 的两种行为，按钮与世界快捷键走到同一个地方，
 * 不会出现「按钮做了 A、快捷键做了 B」的错位。
 *
 * 播放头那一侧只判「有没有东西可切」，**不要求先选中** —— 反过来，选了
 * 几条时就该把那几条一起切掉，这才是多选的意义（同一垂面叠着好几条时，
 * 只切一条，剩下的立刻又叠上来）。
 */
const splitTarget = computed<{ mode: 'caret' } | { mode: 'playhead' } | null>(() => {
  if (editor.editingId) return canSplitAtCaret.value ? { mode: 'caret' } : null
  return canSplitAtPlayhead.value ? { mode: 'playhead' } : null
})

const splitTitle = computed(() => {
  if (editor.editingId) return '以编辑光标为界分割当前字幕（Ctrl+B）'
  if (playheadSplitCount.value > 1) {
    return `在播放头处把选中的 ${playheadSplitCount.value} 条各切一刀：文本整段复制、两段标红待确认（Ctrl+B）`
  }
  return '在播放头处分割：文本整段复制，两段标红待确认（Ctrl+B）'
})

/** 按当前语义执行分割 */
function splitNow(): void {
  const target = splitTarget.value
  if (!target) return
  if (target.mode === 'caret') {
    splitAtCaret()
    return
  }
  splitAtPlayhead()
}

/** 编辑框内的快捷键：Ctrl+B 以光标为界分割（全局快捷键在编辑态会让位给输入框） */
function onEditorKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && (event.key === 'b' || event.key === 'B')) {
    event.preventDefault()
    /*
     * 必须掐断冒泡。`splitAtCaret` 干完活会立刻退出编辑态（否则 textarea 的
     * v-model 还指着旧条目），等这次按键继续冒泡到 window 时，EditorView 那边的
     * `if (editor.editingId) return` 守卫已经形同虚设 —— 于是同一次 Ctrl+B 会被
     * 第二套逻辑按播放头再切一刀，一条字幕莫名变成三条。
     * 探针 timeline-lanes 就是靠「编辑态分割后条数应该是 7 而不是 8」逮住它的。
     */
    event.stopPropagation()
    splitAtCaret()
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (editor.editingId) return
  /*
   * 焦点在输入框里时，这一整套快捷键一律让位。
   *
   * 上面那句只认「文本编辑态」，但表格里的可输入控件不止文本框 —— 时间码是
   * 一个真正的 <input>，且它不经过 `editor.editingId`。少了这道判断，在时间码
   * 里按 Delete 想删一位数字，事件冒泡上来就被当成「删除选中的字幕」，
   * 整条字幕当场消失（真踩过）。
   */
  if (isTypingTarget(event.target)) return

  const currentId = editor.selectedIds[0]
  const index = currentId ? allIds.value.indexOf(currentId) : -1

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    const next = allIds.value[Math.min(allIds.value.length - 1, index + 1)]
    if (next) editor.select(next, 'replace', allIds.value)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    const prev = allIds.value[Math.max(0, index - 1)]
    if (prev) editor.select(prev, 'replace', allIds.value)
  } else if (event.key === 'F2' || event.key === 'Enter') {
    if (currentId) {
      event.preventDefault()
      // 在「仅译文」视图下 F2 该进译文行 —— 那时原文行根本没渲染出来，
      // 却把编辑态指向它，用户会看到「按了没反应」
      const slot =
        settings.subtitleView === 'translation' && trLang.value ? trLang.value : SOURCE_SLOT
      void beginEdit(currentId, slot)
    }
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    removeSelected()
  } else if (event.key === 'Insert') {
    event.preventDefault()
    addSegment()
  }
}
</script>

<template>
  <section class="subtable" tabindex="0" @keydown="onKeydown">
    <!-- 编辑操作栏 -->
    <div class="subtable__toolbar">
      <button class="op" type="button" title="添加一条空字幕（Insert）" @click="addSegment">
        <Icon name="plus" :size="13" />
        <span>添加</span>
      </button>
      <button
        class="op"
        type="button"
        title="删除选中的字幕（Delete）"
        :disabled="!editor.hasSelection"
        @click="removeSelected"
      >
        <Icon name="trash" :size="13" />
        <span>删除</span>
      </button>
      <button
        class="op"
        type="button"
        title="合并选中的字幕：按顺序头尾相接，间隙被覆盖（Ctrl+M）"
        :disabled="!canMerge"
        @click="mergeSel"
      >
        <Icon name="layers" :size="13" />
        <span>合并</span>
      </button>
      <button
        class="op"
        type="button"
        :title="splitTitle"
        :disabled="!splitTarget"
        @mousedown.prevent
        @click="splitNow"
      >
        <Icon name="scissors" :size="13" />
        <span>分割</span>
      </button>

      <span class="toolbar__sep" aria-hidden="true" />

      <!-- 撤销 / 重做贴成一组：两个图标按钮之间的缝比工具栏常规间隔更小，
           一眼看出它们是「一对」而不是两个不相干的动作 -->
      <span class="opgroup">
        <button
          class="op"
          type="button"
          :title="undoHint"
          :disabled="!canUndo"
          @click="undo"
        >
          <Icon name="undo" :size="13" />
          <span>撤销</span>
        </button>
        <button
          class="op"
          type="button"
          title="重做（Ctrl+Y）"
          :disabled="!canRedo"
          @click="redo"
        >
          <Icon name="redo" :size="13" />
          <span>重做</span>
        </button>
      </span>

      <span class="spacer" />

      <!-- 显示方式：纯视图状态，不动数据、也不影响导出 -->
      <span v-seg-thumb class="viewtoggle" role="group" aria-label="显示方式">
        <button
          v-for="opt in VIEW_OPTIONS"
          :key="opt.value"
          class="viewtoggle__item"
          :class="{ 'is-active': settings.subtitleView === opt.value }"
          type="button"
          :disabled="opt.value !== 'source' && !hasAnyTranslation"
          :title="
            opt.value !== 'source' && !hasAnyTranslation
              ? '还没有译文，先用「AI 翻译」生成'
              : opt.title
          "
          @click="settings.subtitleView = opt.value"
        >
          {{ opt.label }}
        </button>
      </span>

      <span class="op op--count">
        {{ editor.selectedIds.length > 0 ? `已选 ${editor.selectedIds.length} 条` : '未选择' }}
      </span>
    </div>

    <!--
      表头单独套一层：窗口窄到需要横向滚动时，表头要跟着正文一起平移
      （`translateX(-scrollLeft)`）。直接给表头自己加 overflow 是不行的 ——
      它和正文是两个滚动容器，滚起来会各走各的。
    -->
    <div class="subtable__headwrap">
      <div
        class="subtable__head"
        :class="{ 'has-spk': hasSpeakers }"
        :style="{ transform: `translateX(${-scrollLeft}px)` }"
      >
        <span class="cell cell--check">
          <input
            type="checkbox"
            class="row__check"
            :checked="allChecked"
            title="全选 / 全不选"
            @change="toggleAll"
          />
        </span>
        <span class="cell cell--index">#</span>
        <span class="cell cell--time">开始</span>
        <span class="cell cell--time">结束</span>
        <span v-if="hasSpeakers" class="cell cell--spk">讲话人</span>
        <span class="cell cell--text">字幕文本</span>
      </div>
    </div>

    <div ref="bodyRef" class="subtable__body scroll-y" @scroll.passive="onBodyScroll">
      <template v-for="(seg, index) in segments" :key="seg.id">
        <!--
          子项目分界：只插一个**独立的块**，不动 `segments` 的结构
          （不插假条目），所以行号、选中、全选、快捷键全都不受影响。
          上下各标一次名字是有意的：滚动时随时知道上下各属谁，等同页码。
        -->
        <div v-if="seps.has(index)" class="subsep" aria-hidden="true">
          <span class="subsep__line" />
        </div>

        <div
          :data-seg-id="seg.id"
          class="row"
          :class="{
            'has-spk': hasSpeakers,
            'is-selected': selectedSet.has(seg.id),
            'is-current': editor.selectedIds[0] === seg.id,
            'is-edited': isEdited(seg),
            'has-error': worstLevel(seg) === 'error',
            'has-warning': worstLevel(seg) === 'warning',
            'is-acked': !!seg.acked,
            'is-drop-target': dragOverIndex === index && dragFrom !== null && dragFrom !== index,
          }"
          @click="onRowClick($event, seg.id)"
          @contextmenu="openRowMenu($event, seg)"
          @dragover="onReorderOver($event, index)"
          @drop="onReorderDrop($event, index)"
        >
          <span class="cell cell--check">
            <input
              type="checkbox"
              class="row__check"
              :checked="selectedSet.has(seg.id)"
              @click.stop
              @change="onCheck(seg.id)"
            />
          </span>

          <span
            class="cell cell--index mono"
            draggable="true"
            title="按住拖动可以调整顺序：把这一条的内容搬到目标行的时间码上"
            @dragstart="onReorderStart($event, index)"
            @dragend="onReorderEnd"
          >
            <Icon class="row__grip" name="grip" :size="10" />
            <span class="row__index-num">{{ index + 1 }}</span>
          </span>

          <span class="cell cell--time">
            <TimecodeInput
              :model-value="seg.start"
              @update:model-value="setTimecode(seg, 'start', $event)"
            />
          </span>

          <span class="cell cell--time">
            <TimecodeInput
              :model-value="seg.end"
              @update:model-value="setTimecode(seg, 'end', $event)"
            />
          </span>

          <!--
            讲话人只是一条标注：没有分离结果时整列都不渲染，也不占位成「未识别」
            之类的字，免得每条都顶着四个没用的字。
            有数据之后每一格都可点：点开就是换人（或清除标识）。
          -->
          <span v-if="hasSpeakers" class="cell cell--spk">
            <button
              class="spk"
              :class="{ 'is-empty': typeof seg.speaker !== 'number', 'is-current': selectedSet.has(seg.id) }"
              type="button"
              :title="
                typeof seg.speaker === 'number'
                  ? `${speakerText(seg)}，点击更换`
                  : '还没有标注讲话人，点击选择'
              "
              @click="openSpeakerMenu($event, seg)"
            >
              {{ typeof seg.speaker === 'number' ? speakerText(seg) : '未标记' }}
            </button>
          </span>

          <span class="cell cell--text">
            <!-- 原文行 -->
            <span
              v-if="showSourceRow"
              class="textline textline--src"
              :class="{ 'is-stale': isStale(seg, SOURCE_SLOT) }"
              :title="
                isStale(seg, SOURCE_SLOT)
                  ? '这段原文是分割时整段复制过来的，还没按时间码拆开'
                  : '单击即可编辑'
              "
              @click.stop="beginEdit(seg.id, SOURCE_SLOT, $event)"
            >
              <textarea
                v-if="editor.editingId === editKey(seg.id, SOURCE_SLOT)"
                :value="seg.text"
                class="row__editor"
                rows="2"
                @input="onSrcInput(seg, $event)"
                @blur="endEdit(seg.id, SOURCE_SLOT)"
                @keydown.enter.exact.prevent="endEdit(seg.id, SOURCE_SLOT)"
                @keydown.esc.prevent="editor.endEdit()"
                @keydown="onEditorKeydown"
                @click="trackCaret"
                @keyup="trackCaret"
                @select="trackCaret"
              />
              <span v-else class="row__text">{{ seg.text || '（空）' }}</span>
            </span>

            <!-- 译文行：挂在上面那条原文上，靠左侧竖线区分 -->
            <span
              v-if="settings.subtitleView !== 'source' && hasTrRow(seg)"
              class="textline textline--tr"
              :class="{ 'is-stale': isStale(seg, trLang) }"
              :title="
                isStale(seg, trLang)
                  ? '这段译文是分割时整段复制过来的，还没按时间码拆开'
                  : '单击即可编辑译文'
              "
              @click.stop="beginEdit(seg.id, trLang, $event)"
            >
              <textarea
                v-if="editor.editingId === editKey(seg.id, trLang)"
                class="row__editor"
                rows="2"
                :value="trTextOf(seg)"
                @input="onTrInput(seg, $event)"
                @blur="endEdit(seg.id, trLang)"
                @keydown.enter.exact.prevent="endEdit(seg.id, trLang)"
                @keydown.esc.prevent="editor.endEdit()"
                @keydown="onEditorKeydown"
                @click="trackCaret"
                @keyup="trackCaret"
                @select="trackCaret"
              />
              <span v-else class="row__text">{{ trTextOf(seg) || '（空）' }}</span>
            </span>
          </span>
      </div>
      </template>

      <p v-if="segments.length === 0" class="subtable__empty">
        <template v-if="project.isMerge">
          这个项目还没有字幕 —— 完成识别后，这里会显示按顺序拼接好的全部字幕
        </template>
        <template v-else>这个文件还没有字幕内容</template>
      </p>
    </div>

    <UiMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @close="closeMenu"
      @pick="onMenuPick"
    />
  </section>
</template>

<style scoped>
.subtable {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface);
  outline: none;
}

.subtable__head,
.row {
  display: grid;
  /*
   * 最后一列（78px 的「忽略告警」）已撤掉：那个按钮挪进了右键菜单，
   * 宽度还给正文。文本列给了 240px 的下限 —— 窗口再窄也不把字压成
   * 一列竖排，改为整张表左右滑动（见下面的 min-width）。
   *
   * 讲话人那列不在这里：它随数据出现（.has-spk），没开分离就不占宽度。
   */
  grid-template-columns: 28px 44px 104px 104px minmax(240px, 1fr);
  align-items: center;
  gap: var(--space-2);
  /*
   * 窄窗口的下限。窗口比它窄时，行不再继续压缩，而是由
   * `.subtable__body` 出横向滚动条 —— 「字被压成一列」比「要左右滑」
   * 糟糕得多：前者连读都读不了。
   */
  min-width: 620px;
}

/* 有讲话人编号时才多一列，位置固定在「结束」与「字幕文本」之间。
   宽度按称呼给（92px 大约放得下四个汉字），称呼长了就省略号 + 悬停看全称 */
.subtable__head.has-spk,
.row.has-spk {
  grid-template-columns: 28px 44px 104px 104px 92px minmax(240px, 1fr);
  min-width: 720px;
}

/* 编辑操作栏 */
.subtable__toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
  /*
   * 窄窗口时整条工具栏左右滑动。
   *
   * 原来是不换行也不滚动：窗口一窄，右边那半截（显示方式、已选条数）
   * 就被推到可视区外面 —— 不是被压窄，是干脆看不见，页面上也没有任何
   * 迹象表明还有东西在右边。`overflow-x` 让它可滑，`flex: none` 让每个
   * 控件保持原宽（中文按钮被压会变成竖排的一列字）。
   */
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.subtable__toolbar > * {
  flex: none;
}

/* 把显示方式与计数推到右边；内容超宽时它缩到最小，让别的控件先保住宽度 */
.subtable__toolbar > .spacer {
  flex: 1 0 8px;
}

/* 编辑动作与撤销这一组之间的分隔 */
.toolbar__sep {
  flex: none;
  width: 1px;
  height: 14px;
  margin: 0 2px;
  background: var(--color-border);
}

/* 撤销 / 重做贴成一对 */
.opgroup {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.op {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* 工具栏一切到底也得留完整标签：不给收缩、不给折行。
     中文标签在 min-content 下会一个字一行，竖排的按钮看着像坏了 */
  flex: none;
  white-space: nowrap;
  height: 26px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.op:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.op:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.op--count {
  color: var(--color-text-tertiary);
  cursor: default;
}

.op--count:hover {
  background: none;
  color: var(--color-text-tertiary);
}

/* 显示方式三态切换 */
.viewtoggle {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
}

.viewtoggle__item {
  position: relative;
  height: 20px;
  padding: 0 var(--space-2);
  border-radius: 3px;
  font-size: 11px;
  color: var(--color-text-tertiary);
  transition: color var(--dur-fast) var(--ease-out);
}

.viewtoggle__item:hover:not(:disabled):not(.is-active) {
  color: var(--color-text-primary);
}

.viewtoggle__item.is-active {
  /* 选中标记在滑动指示块上（v-seg-thumb），这里只管文字 */
  color: var(--color-text-primary);
  font-weight: var(--weight-semibold);
}

.viewtoggle__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.row__check {
  width: 14px;
  height: 14px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.cell--check {
  display: grid;
  place-items: center;
}

/*
 * 表头的外层：裁掉平移出界的部分。
 *
 * 表头不可能自己横向滚动（它和正文是两个容器，各滚各的会错位），
 * 所以由正文的 scrollLeft 驱动它的 translateX。
 */
.subtable__headwrap {
  flex: none;
  overflow: hidden;
}

.subtable__head {
  width: 100%;
  padding: 0 var(--space-3);
  height: 32px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-inset);
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.subtable__body {
  flex: 1;
  min-height: 0;
  padding: var(--space-1) 0 var(--space-4);
  /* 窗口窄到 620px 以下时，行不再压缩，改为左右滑动（表头跟着走） */
  overflow-x: auto;
}

/* ---------- 子项目分界（只有一条细线） ---------- */

.subsep {
  display: flex;
  align-items: center;
  height: 17px;
  /* 与行同宽：窄窗口横向滚动时分界线也得铺满整条，不然滑过去就断了 */
  min-width: 620px;
}

.subsep__line {
  flex: 1;
  height: 1px;
  margin: 0 12px;
  background: var(--color-border-subtle);
}

.row {
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-2);
  border-left: 3px solid transparent;
  cursor: default;
  /* 长列表渲染优化 */
  content-visibility: auto;
  contain-intrinsic-size: auto 46px;
}

.row:hover {
  background: var(--color-bg-hover);
}

.row.is-selected {
  background: var(--color-bg-selected);
}

.row.is-current {
  border-left-color: var(--color-accent);
}

.row.has-error {
  border-left-color: var(--color-danger);
}

.row.has-warning {
  border-left-color: var(--color-warning);
}

.cell {
  min-width: 0;
}

.cell--index {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--color-text-tertiary);
  /* 这一格是拖动排序的把手：光标要给出手势，否则没人知道这里能拖 */
  cursor: grab;
  border-radius: var(--radius-sm);
}

.cell--index:active {
  cursor: grabbing;
}

/*
 * 讲话人标：中性底、单行省略，不按人分色。
 *
 * 配色规范里只有 AI 那套允许出彩色，而称呼本身已经足够区分 —— 硬造六种
 * 灰阶或彩色，收益是「扫一眼」，代价是整张表开始花，不值。
 */
.cell--spk {
  display: flex;
  align-items: center;
  min-width: 0;
}

.spk {
  display: block;
  max-width: 100%;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
  font-size: 11px;
  color: var(--color-text-secondary);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.spk:hover {
  background: var(--color-bg-active);
  color: var(--color-text-primary);
}

/* 还没归属的条目：虚线感靠留白表达，不额外加边框（加边框整列会变得很吵） */
.spk.is-empty {
  background: transparent;
  color: var(--color-text-disabled);
}

.spk.is-empty:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-secondary);
}

/* 抓取点平时几乎看不见，悬停或拖动时才亮 —— 编号本身才是这一列的主角 */
.row__grip {
  flex: none;
  opacity: 0;
  color: var(--color-text-tertiary);
  transition: opacity var(--dur-fast) var(--ease-out);
}

.row:hover .row__grip {
  opacity: 0.75;
}

/* 编号靠右对齐，把余量留给左边的抓手 */
.row__index-num {
  flex: 1;
  text-align: right;
  padding-right: var(--space-1);
}

.row.is-current .cell--index {
  color: var(--color-accent-text);
  font-weight: var(--weight-medium);
}

/* 拖动经过的行：整行描边，表明「内容会落到这一格」 */
.row.is-drop-target {
  box-shadow: inset 0 0 0 1px var(--color-accent-border);
  background: var(--color-bg-hover);
}

.cell--time {
  display: flex;
  align-items: center;
}

.cell--text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  /* 单击即编辑，用文本光标给出提示 */
  cursor: text;
}

.textline {
  display: block;
  min-width: 0;
}

/* 译文行：左侧一条竖线 + 略小的字号，表明它挂在上面那条原文上 */
.textline--tr {
  margin-left: var(--space-1);
  padding-left: 6px;
  border-left: 2px solid var(--color-info-border);
}

.textline--tr .row__text {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.textline--tr .row__editor {
  min-height: 32px;
}

/* 「待确认」：分割时另一侧是整段复制过来的，还没有人按时间码拆开过。
   用红（本项目的错误语义色）而不是信息色 —— 它是要用户动手处理的东西 */
.textline.is-stale .row__text {
  color: var(--color-danger);
  background: var(--color-danger-subtle);
}

.textline--tr.is-stale {
  border-left-color: var(--color-danger);
}

.row__text {
  display: block;
  font-size: var(--font-size-sm);
  line-height: var(--line-base);
  color: var(--color-text-primary);
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
  /* 文本里的 \n 是「重新断行」的真实成果，照原样显示成换行 */
  white-space: pre-line;
  transition: background var(--dur-fast) var(--ease-out);
  /*
   * 全局默认禁选（见 global.css 的「文本选中策略」），这里是**唯一**的例外：
   * 字幕正文是用户真的会拷出去的东西。时间轴上的字幕条文字、状态栏数字那些
   * 则一律保持不可选 —— 它们是界面的标签，选中的价值为零，误选的代价却很烦。
   */
  user-select: text;
}

.cell--text:hover .row__text {
  background: var(--color-bg-hover);
}

/* 已改动的条目：末尾一个小圆点。中性色阶下没有色相可用，
   用字形标记比换颜色更容易分辨 */
.row.is-edited .textline--src .row__text::after {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-left: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  vertical-align: middle;
}

.row__editor {
  width: 100%;
  min-height: 44px;
  padding: 3px var(--space-1);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  font-family: inherit;
  font-size: var(--font-size-sm);
  line-height: var(--line-base);
  resize: none;
  outline: none;
  box-shadow: 0 0 0 2px var(--color-accent-subtle);
}

/*
 * 已忽略的行：文字退一档，但仍完全可编辑。
 *
 * 目前唯一的「恢复」入口在右键菜单里 —— 这是有意的取舍：
 * 忽略本来就是个低频动作，而它原来占着整整一列 78px，
 * 让每一行正文都短了一截。
 */
.row.is-acked .row__text {
  color: var(--color-text-secondary);
}

.subtable__empty {
  padding: var(--space-10) var(--space-6);
  text-align: center;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}
</style>
