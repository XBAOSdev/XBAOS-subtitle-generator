<script setup lang="ts">
/**
 * 侧栏：项目（细长条）+ 子项目（可折叠、可拖）。
 *
 * 一个项目就是一份 `.xbsgp`；子项目就是以前的一个「文件」。侧栏同时开着多个
 * 项目，箭头只管折叠、条本身就是「切到这个项目」——两个动作分开，不互相抢。
 *
 * 拖拽有两种：项目内换顺序（只改数组，时间码不动）与跨项目搬家（2.5）。
 * 落点可以是别的项目的某一行（插到那一行）、别的项目的条（追加到末尾），
 * 或者底部的「新建项目」（建一个空项目装它）。
 */
import { computed, nextTick, ref } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import type { AudioFile, FileStatus } from '@/types'
import { formatDuration, toShortTimecode } from '@/utils/format'
import { defaultProjectName, replaceIllegalChars, sanitizeFileName } from '@/utils/projectName'
import { useSidebarMenu } from '@/composables/useSidebarMenu'
import Icon from '@/components/Icon.vue'
import UiMenu from '@/components/UiMenu.vue'

const project = useProjectStore()
const ui = useUiStore()

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

/**
 * 侧栏要画的东西：每个项目一条 + 它的子项目。
 *
 * 活动项目读**活引用**（`supportedFiles` / `displayProjectName` / `projectDirty`），
 * 其余读它们各自停下来的那一份 —— 活动项目的那一格在内存里并不实时同步，
 * 只有切走时才写回（`stashActive`）。
 */
interface Row {
  id: string
  name: string
  active: boolean
  collapsed: boolean
  dirty: boolean
  bad: number
  items: AudioFile[]
}

const rows = computed<Row[]>(() =>
  project.drafts.map((d) => {
    const active = d.id === project.activeDraftId
    const items = active ? project.supportedFiles : d.files.filter((f) => f.status !== 'unsupported')
    return {
      id: d.id,
      name: active ? project.displayProjectName : d.name || defaultProjectName(items.map((f) => f.name)),
      active,
      collapsed: d.collapsed,
      dirty: active ? project.projectDirty : d.dirty,
      bad: active ? project.audioProblemFiles.length : 0,
      items,
    }
  }),
)

const totalItems = computed(() => rows.value.reduce((n, r) => n + r.items.length, 0))

/**
 * 点侧栏的空白处 = 取消选中。
 *
 * 多选之后想「不选了」以前无路可走：再点某一条只是把选中换成那一条。
 * 只要按下的不是行、按钮或输入框，就当空白处理 —— 项目之间的间隙、
 * 列表下方的空地都算。
 */
function onBlankClick(event: MouseEvent): void {
  const el = event.target as HTMLElement | null
  if (el?.closest('.filetree__sub, .filetree__proj, .filetree__search, button, input')) return
  if (selDrafts.value.length === 0 && selItems.value.length === 0) return
  selDrafts.value = []
  selItems.value = []
  lastPick.value = null
}

function iconOf(status: FileStatus): string {
  return STATUS_ICON[status]
}

/* ------------------------------------------------------------------ 切项目 */

function switchTo(row: Row): void {
  if (row.active) return
  project.switchDraft(row.id)
}

function toggleFold(row: Row, event: MouseEvent): void {
  event.stopPropagation()
  project.toggleDraft(row.id)
}

/* ------------------------------------------------------------------ 搜索 */

/** 侧栏搜索：项目名命中出整个项目，只有子项目名命中就只留那一行 */
const query = ref('')

interface ViewEntry {
  file: AudioFile
  /** 在所属项目里的真实下标（过滤后 meta 与拖拽换算都不能丢） */
  index: number
  meta: string
}

interface ViewRow extends Row {
  view: ViewEntry[]
}

const viewRows = computed<ViewRow[]>(() => {
  const q = query.value.trim().toLowerCase()
  return rows.value
    .map((row) => {
      const view = row.items.map((file, index) => ({ file, index, meta: metaOf(row, file, index) }))
      if (!q || row.name.toLowerCase().includes(q)) return { ...row, view }
      const kept = view.filter((e) => e.file.name.toLowerCase().includes(q))
      return kept.length > 0 ? { ...row, view: kept } : null
    })
    .filter((r): r is ViewRow => r !== null)
})

const matchedItems = computed(() =>
  query.value.trim() ? viewRows.value.reduce((n, r) => n + r.view.length, 0) : totalItems.value,
)

/* ------------------------------------------------------------------ 多选 */

/**
 * 多选只在同一种对象内部做（项目条选一批 / 子项目行选一批，不混选）。
 * Ctrl 点 = 增删；Shift 点 = 同一列里连片；普通点 = 只剩它自己并跳过去。
 */
const selDrafts = ref<string[]>([])
const selItems = ref<string[]>([])
const lastPick = ref<{ kind: 'draft' | 'item'; id: string; rowId: string; index: number } | null>(
  null,
)

function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

function clickDraft(row: Row, event: MouseEvent): void {
  const at = rows.value.findIndex((r) => r.id === row.id)
  if (event.ctrlKey || event.metaKey) {
    selDrafts.value = toggleIn(selDrafts.value, row.id)
    selItems.value = []
    lastPick.value = { kind: 'draft', id: row.id, rowId: row.id, index: at }
    return
  }
  if (event.shiftKey && lastPick.value?.kind === 'draft') {
    const a = Math.min(lastPick.value.index, at)
    const b = Math.max(lastPick.value.index, at)
    selDrafts.value = rows.value.slice(a, b + 1).map((r) => r.id)
    selItems.value = []
    return
  }
  selDrafts.value = [row.id]
  selItems.value = []
  lastPick.value = { kind: 'draft', id: row.id, rowId: row.id, index: at }
  switchTo(row)
}

function clickItem(row: Row, entry: ViewEntry, event: MouseEvent): void {
  if (entry.file.status === 'unsupported') return
  if (event.ctrlKey || event.metaKey) {
    selItems.value = toggleIn(selItems.value, entry.file.id)
    selDrafts.value = []
    lastPick.value = { kind: 'item', id: entry.file.id, rowId: row.id, index: entry.index }
    return
  }
  if (event.shiftKey && lastPick.value?.kind === 'item' && lastPick.value.rowId === row.id) {
    const a = Math.min(lastPick.value.index, entry.index)
    const b = Math.max(lastPick.value.index, entry.index)
    selItems.value = row.items.slice(a, b + 1).map((f) => f.id)
    selDrafts.value = []
    return
  }
  selItems.value = [entry.file.id]
  selDrafts.value = []
  lastPick.value = { kind: 'item', id: entry.file.id, rowId: row.id, index: entry.index }
  select(row, entry.file)
}

/* ------------------------------------------------------------------ 改名 */

const renaming = ref<{ kind: 'draft' | 'item'; id: string } | null>(null)
const renameText = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

function beginRename(kind: 'draft' | 'item', id: string): void {
  renaming.value = { kind, id }
  renameText.value =
    kind === 'draft'
      ? (rows.value.find((r) => r.id === id)?.name ?? '')
      : (rows.value.flatMap((r) => r.items).find((f) => f.id === id)?.name ?? '')
  renameWarned = false
  void nextTick().then(() => renameInput.value?.select())
}

/**
 * 边打边把非法字符换成 `_`。
 *
 * 等按回车才报错的话，用户打了十个字才发现整串不能用；实时替换 + 一次轻提示，
 * 手指不用离开键盘。提示只弹一次，否则连打三个 `?` 会刷出三条通知。
 */
let renameWarned = false
function onRenameInput(event: Event): void {
  const el = event.target as HTMLInputElement
  const { value, replaced } = replaceIllegalChars(el.value)
  renameText.value = value
  if (!replaced || renameWarned) return
  renameWarned = true
  ui.notify('info', '已替换不能用作文件名的字符', '\\ / : * ? " < > | 会换成下划线')
}

function commitRename(): void {
  const at = renaming.value
  if (!at) return
  // 落盘前再清一遍：结尾的点 / 空格、超长名字都在这里收敛
  const text = sanitizeFileName(renameText.value.trim()).value
  renaming.value = null
  if (!text) return
  if (at.kind === 'draft') void project.renameProject(text)
  else project.renameItem(at.id, text)
}

/** 双击名称也能改（方案 5.2 的第二个入口） */
function startRenameDraft(row: Row): void {
  void (async () => {
    if (!row.active) await project.switchDraft(row.id)
    beginRename('draft', row.id)
  })()
}

/* ------------------------------------------------------------------ 菜单 */

const { menu, openDraftAt, openItemAt, pick } = useSidebarMenu({ beginRename })

function onBarContext(row: Row, event: MouseEvent): void {
  event.preventDefault()
  if (!selDrafts.value.includes(row.id)) {
    selDrafts.value = [row.id]
    selItems.value = []
  }
  openDraftAt(event.clientX, event.clientY, row.id, selDrafts.value)
}

function onRowContext(row: Row, entry: ViewEntry, event: MouseEvent): void {
  event.preventDefault()
  if (!selItems.value.includes(entry.file.id)) {
    selItems.value = [entry.file.id]
    selDrafts.value = []
    lastPick.value = { kind: 'item', id: entry.file.id, rowId: row.id, index: entry.index }
  }
  openItemAt(event.clientX, event.clientY, entry.file.id, selItems.value)
}

function onMenuPick(key: string): void {
  const ids = menu.value?.ids ?? []
  void pick(key, ids)
}

function closeMenu(): void {
  menu.value = null
}

/* ------------------------------------------------------------- 子项目动作 */

/**
 * 点一个子项目 = 切到它所在的工程 + 把字幕列表滚到它第一行。
 *
 * 跨项目也走同一条路（`revealItem` 里先 `switchDraft`）：用户点的是"那一段"，
 * 不是"那次切换" —— 两个动作分开做只会让人点两下。
 */
function select(row: Row, file: AudioFile): void {
  if (file.status === 'unsupported') return
  void project.revealItem(row.id, file.id)
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

/** 有音频才能重识别：纯字幕条目点了也只会把字幕清空、什么都换不回来 */
function canRecognize(file: AudioFile): boolean {
  return !project.recognizing && (file.demo === true || !!file.path)
}

function recognize(file: AudioFile): void {
  void project.recognizeItem(file.id)
}

/**
 * 一行的 meta：`从哪一秒起 + 时长 + 条数`。
 *
 * 偏移是**这个项目内部**的累计时长（不是活动项目的拼接时间轴）——
 * 非活动项目也在侧栏上摆着，拿活动项目的偏移去标它，秒数是错的。
 * 侧栏只有 232px，起点用紧凑时间码，别让时长与条数被省略号吃掉。
 */
function metaOf(row: Row, file: AudioFile, index: number): string {
  let offset = 0
  for (let i = 0; i < index; i += 1) offset += row.items[i]?.durationSec ?? 0
  const off = toShortTimecode(offset)
  const dur = file.durationSec ? ` ${formatDuration(file.durationSec)}` : ''
  return `${off} 起${dur} ${file.segments.length} 条`
}

/* ------------------------------------------------------------------ 拖拽 */

interface DragItem {
  itemId: string
  draftId: string
}

const drag = ref<DragItem | null>(null)
/** 落点：某个项目的第几行之前 */
const dropAt = ref<{ draftId: string; index: number } | null>(null)
const dropOnNew = ref(false)

function onDragStart(event: DragEvent, draftId: string, itemId: string): void {
  // 识别中不许调顺序：这一轮的进度是按**启动时**的顺序算好的单元前缀和
  if (project.recognizing) {
    event.preventDefault()
    return
  }
  drag.value = { itemId, draftId }
  dropAt.value = null
  dropOnNew.value = false
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', itemId)
  }
}

/** 落在某一行上：上半区插到它之前，下半区插到它之后 */
function onRowDragOver(event: DragEvent, row: Row, index: number): void {
  if (!drag.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const after = event.clientY >= rect.top + rect.height / 2
  dropAt.value = { draftId: row.id, index: index + (after ? 1 : 0) }
  dropOnNew.value = false
}

/** 落在项目条上：追加到那个项目的末尾（折叠着也能放，2.5 第 1 条） */
function onBarDragOver(event: DragEvent, row: Row): void {
  if (!drag.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropAt.value = { draftId: row.id, index: row.items.length }
  dropOnNew.value = false
}

function onDrop(event: DragEvent): void {
  const src = drag.value
  const at = dropAt.value
  event.preventDefault()
  event.stopPropagation()
  cleanupDrag()
  if (!src || !at) return

  if (src.draftId === at.draftId) {
    // 项目内换顺序：换算成 `files` 里的下标（`at.index` 是 supportedFiles 里的位置）
    const list = project.supportedFiles
    const from = list.findIndex((f) => f.id === src.itemId)
    if (from < 0) return
    const anchor = list[at.index]?.id
    const all = project.files
    let to = anchor
      ? all.findIndex((f) => f.id === anchor)
      : all.findIndex((f) => f.id === list[list.length - 1]?.id) + 1
    if (to < 0) return
    if (to > from) to -= 1
    if (to !== from) project.reorder(from, to)
    return
  }

  project.moveItemTo(src.itemId, src.draftId, at.draftId, at.index)
}

/** 拖到底部「新建项目」上：建一个空项目，把它放进去 */
function onNewDragOver(event: DragEvent): void {
  if (!drag.value) return
  event.preventDefault()
  dropOnNew.value = true
  dropAt.value = null
}

function onNewDrop(event: DragEvent): void {
  const src = drag.value
  event.preventDefault()
  event.stopPropagation()
  cleanupDrag()
  if (!src) return
  const id = project.createDraft({ activate: false })
  project.moveItemTo(src.itemId, src.draftId, id, 0)
}

function cleanupDrag(): void {
  drag.value = null
  dropAt.value = null
  dropOnNew.value = false
}

function rowClass(row: Row, index: number): Record<string, boolean> {
  const at = dropAt.value
  return {
    'is-drop-before': !!at && at.draftId === row.id && at.index === index,
    'is-drop-after':
      !!at && at.draftId === row.id && at.index === index + 1 && index === row.items.length - 1,
    'is-dragging': drag.value?.itemId === row.items[index]?.id,
  }
}

function barClass(row: Row): Record<string, boolean> {
  const at = dropAt.value
  return { 'is-drop': !!at && at.draftId === row.id && at.index === row.items.length }
}

function newDraft(): void {
  project.createDraft({ activate: true })
}

function close(row: Row): void {
  if (row.dirty) {
    ui.notify('info', '有未保存的改动', '先保存，再从侧栏移除这个项目')
    return
  }
  project.closeDraft(row.id)
}
</script>

<template>
  <aside class="filetree">
    <div class="filetree__head">
      <span class="filetree__title">项目</span>
      <input
        v-model="query"
        class="filetree__search"
        type="search"
        placeholder="搜索"
        aria-label="搜索项目或子项目"
      />
      <span class="filetree__count">{{ viewRows.length }}</span>
    </div>

    <div class="filetree__body scroll-y" @dragend="cleanupDrag" @click="onBlankClick">
      <section v-for="row in viewRows" :key="row.id" class="filetree__group">
        <!-- 项目条：箭头只管折叠，条本身是「切到这个项目」 -->
        <div
          class="filetree__proj"
          :class="[{ 'is-active': row.active, 'is-selected': selDrafts.includes(row.id) }, barClass(row)]"
          :title="row.name"
          @click="clickDraft(row, $event)"
          @contextmenu="onBarContext(row, $event)"
          @dragover="onBarDragOver($event, row)"
          @drop="onDrop"
        >
          <button
            class="filetree__fold"
            type="button"
            :title="row.collapsed ? '展开子项目' : '收起子项目'"
            @click="toggleFold(row, $event)"
          >
            <Icon name="chevron-right" :size="12" :class="{ 'is-open': !row.collapsed }" />
          </button>
          <input
            v-if="renaming?.kind === 'draft' && renaming.id === row.id"
            ref="renameInput"
            :value="renameText"
            class="filetree__rename"
            type="text"
            @input="onRenameInput"
            @click.stop
            @dblclick.stop
            @keydown.enter="commitRename"
            @keydown.esc="renaming = null"
            @blur="commitRename"
          />
          <span v-else class="filetree__proj-name" @dblclick.stop="startRenameDraft(row)">
            {{ row.name }}
          </span>
          <span v-if="row.dirty" class="filetree__dot" aria-hidden="true" />
          <span v-if="row.bad > 0" class="filetree__proj-bad" :title="`${row.bad} 个音频对不上`">
            <Icon name="alert" :size="11" />
          </span>
          <span class="filetree__proj-count">{{ row.items.length }}</span>
          <!-- 关闭 = 只从列表移出，不删磁盘上的 .xbsgp（2.6） -->
          <button
            v-if="rows.length > 1"
            class="filetree__close"
            type="button"
            title="从列表移出这个项目（不删除磁盘文件）"
            @click.stop="close(row)"
          >
            <Icon name="x" :size="11" />
          </button>
        </div>

        <ul v-show="!row.collapsed" class="filetree__list">
          <li
            v-for="entry in row.view"
            :key="entry.file.id"
            class="filetree__sub"
            :class="rowClass(row, entry.index)"
            :draggable="!project.recognizing && !query.trim()"
            :title="project.recognizing ? '识别过程中不能调整顺序' : '拖动可调整顺序或移到别的项目'"
            @contextmenu="onRowContext(row, entry, $event)"
            @dragstart="onDragStart($event, row.id, entry.file.id)"
            @dragover="onRowDragOver($event, row, entry.index)"
            @drop="onDrop"
          >
            <button
              class="filetree__item"
              :class="{
                'is-active': project.activeFileId === entry.file.id,
                'is-selected': selItems.includes(entry.file.id),
              }"
              type="button"
              @click="clickItem(row, entry, $event)"
            >
              <span class="filetree__status" :class="`filetree__status--${entry.file.status}`">
                <Icon :name="iconOf(entry.file.status)" :size="12" />
              </span>
              <span class="filetree__main">
                <input
                  v-if="renaming?.kind === 'item' && renaming.id === entry.file.id"
                  ref="renameInput"
                  :value="renameText"
                  class="filetree__rename"
                  type="text"
                  @input="onRenameInput"
                  @click.stop
                  @dblclick.stop
                  @keydown.enter="commitRename"
                  @keydown.esc="renaming = null"
                  @blur="commitRename"
                />
                <span v-else class="filetree__name">{{ entry.file.name }}</span>
                <span class="filetree__meta">
                  {{ entry.meta }}
                  <span
                    v-if="project.mediaStateOf(entry.file.id)"
                    class="filetree__bad"
                  >
                    {{ project.mediaStateOf(entry.file.id) === 'missing' ? '音频找不到' : '音频被换过' }}
                  </span>
                </span>
              </span>
            </button>

            <!-- 行内动作：只在悬停时出现，避免每一行都挂一串常显按钮 -->
            <span class="filetree__acts">
              <button
                v-if="canRecognize(entry.file)"
                class="filetree__act"
                type="button"
                title="重新识别这一条"
                @click.stop="recognize(entry.file)"
              >
                <Icon name="wand" :size="12" />
              </button>
              <button
                v-if="canReload(entry.file)"
                class="filetree__act"
                type="button"
                title="重新读取源文件"
                @click.stop="reload(entry.file)"
              >
                <Icon name="refresh" :size="12" />
              </button>
              <button
                v-if="project.mediaStateOf(entry.file.id) || !entry.file.path"
                class="filetree__act"
                type="button"
                title="音频映射"
                @click.stop="openMap(entry.file)"
              >
                <Icon name="file-audio" :size="12" />
              </button>
            </span>
          </li>
        </ul>

        <p v-if="row.items.length === 0 && !row.collapsed" class="filetree__empty">
          还没有子项目
        </p>
      </section>

      <button
        class="filetree__new"
        :class="{ 'is-drop': dropOnNew }"
        type="button"
        title="新建一个空项目"
        @click="newDraft"
        @dragover="onNewDragOver"
        @drop="onNewDrop"
      >
        <Icon name="plus" :size="12" />
        <span>新建项目</span>
      </button>

      <p v-if="totalItems > 0" class="filetree__hint">
        <template v-if="query.trim()">匹配 {{ matchedItems }} / {{ totalItems }} 个子项目</template>
        <template v-else>共 {{ totalItems }} 个子项目，按顺序首尾相接</template>
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

/* 搜索框：让标题与计数分居两侧，输入框吃掉中间的宽度 */
.filetree__search {
  flex: 1;
  min-width: 0;
  margin: 0 var(--space-2);
  padding: 2px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-base);
  font-size: 11px;
  color: var(--color-text-primary);
  outline: none;
}

.filetree__search:focus {
  border-color: var(--color-accent-border);
}

/* 行内改名：直接在原来的名字位置变成输入框 */
.filetree__rename {
  flex: 1;
  min-width: 0;
  padding: 0 2px;
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-base);
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
  outline: none;
}

.filetree__body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--space-2) var(--space-3);
}

/* ---------- 项目条（26px，细长条，不是卡片） ---------- */

.filetree__group + .filetree__group {
  margin-top: 6px;
}

.filetree__proj {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 6px;
  margin-bottom: 4px;
  border-radius: var(--radius-md);
  box-shadow: inset 0 0 0 1px transparent;
  cursor: pointer;
}

.filetree__proj:hover {
  background: var(--color-bg-hover);
}

.filetree__proj.is-active {
  background: var(--color-bg-raised);
  box-shadow:
    var(--shadow-sm),
    inset 0 0 0 1px var(--color-text-tertiary);
}

/* 项目条的多选也用同一套描边，视线不用在两种「选中」之间换算 */
.filetree__proj.is-selected:not(.is-active) {
  background: var(--color-bg-raised);
  box-shadow:
    var(--shadow-sm),
    inset 0 0 0 1px var(--color-text-tertiary);
}

/* 拖到某条上 = 追加到这个项目末尾，落点提示就是整条描边 */
.filetree__proj.is-drop {
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

.filetree__proj-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: var(--weight-semibold);
  /* 非活动项目的名字压一档：光靠底色区别，两个项目挨着时看不出在看哪一个 */
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filetree__proj.is-active .filetree__proj-name {
  color: var(--color-text-primary);
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

.filetree__close {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.filetree__proj:hover .filetree__close {
  opacity: 1;
}

.filetree__close:hover {
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
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

/*
 * 选中态：所有被选中的行**都**带描边。
 *
 * 以前只有「活动」那一条有白框，多选三条时只框了一条，看起来像只选了第一条 ——
 * 描边才是「这几条会被一起动手」的唯一视觉承诺，必须一条不落。
 * 用方案里统一的选中样式（raised + 1px 强调描边 + 阴影）。
 */
.filetree__item.is-selected {
  background: var(--color-bg-raised);
  border-color: var(--color-text-tertiary);
  box-shadow: var(--shadow-sm);
}

.filetree__item.is-selected .filetree__name {
  font-weight: var(--weight-semibold);
}

/* 只是「正在看」这一条、并没有被选中：浅底、不加框，与选中区分开 */
.filetree__item.is-active:not(.is-selected) {
  background: var(--color-accent-subtle);
  border-color: transparent;
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

/* ---------- 新建 / 空态 ---------- */

.filetree__new {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  margin-top: 6px;
  padding: 0 8px;
  border-radius: var(--radius-md);
  font-size: 12px;
  color: var(--color-text-tertiary);
  box-shadow: inset 0 0 0 1px transparent;
}

.filetree__new:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.filetree__new.is-drop {
  background: var(--color-accent-subtle);
  box-shadow: inset 0 0 0 1px var(--color-accent);
  color: var(--color-text-primary);
}

.filetree__empty {
  margin: 0 0 4px 20px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.filetree__hint {
  margin: var(--space-3) 0 0;
  padding: 0 var(--space-2);
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
