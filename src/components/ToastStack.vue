<script setup lang="ts">
import { useUiStore } from '@/stores/ui'
import Icon from '@/components/Icon.vue'

const ui = useUiStore()

const iconOf = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  error: 'alert',
} as const
</script>

<template>
  <Teleport to="body">
    <div class="toasts" role="status" aria-live="polite">
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
          <button
            class="toast__close"
            type="button"
            aria-label="关闭提示"
            @click="ui.dismissToast(item.id)"
          >
            <Icon name="x" :size="13" />
          </button>
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
  pointer-events: auto;
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

.toast__close {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
}

.toast__close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
</style>
