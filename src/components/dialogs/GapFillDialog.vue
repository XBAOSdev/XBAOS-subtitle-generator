<script setup lang="ts">
import { computed, ref } from 'vue'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore, DEFAULT_SETTINGS } from '@/stores/settings'
import { useProjectStore } from '@/stores/project'
import { useHistoryStore } from '@/stores/history'
import { applyGapFill, planGapFill } from '@/utils/gapFill'
import { toTimecode } from '@/utils/format'
import ModalDialog from './ModalDialog.vue'
import Icon from '@/components/Icon.vue'

const ui = useUiStore()
const settings = useSettingsStore()
const project = useProjectStore()

const thresholdSec = ref(settings.gapFill.thresholdSec)
const keepGapSec = ref(settings.gapFill.keepGapSec)
const limitEnabled = ref(settings.gapFill.limitEnabled)
const maxDurationSec = ref(settings.gapFill.maxDurationSec)

const options = computed(() => ({
  thresholdSec: Number(thresholdSec.value),
  keepGapSec: Number(keepGapSec.value),
  limitEnabled: limitEnabled.value,
  maxDurationSec: Number(maxDurationSec.value),
}))

const activeFile = computed(() => project.viewFile)

const changes = computed(() => {
  if (!activeFile.value) return []
  return planGapFill(activeFile.value.segments, options.value)
})

const previewRows = computed(() => changes.value.slice(0, 8))

/**
 * 全队列合计会变化多少处。
 * 合并模式下「全部」指的就是那条合并时间轴本身 —— 改各段原件不会反映到
 * 视图与导出里，所以不能拿 supportedFiles 去统计。
 */
const allTargets = computed(() =>
  project.isMerge && project.mergedFile ? [project.mergedFile] : project.supportedFiles,
)

const totalChanges = computed(() =>
  allTargets.value.reduce(
    (sum, file) => sum + planGapFill(file.segments, options.value).length,
    0,
  ),
)

function resetDefaults(): void {
  const d = DEFAULT_SETTINGS.gapFill
  thresholdSec.value = d.thresholdSec
  keepGapSec.value = d.keepGapSec
  limitEnabled.value = d.limitEnabled
  maxDurationSec.value = d.maxDurationSec
}

function persist(): void {
  settings.gapFill = { ...options.value }
}

function apply(scope: 'current' | 'all'): void {
  const targets =
    scope === 'current'
      ? activeFile.value
        ? [activeFile.value]
        : []
      : allTargets.value

  const history = useHistoryStore()
  let filled = 0
  for (const file of targets) {
    // 每个文件各自入历史（history 按 fileId 分桶），撤回时互不影响。
    // 以前这里是直接改数据，撤回栈里根本没有这一步 —— 用户按 Ctrl+Z 会
    // 跳过它撤到更早的操作，等于「填充空隙」不可撤销。
    history.commit(file.id, file.segments, '填充空隙', () => {
      filled += applyGapFill(file.segments, options.value)
    })
  }

  persist()
  ui.closeDialog()

  if (filled === 0) {
    ui.notify('info', '没有需要填充的空隙', '当前参数下所有间隔都超出阈值或已有重叠')
    return
  }

  ui.notify(
    'success',
    `已填充 ${filled} 处空隙`,
    scope === 'current' ? activeFile.value?.name : `覆盖 ${targets.length} 个文件`,
  )
}

function close(): void {
  ui.closeDialog()
}
</script>

<template>
  <ModalDialog
    title="填充文本空隙"
    subtitle="消除相邻字幕之间的展示间隔，超过阈值的停顿会被保留"
    width="620px"
    @close="close"
  >
    <div class="gapfill">
      <div class="gapfill__params">
        <label class="field">
          <span class="field__label">间隔阈值</span>
          <span class="field__control">
            <input
              v-model.number="thresholdSec"
              class="input input--mono"
              type="number"
              min="0.5"
              max="10"
              step="0.1"
            />
            <span class="field__unit">秒</span>
          </span>
          <span class="field__hint">超过此长度的停顿视为有意停顿，不填充</span>
        </label>

        <label class="field">
          <span class="field__label">保留间隙</span>
          <span class="field__control">
            <input
              v-model.number="keepGapSec"
              class="input input--mono"
              type="number"
              min="0"
              max="0.2"
              step="0.01"
            />
            <span class="field__unit">秒</span>
          </span>
          <span class="field__hint">填充后留一点缝，防止播放器在边界处闪烁</span>
        </label>

        <div class="field">
          <label class="switch field__switch">
            <input v-model="limitEnabled" type="checkbox" />
            <span class="switch__track" />
            <span class="field__label">限制单条最长时长</span>
          </label>
          <span class="field__control">
            <input
              v-model.number="maxDurationSec"
              class="input input--mono"
              type="number"
              min="1"
              max="60"
              step="0.5"
              :disabled="!limitEnabled"
            />
            <span class="field__unit">秒</span>
          </span>
          <span class="field__hint">
            避免前一条语音很短、却被拉长到接近阈值的情况
          </span>
        </div>
      </div>

      <div class="gapfill__preview">
        <div class="gapfill__preview-head">
          <span class="gapfill__preview-title">
            预览
            <span class="gapfill__count">
              {{
                activeFile
                  ? `将修改 ${changes.length} 处`
                  : '当前没有选中的文件'
              }}
            </span>
          </span>
          <span v-if="project.supportedFiles.length > 1" class="gapfill__total">
            全部文件合计 {{ totalChanges }} 处
          </span>
        </div>

        <ul v-if="previewRows.length > 0" class="gapfill__list">
          <li v-for="row in previewRows" :key="row.id" class="gapfill__row">
            <span class="gapfill__row-index mono">第 {{ row.index + 1 }} 条</span>
            <span class="gapfill__row-time mono">
              {{ toTimecode(row.beforeEnd) }}
              <Icon name="chevron-right" :size="12" />
              <span class="gapfill__row-after">{{ toTimecode(row.afterEnd) }}</span>
            </span>
            <span class="gapfill__row-delta mono">+{{ row.filled.toFixed(3) }}s</span>
          </li>
          <li v-if="changes.length > previewRows.length" class="gapfill__more">
            还有 {{ changes.length - previewRows.length }} 处未列出
          </li>
        </ul>

        <p v-else class="gapfill__empty">
          当前参数下没有需要填充的空隙。
        </p>
      </div>
    </div>

    <template #footer>
      <button class="btn btn--ghost" type="button" @click="resetDefaults">
        恢复默认
      </button>
      <span class="gapfill__spacer" />
      <button class="btn" type="button" @click="close">取消</button>
      <button
        v-if="project.supportedFiles.length > 1"
        class="btn"
        type="button"
        :disabled="totalChanges === 0"
        @click="apply('all')"
      >
        应用到全部文件
      </button>
      <button
        class="btn btn--primary"
        type="button"
        :disabled="changes.length === 0"
        @click="apply('current')"
      >
        应用到当前文件
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.gapfill {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.gapfill__params {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field__label {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
}

.field__switch {
  margin-bottom: 2px;
}

.field__control {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 180px;
}

.field__unit {
  flex: none;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.field__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.gapfill__preview {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.gapfill__preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-inset);
  border-bottom: 1px solid var(--color-border-subtle);
}

.gapfill__preview-title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
}

.gapfill__count {
  margin-left: var(--space-2);
  color: var(--color-accent-text);
}

.gapfill__total {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.gapfill__list {
  max-height: 240px;
  overflow-y: auto;
}

.gapfill__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  background: var(--color-warning-subtle);
}

.gapfill__row + .gapfill__row {
  border-top: 1px solid var(--color-border-subtle);
}

.gapfill__row-index {
  flex: none;
  width: 68px;
  color: var(--color-text-tertiary);
}

.gapfill__row-time {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-secondary);
}

.gapfill__row-after {
  color: var(--color-text-primary);
  font-weight: var(--weight-medium);
}

.gapfill__row-delta {
  flex: none;
  color: var(--color-warning);
}

.gapfill__more {
  padding: var(--space-2) var(--space-3);
  font-size: 11px;
  color: var(--color-text-tertiary);
  background: var(--color-bg-inset);
}

.gapfill__empty {
  padding: var(--space-5) var(--space-3);
  text-align: center;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.gapfill__spacer {
  flex: 1;
}
</style>
