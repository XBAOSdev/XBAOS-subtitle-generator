<script setup lang="ts">
import { computed } from 'vue'
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

      <!-- 独立模式：文件树。不支持的文件单独归到下方分区，这里不重复列出 -->
      <ul v-else class="filetree__list">
        <li v-for="file in project.supportedFiles" :key="file.id">
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
