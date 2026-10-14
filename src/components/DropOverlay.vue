<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import { SUPPORTED_LABELS } from '@/utils/formats'

defineProps<{ active: boolean }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="veil">
      <div v-if="active" class="veil">
        <div class="veil__box">
          <span class="veil__icon">
            <Icon name="import" :size="30" />
          </span>
          <p class="veil__title">松手即可添加到队列</p>
          <p class="veil__hint">支持 {{ SUPPORTED_LABELS.join('  ') }}</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: grid;
  place-items: center;
  background: var(--color-overlay);
  backdrop-filter: blur(2px);
  pointer-events: none;
}

.veil__box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-12);
  border: 2px dashed var(--color-accent-border);
  border-radius: var(--radius-xl);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-lg);
}

.veil__icon {
  color: var(--color-accent);
  margin-bottom: var(--space-1);
}

.veil__title {
  font-size: var(--font-size-md);
  font-weight: var(--weight-medium);
}

.veil__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.veil-enter-active,
.veil-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}

.veil-enter-from,
.veil-leave-to {
  opacity: 0;
}
</style>
