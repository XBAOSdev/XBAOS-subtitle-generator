<script setup lang="ts">
/**
 * 浮层菜单（右键菜单 / 下拉菜单）。
 *
 * 自己实现而不是用原生菜单：需要「不可用项变灰并说明原因」、需要子菜单、
 * 需要跟着行内元素定位 —— 这几样原生 `<select>` 与系统菜单都给不了。
 *
 * 位置一律夹进视口：右键点最后一行时不夹的话，菜单会有一半跑到屏幕外面。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { tidyMenu, type MenuItem } from '@/utils/menu'
import Icon from '@/components/Icon.vue'

const props = defineProps<{
  /** 视口坐标（clientX / clientY） */
  x: number
  y: number
  items: MenuItem[]
  minWidth?: number
}>()

const emit = defineEmits<{ close: []; pick: [string] }>()

const root = ref<HTMLElement | null>(null)
const subRoot = ref<HTMLElement | null>(null)
const pos = ref({ x: props.x, y: props.y })
const sub = ref<{ items: MenuItem[]; x: number; y: number; from: string } | null>(null)

const list = computed(() => tidyMenu(props.items))

/** 贴着点击处展开，越界时往回收 */
async function place(): Promise<void> {
  await nextTick()
  const el = root.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const pad = 6
  let x = props.x
  let y = props.y
  if (x + rect.width > window.innerWidth - pad) x = Math.max(pad, props.x - rect.width)
  if (y + rect.height > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - rect.height - pad)
  pos.value = { x, y }
}

watch(() => [props.x, props.y, props.items], () => void place(), { immediate: true })

function onEnter(item: MenuItem, event: MouseEvent): void {
  if (item.disabled || !item.children || item.children.length === 0) {
    sub.value = null
    return
  }
  const el = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const width = root.value?.getBoundingClientRect().width ?? 180
  const right = el.right + width > window.innerWidth - 6
  sub.value = {
    items: item.children,
    x: right ? el.left - width + 2 : el.right - 2,
    y: el.top - 4,
    from: item.key,
  }
}

function activate(item: MenuItem): void {
  if (item.disabled || item.children) return
  emit('pick', item.key)
  emit('close')
}

/** 子菜单太靠底时上移，别被视口切掉 */
async function placeSub(): Promise<void> {
  await nextTick()
  const el = subRoot.value
  if (!el || !sub.value) return
  const rect = el.getBoundingClientRect()
  const pad = 6
  if (rect.bottom > window.innerHeight - pad) {
    sub.value = { ...sub.value, y: Math.max(pad, window.innerHeight - rect.height - pad) }
  }
}

watch(sub, () => void placeSub())

/**
 * Esc 关菜单。
 *
 * 挂在 window 的捕获阶段：菜单打开时页面上可能还有别的键盘处理（表格的
 * 方向键、编辑区的 Esc），它们不该为一个浮层让路，也不该抢在浮层前面。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      class="menulayer"
      @mousedown.self="emit('close')"
      @contextmenu.prevent
      @wheel="emit('close')"
    >
      <div
        ref="root"
        class="menu"
        role="menu"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px`, minWidth: `${minWidth ?? 168}px` }"
        @mousedown.stop
      >
        <template v-for="(item, index) in list" :key="item.key || `d${index}`">
          <div v-if="item.divider" class="menu__divider" />
          <button
            v-else
            class="menu__item"
            :class="{ 'is-disabled': item.disabled, 'is-danger': item.danger, 'is-open': sub?.from === item.key }"
            type="button"
            role="menuitem"
            :disabled="item.disabled"
            @mouseenter="onEnter(item, $event)"
            @click="activate(item)"
          >
            <span class="menu__icon">
              <Icon v-if="item.icon" :name="item.icon" :size="13" />
            </span>
            <span class="menu__label">{{ item.label }}</span>
            <span v-if="item.hint" class="menu__hint">{{ item.hint }}</span>
            <Icon v-if="item.children" name="chevron-right" :size="11" class="menu__caret" />
          </button>
        </template>
      </div>

      <div
        v-if="sub"
        ref="subRoot"
        class="menu menu--sub"
        role="menu"
        :style="{ left: `${sub.x}px`, top: `${sub.y}px`, minWidth: '148px' }"
        @mousedown.stop
      >
        <button
          v-for="item in tidyMenu(sub.items)"
          :key="item.key"
          class="menu__item"
          :class="{ 'is-disabled': item.disabled, 'is-danger': item.danger }"
          type="button"
          role="menuitem"
          :disabled="item.disabled"
          @click="activate(item)"
        >
          <span class="menu__icon">
            <Icon v-if="item.icon" :name="item.icon" :size="13" />
          </span>
          <span class="menu__label">{{ item.label }}</span>
          <span v-if="item.hint" class="menu__hint">{{ item.hint }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 整层铺满视口只为了接住「点别处就关」这一下。
 * 不吞滚轮（页面还能滚），但滚了就关 —— 菜单是相对某一行展开的，
 * 行滚走了菜单还停在原处，只会点错。
 */
.menulayer {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
}

.menu {
  position: fixed;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  box-shadow: var(--shadow-md);
}

.menu__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 26px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  text-align: left;
  white-space: nowrap;
}

.menu__item:hover:not(:disabled),
.menu__item.is-open {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.menu__item:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.menu__item.is-danger:not(:disabled) {
  color: var(--color-danger);
}

.menu__item.is-danger:hover:not(:disabled) {
  background: var(--color-danger-subtle);
}

.menu__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  color: var(--color-text-tertiary);
}

.menu__item.is-danger .menu__icon {
  color: inherit;
}

.menu__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu__hint {
  flex: none;
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.menu__caret {
  flex: none;
  color: var(--color-text-tertiary);
}

.menu__divider {
  height: 1px;
  margin: 4px 2px;
  background: var(--color-border-subtle);
}
</style>
