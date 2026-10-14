<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import Icon from '@/components/Icon.vue'

withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    width?: string
    /** 是否允许点击遮罩关闭 */
    maskClosable?: boolean
  }>(),
  {
    width: '520px',
    maskClosable: true,
  },
)

const emit = defineEmits<{ close: [] }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      class="modal"
      @mousedown.self="maskClosable && emit('close')"
    >
      <div
        class="modal__panel"
        :style="{ width }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
      >
        <header class="modal__head">
          <div class="modal__heading">
            <h2 class="modal__title">{{ title }}</h2>
            <p v-if="subtitle" class="modal__subtitle">{{ subtitle }}</p>
          </div>
          <button
            class="modal__close"
            type="button"
            aria-label="关闭"
            @click="emit('close')"
          >
            <Icon name="x" :size="15" />
          </button>
        </header>

        <div class="modal__body">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="modal__foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/**
 * 弹窗容器
 *
 * 这里刻意用 flex 而不是 grid + place-items。用 grid 时面板上的
 * `max-height: 100%` 参照的是「行轨道」高度，而单个 auto 行轨道是按内容
 * 撑开的 —— 于是 max-height 变成对「由内容决定的高度」取 100%，自引用，
 * 约束不到视口：小窗口下整个面板顶出屏幕，面板内部那个 overflow-y 也永远
 * 不会被触发，用户既看不全也滚不动。
 * 换成 flex 后 `max-height: 100%` 参照的是容器内容盒（fixed inset:0，高度确定），
 * 面板被压住，内部滚动才会真正生效。
 * `safe center` 是兜底：窗口极矮时改为顶对齐，避免内容从上方溢出后滚不到。
 */
.modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: safe center;
  justify-content: center;
  overflow: auto;
  padding: var(--space-6);
  background: var(--color-overlay);
}

.modal__panel {
  max-width: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-lg);
  animation: modal-in var(--dur-base) var(--ease-out);
}

@keyframes modal-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.99);
  }
}

.modal__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
}

.modal__heading {
  flex: 1;
  min-width: 0;
}

.modal__title {
  font-size: var(--font-size-md);
  font-weight: var(--weight-semibold);
}

.modal__subtitle {
  margin-top: 3px;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.modal__close {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  margin: -2px -2px 0 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
}

.modal__close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.modal__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 滚到底不要连带把外层遮罩滚走 */
  overscroll-behavior: contain;
  padding: var(--space-4);
}

.modal__foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-bg-inset);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}
</style>
