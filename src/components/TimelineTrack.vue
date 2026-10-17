<script setup lang="ts">
/**
 * 时间轴（时间轴泳道 + 波形）。
 *
 * 三层结构，各管一件事：
 *   ① canvas 只画波形与网格 —— 每像素一列采样，缩放时重映射时间即可；
 *   ② DOM 画字幕条 —— 文字截断、光标、拖拽热区这些用 DOM 最省事，
 *      而且只渲染可视范围内的几十条，与表格里几千行 DOM 是两码事；
 *   ③ DOM 画播放头 —— 它要贯穿波形与字幕轨道，用 canvas 画就会被下面的
 *      字幕条盖住。
 *
 * 三层共用同一个坐标映射 `x(t) = (t - viewStartSec) * pxPerSec`，
 * 这是整块界面唯一的「时间 ↔ 像素」换算，任何交互都走它，不各算各的。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useSettingsStore } from '@/stores/settings'
import { useHistoryStore } from '@/stores/history'
import { makeMockPeaks } from '@/mock/mockData'
import { assignLanes, exceedsLaneLimit, laneNeighbours, MAX_LANES } from '@/utils/timelineLayout'
import { MIN_SEGMENT_SEC } from '@/utils/segmentOps'
import { noticeBlocked } from '@/utils/confirm'
import { toTimecode } from '@/utils/format'
import type { AudioPeaks, SubtitleSegment } from '@/types'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const editor = useEditorStore()
const settings = useSettingsStore()
const history = useHistoryStore()

const stageRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

const WAVE_H = 72
/** 单条泳道高度 */
const LANE_H = 24
/**
 * 最多铺几条泳道。取值与上限同源，见 `timelineLayout.MAX_LANES` ——
 * 界面上「能画几层」和「允许多少条同时重叠」必须是同一个数字，
 * 否则拦下来的和画出来的对不上。
 */
/** 边界拖拽热区宽度（条够宽时才用得上） */
const GRIP_MAX = 8
/** 最小可见时长（秒）：放大到这个程度就到顶了 */
const MIN_VISIBLE_SEC = 0.6
/**
 * 纵向上移出这个距离视为「换轨」，解除同轨夹取（允许与邻居重叠）。
 *
 * 「同一泳道不许重叠」是默认约束，拖拽被邻居顶住是**有意为之的对齐辅助**；
 * 想重叠就得主动把指针纵向挪开一点，表达「我要换到别的泳道去」——这样
 * 一般的横向拖动不会误触重叠。
 *
 * 取 0.2 个泳道（≈5px）。这一路是往下调的：0.6（≈14px）→ 0.3（≈7px）→ 0.2。
 * 前两档都要挪一大段才突破，很不跟手；5px 仍然明显大于横向拖动时的手抖
 * （约 1–3px），「对齐」这层保护还在。再小就要开始误触了。
 */
const LANE_ESCAPE_PX = LANE_H * 0.2
/**
 * 横向拖动多少像素才算「真的在拖」。
 *
 * 没有它的话，一次 Ctrl+单击（指针几乎不动）也会被当成拖拽，松手时把 click
 * 吃掉 —— 表现就是「多选点了没反应」。阈值取 3px：比手抖大，比有意的拖动小。
 */
const DRAG_THRESHOLD = 3

/** 统一把时间码收敛到毫秒，避免浮点尾巴越算越长 */
function round3(v: number): number {
  return Number(v.toFixed(3))
}

function css(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/* ------------------------------------------------------------ 时长与视窗 */

/** 演示数据（无真实音频文件时）的峰值 */
const mockPeaks = ref<AudioPeaks | null>(null)

function currentDuration(): number {
  return (
    project.peaksOf(project.viewFileId)?.durationSec ??
    mockPeaks.value?.durationSec ??
    project.viewFile?.durationSec ??
    0
  )
}

const duration = computed(() => currentDuration())
const stageW = ref(0)

/**
 * 缩放用「相对适应宽度的倍数」而不是绝对像素密度。
 *
 * 这样窗口一改大小，适应宽度会自动跟着变，用户之前放大的倍数依然成立 ——
 * 记绝对 px/s 的话，窗口变宽后视图会莫名其妙多出一截空白或内容跑到视野外。
 */
const zoom = ref(1)

/** 适应宽度时的像素密度 */
const fitPxPerSec = computed(() =>
  duration.value > 0 && stageW.value > 0 ? stageW.value / duration.value : 0,
)
const pxPerSec = computed(() => fitPxPerSec.value * zoom.value)
/** 当前视窗覆盖的时长（秒） */
const visibleSec = computed(() =>
  pxPerSec.value > 0 ? stageW.value / pxPerSec.value : duration.value,
)
/** 放大上限：视窗里至少还能看到 MIN_VISIBLE_SEC 那么长 */
const maxZoom = computed(() =>
  duration.value > 0 ? Math.max(1, duration.value / MIN_VISIBLE_SEC) : 1,
)

const viewStartSec = ref(0)

function clampView(): void {
  const maxStart = Math.max(0, duration.value - visibleSec.value)
  if (viewStartSec.value > maxStart) viewStartSec.value = maxStart
  if (viewStartSec.value < 0) viewStartSec.value = 0
}

/** 时间 → 像素（相对 stage 左边缘） */
function xOf(t: number): number {
  return (t - viewStartSec.value) * pxPerSec.value
}

/** 像素 → 时间 */
function timeAtX(x: number): number {
  if (pxPerSec.value <= 0) return 0
  return viewStartSec.value + x / pxPerSec.value
}

/**
 * 以某个时间点为锚点缩放：锚点停在屏幕上的同一个位置。
 *
 * 不这么做的话，逐级放大时内容会整体往左飘，用户得反复重新定位 ——
 * 触控板捏合缩放尤其明显（锚点应该始终在两根手指中间）。
 */
function zoomAround(nextZoom: number, anchorSec: number): void {
  const clamped = Math.min(maxZoom.value, Math.max(1, nextZoom))
  if (clamped === zoom.value) return
  const width = stageW.value
  const anchorRatio = width > 0 && pxPerSec.value > 0 ? (anchorSec - viewStartSec.value) / visibleSec.value : 0
  zoom.value = clamped
  if (clamped <= 1) {
    viewStartSec.value = 0
    return
  }
  viewStartSec.value = anchorSec - anchorRatio * (width / (fitPxPerSec.value * clamped))
  clampView()
}

function resetZoom(): void {
  zoom.value = 1
  viewStartSec.value = 0
}

/* -------------------------------------------------------------- 泳道布局 */

const segments = computed(() => project.viewFile?.segments ?? [])
const allIds = computed(() => segments.value.map((s) => s.id))
const selectedSet = computed(() => new Set(editor.selectedIds))

/**
 * 泳道分配是纯数据派生，任何来源的改动都会自动重排 ——
 * 时间轴上拖动、下方表格里手输时间码、批量整体偏移，走的是同一条路。
 */
const layout = computed(() => assignLanes(segments.value))
const laneCount = computed(() => Math.max(1, layout.value.laneCount))
const visibleLaneCount = computed(() => Math.min(laneCount.value, MAX_LANES))
/** 泳道区高度 */
const lanesH = computed(() => visibleLaneCount.value * LANE_H)
/** 超限的泳道数（仅用于提示） */
const overflowLanes = computed(() => Math.max(0, laneCount.value - MAX_LANES))

function laneIndexOf(segId: string): number {
  return layout.value.laneOf.get(segId) ?? 0
}

/**
 * 某条是否落在上限之外。
 *
 * 这种状态正常来说不该出现 —— 时间码输入与拖拽都会在造成超限前拦下来，
 * 剩下的入口只有识别结果本身。但它一旦出现，画面上必须有**明确的区别**：
 * 早先的做法是把超出的条目直接叠在最后一层，结果几条色块糊在一起，用户
 * 既看不出哪一条是多余的，也判断不出这是个问题（只会觉得界面坏了）。
 * 现在给它们一套警示配色，配合工具条上的一句说明。
 */
function isOverflow(segId: string): boolean {
  return laneIndexOf(segId) >= MAX_LANES
}

/**
 * 超出可见泳道的条目堆进最后一条：宁可视觉重叠，也不能让它消失
 * —— 消失了就点不到、删不掉，用户反而没有办法收拾这个局面。
 * 区别靠配色给出来，不靠位置。
 */
function laneTop(segId: string): number {
  return Math.min(laneIndexOf(segId), MAX_LANES - 1) * LANE_H
}

/* ------------------------------------------------------------- 拖拽状态 */

interface DragState {
  id: string
  /**
   * `move` = 拖整条平移；`start` / `end` = 拖某一侧的边界。
   * 三种共用一套状态机：都是「按下 → 跟随鼠标 → 松手落数据」，
   * 差别只在算新时间码的那一行。
   */
  edge: 'move' | 'start' | 'end'
  /** 逻辑泳道序号，用于夹取邻居 */
  lane: number
  pointerId: number
  originY: number
  /** 按下时的指针横坐标。拖整条按位移算，必须有个不变的参照点 */
  originX: number
  /** 按下时的原始时间码（拖整条时整段平移的基准） */
  originStart: number
  originEnd: number
  /** 边界拖拽时：可拖到的**时间**范围（秒） */
  lo: number
  hi: number
  /** 拖整条时：可平移的**位移**范围（秒） */
  minDelta: number
  maxDelta: number
  /** 纵向拖离本泳道 → 解除夹取，允许与邻居重叠（落到另一条泳道上） */
  escaped: boolean
  moved: boolean
}

const drag = ref<DragState | null>(null)
/** 拖拽中的临时时间码。只在本地改，松手才落数据与历史栈 */
const dragPreview = ref<{ id: string; start: number; end: number } | null>(null)
/** 拖拽刚结束时浏览器还会补一个 click，别把它当成「选中」 */
let suppressClick = false

interface Bar {
  seg: SubtitleSegment
  x: number
  w: number
  top: number
  active: boolean
  dragging: boolean
  /** 落在 MAX_LANES 之外（正常不该发生，见 isOverflow） */
  overflow: boolean
}

/** 只渲染可视范围内的条目。2000 条里真正在视野里的通常只有几十条 */
const bars = computed<Bar[]>(() => {
  const width = stageW.value
  if (width <= 0 || pxPerSec.value <= 0) return []
  const out: Bar[] = []
  const dragging = dragPreview.value
  for (const seg of segments.value) {
    const moving = dragging && dragging.id === seg.id ? dragging : null
    const start = moving ? moving.start : seg.start
    const end = moving ? moving.end : seg.end
    const x = xOf(start)
    const w = Math.max(2, (end - start) * pxPerSec.value)
    if (x + w < -12 || x > width + 12) continue
    out.push({
      seg,
      x,
      w,
      top: laneTop(seg.id),
      active: selectedSet.value.has(seg.id),
      dragging: !!moving,
      overflow: isOverflow(seg.id),
    })
  }
  return out
})

/** 条太窄时热区要跟着收，否则整条都是热区，点不中（点哪儿都在拖边界） */
function gripWidth(barW: number): number {
  return Math.max(2, Math.min(GRIP_MAX, barW / 3))
}

/* ------------------------------------------------------------ 拖拽实现 */

/** 把指针捕获与初始状态一次装好，三种拖拽共用 */
function beginDrag(
  event: PointerEvent,
  seg: SubtitleSegment,
  edge: 'move' | 'start' | 'end',
): void {
  if (event.button !== 0) return
  const lane = laneIndexOf(seg.id)
  const { prev, next } = laneNeighbours(segments.value, layout.value.laneOf, seg.id, lane)

  // 同一条泳道上不许重叠：拖这一侧时被左右邻居顶住。
  // 没有邻居的一侧退到 0 / 总时长（拖整条则是「不许移出音频范围」）。
  const lo = edge === 'start' ? (prev ? prev.end : 0) : seg.start + MIN_SEGMENT_SEC
  const hi = edge === 'start' ? seg.end - MIN_SEGMENT_SEC : next ? next.start : duration.value
  const minDelta = prev ? prev.end - seg.start : -seg.start
  const maxDelta = next ? next.start - seg.end : duration.value - seg.end

  drag.value = {
    id: seg.id,
    edge,
    lane,
    pointerId: event.pointerId,
    originY: event.clientY,
    originX: event.clientX,
    originStart: seg.start,
    originEnd: seg.end,
    lo,
    hi,
    minDelta,
    maxDelta,
    escaped: false,
    moved: false,
  }
  dragPreview.value = { id: seg.id, start: seg.start, end: seg.end }
  suppressClick = false

  const el = event.currentTarget as HTMLElement
  el.setPointerCapture(event.pointerId)
  /*
   * 只有拖边界这一路可以 preventDefault。
   *
   * 拖整条是**挂在字幕条自己身上**的：对 pointerdown 调 preventDefault 会连带
   * 把浏览器的兼容鼠标事件（mousedown / mouseup / click）一起掐掉，于是
   * 「点一下选中」直接失效 —— 而拖整条只有在真的动了之后才算拖，没动的那一下
   * 必须还是普通点击。文本选中由全局的 `user-select: none` 挡着，不需要这里出手。
   */
  if (edge !== 'move') event.preventDefault()
  event.stopPropagation()
}

/** 拖条两侧的边界：改起点或终点 */
function startDrag(event: PointerEvent, seg: SubtitleSegment, edge: 'start' | 'end'): void {
  beginDrag(event, seg, edge)
}

/** 拖条身：整条平移（起点终点一起动，时长不变） */
function startMove(event: PointerEvent, seg: SubtitleSegment): void {
  beginDrag(event, seg, 'move')
}

function onDragMove(event: PointerEvent): void {
  const state = drag.value
  const preview = dragPreview.value
  if (!state || !preview || event.pointerId !== state.pointerId) return

  const stage = stageRef.value
  if (!stage || pxPerSec.value <= 0) return

  // 纵向拖开一条泳道的高度 → 当作「换轨」，解除夹取，允许重叠
  if (!state.escaped && Math.abs(event.clientY - state.originY) > LANE_ESCAPE_PX) {
    state.escaped = true
  }

  const dx = event.clientX - state.originX
  // 手抖不算拖动：低于阈值时连 moved 都不置位，松手后 click 才能照常选中
  if (Math.abs(dx) < DRAG_THRESHOLD) return
  state.moved = true

  if (state.edge === 'move') {
    // 整条平移：位移直接由像素差换算，不经过「时间 - 时间」，跟手且不受缩放累积误差影响
    const lo = state.escaped ? -state.originStart : state.minDelta
    const hi = state.escaped ? duration.value - state.originEnd : state.maxDelta
    const delta = Math.max(lo, Math.min(dx / pxPerSec.value, hi))
    preview.start = round3(state.originStart + delta)
    preview.end = round3(state.originEnd + delta)
    return
  }

  const rect = stage.getBoundingClientRect()
  const t = timeAtX(event.clientX - rect.left)
  if (state.edge === 'start') {
    preview.start = Math.max(state.lo, Math.min(t, preview.end - MIN_SEGMENT_SEC, state.hi))
  } else {
    preview.end = Math.min(state.hi, Math.max(t, preview.start + MIN_SEGMENT_SEC, state.lo))
  }
}

function onDragUp(event: PointerEvent): void {
  const state = drag.value
  const preview = dragPreview.value
  // 先认领再清状态：别的指针（比如第二根手指）抬起时不能把当前拖拽清掉
  if (!state || !preview || event.pointerId !== state.pointerId) return
  drag.value = null
  dragPreview.value = null

  if (!state.moved) return

  suppressClick = true
  window.setTimeout(() => {
    suppressClick = false
  }, 0)

  const file = project.viewFile
  if (!file) return
  const target = file.segments.find((s) => s.id === state.id)
  if (!target) return

  const start = round3(preview.start)
  const end = round3(preview.end)
  if (start === target.start && end === target.end) return

  // 上限硬拦：纵向逃逸之后整条可以落到任何位置，这一步完全可能把它推成第 6 条
  if (exceedsLaneLimit(file.segments, { id: state.id, start, end })) {
    void noticeBlocked({
      title: `同一时刻最多 ${MAX_LANES} 条字幕`,
      message: '这次拖动会让同一时刻重叠的字幕超过上限，改动已经放弃。',
      detail: '把挤在一起的字幕挪开或者删掉几条之后再试。',
    })
    return
  }

  const label =
    state.edge === 'move' ? '移动字幕' : state.edge === 'start' ? '调整字幕起点' : '调整字幕终点'
  history.commit(file.id, file.segments, label, () => {
    file.segments = file.segments.map((s) => (s.id === state.id ? { ...s, start, end } : s))
  })
  // 刻意**不**挪播放头：拖一下就把游标带走，会打断「先摆好位置、再逐条听」的节奏。
  // 游标只由「点空白处」和播放本身决定。
}

/* ------------------------------------------------------------ 播放头拖拽 */

/*
 * 播放头本身是 1.5px 的细线，直接拿它当热区是点不中的。
 * 所以线保持 `pointer-events: none`，在它内部挂一条 **9px 宽的透明热区**
 * （子元素写 `pointer-events: auto` 可以把祖先的 none 覆盖回来）。
 *
 * 9px 这个宽度是权衡出来的：再宽就会开始挡住字幕条 —— 播放头是 z-index 4，
 * 压在字幕条上面，热区太宽时「想把游标停在某条字幕上」会变成「拖游标」。
 */
const scrubLabel = ref<string | null>(null)
let scrubPointer: number | null = null

function seekToPointer(clientX: number): void {
  const stage = stageRef.value
  if (!stage || duration.value <= 0) return
  const rect = stage.getBoundingClientRect()
  // 只夹在 [0, 总时长]，**不**躲字幕条：游标本来就该能停在任意位置，
  // 它和字幕条之间没有「不能重叠」的约束（那是拖字幕条的规则）
  const t = Math.max(0, Math.min(duration.value, timeAtX(clientX - rect.left)))
  editor.setPlayhead(t)
  scrubLabel.value = toTimecode(t)
}

function startScrub(event: PointerEvent): void {
  if (event.button !== 0 || duration.value <= 0) return
  // 必须掐掉冒泡：stage 上还挂着「点空白定位」与「拖拽平移」两套逻辑，
  // 不拦的话一次拖拽会被解读成三次（定位 + 平移 + 拖游标）
  //
  // **但绝不能在这里 preventDefault()** —— 它对 pointerdown 生效时会连
  // 兼容鼠标事件（mousedown / click / dblclick）一起掐掉，于是「双击播放头回到开头」
  // 永远不会触发。这跟「拖整条字幕条」那条坑是同一个机制（那边也是不能 preventDefault，
  // 否则「点一下选中」失效），所以两处都只 stopPropagation。
  event.stopPropagation()
  scrubPointer = event.pointerId
  editor.scrubbing = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  seekToPointer(event.clientX)
}

function onScrubMove(event: PointerEvent): void {
  if (scrubPointer === null || event.pointerId !== scrubPointer) return
  event.stopPropagation()
  seekToPointer(event.clientX)
}

function endScrub(event: PointerEvent): void {
  if (scrubPointer === null || event.pointerId !== scrubPointer) return
  event.stopPropagation()
  scrubPointer = null
  scrubLabel.value = null
  // 交给播放器去追新位置：拖拽期间它刻意不跟（否则每帧 seek 一次，声音会碎）
  editor.scrubbing = false
}

/** 双击播放头回到起点：剪辑软件里的老习惯，顺手给上 */
function resetPlayhead(): void {
  editor.setPlayhead(0)
  scrubLabel.value = null
}

/* -------------------------------------------------------- 轨道空白区交互 */
/** 空白处按下：先移游标，若接着拖动则改判为平移时间轴 */
const panning = ref(false)
let panState: {
  pointerId: number
  originX: number
  originStart: number
  playheadBefore: number
  moved: boolean
} | null = null
/** 拖拽平移的启动阈值（像素） */
const PAN_THRESHOLD = 4

function onStagePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || duration.value <= 0) return
  const stage = stageRef.value
  if (!stage) return
  const rect = stage.getBoundingClientRect()
  const t = Math.max(0, Math.min(duration.value, timeAtX(event.clientX - rect.left)))

  panState = {
    pointerId: event.pointerId,
    originX: event.clientX,
    originStart: viewStartSec.value,
    playheadBefore: editor.playheadSec,
    moved: false,
  }
  // 点击即定位：与旧版行为一致（点轨道任何非字幕位置都把游标移过去）
  editor.setPlayhead(t)
  stage.setPointerCapture(event.pointerId)
}

function onStagePointerMove(event: PointerEvent): void {
  if (!panState || event.pointerId !== panState.pointerId) return
  const dx = event.clientX - panState.originX
  if (!panState.moved) {
    if (Math.abs(dx) < PAN_THRESHOLD) return
    panState.moved = true
    panning.value = true
    // 一开始按下的那次定位作废：用户是在拖时间轴，不是在挑位置
    editor.setPlayhead(panState.playheadBefore)
  }
  if (zoom.value <= 1) return
  viewStartSec.value = panState.originStart - dx / pxPerSec.value
  clampView()
}

function onStagePointerUp(event: PointerEvent): void {
  if (!panState || event.pointerId !== panState.pointerId) return
  panState = null
  panning.value = false
}

/* ------------------------------------------------------------ 字幕条交互 */

function onBarClick(event: MouseEvent, seg: SubtitleSegment): void {
  if (suppressClick) return
  // Ctrl/Cmd 多选；Shift 连选（与表格里的行点击保持同一套语义）
  const mode = event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'range' : 'replace'
  editor.select(seg.id, mode, allIds.value)
  /*
   * 刻意**不**把播放头挪到这一条的起点。
   *
   * 游标是「当前听到哪儿」的唯一标示，只该由「点空白处」和播放本身决定。
   * 点一条就把游标带走，会让人没法一边听一边挑条目 —— 尤其配上「选中即播放」
   * 的习惯后，点第二下就把第一下听到的位置丢了。要定位到这一条，
   * 点它前面/后面的空白处就行，那一次点击本来就是「我要从这儿听」。
   */
}

/* -------------------------------------------------------------- 滚轮交互 */

/**
 * 滚轮：
 *   - 普通滚轮 = 水平平移（上下滚也走横向。时间轴只有一根轴，不需要纵向滚动）
 *   - Ctrl/Cmd + 滚轮 = 缩放（触控板双指捏合在 Chromium 里就是带 ctrlKey 的 wheel）
 *
 * **必须 preventDefault**：Chromium 默认把 Ctrl+wheel 当整页缩放，不拦住的话
 * 一次捏合会把整个软件界面放大，比缩放不生效更糟。
 * 元素级 addEventListener 默认 passive:false，显式写上是为了不依赖这个默认值。
 */
function onWheel(event: WheelEvent): void {
  if (duration.value <= 0) return
  event.preventDefault()

  if (event.ctrlKey || event.metaKey) {
    const stage = stageRef.value
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    // 触控板捏合的 deltaY 很小，鼠标滚轮很大，指数映射让两者手感接近
    const factor = Math.exp(-event.deltaY * 0.0022)
    zoomAround(zoom.value * factor, timeAtX(event.clientX - rect.left))
    return
  }

  if (zoom.value <= 1) return
  // 横向滚轮优先用 deltaX；只有纵向滚轮时把它当横向用
  const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  const pixels = event.deltaMode === 1 ? raw * 16 : raw
  viewStartSec.value += pixels / pxPerSec.value
  clampView()
}

function zoomBy(factor: number): void {
  const center = viewStartSec.value + visibleSec.value / 2
  zoomAround(zoom.value * factor, center)
}

/* ---------------------------------------------------------------- 绘制 */

function draw(): void {
  const canvas = canvasRef.value
  const width = stageW.value
  if (!canvas || width <= 0) return

  const height = WAVE_H
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const dur = duration.value
  if (dur <= 0 || pxPerSec.value <= 0) return

  const colorWave = css('--color-waveform', '#a8a8a8')
  const colorGrid = css('--color-grid-line', 'rgba(0,0,0,.07)')
  const colorBorder = css('--color-segment-border', '#3f3f3f')

  const start = viewStartSec.value
  const end = start + visibleSec.value
  const mid = height / 2
  const half = Math.max(4, height / 2 - 8)

  /* 时间网格：步长随视窗长度自适应，缩得越深越细 */
  const span = end - start
  const stepSec =
    span > 1800 ? 300 : span > 600 ? 120 : span > 180 ? 30 : span > 60 ? 10 : span > 20 ? 5 : span > 6 ? 1 : 0.5
  ctx.strokeStyle = colorGrid
  ctx.lineWidth = 1
  for (let t = Math.ceil(start / stepSec) * stepSec; t < end; t += stepSec) {
    const x = Math.round(xOf(t)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }

  /* 中线 */
  ctx.beginPath()
  ctx.moveTo(0, Math.round(mid) + 0.5)
  ctx.lineTo(width, Math.round(mid) + 0.5)
  ctx.stroke()

  /* 合并模式：分段边界，一眼看清每段音频从哪儿开始 */
  if (project.isMerge) {
    ctx.strokeStyle = colorBorder
    ctx.setLineDash([3, 3])
    for (const part of project.mergedParts) {
      if (part.offsetSec <= start || part.offsetSec >= end) continue
      const x = Math.round(xOf(part.offsetSec)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  /* 波形：每像素列取该列覆盖到的采样峰值 */
  const peaks = project.peaksOf(project.viewFileId) ?? mockPeaks.value
  if (!peaks) return
  const { data, peaksPerSecond } = peaks
  ctx.fillStyle = colorWave

  for (let x = 0; x < width; x += 1) {
    const t0 = start + x / pxPerSec.value
    const t1 = start + (x + 1) / pxPerSec.value
    const i0 = Math.floor(t0 * peaksPerSecond)
    const i1 = Math.max(i0 + 1, Math.floor(t1 * peaksPerSecond))
    let max = 0
    for (let i = Math.max(0, i0); i < i1 && i < data.length; i += 1) {
      if (data[i] > max) max = data[i]
    }
    if (max <= 0) continue
    const h = Math.max(0.8, max * half)
    ctx.fillRect(x, mid - h, 1, h * 2)
  }
  // 「已播过」的一档深色不在这里画：那会让每一帧播放都要重绘整条波形。
  // 改由上层一个 DOM 遮罩按播放头宽度盖出来，成本是一次 transform 合成。
}

/* ------------------------------------------------------------ 生命周期 */

let raf = 0
function scheduleDraw(): void {
  if (raf) return
  raf = window.requestAnimationFrame(() => {
    raf = 0
    draw()
  })
}

let stageObserver: ResizeObserver | null = null
let mockMedia: MediaQueryList | null = null

onMounted(() => {
  const stage = stageRef.value
  if (stage) {
    stageW.value = stage.clientWidth
    stageObserver = new ResizeObserver((entries) => {
      for (const entry of entries) stageW.value = Math.round(entry.contentRect.width)
      clampView()
      scheduleDraw()
    })
    stageObserver.observe(stage)
    stage.addEventListener('wheel', onWheel, { passive: false })
  }
  mockMedia = window.matchMedia('(prefers-color-scheme: dark)')
  mockMedia.addEventListener('change', scheduleDraw)

  // 拖拽热区虽然 SetPointerCapture 了指针，但指针移出浏览器窗口时事件仍可能
  // 落在 window 上，所以在 window 上再收一遍，避免条「粘住鼠标」
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerUp)
  window.addEventListener('pointercancel', onWindowPointerUp)
  scheduleDraw()
})

onBeforeUnmount(() => {
  stageObserver?.disconnect()
  mockMedia?.removeEventListener('change', scheduleDraw)
  stageRef.value?.removeEventListener('wheel', onWheel)
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', onWindowPointerUp)
  window.removeEventListener('pointercancel', onWindowPointerUp)
  if (raf) window.cancelAnimationFrame(raf)
})

/** 换文件 / 换合并产物：视窗复位，并把演示峰值准备好 */
watch(
  () => project.viewFileId,
  (fileId) => {
    const file = project.viewFile
    if (!file?.durationSec) {
      mockPeaks.value = null
    } else if (!project.peaksOf(fileId)) {
      mockPeaks.value = file.demo ? makeMockPeaks(file.durationSec, 50) : null
    } else {
      mockPeaks.value = null
    }
    if (fileId && file && !file.merged) void project.ensureMedia(fileId)
    resetZoom()
    editor.setPlayhead(0)
    scheduleDraw()
  },
  { immediate: true },
)

watch([zoom, viewStartSec, stageW], () => {
  clampView()
  scheduleDraw()
})

watch(duration, () => {
  clampView()
  scheduleDraw()
})

/**
 * 波形到达就重画。
 *
 * `mediaVersion` 必须显式列进来：peaks 是**异步**写进 `project.media`这张 Map 的，
 * 而 Map 的内容变动不可靠地触发 Vue 依赖（详见 store 里 mediaVersion 的注释）。
 * 只靠 `project.peaksOf()` 的返回值当依赖，peaks 到位那一刻可能根本没人被通知。
 */
watch(() => [project.mediaVersion, project.peaksOf(project.viewFileId), settings.themeMode, project.isMerge], scheduleDraw)

/** 时间码变化后泳道可能重排，波形不必重画，但条的位置要跟着动 */
watch(
  () => project.viewFile?.segments.map((s) => `${s.id}:${s.start}-${s.end}`).join(','),
  () => {
    clampView()
    scheduleDraw()
  },
)

/* ------------------------------------------------ 与下方字幕区的双向联动 */

/**
 * 波形侧选中 → 表格侧已经有一份「滚动到该行」的 watch，不必重复。
 * 这里补反方向：表格里换了选中项（键盘上下、校验列表跳转）时，
 * 把时间轴视窗挪过去，让那条真的出现在视野里 —— 放大了以后
 * 「选中了但看不见」是最容易让人以为点坏了的情况。
 */
watch(
  () => editor.selectedIds[0],
  (id) => {
    if (!id || zoom.value <= 1) return
    const seg = segments.value.find((s) => s.id === id)
    if (!seg) return
    const left = xOf(seg.start)
    const right = xOf(seg.end)
    if (left >= 0 && right <= stageW.value) return
    const span = visibleSec.value
    // 居中偏左一点：右边留出余量，方便连看后面几条
    viewStartSec.value = seg.start - span * 0.3
    clampView()
  },
)

/** 播放时视窗跟着走，否则放大以后播到后面就看不见了 */
watch(
  () => editor.playheadSec,
  (t) => {
    if (!editor.isPlaying || zoom.value <= 1) return
    const span = visibleSec.value
    if (t >= viewStartSec.value && t <= viewStartSec.value + span * 0.9) return
    viewStartSec.value = t - span * 0.2
    clampView()
  },
)

/** 拖拽中的预览也走全局监听：指针可能被 SetPointerCapture 绑到热区上 */
function onWindowPointerMove(event: PointerEvent): void {
  onDragMove(event)
}
function onWindowPointerUp(event: PointerEvent): void {
  onDragUp(event)
}

/* ------------------------------------------------------------------ 文案 */

const zoomPercent = computed(() => `${Math.round(zoom.value * 100)}%`)

const statusText = computed(() => {
  const count = editor.selectedIds.length
  if (count === 0) return '点击字幕条选中，点空白处定位播放头'
  if (count === 1) {
    const seg = segments.value.find((s) => s.id === editor.selectedIds[0])
    return seg ? `已选中第 ${segments.value.indexOf(seg) + 1} 条` : '已选中 1 条'
  }
  return `已选中 ${count} 条`
})

/** 拖拽时的时间码气泡 */
const dragBubble = computed(() => {
  const preview = dragPreview.value
  const state = drag.value
  if (!preview || !state) return null
  const t = state.edge === 'start' ? preview.start : preview.end
  return { x: xOf(t), text: toTimecode(t), escaped: state.escaped }
})

/** 字幕条上显示的文字：只取一小段，靠 CSS 截断补省略号 */
function clipText(seg: SubtitleSegment): string {
  const text = seg.text.trim()
  return text || '（空）'
}

const playheadX = computed(() => xOf(editor.playheadSec))

/** 已播遮罩宽度：夹在 0…stage 宽之间，播放头在视窗外时遮罩不会撑破容器 */
const playedWidth = computed(() => Math.max(0, Math.min(stageW.value, playheadX.value)))
</script>

<template>
  <div class="timeline">
    <!-- 工具条：不放标题，只放状态与缩放操作，尽量少占高度 -->
    <div class="timeline__bar">
      <span class="timeline__status">{{ statusText }}</span>

      <span v-if="overflowLanes > 0" class="timeline__warn">
        同一时刻重叠超过 {{ MAX_LANES }} 条（共 {{ laneCount }} 层），超出的已用警示色标出
      </span>

      <span class="spacer" />

      <span class="timeline__zoom mono">{{ zoomPercent }}</span>
      <button
        class="timeline__btn"
        type="button"
        title="缩小（Ctrl + 滚轮）"
        :disabled="zoom <= 1"
        @click="zoomBy(1 / 1.6)"
      >
        <Icon name="zoom-out" :size="13" />
      </button>
      <button
        class="timeline__btn"
        type="button"
        title="适应宽度（把整段音频铺满）"
        :disabled="zoom <= 1"
        @click="resetZoom"
      >
        <Icon name="fit-width" :size="13" />
      </button>
      <button
        class="timeline__btn"
        type="button"
        title="放大（Ctrl + 滚轮）"
        :disabled="zoom >= maxZoom"
        @click="zoomBy(1.6)"
      >
        <Icon name="zoom-in" :size="13" />
      </button>
    </div>

    <div
      ref="stageRef"
      class="timeline__stage"
      :class="{ 'is-panning': panning, 'is-zoomed': zoom > 1 }"
      :style="{ '--wave-h': WAVE_H + 'px', '--lanes-h': lanesH + 'px' }"
      @pointerdown="onStagePointerDown"
      @pointermove="onStagePointerMove"
      @pointerup="onStagePointerUp"
      @pointercancel="onStagePointerUp"
    >
      <canvas ref="canvasRef" class="timeline__wave" />

      <!-- 已播区域：一层遮罩跟着播放头走，比每帧重绘波形便宜得多 -->
      <div class="timeline__played" :style="{ width: playedWidth + 'px' }" />

      <div class="timeline__lanes">
        <div
          v-for="bar in bars"
          :key="bar.seg.id"
          class="tl-clip"
          :class="{
            'is-active': bar.active,
            'is-dragging': bar.dragging,
            'is-overflow': bar.overflow,
          }"
          :data-seg-id="bar.seg.id"
          :style="{ left: bar.x + 'px', width: bar.w + 'px', top: bar.top + 'px', '--lane-h': LANE_H + 'px' }"
          :title="
            bar.overflow
              ? '这一条超出了同一时刻的字幕条数上限，请调整时间码或删除'
              : `${bar.seg.text || '（空）'}\n拖动条身可整体平移，拖两侧可改边界`
          "
          @pointerdown="startMove($event, bar.seg)"
          @click="onBarClick($event, bar.seg)"
        >
          <span class="tl-clip__text">{{ clipText(bar.seg) }}</span>
          <span
            class="tl-clip__grip tl-clip__grip--start"
            :style="{ width: gripWidth(bar.w) + 'px' }"
            title="拖动调整起点"
            @pointerdown="startDrag($event, bar.seg, 'start')"
            @click.stop
          />
          <span
            class="tl-clip__grip tl-clip__grip--end"
            :style="{ width: gripWidth(bar.w) + 'px' }"
            title="拖动调整终点"
            @pointerdown="startDrag($event, bar.seg, 'end')"
            @click.stop
          />
        </div>
      </div>

      <div class="timeline__playhead" :style="{ transform: `translateX(${playheadX}px)` }">
        <span
          class="timeline__playhead-hit"
          title="拖动调整播放位置（双击回到开头）"
          @pointerdown="startScrub"
          @pointermove="onScrubMove"
          @pointerup="endScrub"
          @pointercancel="endScrub"
          @lostpointercapture="endScrub"
          @dblclick="resetPlayhead"
        />
      </div>

      <div
        v-if="scrubLabel"
        class="timeline__bubble mono"
        :style="{ transform: `translateX(${playheadX}px)` }"
      >
        {{ scrubLabel }}
      </div>

      <div
        v-if="dragBubble"
        class="timeline__bubble mono"
        :class="{ 'is-free': dragBubble.escaped }"
        :style="{ transform: `translateX(${dragBubble.x}px)` }"
      >
        {{ dragBubble.text }}
      </div>

      <p v-if="duration <= 0" class="timeline__empty">还没有可显示的波形数据</p>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  flex: none;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-surface);
}

/* ------------------------------------------------------------ 工具条 */

.timeline__bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 var(--space-3);
}

.timeline__status {
  font-size: 11px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.timeline__warn {
  flex: none;
  font-size: 11px;
  color: var(--color-warning);
}

.timeline__zoom {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
  /* 数字等宽，缩放时百分比跳动不会让按钮跟着左右晃 */
  font-variant-numeric: tabular-nums;
}

.timeline__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
}

.timeline__btn:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.timeline__btn:disabled {
  opacity: 0.35;
}

/* ------------------------------------------------------- 波形 + 字幕轨道 */

.timeline__stage {
  position: relative;
  margin: 0 var(--space-3) var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
  overflow: hidden;
  cursor: crosshair;
  /* 触屏：不要让浏览器把拖动解释成滚动/缩放，我们自己处理 */
  touch-action: none;
}

.timeline__stage.is-panning {
  cursor: grabbing;
}

.timeline__wave {
  display: block;
  height: var(--wave-h);
}

/**
 * 已播遮罩：从左边铺到播放头，把波形压暗一档。
 * 只改宽度、不改 canvas，所以播放时每帧的代价是一次布局合成，而不是重绘。
 */
.timeline__played {
  position: absolute;
  top: 0;
  left: 0;
  height: var(--wave-h);
  background: var(--color-waveform-played-mask, rgba(255, 255, 255, 0.06));
  pointer-events: none;
}

/* 字幕轨道：几条泳道叠在一起，靠泳道分隔线看出是一条轨道 */
.timeline__lanes {
  position: relative;
  height: var(--lanes-h);
  border-top: 1px solid var(--color-lane-line, var(--color-border-subtle));
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent calc(var(--lane-h) - 1px),
    var(--color-lane-line, rgba(0, 0, 0, 0.06)) calc(var(--lane-h) - 1px),
    var(--color-lane-line, rgba(0, 0, 0, 0.06)) var(--lane-h)
  );
}

/* 单条字幕条 */
.tl-clip {
  position: absolute;
  height: calc(var(--lane-h) - 3px);
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 5px;
  border: 1px solid var(--color-clip-border);
  border-radius: 3px;
  background: var(--color-clip);
  color: var(--color-text-secondary);
  font-size: 10px;
  line-height: 1;
  overflow: hidden;
  /* 条身可整体拖动，光标用抓取手势提示「这里能拖」 */
  cursor: grab;
  /*
   * 只给 top 过渡：换泳道时平滑滑过去（这是用户要的「剪辑软件那味」），
   * 而 left / width 必须瞬时 —— 拖动边界和缩放时若也带缓动，
   * 条会追着鼠标慢慢爬，手感立刻变糊。
   * 拖「整条」时 left 在变，所以那一路由 .is-dragging 关掉过渡。
   */
  transition: top 0.16s ease, background-color 0.12s ease;
}

.tl-clip.is-active {
  background: var(--color-clip-active);
  border-color: var(--color-clip-border-active);
  color: var(--color-text-primary);
}

.tl-clip.is-dragging {
  transition: none;
  cursor: grabbing;
  background: var(--color-clip-active);
  border-color: var(--color-clip-border-active);
  color: var(--color-text-primary);
  z-index: 3;
}

/*
 * 超出「同时最多 5 条」的条目。
 *
 * 它们只能和别的条叠在同一层（没有第 6 层可放），所以必须靠**颜色**把自己
 * 摘出来 —— 否则画面就是几块糊在一起、看不出谁是谁的色块，用户只会以为
 * 界面坏了。红色在本项目里是「这里有问题、需要你处理」的语义，正好。
 * 注意仍然可点可拖：留着它们就是为了让用户能收拾这个局面。
 */
.tl-clip.is-overflow {
  background: var(--color-clip-overflow);
  border-color: var(--color-clip-overflow-border);
  color: var(--color-danger);
  border-style: dashed;
}

.tl-clip.is-overflow.is-active,
.tl-clip.is-overflow.is-dragging {
  background: var(--color-clip-overflow);
  border-style: solid;
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.tl-clip__text {
  flex: 1;
  min-width: 0;
  /* 放不下的字用省略号收掉：够宽就能认出是哪一条，窄了就只剩一个色块 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tl-clip__grip {
  position: absolute;
  top: 0;
  bottom: 0;
  cursor: col-resize;
}

.tl-clip__grip--start {
  left: 0;
}

.tl-clip__grip--end {
  right: 0;
}

.tl-clip__grip:hover {
  background: var(--color-clip-grip);
}

/* ---------------------------------------------------------- 播放头与气泡 */

.timeline__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1.5px;
  margin-left: -0.75px;
  background: var(--color-playhead);
  pointer-events: none;
  z-index: 4;
}

.timeline__playhead::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  border-radius: 50%;
  background: var(--color-playhead);
}

/* 播放头的拖拽热区。线本身是 pointer-events: none，这里把它「打开」。
   宽度别加大：播放头压在字幕条之上，热区一宽就抢走「点字幕条」的点击。 */
.timeline__playhead-hit {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 9px;
  margin-left: -4.5px;
  pointer-events: auto;
  cursor: ew-resize;
}

/* 顶部圆点单独放大一点：这是用户真正会去抓的地方 */
.timeline__playhead-hit::before {
  content: '';
  position: absolute;
  top: -2px;
  left: 50%;
  width: 13px;
  height: 13px;
  margin-left: -6.5px;
  border-radius: 50%;
}

.timeline__bubble {
  position: absolute;
  top: 2px;
  left: 0;
  z-index: 5;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-elevated, var(--color-bg-surface));
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  font-size: 10px;
  white-space: nowrap;
  pointer-events: none;
  transform-origin: left top;
}

.timeline__bubble.is-free {
  color: var(--color-warning);
}

.timeline__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}
</style>
