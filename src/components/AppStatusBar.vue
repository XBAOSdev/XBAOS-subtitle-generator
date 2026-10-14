<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { formatDuration } from '@/utils/format'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const settings = useSettingsStore()
const ui = useUiStore()

const backendLabel = computed(() => {
  if (settings.backend === 'cpu') return 'CPU'
  if (settings.backend === 'vulkan') return 'Vulkan'
  return '自动'
})

const issueText = computed(() => {
  const parts: string[] = []
  if (project.errorCount > 0) parts.push(`${project.errorCount} 条错误`)
  if (project.warningCount > 0) parts.push(`${project.warningCount} 条警告`)
  return parts.join('，')
})

/**
 * 告警数变化时闪一下。
 *
 * 校验是「边打字边跑」的，这个数字会高频跳；直接突变读起来像是界面自己动了一下，
 * 闪一下反而能让人看清「刚才是这里变了」。做法是加一个类、动画放完就摘掉 ——
 * **不能靠给元素换 key 来做交叉淡化**：那会在过渡的那一帧里同时存在两个节点，
 * 「底栏写着什么」这类文本断言会读到两份。
 */
const issuePulse = ref(false)
watch(issueText, (next, prev) => {
  if (!next || next === prev) return
  issuePulse.value = false
  void nextTick(() => {
    issuePulse.value = true
  })
})
</script>

<template>
  <footer class="statusbar">
    <div class="statusbar__side">
      <template v-if="project.hasFiles">
        <span>文件 {{ project.files.length }}</span>
        <span class="statusbar__sep" aria-hidden="true">|</span>
        <span>字幕 {{ project.totalSegments }} 条</span>
        <span class="statusbar__sep" aria-hidden="true">|</span>
        <span>时长 {{ formatDuration(project.totalDuration) }}</span>
      </template>
      <template v-else>
        <span>尚未导入音频</span>
      </template>
    </div>

    <div class="statusbar__center">
      <!-- 飞行期间这一行**已经占好位置**，只是透明的。
           布局全程不动、只有透明度在动，是「不跳变」的关键：
           若等进度行出现再撑开，底部会因为多出一段文字而横向挤一下。 -->
      <template v-if="project.recognizing || ui.taskFlight">
        <div class="statusbar__progress" :class="{ 'is-veiled': ui.taskFlight !== null }">
          <Icon name="spinner" :size="12" class="statusbar__spin" />
          <span class="statusbar__progress-text">{{ project.progressLabel }}</span>
          <span class="statusbar__progress-track" aria-hidden="true">
            <span
              class="statusbar__progress-bar"
              :style="{ width: `${project.progress}%` }"
            />
          </span>
          <span class="mono">{{ project.progress }}%</span>
        </div>
      </template>
      <template v-else-if="issueText">
        <button
          class="statusbar__issue"
          :class="{ 'is-pulse': issuePulse }"
          type="button"
          @click="ui.navigate('editor')"
          @animationend="issuePulse = false"
        >
          <Icon name="alert" :size="12" />
          <span>{{ issueText }}</span>
        </button>
      </template>
    </div>

    <div class="statusbar__side statusbar__side--right">
      <span v-if="project.pendingReviewCount > 0" class="statusbar__pending">
        {{ project.pendingReviewCount }} 个文件处理完成
      </span>
      <span class="statusbar__sep" aria-hidden="true">|</span>
      <span class="statusbar__backend" :title="'推理后端：' + backendLabel">
        <Icon name="cpu" :size="12" />
        <span>{{ backendLabel }}</span>
      </span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  height: var(--statusbar-height);
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-4);
  background: var(--color-bg-surface);
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-tertiary);
  user-select: none;
}

.statusbar__side {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.statusbar__side--right {
  justify-content: flex-end;
}

.statusbar__center {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.statusbar__progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  opacity: 1;
  transition: opacity var(--dur-fast) var(--ease-out);
}

/* 圆点还在飞：占位但透明。飞完 to 掉这个类，120ms 淡入 */
.statusbar__progress.is-veiled {
  opacity: 0;
}

.statusbar__sep {
  color: var(--color-border-strong);
}

.statusbar__spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.statusbar__progress-text {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.statusbar__progress-track {
  display: block;
  width: 120px;
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-bg-subtle);
  overflow: hidden;
}

.statusbar__progress-bar {
  display: block;
  height: 100%;
  background: var(--color-accent);
  border-radius: var(--radius-pill);
  transition: width var(--dur-base) var(--ease-out);
}

.statusbar__issue {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--color-warning);
  font-size: 11px;
}

.statusbar__issue:hover {
  background: var(--color-warning-subtle);
}

/* 告警数变了 → 闪一下（放完由 animationend 摘掉这个类） */
.statusbar__issue.is-pulse {
  animation: issue-blip var(--dur-base) var(--ease-out);
}

@keyframes issue-blip {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 1;
  }
}

.statusbar__pending {
  color: var(--color-text-secondary);
}

.statusbar__backend {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
</style>
