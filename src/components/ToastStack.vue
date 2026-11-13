<script setup lang="ts">
/**
 * 弹出的通知（右上角一列）。
 *
 * 三条约束，都是被「挡住操作」逼出来的：
 *
 * ① **最多 4 条**（上限由 store 的 `TOAST_LIMIT` 执行）。这里不再往下无限排 ——
 *    右上是每个界面都要用的地方（时间轴、工具面板、底栏按钮），排到第七条就等于
 *    把界面糊住了。
 * ② **不接收鼠标**。整列 `pointer-events: none`：通知压在按钮上时，用户点下去
 *    应该点到按钮，而不是点到一张读过就忘的卡片上。既然不吃鼠标，那个「×」也
 *    就没有存在的意义了 —— 留一个点不到的关闭键比没有更糟。
 * ③ **鼠标靠近就收起来**。指针一旦进入这一列（外扩一圈），全部通知立刻消失：
 *    用户的动作本来就是「我要用下面那块」，让他先想办法关掉通知是多余的一步。
 *
 * 为什么用 `pointermove` 判坐标而不是 `mouseenter`：通知是**后出现**在静止指针
 * 底下的，浏览器不会补发 enter/leave（这条在日志气泡上已经踩过一次）。指针不动
 * 时也确实不该消失 —— 那时用户并没有要操作那块区域。
 *
 * 收起只清「弹出的这一列」，通知中心里一条不少：用户的诉求是「别挡我」，
 * 不是「刚才那条记录别留」。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUiStore } from '@/stores/ui'
import Icon from '@/components/Icon.vue'

const ui = useUiStore()

const stackRef = ref<HTMLElement | null>(null)

const iconOf = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  error: 'alert',
} as const

/** 指针离这一列多近就算「靠近」：留一圈余量，斜着划过去也算 */
const NEAR_PAD = 28

let wasInside = false

function nearStack(x: number, y: number): boolean {
  const el = stackRef.value
  if (!el || ui.toasts.length === 0) return false
  const r = el.getBoundingClientRect()
  return (
    x >= r.left - NEAR_PAD &&
    x <= r.right + NEAR_PAD &&
    y >= r.top - NEAR_PAD &&
    y <= r.bottom + NEAR_PAD
  )
}

function onPointerMove(event: PointerEvent): void {
  const inside = nearStack(event.clientX, event.clientY)
  // 只在「刚进入」那一下收：一直停在里面时不必每帧都清一遍
  if (inside && !wasInside) ui.dismissAllToasts()
  wasInside = inside
}

watch(
  () => ui.toasts.length,
  async () => {
    // 这一列变了之后指针可能还悬在原地，下一次移进来要能再触发
    await nextTick()
    wasInside = false
  },
)

onMounted(() => window.addEventListener('pointermove', onPointerMove, { passive: true }))
onBeforeUnmount(() => window.removeEventListener('pointermove', onPointerMove))
</script>

<template>
  <Teleport to="body">
    <div ref="stackRef" class="toasts" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div
          v-for="item in ui.toasts"
          :key="item.id"
          class="toast"
          :class="`toast--${item.type}`"
        >
          <span class="toast__icon">
            <Icon :name="iconOf[item.type]" :size="14" />
          </span>
          <div class="toast__body">
            <p class="toast__title">{{ item.title }}</p>
            <p v-if="item.message" class="toast__message">{{ item.message }}</p>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: calc(var(--titlebar-height) + var(--space-3));
  right: var(--space-4);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 340px;
  /* 通知不接收鼠标：它压着的往往正是要点的按钮 */
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-md);
}

/* 类型靠图标颜色区分，不再在左侧加一条饰线 —— 卡片四边同宽更干净 */

.toast__icon {
  margin-top: 1px;
  color: var(--color-text-tertiary);
}

.toast--success .toast__icon {
  color: var(--color-success);
}

.toast--warning .toast__icon {
  color: var(--color-warning);
}

.toast--error .toast__icon {
  color: var(--color-danger);
}

.toast__body {
  flex: 1;
  min-width: 0;
}

.toast__title {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
}

.toast__message {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

/* 新的从右边进来 */
.toast-enter-from {
  opacity: 0;
  transform: translateX(16px);
}

/* 退场一律向上收：被挤出上限的那条是往「上」离开，与新的从下方补位对得上 */
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
