<script setup lang="ts">
/**
 * 跨文件讲话人对应关系表。
 *
 * 为什么要有这张表：编号只是「这个文件里的第几个人」，A 文件的 1 号与
 * B 文件的 1 号未必是同一个人。硬按编号绑一起，导出时两个陌生人的字幕
 * 会顶着同一个名字；而全都不绑，同一场录制拆成几个文件的人又对不上号。
 *
 * 表的结构：
 *   第一行 = 文件名（列），第一列 = 全局序号（行），最后一列 = 统一称呼。
 *   格子里的标签是「这个文件里的第几号」，拖到别的行 = 归入那一行。
 *   最下面两行是空的：拖进去就是**新开一位**（相当于新建一个对应关系），
 *   也可以当作暂存区把人先拎下来。
 *
 * 「统一称呼」这一列浮在表格右侧（sticky），文件多的时候横向滚动，
 * 这一列始终看得见、始终改得到。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useSpeakerStore } from '@/stores/speakers'
import { useUiStore } from '@/stores/ui'
import { defaultSpeakerName, pickSampleRange } from '@/utils/speaker'
import ModalDialog from '@/components/dialogs/ModalDialog.vue'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const speakers = useSpeakerStore()
const ui = useUiStore()

/** 表里的列：一个文件一列。没有讲话人的文件不占列（空列只是噪声） */
const columns = computed(() =>
  project.speakerMappingFiles.filter((f) =>
    f.segments.some((s) => typeof s.speaker === 'number'),
  ),
)

/** 有人的全局编号（按编号升序） */
const usedRows = computed(() => speakers.usedGlobals())

/**
 * 表的总行数 = 有人的行 + 末尾两个空行。
 *
 * 空行是给人「新建一个对应关系」用的，不占太多地方，但不能没有 ——
 * 没有它就得先把某个人的关系拆开才能新建，用户会以为做不到。
 */
const totalRows = computed(() => usedRows.value.length + 2)

/**
 * 行号列表（0 起）。
 *
 * **必须显式给数组**，不能写 `v-for="row in totalRows"` ——
 * 那种简写形式是从 1 数到 n 的，行号整体差一位：第 0 行会显示第 1 行的人，
 * 最后一行的编号还会越界。看着就是「谁跟谁对不上」，却查不出是哪里的错。
 */
const rowIndexes = computed(() => Array.from({ length: totalRows.value }, (_, i) => i))

function cellAt(columnId: string, row: number): { local: number; name: string } | null {
  const global = usedRows.value[row]
  if (global === undefined) return null
  const local = speakers.localOf(columnId, global)
  if (local === undefined) return null
  return { local, name: speakers.globalName(global) || defaultSpeakerName(local) }
}

/* ------------------------------------------------------------ 拖拽 */

const dragFrom = ref<{ columnId: string; local: number } | null>(null)
const dropRow = ref<number | null>(null)

function onDragStart(event: DragEvent, columnId: string, local: number): void {
  dragFrom.value = { columnId, local }
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', `${columnId}#${local}`)
  }
}

function onDragEnd(): void {
  dragFrom.value = null
  dropRow.value = null
}

function onRowDragOver(event: DragEvent, row: number): void {
  if (!dragFrom.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropRow.value = row
}

function onRowDragLeave(event: DragEvent): void {
  // 只有真的离开这一行才取消高亮：子元素冒泡也会触发 dragleave，
  // 直接清会把高亮闪掉
  const row = event.currentTarget as HTMLElement | null
  const related = event.relatedTarget as Node | null
  if (row && related && row.contains(related)) return
  dropRow.value = null
}

function onRowDrop(event: DragEvent, row: number): void {
  event.preventDefault()
  const from = dragFrom.value
  dragFrom.value = null
  dropRow.value = null
  if (!from) return
  speakers.moveToRow(from.columnId, from.local, row)
}

/* ------------------------------------------------------------ 试听 */

const previewEl = ref<HTMLAudioElement | null>(null)
const previewingKey = ref<string | null>(null)
let stopTimer = 0

function stopPreview(): void {
  if (stopTimer) {
    window.clearTimeout(stopTimer)
    stopTimer = 0
  }
  const el = previewEl.value
  if (el) el.pause()
  previewingKey.value = null
}

function waitMeta(el: HTMLAudioElement): Promise<void> {
  if (el.readyState >= 1) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      el.removeEventListener('loadedmetadata', done)
      resolve()
    }
    el.addEventListener('loadedmetadata', done)
  })
}

/**
 * 试听某位讲话人：截一段**至少 3 秒**的他/她的音频。
 *
 * 不到 3 秒听不出是谁 —— 两个字的一声「嗯」谁也认不出来。
 * 单条字幕不够长就顺着往下攒，攒够为止。
 */
async function preview(columnId: string, local: number): Promise<void> {
  const column = columns.value.find((c) => c.id === columnId)
  if (!column) return
  const segments = column.segments.filter((seg) => seg.speaker === local)
  const range = pickSampleRange(segments, column.durationSec ?? 0)
  if (!range) {
    ui.notify('info', '没有可试听的片段', '这一位还没有字幕')
    return
  }

  // 合并模式下时间轴是拼起来的，得先找到落在哪一段原始音频上
  let audioId = columnId
  let start = range.start
  let end = range.end
  if (project.isMerge) {
    const part = project.mergedParts.find(
      (p) => range.start >= p.offsetSec && range.start < p.offsetSec + p.durationSec,
    )
    if (!part) {
      ui.notify('info', '没有可试听的片段', '这一段在合并时间轴上找不到出处')
      return
    }
    audioId = part.fileId
    start = range.start - part.offsetSec
    end = start + (range.end - range.start)
  }

  await project.ensureMedia(audioId)
  const media = project.mediaOf(audioId)
  if (!media.blobUrl) {
    ui.notify('warning', '无法试听', '这个文件读不到音频')
    return
  }
  const el = previewEl.value
  if (!el) return
  stopPreview()
  if (el.getAttribute('src') !== media.blobUrl) el.setAttribute('src', media.blobUrl)
  await waitMeta(el)
  try {
    el.currentTime = start
    await el.play()
  } catch {
    ui.notify('warning', '无法试听', '音频播放被系统拦下了')
    return
  }
  previewingKey.value = `${columnId}#${local}`
  stopTimer = window.setTimeout(() => {
    el.pause()
    previewingKey.value = null
    stopTimer = 0
  }, Math.max(400, (end - start) * 1000))
}

/* ------------------------------------------------------------ 称呼 */

function setRowName(global: number, event: Event): void {
  const input = event.target as HTMLInputElement
  speakers.setGlobalName(global, input.value)
}

/* ------------------------------------------------------------ 关闭 */

function cancel(): void {
  stopPreview()
  speakers.pendingShareConfirm = false
  ui.closeDialog()
}

function confirm(): void {
  stopPreview()
  speakers.mappingConfirmed = true
  /*
   * 只有「勾了共用才进来的」这一次确认才打开开关。
   * 从侧栏「调整对应关系」按钮进来时开关保持原样 —— 用户只是来整理关系，
   * 不该因为点了确认就被强行共用。
   */
  if (speakers.pendingShareConfirm) speakers.shared = true
  speakers.pendingShareConfirm = false
  ui.closeDialog()
}

onBeforeUnmount(stopPreview)
</script>

<template>
  <ModalDialog
    title="讲话人对应关系"
    subtitle="同一个人的讲话人在不同文件里可能编号不同。把它们拖到同一行，就是同一个人。"
    width="min(880px, 92vw)"
    :mask-closable="false"
    @close="cancel"
  >
    <div class="spkmap">
      <div class="spkmap__scroll">
        <table class="spkmap__table">
          <thead>
            <tr>
              <th class="spkmap__no">序号</th>
              <th v-for="col in columns" :key="col.id" class="spkmap__file" :title="col.name">
                {{ col.name }}
              </th>
              <th class="spkmap__name">统一称呼</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rowIndexes"
              :key="row"
              class="spkmap__row"
              :class="{ 'is-drop': dropRow === row }"
              @dragover="onRowDragOver($event, row)"
              @dragleave="onRowDragLeave"
              @drop="onRowDrop($event, row)"
            >
              <td class="spkmap__no">{{ row + 1 }}</td>
              <td v-for="col in columns" :key="col.id" class="spkmap__cell">
                <button
                  v-if="cellAt(col.id, row)"
                  class="spkmap__chip"
                  :class="{ 'is-playing': previewingKey === `${col.id}#${cellAt(col.id, row)!.local}` }"
                  type="button"
                  draggable="true"
                  :title="`点击试听这一位（至少 3 秒）`"
                  @click="preview(col.id, cellAt(col.id, row)!.local)"
                  @dragstart="onDragStart($event, col.id, cellAt(col.id, row)!.local)"
                  @dragend="onDragEnd"
                >
                  <span class="spkmap__chip-no mono">{{ cellAt(col.id, row)!.local + 1 }}</span>
                  <span class="spkmap__chip-name">{{ cellAt(col.id, row)!.name }}</span>
                </button>
              </td>
              <td class="spkmap__name">
                <input
                  v-if="row < usedRows.length"
                  class="spkmap__input"
                  type="text"
                  maxlength="20"
                  :value="speakers.globals[usedRows[row]]?.name ?? ''"
                  :placeholder="speakers.globals[usedRows[row]]?.fallback ?? ''"
                  @input="setRowName(usedRows[row], $event)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="spkmap__tip">
        拖动标签可以换行；拖到最后两行是给它单独开一位。下面两行也可以当暂存区用。
      </p>
    </div>

    <audio ref="previewEl" class="spkmap__audio" preload="metadata" />

    <template #footer>
      <button class="btn" type="button" @click="cancel">取消</button>
      <button class="btn btn--primary" type="button" @click="confirm">
        <Icon name="check" :size="13" />
        <span>确认</span>
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.spkmap {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.spkmap__scroll {
  overflow: auto;
  max-height: 52vh;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
}

.spkmap__table {
  /*
   * 按内容撑开，不让浏览器均分宽度。
   *
   * 写死宽度再加「均分列」看着整齐，但文件一多每列都被压到几十像素，
   * 表头只剩「S···」，连哪个文件是哪一列都认不出来。这里改成内容宽度 +
   * 外层横向滚动：无论多少列，文件名都完整，看不过来的部分左右滑。
   */
  width: max-content;
  min-width: 100%;
  table-layout: auto;
  border-collapse: collapse;
}

.spkmap__table th,
.spkmap__table td {
  border-bottom: 1px solid var(--color-border-subtle);
  padding: var(--space-2);
  text-align: left;
  vertical-align: middle;
}

.spkmap__table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--color-bg-inset);
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.spkmap__no {
  width: 44px;
  color: var(--color-text-tertiary);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

/* 文件名整列完整显示（表格已按内容撑开，这里只给一个下限，避免短名挤成一条缝） */
.spkmap__file {
  min-width: 140px;
  white-space: nowrap;
}

/*
 * 统一称呼这一列浮在右侧。
 * 文件多的时候表格要横向滚，这一列必须始终看得见、始终改得到 ——
 * 它是这张表里唯一要动的地方，滚走了就等于没法用。
 */
.spkmap__name {
  position: sticky;
  right: 0;
  width: 160px;
  min-width: 160px;
  background: var(--color-bg-raised);
  border-left: 1px solid var(--color-border);
}

.spkmap__table thead .spkmap__name {
  z-index: 3;
  background: var(--color-bg-inset);
}

.spkmap__row.is-drop .spkmap__cell,
.spkmap__row.is-drop .spkmap__name {
  background: var(--color-bg-selected);
}

.spkmap__cell {
  background: var(--color-bg-raised);
}

.spkmap__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  cursor: grab;
}

.spkmap__chip:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-hover);
}

.spkmap__chip.is-playing {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 1px var(--color-accent-border);
}

.spkmap__chip-no {
  flex: none;
  color: var(--color-text-tertiary);
  font-size: 10px;
}

.spkmap__chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spkmap__input {
  width: 100%;
  height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
  outline: none;
}

.spkmap__input:hover {
  border-color: var(--color-border);
}

.spkmap__input:focus {
  border-color: var(--color-accent);
  background: var(--color-bg-surface);
}

.spkmap__tip {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.spkmap__audio {
  display: none;
}
</style>
