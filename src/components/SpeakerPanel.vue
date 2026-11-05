<script setup lang="ts">
/**
 * 讲话人面板（编辑器右侧栏）。
 *
 * 只管「称呼」这一层：改名字、加一位、删一位。字幕归属在表格里改（点那一格
 * 或右键），这里不重复提供 ——— 同一件事两个入口而且判断条件还不一样，是
 * 最容易出现「界面上说改了、实际没改」的地方。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useSpeakerStore } from '@/stores/speakers'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { clearSpeaker, mergeSpeakerInto, setSpeakerFor, type SpeakerEntry } from '@/utils/speaker'
import ModalDialog from '@/components/dialogs/ModalDialog.vue'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const speakers = useSpeakerStore()
const editor = useEditorStore()
const history = useHistoryStore()
const settings = useSettingsStore()
const ui = useUiStore()

const file = computed(() => project.viewFile)
const fileId = computed(() => project.viewFileId ?? '')
const segments = computed(() => file.value?.segments ?? [])

const list = computed(() => speakers.speakersOf(fileId.value, segments.value))

/** 有一条带编号就显示这块 —— 没开分离的文件不该多出一整块空面板 */
const visible = computed(
  () => list.value.length > 0 || segments.value.some((s) => typeof s.speaker === 'number'),
)

/* ------------------------------------------------------------ 改称呼 */

const editing = ref<number | null>(null)
const draft = ref('')
const panelRef = ref<HTMLElement | null>(null)

async function beginRename(entry: SpeakerEntry): Promise<void> {
  editing.value = entry.index
  draft.value = entry.name
  await nextTick()
  // 输入框在 v-for 里，模板 ref 会被收成数组；直接按类名取当前那一个更稳
  const el = panelRef.value?.querySelector<HTMLInputElement>('.spkrow__input')
  el?.focus()
  el?.select()
}

function commitRename(): void {
  const index = editing.value
  editing.value = null
  if (index === null) return
  const next = draft.value.trim()
  const before = speakers.nameOf(fileId.value, index)
  if (next === before) return
  speakers.rename(fileId.value, index, next)
  ui.notify(
    'success',
    next ? `已改名为「${next}」` : `已恢复默认称呼`,
    speakers.nameOf(fileId.value, index),
  )
}

function cancelRename(): void {
  editing.value = null
}

/* ------------------------------------------------------------ 新增 / 删除 */

function addSpeaker(): void {
  const target = file.value
  if (!target) return
  const index = speakers.addSpeaker(fileId.value, target.segments)
  const name = speakers.nameOf(fileId.value, index)

  // 已经选好一批条目时，新增这一位就是给它们找归属 —— 只加一个空位反而要多点两下
  const ids = [...editor.selectedIds]
  if (ids.length > 0) {
    const result = setSpeakerFor(target.segments, ids, index)
    if (result.changed > 0) {
      history.commit(target.id, target.segments, '更改讲话人', () => {
        target.segments = result.segments
      })
    }
    ui.notify('success', `已新增「${name}」`, `选中的 ${result.changed} 条字幕归到这一位`)
    return
  }
  ui.notify('info', `已新增「${name}」`, '先在表格里选中字幕，再点这一位即可归入')
}

/* ------------------------------------------------------------ 跨文件共用 */

/** 参与对应关系的文件（合并模式下是一条合并产物） */
const mappingFiles = computed(() => project.speakerMappingFiles)

/** 有讲话人的文件数：只有一个文件时没什么可对应的，不用打断用户 */
const speakerFileCount = computed(
  () =>
    mappingFiles.value.filter((f) => f.segments.some((s) => typeof s.speaker === 'number')).length,
)

/**
 * 勾上「所有文件共用同一套称呼」。
 *
 * 第一次勾要**先让人确认**不同文件之间谁是谁 —— 直接按编号绑一起，
 * A 文件的 1 号与 B 文件的 1 号会被当成同一个人（编号只是「这个文件里的
 * 第几个人」，两个文件各拍各的，编号相同纯属巧合）。
 *
 * 确认之前勾选框弹回去：没确认就没生效，界面上也不能显示成已经生效。
 */
function onShareChange(event: Event): void {
  const el = event.target as HTMLInputElement
  if (!el.checked) {
    /*
     * 取消共用：**什么都不用清**。
     *
     * 各文件一直各自留着一份称呼（`byFile`），共用只是在上面盖了一层统一
     * 叫法。关掉开关，`namesOf()` 立刻回到各自那份 —— 也就是共用之前
     * 用户已经改好的称呼。
     */
    settings.speakerNamesShared = false
    return
  }
  if (!speakers.mappingConfirmed && speakerFileCount.value > 1) {
    // 先确认，后生效：勾选框弹回去，界面上不能显示成已经生效。
    // 取消弹窗时等于什么都没发生，开关也就留在原位
    el.checked = false
    if (speakers.mappingBuilt) speakers.ensureMapping(mappingFiles.value)
    else speakers.rebuildMapping(mappingFiles.value)
    // 记下这次弹窗是勾选引来的：确认后才由弹窗打开共用
    speakers.pendingShareConfirm = true
    ui.openDialog('speaker-map')
    return
  }
  speakers.ensureMapping(mappingFiles.value)
  settings.speakerNamesShared = true
}

/** 重新打开对应关系表调整（只是调整，不因此打开共用开关） */
function openMap(): void {
  speakers.pendingShareConfirm = false
  if (speakers.mappingBuilt) speakers.ensureMapping(mappingFiles.value)
  else speakers.rebuildMapping(mappingFiles.value)
  ui.openDialog('speaker-map')
}

/**
 * 新识别出来的讲话人也要挂到全局位上。
 *
 * 共用模式下没挂上的人没有统一称呼：侧栏退回「讲话人 N」，表里也看不见他 ——
 * 用户会以为分离没生效。
 */
watch(
  () =>
    project.speakerMappingFiles
      .map(
        (f) =>
          f.segments
            .filter((s) => typeof s.speaker === 'number')
            .map((s) => s.speaker)
            .join(','),
      )
      .join('|'),
  () => {
    if (settings.speakerNamesShared) speakers.ensureMapping(mappingFiles.value)
  },
  { immediate: true },
)

/**
 * 开关被「合并为一条时间轴」的默认值打开时，同样要先把对应关系补齐 ——
 * 没有对应关系就没有统一称呼，侧栏会显示成一片「讲话人 N」。
 */
watch(
  () => settings.speakerNamesShared,
  (on) => {
    if (on) speakers.ensureMapping(mappingFiles.value)
  },
  // 面板挂载时也要补一次：开关可能是在别的页面被「合并模式」的默认值打开
  { immediate: true },
)

const pending = ref<SpeakerEntry | null>(null)
const mode = ref<'clear' | 'merge'>('clear')
const mergeTo = ref<number>(-1)

/** 可以并入的对象：除自己以外的所有讲话人 */
const mergeTargets = computed(() => list.value.filter((e) => e.index !== pending.value?.index))

function askDelete(entry: SpeakerEntry): void {
  pending.value = entry
  mode.value = mergeTargets.value.length > 0 ? 'merge' : 'clear'
  mergeTo.value = mergeTargets.value[0]?.index ?? -1
}

function closeDelete(): void {
  pending.value = null
}

function doDelete(): void {
  const target = file.value
  const entry = pending.value
  if (!target || !entry) return

  if (mode.value === 'merge' && mergeTo.value >= 0) {
    const result = mergeSpeakerInto(target.segments, entry.index, mergeTo.value)
    const toName = speakers.nameOf(fileId.value, mergeTo.value)
    history.commit(target.id, target.segments, '并入讲话人', () => {
      target.segments = result.segments
    })
    speakers.forget(fileId.value, entry.index)
    pending.value = null
    ui.notify('success', `「${entry.name}」已并入「${toName}」`, `${result.changed} 条字幕换了归属`)
    return
  }

  const result = clearSpeaker(target.segments, entry.index)
  history.commit(target.id, target.segments, '清除讲话人标识', () => {
    target.segments = result.segments
  })
  speakers.forget(fileId.value, entry.index)
  pending.value = null
  ui.notify('success', `已删除「${entry.name}」`, `${result.changed} 条字幕变回未标记`)
}
</script>

<template>
  <div v-if="visible" ref="panelRef" class="speakers-wrap">
    <hr class="divider" />
    <div class="speakers">
    <div class="speakers__head">
      <span class="speakers__title">讲话人</span>
      <span class="speakers__count">{{ list.length }} 位</span>
      <span class="spacer" />
      <button class="speakers__add" type="button" title="新增一位讲话人" @click="addSpeaker">
        <Icon name="plus" :size="12" />
        <span>新增</span>
      </button>
    </div>

    <ul class="speakers__list">
      <li v-for="entry in list" :key="entry.index" class="spkrow">
        <span class="spkrow__index mono">{{ entry.index + 1 }}</span>

        <input
          v-if="editing === entry.index"
          v-model="draft"
          class="spkrow__input"
          type="text"
          maxlength="20"
          @blur="commitRename"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
        />
        <button
          v-else
          class="spkrow__name"
          type="button"
          title="点击修改称呼"
          @click="beginRename(entry)"
        >
          {{ entry.name }}
        </button>

        <span class="spkrow__count">{{ entry.count > 0 ? `${entry.count} 条` : '未使用' }}</span>

        <button
          class="spkrow__del"
          type="button"
          title="删除这一位讲话人"
          @click="askDelete(entry)"
        >
          <Icon name="trash" :size="12" />
        </button>
      </li>
    </ul>

    <div class="speakers__share">
      <label class="speakers__share-check">
        <input
          type="checkbox"
          :checked="settings.speakerNamesShared"
          @change="onShareChange"
        />
        <span>所有文件共用同一套称呼</span>
      </label>
      <button class="speakers__mapbtn" type="button" @click="openMap">调整对应关系</button>
    </div>

    <ModalDialog
      v-if="pending"
      title="删除讲话人"
      :subtitle="`「${pending.name}」名下有 ${pending.count} 条字幕`"
      width="440px"
      @close="closeDelete"
    >
      <div class="del">
        <label class="del__opt" :class="{ 'is-off': mergeTargets.length === 0 }">
          <input v-model="mode" type="radio" value="merge" :disabled="mergeTargets.length === 0" />
          <span class="del__body">
            <span class="del__label">并入其他讲话人</span>
            <span class="del__hint">
              这些字幕改成别人的名字，属于同一个人的两段发言就此合并
            </span>
            <select v-if="mode === 'merge'" v-model.number="mergeTo" class="select del__select">
              <option v-for="item in mergeTargets" :key="item.index" :value="item.index">
                {{ item.name }}
              </option>
            </select>
          </span>
        </label>

        <label class="del__opt">
          <input v-model="mode" type="radio" value="clear" />
          <span class="del__body">
            <span class="del__label">只删除讲话人标识</span>
            <span class="del__hint">这些字幕保留内容，标注清空，变回「未标记」</span>
          </span>
        </label>
      </div>

      <template #footer>
        <button class="btn" type="button" @click="closeDelete">取消</button>
        <button class="btn btn--danger" type="button" @click="doDelete">删除</button>
      </template>
    </ModalDialog>
    </div>
  </div>
</template>

<style scoped>
.speakers {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.speakers__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.speakers__title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}

.speakers__count {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.speakers__add {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  height: 22px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.speakers__add:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.speakers__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.spkrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-sm);
}

.spkrow:hover {
  background: var(--color-bg-hover);
}

.spkrow__index {
  flex: none;
  width: 14px;
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.spkrow__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

.spkrow__name:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.spkrow__input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 var(--space-1);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  font: inherit;
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
  outline: none;
}

.spkrow__count {
  flex: none;
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.spkrow__del {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
  opacity: 0;
}

.spkrow:hover .spkrow__del,
.spkrow__del:focus-visible {
  opacity: 1;
}

.spkrow__del:hover {
  background: var(--color-danger-subtle);
  color: var(--color-danger);
}

.speakers__share {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.speakers__share-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.speakers__share input {
  width: 13px;
  height: 13px;
  flex: none;
  margin: 0;
  accent-color: var(--color-accent);
}

/* 开关旁边的入口：随时能重新打开对应关系表改 */
.speakers__mapbtn {
  flex: none;
  height: 20px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 10px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.speakers__mapbtn:hover {
  border-color: var(--color-border-strong);
  background: var(--color-bg-hover);
  color: var(--color-text-secondary);
}

/* 删除时的两个选项 */
.del {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.del__opt {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.del__opt:hover {
  background: var(--color-bg-hover);
}

.del__opt.is-off {
  opacity: 0.45;
  cursor: not-allowed;
}

.del__opt input[type='radio'] {
  margin-top: 2px;
  width: 15px;
  height: 15px;
  flex: none;
  accent-color: var(--color-accent);
}

.del__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.del__label {
  font-size: var(--font-size-sm);
}

.del__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.del__select {
  margin-top: var(--space-1);
  max-width: 220px;
}
</style>
