<script setup lang="ts">
/**
 * 可搜索下拉选择。
 *
 * 原生 `<select>` 不支持输入过滤，而场景预设这类条目会越加越多，
 * 用户应当能直接打字缩小范围。结构刻意保持简单：
 * 一个输入框 + 过滤后的列表，选中后立刻收起。
 */
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'

interface Option {
  id: string
  name: string
  note?: string
}

const props = defineProps<{
  modelValue: string
  options: Option[]
  placeholder?: string
}>()

const emit = defineEmits<{ update: [value: string] }>()

const open = ref(false)
const query = ref('')
const root = ref<HTMLElement | null>(null)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.options
  return props.options.filter(
    (o) => o.name.toLowerCase().includes(q) || (o.note ?? '').toLowerCase().includes(q),
  )
})

const current = computed(() => props.options.find((o) => o.id === props.modelValue))

function pick(id: string): void {
  emit('update', id)
  close()
}

function toggle(): void {
  if (open.value) {
    close()
  } else {
    query.value = ''
    open.value = true
  }
}

function close(): void {
  open.value = false
}

function onOutside(e: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close()
}

onMounted(() => document.addEventListener('pointerdown', onOutside, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div ref="root" class="scsel">
    <button class="scsel__field" type="button" @click="toggle">
      <span class="scsel__value" :class="{ 'is-placeholder': !current }">
        {{ current ? current.name : (placeholder ?? '请选择') }}
      </span>
      <span class="scsel__caret" :class="{ 'is-open': open }" />
    </button>

    <div v-if="open" class="scsel__pop">
      <input
        v-model="query"
        class="scsel__search input"
        type="text"
        placeholder="输入关键字筛选"
        @keydown.escape="close"
      />
      <ul class="scsel__list">
        <li v-for="o in filtered" :key="o.id">
          <button
            class="scsel__item"
            :class="{ 'is-active': o.id === modelValue }"
            type="button"
            @click="pick(o.id)"
          >
            <span class="scsel__name">{{ o.name }}</span>
            <span class="scsel__note">{{ o.note }}</span>
          </button>
        </li>
        <li v-if="filtered.length === 0" class="scsel__empty">没有匹配的场景</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.scsel {
  position: relative;
}

.scsel__field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
}

.scsel__field:hover {
  border-color: var(--color-border-strong);
}

.scsel__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scsel__value.is-placeholder {
  color: var(--color-text-tertiary);
}

.scsel__caret {
  flex: none;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--color-text-tertiary);
  transition: transform var(--dur-fast) ease;
}

.scsel__caret.is-open {
  transform: rotate(180deg);
}

.scsel__pop {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-md);
}

.scsel__search {
  width: 100%;
  margin-bottom: var(--space-2);
}

.scsel__list {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.scsel__item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 6px var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.scsel__item:hover {
  background: var(--color-bg-inset);
}

.scsel__item.is-active {
  background: var(--color-bg-inset);
  box-shadow: inset 0 0 0 1px var(--color-accent-border);
}

.scsel__name {
  font-weight: var(--weight-medium);
}

.scsel__note {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.scsel__empty {
  padding: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  text-align: center;
}
</style>
