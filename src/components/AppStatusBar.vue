<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { useLogStore } from '@/stores/logs'
import { formatDuration } from '@/utils/format'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const settings = useSettingsStore()
const ui = useUiStore()
const logs = useLogStore()

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

/*
 * ---- 日志气泡 ----
 *
 * 进度条只说得清「走了多少」，说不清「在等什么」。识别时真正让人焦虑的是
 * 中间那段没有百分比的时间（解码、加载模型、聚类），而这恰好是引擎日志
 * 一直在报的。鼠标停上去就把日志摊开，移开即收 —— 需要时看得见，不需要时
 * 不占任何位置。
 */
const logOpen = ref(false)
const logList = ref<HTMLElement | null>(null)

/**
 * 关气泡先排队，不立即关。
 *
 * 进度区与气泡之间有一段空隙（气泡浮在底栏上方），指针往上走必然先离开进度区、
 * 再进入气泡 —— 立刻关掉的话，用户根本够不到那块气泡。所以延迟一点关，
 * 期间指针进入气泡就取消这次关闭。
 */
let closeTimer: number | undefined

function openLog(): void {
  if (closeTimer !== undefined) {
    window.clearTimeout(closeTimer)
    closeTimer = undefined
  }
  logOpen.value = true
}

function scheduleClose(): void {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => {
    closeTimer = undefined
    logOpen.value = false
  }, 180)
}

onBeforeUnmount(() => {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
})

/** 只摊最后几十行：再往上翻没人看，只会把底栏顶穿 */
const recentLogs = computed(() => logs.lines.slice(-40))

/** 新行进来时贴底，否则用户看到的是十秒前的现场 */
watch(
  () => (logOpen.value ? logs.lines.length : 0),
  async () => {
    await nextTick()
    const el = logList.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function stamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

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
      <template v-else-if="project.intake.length > 0">
        <span>待识别 {{ project.pendingIntake.length }} 个</span>
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
        <div
          class="statusbar__progress"
          :class="{ 'is-veiled': ui.taskFlight !== null }"
          @mouseenter="openLog"
          @mouseleave="scheduleClose"
        >
          <Icon name="spinner" :size="12" />
          <span class="statusbar__progress-text">{{ project.progressLabel }}</span>
          <span class="statusbar__progress-track" aria-hidden="true">
            <span class="statusbar__progress-bar" :style="{ width: `${project.progress}%` }" />
          </span>
          <span class="mono">{{ project.progress }}%</span>

          <div
            v-if="logOpen && recentLogs.length > 0"
            class="statusbar__log"
            role="log"
            @mouseenter="openLog"
            @mouseleave="scheduleClose"
          >
            <div class="statusbar__log-head">
              <span>运行日志</span>
              <span class="statusbar__log-count">{{ logs.lines.length }} 行</span>
            </div>
            <ul ref="logList" class="statusbar__log-body">
              <li v-for="line in recentLogs" :key="line.id" :class="`is-${line.level}`">
                <span class="statusbar__log-time mono">{{ stamp(line.at) }}</span>
                <span class="statusbar__log-text">{{ line.text }}</span>
              </li>
            </ul>
          </div>
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
  justify-content: center;
  gap: var(--space-2);
  /*
   * 固定宽度是这里的关键。
   *
   * 以前这一块宽度跟着文案走：文件名一长、文案一换（「第 1/2 遍」→「分析讲话人」），
   * 整块就往左右长，进度条跟着平移 —— 明明进度在推进，看起来却像在抖。
   * 宽度定死，文字区自己吃剩余空间、超了省略，进度条永远在同一个位置。
   */
  flex: none;
  width: 344px;
}

.statusbar__progress {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
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

.statusbar__progress-text {
  /* 吃掉剩余宽度，长文件名在这里省略，不再把进度条顶走 */
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--color-text-secondary);
}

.statusbar__progress > svg {
  flex: none;
}

.statusbar__progress-track {
  position: relative;
  flex: none;
  display: block;
  width: 120px;
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-bg-subtle);
  overflow: hidden;
}

/* 百分比列定死宽度：99% → 100% 也不该把条子挤一下 */
.statusbar__progress > .mono {
  flex: none;
  width: 34px;
  text-align: right;
}

.statusbar__progress-bar {
  display: block;
  height: 100%;
  background: var(--color-accent);
  border-radius: var(--radius-pill);
  transition: width var(--dur-base) var(--ease-out);
}

/* ---------- 日志气泡 ---------- */

.statusbar__log {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  width: 560px;
  max-width: 80vw;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  /* 不裁剪：下面那个「桥」是伸出盒子外的，裁掉就等于没有 */
  overflow: visible;
}

/*
 * 把进度区与气泡之间那 10px 空隙也变成气泡的一部分。
 * 指针从进度区往上走时一直落在可交互区域里，气泡就不会先关掉。
 */
.statusbar__log::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  height: 12px;
}

.statusbar__log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 6px var(--space-3);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 11px;
}

.statusbar__log-count {
  color: var(--color-text-tertiary);
}

.statusbar__log-body {
  margin: 0;
  padding: var(--space-2) 0;
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
  /* 父级不裁剪了（要给「桥」留出空间），圆角由滚动区自己收口 */
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  font-size: 11px;
  line-height: 1.55;
}

.statusbar__log-body li {
  display: flex;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  color: var(--color-text-secondary);
  user-select: text;
}

.statusbar__log-body li.is-warn {
  color: var(--color-warning);
}

.statusbar__log-body li.is-error {
  color: var(--color-danger);
}

.statusbar__log-time {
  flex: none;
  color: var(--color-text-tertiary);
  font-size: 10px;
  padding-top: 1px;
}

.statusbar__log-text {
  min-width: 0;
  word-break: break-word;
  white-space: pre-wrap;
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
