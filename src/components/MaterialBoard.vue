<script setup lang="ts">
/**
 * 素材区：拖放、列表、排序三件事合成一块。
 *
 * 为什么不再是「拖放框 + 队列表格」两截：
 *   · 两截时用户得先理解「这里放、那里看」，而它们本来就是同一批东西；
 *   · 表格的每一行是一条记录，天然不适合承载「一个文件」这种有身份的物件；
 *   · 顺序决定拼接顺序，方块之间**按住就能拖**比上下箭头直观得多。
 *
 * 末尾那个虚线方块是常驻入口：不写任何文字，只有加号。点击拉起系统文件
 * 选择器，音频与字幕走同一个入口 —— 用户手里的东西本来就是混着的，
 * 「先想清楚这是音频还是字幕，再选对应的按钮」是给软件省事，不是给人省事。
 */
import { ref } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { useI18n } from '@/composables/useI18n'
import type { AudioFile, FileStatus } from '@/types'
import { formatBytes, formatDuration } from '@/utils/format'
import { SUPPORTED_LABELS, SUBTITLE_EXTS, UNSUPPORTED_LABELS, extOf, isSubtitleExt } from '@/utils/formats'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()
const { t } = useI18n()

const inputRef = ref<HTMLInputElement | null>(null)
const isDev = import.meta.env.DEV

/** 正在拖动的源序号；null 表示当前不是内部排序 */
const dragFrom = ref<number | null>(null)
/** 松手会插到第几个位置之前（0..n），用来画那道插入线 */
const insertAt = ref<number | null>(null)

const STATUS_ICON: Record<FileStatus, string> = {
  queued: 'clock',
  processing: 'spinner',
  pending: 'dot',
  reviewed: 'check',
  edited: 'check',
  issue: 'alert',
  failed: 'alert',
  unsupported: 'ban',
}

function statusIcon(status: FileStatus): string {
  return STATUS_ICON[status]
}

/* ------------------------------------------------------------ 导入 */

function pick(): void {
  inputRef.value?.click()
}

/**
 * 收下选好的文件。
 *
 * 全选字幕时**直接进编辑器**：这类文件不需要识别，用户点开就是为了改它，
 * 停在素材区等他再点一次「去预览」是多余的。混选或含音频时留在这一页 ——
 * 那才是有活要干的情况。
 */
async function accept(files: File[]): Promise<void> {
  if (files.length === 0) return
  const bridge = window.xbaos
  const subtitleOnly = files.every((f) => isSubtitleExt(extOf(f.name)))
  if (subtitleOnly && bridge?.pathForFile) {
    let ok = false
    for (const f of files) {
      const path = bridge.pathForFile(f)
      if (path && (await project.addSubtitleFromPath(path))) ok = true
    }
    if (ok) ui.navigate('editor')
    return
  }
  // 音频与字幕的分流本来就在 store 里（按扩展名各走一路），这里不重复判断
  project.receiveDroppedFiles(files)
}

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  void accept(files)
}

/* ------------------------------------------------------------ 排序 */

function onDragStart(event: DragEvent, index: number): void {
  dragFrom.value = index
  insertAt.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 必须写点东西：部分平台上不 setData 的拖拽不会真正开始
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(event: DragEvent, index: number): void {
  // 从资源管理器拖进来的文件不参与排序，交给窗口那一层的统一处理
  if (dragFrom.value === null) return
  event.preventDefault()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  insertAt.value = event.clientX < rect.left + rect.width / 2 ? index : index + 1
}

function onDrop(event: DragEvent, index: number): void {
  if (dragFrom.value === null) return
  event.preventDefault()
  // 内部分支必须掐断冒泡，否则窗口上的全局 drop 也会跟着跑一次
  event.stopPropagation()
  const target = insertAt.value ?? index
  moveTo(dragFrom.value, target)
  onDragEnd()
}

function onDragEnd(): void {
  dragFrom.value = null
  insertAt.value = null
}

/**
 * `insertAt` 是「插到谁前面」，而 store 的 `reorder` 是「挪到第几号位」。
 * 两者在向右移动时差一位 —— 不换算的话，往后拖一格会纹丝不动。
 */
function moveTo(from: number, insertAtPos: number): void {
  const to = insertAtPos > from ? insertAtPos - 1 : insertAtPos
  if (to === from) return
  project.reorderIntake(from, to)
}

/* ------------------------------------------------------------ 动画 */

/**
 * 移除方块时先把它从布局里摘出来、钉在原来的位置再淡出。
 *
 * 不这么做的话，方块在离场的那 180ms 里仍占着一个格子，后面一串要等它消失完
 * 才「啪」地跳过去 —— 看起来是两段动作。摘出来之后，剩下的方块立刻开始位移
 * （FLIP 的 `mtile-move`），离场的那块在原地缩小淡掉，两件事同时发生。
 *
 * 坐标只能实测：列宽是 `1fr`，窗口一变就不一样，写死像素必然错位。
 */
function onBeforeLeave(el: Element): void {
  const node = el as HTMLElement
  const grid = node.parentElement
  if (!grid) return
  const rect = node.getBoundingClientRect()
  const box = grid.getBoundingClientRect()
  node.style.width = `${rect.width}px`
  node.style.height = `${rect.height}px`
  // 绝对定位的包含块是网格的 padding box：扣掉边框宽度、补上已经滚过的距离
  node.style.left = `${rect.left - box.left - grid.clientLeft + grid.scrollLeft}px`
  node.style.top = `${rect.top - box.top - grid.clientTop + grid.scrollTop}px`
}

/* ------------------------------------------------------------ 选择与移除 */

/** 已经有识别结果的文件才确认：这一下会连带丢掉它的全部字幕 */
async function askRemove(file: AudioFile): Promise<void> {
  const count = file.segments.length
  if (count > 0) {
    const message = `「${file.name}」已经识别出 ${count} 条字幕，移除后这些字幕会一并丢失，且无法恢复。`
    const detail = '磁盘上的原始文件不会被删除，只是从队列里移出。'
    const bridge = window.xbaos
    if (bridge) {
      const ok = await bridge.dialog.confirm({
        title: '从队列移除',
        message,
        detail,
        buttons: ['取消', '移除'],
        defaultId: 0,
        cancelId: 0,
      })
      if (ok !== 1) return
    } else if (!window.confirm(`${message}\n\n${detail}`)) {
      return
    }
  }
  project.removeFile(file.id)
  ui.notify('info', '已从队列移除', file.name)
}

/** 打开一个已经保存过的项目（.xbsgp）。有未保存改动时由 store 先问 */
async function openProject(): Promise<void> {
  await project.openProject()
}

/** 清空队列：只清还没识别的素材，已经建出来的项目一条都不动 */
async function clearAll(): Promise<void> {
  const total = project.intake.length
  const detail =
    '已经识别完成的内容在各自的项目里，不受影响。清空只丢掉还没开始识别的这些素材，原始文件不会被删除。'

  const bridge = window.xbaos
  if (bridge) {
    const ok = await bridge.dialog.confirm({
      title: '清空队列',
      message: `确定要清空队列中的 ${total} 个文件吗？`,
      detail,
      buttons: ['取消', '清空'],
      defaultId: 0,
      cancelId: 0,
    })
    if (ok !== 1) return
  } else if (!window.confirm(`确定要清空队列中的 ${total} 个文件吗？\n\n${detail}`)) {
    return
  }

  project.clearAll()
  ui.notify('info', '队列已清空')
}

/**
 * 打开录音窗口。
 *
 * **不弹确认直接开窗**：录音窗口本身就是「要录什么」的选择现场（勾选输入源、
 * 点开始才会真的采集），开窗前再多问一句纯属多一步操作 —— 用户点「录制音频」
 * 的意图已经够明确了。关闭时的防丢确认在窗口那侧把关。
 */
async function openRecorder(): Promise<void> {
  const bridge = window.xbaos
  if (!bridge?.record?.open) {
    ui.notify('info', '浏览器预览模式下不可用', '录音需要以桌面应用方式运行')
    return
  }
  ui.setRecordActive(true)
  await bridge.record.open()
}

function loadDemo(): void {
  project.loadDemo()
  ui.notify('info', '已载入演示数据', '仅开发预览可用，正式版本不含此入口')
}

/** 脚注里列字幕格式：与音频格式并列，告诉用户同一个入口也吃得下字幕 */
const SUBTITLE_LABELS = SUBTITLE_EXTS.map((ext) => ext.toUpperCase())
</script>

<template>
  <section class="col board">
    <header class="col__head">
      <Icon name="layers" :size="14" class="board__headicon" />
      <span class="col__title">素材</span>
      <span v-if="project.intake.length > 0" class="hint">
        {{ project.intake.length }} 个文件
      </span>
      <span class="spacer" />

      <button
        class="btn btn--sm btn--ghost"
        type="button"
        title="打开已保存的项目（.xbsgp）"
        @click="openProject"
      >
        <Icon name="folder-open" :size="13" />
        <span>打开项目</span>
      </button>
      <button class="btn btn--sm btn--ghost" type="button" title="录制音频" @click="openRecorder">
        <Icon name="mic" :size="13" />
        <span>录制音频</span>
      </button>
      <button
        v-if="project.intake.length > 0"
        class="board__iconbtn"
        type="button"
        title="清空队列"
        @click="clearAll"
      >
        <Icon name="trash" :size="13" />
      </button>
      <button v-if="isDev" class="board__dev" type="button" @click="loadDemo">载入演示数据</button>
    </header>

    <!--
      用 TransitionGroup 当网格容器（`tag="div"`），方块增删与重排才会有连贯的位移：
      新块撑开时加号块滑过去、删掉一块时后面的补上，都是同一段动画而不是瞬移。
    -->
    <TransitionGroup
      tag="div"
      name="mtile"
      class="board__grid"
      @dragover.prevent
      @drop="onDrop($event, project.intake.length)"
      @before-leave="onBeforeLeave"
    >
      <article
        v-for="(file, index) in project.intake"
        :key="file.id"
        class="tile"
        :class="{
          'is-unsupported': file.status === 'unsupported',
          'is-dragging': dragFrom === index,
          'is-gap': insertAt === index,
        }"
        draggable="true"
        :title="`${file.name}\n${t(`status.${file.status}`)}｜${file.dir}`"
        @dragstart="onDragStart($event, index)"
        @dragover="onDragOver($event, index)"
        @drop="onDrop($event, index)"
        @dragend="onDragEnd"
      >
        <span class="tile__no mono">{{ index + 1 }}</span>
        <span class="tile__state" :class="`tile__state--${file.status}`">
          <Icon :name="statusIcon(file.status)" :size="11" />
        </span>
        <button
          class="tile__del"
          type="button"
          title="移除"
          @click.stop="askRemove(file)"
        >
          <Icon name="x" :size="11" />
        </button>

        <span class="tile__grip"><Icon name="grip" :size="12" /></span>
        <span class="tile__name">{{ file.name }}</span>
        <span class="tile__meta mono">
          <span>{{ file.ext.toUpperCase() }}</span>
          <span v-if="(file.durationSec ?? 0) > 0">
            {{ formatDuration(file.durationSec ?? 0) }}
          </span>
          <span v-else-if="(file.sizeBytes ?? 0) > 0">
            {{ formatBytes(file.sizeBytes ?? 0) }}
          </span>
          <span v-if="file.segments.length > 0">{{ file.segments.length }} 条</span>
        </span>
      </article>

      <!-- 常驻入口：只有加号，不写文字。导入后新文件排在它前面，它就自然往后挪 -->
      <button
        key="__add"
        class="tile tile--add"
        :class="{ 'is-gap': insertAt === project.intake.length }"
        type="button"
        title="添加音频或字幕文件"
        @click="pick"
      >
        <Icon name="plus" :size="20" />
      </button>
    </TransitionGroup>

    <footer class="board__foot">
      <!--
        两组各自不可拆：`[支持] 列表` 和 `[不支持] 列表` 被折行拆开时，
        「不支持」三个字会留在上一行末尾、它的清单却跑到了下一行，
        读起来像是「不支持」后面什么都没有。
      -->
      <span class="board__group">
        <span class="board__tag board__tag--ok">支持</span>
        <span class="board__fmt">{{ SUPPORTED_LABELS.join(' ') }}</span>
        <span class="board__fmt">{{ SUBTITLE_LABELS.join(' ') }}</span>
      </span>
      <span class="board__group">
        <span class="board__tag board__tag--no">不支持</span>
        <span class="board__fmt board__fmt--muted">{{ UNSUPPORTED_LABELS.join(' ') }}</span>
      </span>
      <button class="board__why" type="button" @click="ui.openDialog('format-help')">原因</button>
    </footer>

    <input
      ref="inputRef"
      class="sr-only"
      type="file"
      multiple
      accept=".mp3,.wav,.flac,.ogg,.oga,.opus,.aif,.aiff,.srt,.vtt,.ass,.ssa,audio/*"
      @change="onChange"
    />
  </section>
</template>

<style scoped>
.board {
  min-width: 0;
}

.board__headicon {
  flex: none;
  color: var(--color-text-tertiary);
}

.board__iconbtn {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
}

.board__iconbtn:hover {
  background: var(--color-bg-hover);
  color: var(--color-danger);
}

.board__dev {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
  text-decoration: underline;
  text-decoration-style: dotted;
}

.board__dev:hover {
  color: var(--color-accent);
}

/* ------------------------------------------------------------ 网格 */

.board__grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 离场方块改绝对定位后，坐标以这里为原点 */
  position: relative;
  padding: var(--space-4);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: var(--space-3);
  align-content: start;
}

/* ------------------------------------------------------------ 方块 */

.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  /* 名字与元信息在方块里居中偏下：上方留给序号与状态角标，
     贴死底边会让上方空出一大块，整块看起来像没做完 */
  justify-content: center;
  gap: 2px;
  height: 88px;
  min-width: 0;
  padding: var(--space-4) var(--space-3) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  text-align: left;
  cursor: grab;
  transition: border-color var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out);
}

.tile:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-hover);
}

.tile.is-active {
  background: var(--color-bg-raised);
  border-color: var(--color-accent-border);
  box-shadow: var(--shadow-sm), inset 0 0 0 1px var(--color-accent-border);
}

.tile.is-unsupported {
  border-style: dashed;
}

.tile.is-dragging {
  opacity: 0.4;
}

/* 插入位置：一条 2px 的竖线贴着方块的左边缘 */
.tile.is-gap::before {
  content: '';
  position: absolute;
  left: calc(var(--space-3) / -2 - 1px);
  top: 0;
  bottom: 0;
  width: 2px;
  border-radius: 1px;
  background: var(--color-accent);
}

.tile__no {
  position: absolute;
  left: var(--space-2);
  top: var(--space-2);
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.tile__state {
  position: absolute;
  right: var(--space-2);
  top: var(--space-2);
  display: grid;
  place-items: center;
  color: var(--color-text-tertiary);
}

.tile__state--issue,
.tile__state--failed {
  color: var(--color-danger);
}

.tile__state--processing {
  color: var(--color-accent);
}

.tile__state--pending,
.tile__state--reviewed,
.tile__state--edited {
  color: var(--color-success);
}

/* 移除按钮与状态角标占同一处：hover 时把状态换下去，腾出位置 */
.tile__del {
  position: absolute;
  right: var(--space-2);
  top: var(--space-2);
  display: none;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
}

.tile:hover .tile__del {
  display: grid;
}

.tile:hover .tile__state {
  display: none;
}

.tile__del:hover {
  background: var(--color-danger-subtle);
  color: var(--color-danger);
}

.tile__grip {
  position: absolute;
  right: var(--space-2);
  bottom: var(--space-2);
  display: none;
  color: var(--color-text-disabled);
}

.tile:hover .tile__grip {
  display: block;
}

/* 文件名占两行，超出用省略号；`line-clamp` 需要 display:-webkit-box */
.tile__name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
  line-height: 1.35;
  color: var(--color-text-primary);
  word-break: break-all;
}

.tile__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 10px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
}

/* ------------------------------------------------------------ 增删与重排 */

/*
 * 这段必须排在 `.tile` 之后：`.mtile-leave-active` 和 `.tile` 特异度一样，
 * 谁在后面谁赢 —— 放在前面时 `.tile { position: relative }` 会把
 * `position: absolute` 反压回去，离场方块就留在流里，动画退化成两段。
 *
 * `mtile-move` 是 FLIP：Vue 在更新前后各量一次位置，差值写成 transform 再过渡回零，
 * 所以重排是「滑」过去的。缓动按项目约定分两条：出现 `--ease-out`、消失 `--ease-in`。
 */
.mtile-move,
.mtile-enter-active {
  transition: transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}

.mtile-enter-from,
.mtile-leave-to {
  opacity: 0;
  transform: scale(0.94);
}

/*
 * 离场方块必须脱离布局，否则它在淡出的这 180ms 里还占着格子，
 * 后面的方块要等它彻底消失才敢动。坐标由 `onBeforeLeave` 实测写入
 * （列宽是 `1fr`，写死像素必然错位）。
 */
.mtile-leave-active {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  transition: transform var(--dur-base) var(--ease-in),
    opacity var(--dur-base) var(--ease-in);
}

/* ------------------------------------------------------------ 添加块 */

.tile--add {
  display: grid;
  place-items: center;
  padding: 0;
  border-style: dashed;
  border-color: var(--color-border-strong);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

.tile--add:hover {
  border-color: var(--color-accent-border);
  background: var(--color-accent-subtle);
  color: var(--color-accent);
}

/* ------------------------------------------------------------ 脚注 */

.board__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--color-border-subtle);
  font-size: 11px;
}

/* 一组「标签 + 清单」当作一个不可拆的整体折行 */
.board__group {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}

.board__tag {
  flex: none;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-weight: var(--weight-medium);
}

.board__tag--ok {
  background: var(--color-success-subtle);
  color: var(--color-success);
}

.board__tag--no {
  background: var(--color-bg-subtle);
  color: var(--color-text-tertiary);
}

.board__fmt {
  color: var(--color-text-secondary);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.board__fmt--muted {
  color: var(--color-text-tertiary);
}

.board__why {
  font-size: 11px;
  color: var(--color-accent);
  text-decoration: underline;
  text-decoration-style: dotted;
  white-space: nowrap;
}
</style>
