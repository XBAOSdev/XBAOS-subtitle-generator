<script setup lang="ts">
/**
 * 通知中心：标题栏右侧那个铃铛。
 *
 * 为什么要有它：弹出的通知现在最多 4 条、靠近就收，那**没看见的那一条**去哪了？
 * 不能凭「用户大概率不看」就真丢掉 —— 识别失败、保存失败这类事只有一次机会
 * 说明白。这里就是那些通知的去处，也是它们的唯一去处。
 *
 * 只记本次进程：关掉软件就清空。跨会话留一份「上次运行的通知」没有意义 ——
 * 用户重开软件时那些事已经过去了，留着只会让人以为它刚刚发生。
 *
 * 层级用 `--z-dropdown`：面板是标题栏的子元素，标题栏本身没有 z-index，
 * 面板要压住下面的内容区才不会只露一半。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useUiStore } from '@/stores/ui'
import Icon from '@/components/Icon.vue'

const ui = useUiStore()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

/** 倒序：最近发生的在最上面 */
const list = computed(() => [...ui.notices].reverse())

const iconOf = {
  info: 'info',
  success: 'check',
  warning: 'alert',
  error: 'alert',
} as const

/** 时刻精确到秒：通知的价值在「什么时候发生的」 */
function clockOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 点空白处收起。捕获阶段监听：面板里的滚动条、列表项都不该拦下这一下 */
function onDocPointerDown(event: PointerEvent): void {
  if (!open.value) return
  if (root.value?.contains(event.target as Node)) return
  open.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
}

/**
 * 开合面板。
 *
 * 展开时顺手收掉右上角那一列弹出的通知：两者占的是同一块地方，而面板里本来
 * 就是同样的内容（还更全），叠着显示只会互相盖住。
 *
 * 同时把当前最新一条记为已读，铃铛上的圆点随之消失 —— 用户已经"看到了"，
 * 点不点开都一样；再留着它闪，这个提示就失去了"有新东西"的意思。
 */
function toggle(): void {
  open.value = !open.value
  if (open.value) {
    ui.dismissAllToasts()
    ui.markNoticesSeen()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="root" class="notice">
    <button
      class="notice__btn"
      type="button"
      :title="`通知（本次运行 ${ui.notices.length} 条）`"
      aria-label="通知"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon name="bell" :size="15" />
      <span v-if="ui.noticeUnread" class="notice__dot" aria-hidden="true" />
    </button>

    <div v-if="open" class="notice__panel" role="dialog" aria-label="本次运行的通知">
      <p v-if="list.length === 0" class="notice__empty">本次运行没有通知</p>
      <ul v-else class="notice__list">
        <li v-for="item in list" :key="item.id" class="notice__item">
          <span class="notice__icon" :class="`notice__icon--${item.type}`">
            <Icon :name="iconOf[item.type]" :size="13" />
          </span>
          <div class="notice__body">
            <div class="notice__head">
              <span class="notice__title">{{ item.title }}</span>
              <span class="notice__time">{{ clockOf(item.at) }}</span>
            </div>
            <p v-if="item.message" class="notice__message">{{ item.message }}</p>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.notice {
  position: relative;
  /* 标题栏整条是拖动区，面板里的滚动与点击都必须排除掉 */
  -webkit-app-region: no-drag;
}

/*
 * 尺寸与标题栏其它图标按钮一致（42 × 标题栏高）。
 * 不复用 `.titlebar__btn`：那是 AppTitlebar 的 scoped 类，罩不到子组件内部。
 */
.notice__btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 42px;
  height: var(--titlebar-height);
  color: var(--color-text-secondary);
  transition: background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.notice__btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

/* 有未读就点一个小圆点：只提示「有东西」，不显示数字（数字会逼人去清零） */
.notice__dot {
  position: absolute;
  top: 8px;
  right: 10px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent);
}

.notice__panel {
  /*
   * 固定定位而不是挂在这个 42px 宽的小盒子上：
   * 铃铛右边还有窗口控制按钮，按 `.notice` 的右边缘对齐会让面板向右伸出去、
   * 盖住最小化/关闭那几个键，也离窗口边缘太远。钉在窗口右上角才是它该在的地方。
   */
  position: fixed;
  top: calc(var(--titlebar-height) - 1px);
  right: var(--space-3);
  z-index: var(--z-dropdown);
  width: 340px;
  max-height: min(60vh, 420px);
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-md);
}

.notice__empty {
  padding: var(--space-4) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  text-align: center;
}

.notice__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.notice__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
}

.notice__item:hover {
  background: var(--color-bg-hover);
}

.notice__icon {
  margin-top: 2px;
  color: var(--color-text-tertiary);
}

.notice__icon--success {
  color: var(--color-success);
}

.notice__icon--warning {
  color: var(--color-warning);
}

.notice__icon--error {
  color: var(--color-danger);
}

.notice__body {
  flex: 1;
  min-width: 0;
}

.notice__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.notice__title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

.notice__time {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.notice__message {
  margin-top: 2px;
  font-size: 11px;
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
  word-break: break-word;
}
</style>
