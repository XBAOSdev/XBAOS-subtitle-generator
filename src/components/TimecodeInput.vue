<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { parseRelativeOffset, parseTimecode, toTimecode } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    modelValue: number
    /** 是否允许输入 +0.5 / -0.3 这样的相对调整 */
    relative?: boolean
    disabled?: boolean
  }>(),
  {
    relative: true,
    disabled: false,
  },
)

const emit = defineEmits<{ 'update:modelValue': [number] }>()

const editing = ref(false)
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const invalid = ref(false)

async function begin(): Promise<void> {
  if (props.disabled) return
  draft.value = toTimecode(props.modelValue)
  invalid.value = false
  editing.value = true
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}

function commit(): void {
  const raw = draft.value.trim()
  if (!raw) {
    cancel()
    return
  }

  if (props.relative) {
    const offset = parseRelativeOffset(raw)
    if (offset !== null) {
      emit('update:modelValue', Math.max(0, Number((props.modelValue + offset).toFixed(3))))
      editing.value = false
      return
    }
  }

  const absolute = parseTimecode(raw)
  if (absolute === null) {
    invalid.value = true
    return
  }

  emit('update:modelValue', Number(absolute.toFixed(3)))
  editing.value = false
}

function cancel(): void {
  editing.value = false
  invalid.value = false
}

/** 方向键微调 ±0.1 秒 */
function nudge(delta: number): void {
  emit('update:modelValue', Math.max(0, Number((props.modelValue + delta).toFixed(3))))
}

watch(
  () => props.modelValue,
  () => {
    invalid.value = false
  },
)
</script>

<template>
  <span class="timecode">
    <input
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      class="timecode__input mono"
      :class="{ 'is-invalid': invalid }"
      type="text"
      spellcheck="false"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @blur="commit"
    />
    <button
      v-else
      class="timecode__display mono"
      type="button"
      :disabled="disabled"
      :title="relative ? '点击编辑，可输入 +0.5 或 -0.3 微调' : '点击编辑'"
      @click="begin"
      @keydown="
        (event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            nudge(0.1)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            nudge(-0.1)
          }
        }
      "
    >
      {{ toTimecode(modelValue) }}
    </button>

    <span class="timecode__spinner">
      <button
        class="timecode__step"
        type="button"
        tabindex="-1"
        :disabled="disabled"
        title="减少 0.1 秒"
        @click="nudge(-0.1)"
      >
        <svg viewBox="0 0 8 5" width="7" height="4.5" aria-hidden="true">
          <path d="M0 5 4 0l4 5Z" fill="currentColor" />
        </svg>
      </button>
      <button
        class="timecode__step"
        type="button"
        tabindex="-1"
        :disabled="disabled"
        title="增加 0.1 秒"
        @click="nudge(0.1)"
      >
        <svg viewBox="0 0 8 5" width="7" height="4.5" aria-hidden="true">
          <path d="M0 0l4 5 4-5Z" fill="currentColor" />
        </svg>
      </button>
    </span>
  </span>
</template>

<style scoped>
.timecode {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.timecode__display {
  flex: 1;
  min-width: 0;
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  text-align: left;
  /* 时间码经常要拷到别处去对齐（剪辑软件、Excel），放行选中 */
  user-select: text;
  transition: background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.timecode__display:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.timecode__input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 var(--space-1);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  font-size: var(--font-size-xs);
  outline: none;
  box-shadow: 0 0 0 2px var(--color-accent-subtle);
}

.timecode__input.is-invalid {
  border-color: var(--color-danger);
  box-shadow: 0 0 0 2px var(--color-danger-subtle);
}

.timecode__spinner {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.timecode:hover .timecode__spinner {
  opacity: 1;
}

.timecode__step {
  display: grid;
  place-items: center;
  width: 11px;
  height: 8px;
  color: var(--color-text-tertiary);
}

.timecode__step:hover:not(:disabled) {
  color: var(--color-accent);
}
</style>
