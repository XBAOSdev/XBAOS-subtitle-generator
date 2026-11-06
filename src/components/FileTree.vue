<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { useI18n } from '@/composables/useI18n'
import type { AudioFile, FileStatus } from '@/types'
import { formatDuration, toTimecode } from '@/utils/format'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()
const { t } = useI18n()

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

const isMerge = computed(() => project.isMerge)

/** 合并模式：每段音频在拼接时间轴上的起点 */
const parts = computed(() => project.mergedParts)

const mergedSegments = computed(() => project.viewFile?.segments.length ?? 0)

/**
 * 项目条是否展开。
 *
 * 现在只有一个项目容器，所以这只是一层本地会话状态；等 P4 接上多项目时，
 * 这里换成 `expanded: Record<projectId, boolean>` 即可 —— 箭头按钮与
 * 条本身的分工（折叠 / 切换）已经按那个形状摆好了。
 */
const open = ref(true)

/** 音频有问题（缺失或被换过）的子项目数 */
const badCount = computed(() => project.audioProblemFiles.length)

/*
 * ---- 拖拽排序 ----
 *
 * 顺序不只是排列顺序：合并模式下它就是时间轴上的先后，改顺序 = 重排字幕时间码
 * 与音频拼接（`reorder()` 里会 rebuildMerged）。所以这里只负责「把 from 挪到 to」，
 * 产物重建交给 store。
 *
 * 落点用**上下半区**判定（上=插到这一份之前，下=之后），与导入页的左右半区同构。
 */
const dragId = ref('')
/** 插入位置，0..n（n 表示落在最后一份之后）；-1 = 没有落点 */
const dropAt = ref(-1)

function onDragStart(event: DragEvent, id: string): void {
  // 识别中不许调顺序：这一轮的进度是按**启动时**的顺序算好的单元前缀和，
  // 中途挪动会让「第几个文件跑到第几格」对不上，进度条直接跳。
  if (project.recognizing) {
    event.preventDefault()
    return
  }
  dragId.value = id
  dropAt.value = -1
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 某些环境不带数据就不给拖：塞一个占位，内容不用
    event.dataTransfer.setData('text/plain', id)
  }
}

function onDragOver(event: DragEvent, index: number): void {
  if (!dragId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  dropAt.value = event.clientY < rect.top + rect.height / 2 ? index : index + 1
}

function onDrop(): void {
  const from = project.files.findIndex((f) => f.id === dragId.value)
  const list = project.supportedFiles
  const at = dropAt.value
  onDragEnd()
  if (from < 0 || at < 0) return

  // 落点换算成 `files` 里的下标：插到「第 at 份」之前，at === n 时是末尾
  const anchor = list[at]?.id
  let to = anchor
    ? project.files.findIndex((f) => f.id === anchor)
    : project.files.findIndex((f) => f.id === list[list.length - 1]?.id) + 1
  if (to < 0) return
  // splice 语义：先抽走再插入，往后挪要往前错一位
  if (to > from) to -= 1
  if (to === from) return
  project.reorder(from, to)
}

function onDragEnd(): void {
  dragId.value = ''
  dropAt.value = -1
}

/** 落点指示线：往上插一条，落在末尾时补一条在下沿 */
function dropClass(index: number): Record<string, boolean> {
  if (!dragId.value) return {}
  return {
    'is-drop-before': dropAt.value === index,
    'is-drop-after':
      dropAt.value === index + 1 && index === project.supportedFiles.length - 1,
  }
}

function iconOf(status: FileStatus): string {
  return STATUS_ICON[status]
}

function labelOf(status: FileStatus): string {
  return t(`status.${status}`)
}

function select(file: AudioFile): void {
  if (file.status === 'unsupported') return
  project.setActiveFile(file.id)
}

/** 音频映射：缺失 / 被换过 / 纯字幕（想给它挂一份音频）都用同一个入口 */
function openMap(file: AudioFile): void {
  ui.openDialog('audio-map', { fileId: file.id })
}

function canReload(file: AudioFile): boolean {
  // 字幕源文件单独记着：映射过音频之后 `path` 已经指向音频了
  return !!file.subtitleFormat && !!(file.subtitlePath ?? file.path)
}

function reload(file: AudioFile): void {
  void project.reloadSubtitle(file.id)
}

function metaOf(file: AudioFile, index: number): string {
  if (isMerge.value) {
    const offset = toTimecode(parts.value[index]?.offsetSec ?? 0)
    return `${offset} 起 | ${formatDuration(file.durationSec)} | ${file.segments.length} 条`
  }
  return `${file.segments.length} 条 ${labelOf(file.status)}`
}
</script>

<template>
  <aside class="filetree">
    <div class="filetree__head">
      <span class="filetree__title">项目</span>
      <span class="filetree__count">{{ project.supportedFiles.length }}</span>
    </div>

    <div class="filetree__body scroll-y">
      <!-- 项目条：细长条，不是卡片。箭头只管折叠，条本身留给「切换项目」
           （现在只有一个项目，点击暂无动作；P4 接多项目时才真正用起来）。 -->
      <div class="filetree__proj" :class="{ 'is-active': true }">
        <button
          class="filetree__fold"
          type="button"
          :title="open ? '收起子项目' : '展开子项目'"
          @click.stop="open = !open"
        >
          <Icon name="chevron-right" :size="12" :class="{ 'is-open': open }" />
        </button>
        <span class="filetree__proj-name" :title="project.displayProjectName">
          {{ project.displayProjectName }}
        </span>
        <span v-if="project.projectDirty" class="filetree__dot" aria-hidden="true" />
        <span v-if="badCount > 0" class="filetree__proj-bad" :title="`${badCount} 个音频对不上`">
          <Icon name="alert" :size="11" />
        </span>
        <span class="filetree__proj-count">{{ project.supportedFiles.length }}</span>
      </div>

      <ul v-show="open" class="filetree__list">
        <li
          v-for="(file, index) in project.supportedFiles"
          :key="file.id"
          class="filetree__sub"
          :class="[{ 'is-dragging': dragId === file.id }, dropClass(index)]"
          :draggable="!project.recognizing"
          :title="project.recognizing ? '识别过程中不能调整顺序' : '拖动可调整顺序'"
          @dragstart="onDragStart($event, file.id)"
          @dragover="onDragOver($event, index)"
          @drop="onDrop"
          @dragend="onDragEnd"
        >
          <button
            class="filetree__item"
            :class="{ 'is-active': !isMerge && project.activeFileId === file.id }"
            type="button"
            @click="select(file)"
          >
            <span class="filetree__status" :class="`filetree__status--${file.status}`">
              <Icon :name="iconOf(file.status)" :size="12" />
            </span>
            <span class="filetree__main">
              <span class="filetree__name">{{ file.name }}</span>
              <span class="filetree__meta">
                {{ metaOf(file, index) }}
                <span v-if="project.mediaStateOf(file.id)" class="filetree__bad">
                  {{ project.mediaStateOf(file.id) === 'missing' ? '音频找不到' : '音频被换过' }}
                </span>
              </span>
            </span>
          </button>

          <!-- 行内动作：只在悬停时出现，避免每一行都挂两个常显按钮 -->
          <span class="filetree__acts">
            <button
              v-if="project.mediaStateOf(file.id) || !file.path"
              class="filetree__act"
              type="button"
              title="音频映射"
              @click.stop="openMap(file)"
            >
              <Icon name="file-audio" :size="12" />
            </button>
            <button
              v-if="canReload(file)"
              class="filetree__act"
              type="button"
              title="重新读取源文件"
              @click.stop="reload(file)"
            >
              <Icon name="refresh" :size="12" />
            </button>
          </span>
        </li>
      </ul>

      <ul v-if="project.unsupportedFiles.length > 0 && !isMerge" class="filetree__extra">
        <li
          v-for="file in project.unsupportedFiles"
          :key="file.id"
          class="filetree__item filetree__item--muted"
        >
          <span class="filetree__status filetree__status--unsupported">
            <Icon name="ban" :size="12" />
          </span>
          <span class="filetree__main">
            <span class="filetree__name">{{ file.name }}</span>
            <span class="filetree__meta">格式不支持，未进入队列</span>
          </span>
        </li>
      </ul>

      <p v-if="isMerge && project.supportedFiles.length > 0" class="filetree__hint">
        {{ mergedSegments }} 条字幕按上面的顺序首尾相接
      </p>
    </div>
  </aside>
</template>

<style scoped>
.filetree {
  width: 232px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border);
}

.filetree__head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4) var(--space-2);
}

.filetree__title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}

.filetree__count {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.filetree__body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--space-2) var(--space-3);
}

/* ---------- 项目条（26px，细长条，不是卡片） ---------- */

.filetree__proj {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 6px;
  margin-bottom: 4px;
  border-radius: var(--radius-md);
  box-shadow: inset 0 0 0 1px transparent;
}

.filetree__proj.is-active {
  background: var(--color-bg-raised);
  box-shadow:
    var(--shadow-sm),
    inset 0 0 0 1px var(--color-accent-border);
}

.filetree__proj-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filetree__fold {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
}

.filetree__fold:hover {
  background: var(--color-bg-hover);
}

/* 展开时箭头转 90°：chevron-right → 朝下 */
.filetree__fold .is-open {
  transform: rotate(90deg);
}

.filetree__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
}

.filetree__proj-bad {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--color-warning);
}

.filetree__proj-count {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.filetree__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.filetree__list > li {
  position: relative;
}

/* ---------- 子项目行 ---------- */

/* 缩进 20px：与项目名的文字左对齐 */
.filetree__sub {
  display: flex;
  align-items: stretch;
  margin-left: 20px;
}

.filetree__sub[draggable='true'] {
  cursor: grab;
  /* 条目里是按钮，先按住再拖容易变成「拖一段文字」；这里强制按元素拖 */
  -webkit-user-drag: element;
}

.filetree__sub.is-dragging {
  opacity: 0.4;
}

/*
 * 落点指示线用伪元素，不用 inset box-shadow：条目里的按钮是不透明底，
 * 画在 li 上的内阴影会被它整块盖住，屏幕上什么都看不见。
 */
.filetree__list > li.is-drop-before::before,
.filetree__list > li.is-drop-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  z-index: 2;
  height: 2px;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
}

.filetree__list > li.is-drop-before::before {
  top: -1px;
}

.filetree__list > li.is-drop-after::after {
  bottom: -1px;
}

.filetree__item {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 5px var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.filetree__item:hover:not(:disabled) {
  background: var(--color-bg-hover);
}

.filetree__item.is-active {
  background: var(--color-accent-subtle);
  border-color: var(--color-accent-border);
}

.filetree__item--muted {
  opacity: 0.6;
  cursor: default;
}

.filetree__status {
  flex: none;
  margin-top: 2px;
  color: var(--color-text-tertiary);
}

.filetree__status--edited,
.filetree__status--reviewed {
  color: var(--color-success);
}

.filetree__status--issue,
.filetree__status--failed {
  color: var(--color-warning);
}

.filetree__status--processing {
  color: var(--color-accent);
}

.filetree__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.filetree__name {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filetree__meta {
  font-size: 11px;
  color: var(--color-text-tertiary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.filetree__bad {
  color: var(--color-warning);
}

/* ---------- 行内动作 ---------- */

.filetree__acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 4px;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.filetree__sub:hover .filetree__acts {
  opacity: 1;
}

.filetree__act {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
}

.filetree__act:hover {
  background: var(--color-bg-raised);
  color: var(--color-text-primary);
}

.filetree__extra {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.filetree__hint {
  margin: var(--space-3) 0 0;
  padding: 0 var(--space-2);
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
