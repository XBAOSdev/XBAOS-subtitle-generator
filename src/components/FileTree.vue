<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useI18n } from '@/composables/useI18n'
import type { AudioFile, FileStatus } from '@/types'
import { formatDuration, toTimecode } from '@/utils/format'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
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

/** 合并模式：每段音频在合并时间轴上的起点 */
const parts = computed(() => project.mergedParts)

const mergedSegments = computed(() => project.mergedFile?.segments.length ?? 0)

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
</script>

<template>
  <aside class="filetree">
    <div class="filetree__head">
      <span class="filetree__title">文件</span>
      <span class="filetree__count">{{ project.supportedFiles.length }}</span>
    </div>

    <div class="filetree__body scroll-y">
      <!-- 合并模式：编辑器里只有一条拼接产物，所以左边也只列出这一条，
           下面按导入顺序列出各段的起点，方便核对拼接是否对得上。
           这些条目刻意不可点 —— 合并模式下点队列就换掉预览内容，
           恰恰是上一版最让人困惑的地方。 -->
      <template v-if="isMerge">
        <ul class="filetree__list">
          <li>
            <div class="filetree__item is-active">
              <span class="filetree__status filetree__status--reviewed">
                <Icon name="layers" :size="13" />
              </span>
              <span class="filetree__main">
                <span class="filetree__name">合并时间轴</span>
                <span class="filetree__meta">
                  {{ mergedSegments }} 条 | 总时长 {{ formatDuration(project.totalDuration) }}
                </span>
              </span>
            </div>
          </li>
        </ul>

        <div class="filetree__group-label">
          参与合并的 {{ parts.length }} 段音频
        </div>
        <ul class="filetree__list">
          <li
            v-for="(file, index) in project.supportedFiles"
            :key="file.id"
            class="filetree__segment"
            :class="[{ 'is-dragging': dragId === file.id }, dropClass(index)]"
            :draggable="!project.recognizing"
            :title="project.recognizing ? '识别过程中不能调整顺序' : '拖动可调整顺序（合并模式下就是时间轴上的先后）'"
            @dragstart="onDragStart($event, file.id)"
            @dragover="onDragOver($event, index)"
            @drop="onDrop"
            @dragend="onDragEnd"
          >
            <span class="filetree__seg-index mono">{{ index + 1 }}</span>
            <span class="filetree__seg-main">
              <span class="filetree__name">{{ file.name }}</span>
              <span class="filetree__meta">
                {{ toTimecode(parts[index]?.offsetSec ?? 0) }} 起 |
                {{ formatDuration(file.durationSec) }} | {{ file.segments.length }} 条
              </span>
            </span>
          </li>
        </ul>
      </template>

      <!-- 独立模式：文件树。不支持的文件单独归到下方分区，这里不重复列出。
           顺序同样可以拖 —— 两种模式下这一列都是「工程里的先后」 -->
      <ul v-else class="filetree__list">
        <li
          v-for="(file, index) in project.supportedFiles"
          :key="file.id"
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
            :class="{ 'is-active': project.activeFileId === file.id }"
            type="button"
            @click="select(file)"
          >
            <span class="filetree__status" :class="`filetree__status--${file.status}`">
              <Icon :name="iconOf(file.status)" :size="13" />
            </span>
            <span class="filetree__main">
              <span class="filetree__name">{{ file.name }}</span>
              <span class="filetree__meta">
                {{ file.segments.length }} 条 {{ labelOf(file.status) }}
              </span>
            </span>
          </button>
        </li>
      </ul>

      <ul v-if="project.unsupportedFiles.length > 0 && !isMerge" class="filetree__extra">
        <li
          v-for="file in project.unsupportedFiles"
          :key="file.id"
          class="filetree__item filetree__item--muted"
        >
          <span class="filetree__status filetree__status--unsupported">
            <Icon name="ban" :size="13" />
          </span>
          <span class="filetree__main">
            <span class="filetree__name">{{ file.name }}</span>
            <span class="filetree__meta">格式不支持，未进入队列</span>
          </span>
        </li>
      </ul>
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

.filetree__group-label {
  padding: var(--space-2) var(--space-2) var(--space-1);
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

/* ---------- 拖拽排序 ---------- */

.filetree__list > li[draggable='true'] {
  cursor: grab;
  /* 条目里是按钮，先按住再拖容易变成「拖一段文字」；这里强制按元素拖 */
  -webkit-user-drag: element;
}

.filetree__list > li.is-dragging {
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
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2);
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

.filetree__item.is-unsupported,
.filetree__item--muted {
  opacity: 0.6;
  cursor: default;
}

.filetree__status {
  flex: none;
  margin-top: 1px;
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
}

.filetree__segment {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2);
  border-left: 2px solid var(--color-border);
  margin-left: var(--space-2);
}

.filetree__seg-index {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.filetree__seg-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.filetree__extra {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
