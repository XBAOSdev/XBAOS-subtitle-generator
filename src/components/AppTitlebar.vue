<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useI18n } from '@/composables/useI18n'
import { branding } from '@/branding'
import Icon from '@/components/Icon.vue'
import NoticeCenter from '@/components/NoticeCenter.vue'

const ui = useUiStore()
const settings = useSettingsStore()
const { t } = useI18n()
const { themeMode } = storeToRefs(settings)

const viewTitle = computed(() => t(`view.${ui.currentView}`))

const themeIcon = computed(() => {
  if (themeMode.value === 'light') return 'sun'
  if (themeMode.value === 'dark') return 'moon'
  return 'monitor'
})

const themeTitle = computed(() => {
  if (themeMode.value === 'light') return '浅色主题（点击切换）'
  if (themeMode.value === 'dark') return '深色主题（点击切换）'
  return '跟随系统（点击切换）'
})

function cycleTheme(): void {
  themeMode.value =
    themeMode.value === 'auto' ? 'light' : themeMode.value === 'light' ? 'dark' : 'auto'
}

function windowControl(action: 'minimize' | 'maximize' | 'close'): void {
  const api = window.xbaos
  if (api?.window) {
    api.window.control(action)
    return
  }
  ui.notify('info', '浏览器预览模式下不可用', '窗口控制仅在桌面应用中可用')
}

/**
 * 最大化/还原的图标要跟着实际窗口状态走。
 * 光靠点击时翻转本地变量是不行的 —— 用户还可以双击标题栏、
 * 拖到屏幕边缘触发贴靠，这些都绕过了按钮，只能由主进程回推。
 */
const isMaximized = ref(false)
const isFullScreen = ref(false)
let unsubscribeState: (() => void) | undefined

onMounted(() => {
  unsubscribeState = window.xbaos?.window?.onStateChange((state) => {
    isMaximized.value = state.maximized || state.fullScreen
    isFullScreen.value = !!state.fullScreen
    // 最大化 / 还原生效之后浮窗就该收了：用户刚刚点的是按钮，不是格子
    closeSnap()
  })
  document.addEventListener('pointermove', onSnapPointerMove)
  document.addEventListener('pointerdown', onSnapPointerMove, true)
  document.addEventListener('keydown', onSnapKeydown)
  window.addEventListener('blur', closeSnap)
})

onUnmounted(() => {
  unsubscribeState?.()
  document.removeEventListener('pointermove', onSnapPointerMove)
  document.removeEventListener('pointerdown', onSnapPointerMove, true)
  document.removeEventListener('keydown', onSnapKeydown)
  window.removeEventListener('blur', closeSnap)
  window.clearTimeout(snapTimer)
})

/* ---------------------------------------------------------------- 贴靠布局 */

/**
 * 贴靠布局浮窗。
 *
 * Windows 11 那个「悬停最大化按钮弹出六宫格、点一格把窗口贴到半屏」的浮窗，
 * 是**系统给原生标题栏按钮**画的效果。我们的窗口是 `frame: false` 自绘标题栏，
 * 没有原生按钮，系统永远不会替我们弹它 —— 想要这一下，只能自己画一个、
 * 自己算位置。位置计算放在主进程（屏幕工作区 / DPI / 多显示器只有它知道），
 * 这里只负责「弹出来、选中、传一个比例过去」。
 *
 * 交互上有两处不能照直觉写：
 *   ① **悬停 220ms 才弹**。不延迟的话，鼠标从主题按钮划到最小化会顺路扫过
 *      最大化，一路弹出又收起，比没有这个功能更烦人。
 *   ② **关闭走 document 的 pointermove 判坐标，不用 pointerleave**。面板是
 *      后出现在静止指针下面的元素，浏览器不会补发 enter/leave；而按钮与面板
 *      之间还隔着 6px，用 `mouseleave` 会在穿过的瞬间把它关掉。
 *      判据取「按钮 ∪ 面板」的并集矩形再外扩 6px —— 中间那条缝也就包含在内了。
 */
interface SnapCell {
  x: number
  y: number
  w: number
  h: number
}

interface SnapPreset {
  key: string
  label: string
  cells: SnapCell[]
}

/** 六种预设，坐标都是工作区的比例。顺序与 Windows 11 一致：由简到繁 */
const SNAP_PRESETS: SnapPreset[] = [
  {
    key: 'halves',
    label: '左右两分',
    cells: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
  },
  {
    key: 'third-two',
    label: '左边三分之一，右边两格',
    cells: [
      { x: 0, y: 0, w: 0.34, h: 1 },
      { x: 0.34, y: 0, w: 0.66, h: 0.5 },
      { x: 0.34, y: 0.5, w: 0.66, h: 0.5 },
    ],
  },
  {
    key: 'two-third',
    label: '左边两格，右边三分之二',
    cells: [
      { x: 0, y: 0, w: 0.66, h: 0.5 },
      { x: 0, y: 0.5, w: 0.66, h: 0.5 },
      { x: 0.66, y: 0, w: 0.34, h: 1 },
    ],
  },
  {
    key: 'thirds',
    label: '三等分',
    cells: [
      { x: 0, y: 0, w: 0.34, h: 1 },
      { x: 0.34, y: 0, w: 0.33, h: 1 },
      { x: 0.67, y: 0, w: 0.33, h: 1 },
    ],
  },
  {
    key: 'quarters',
    label: '四宫格',
    cells: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    key: 'thirds-half',
    label: '左边三等分，右边上下两格',
    cells: [
      { x: 0, y: 0, w: 0.34, h: 1 },
      { x: 0.34, y: 0, w: 0.33, h: 1 },
      { x: 0.67, y: 0, w: 0.33, h: 0.5 },
      { x: 0.67, y: 0.5, w: 0.33, h: 0.5 },
    ],
  },
]

const snapOpen = ref(false)
const snapPanel = ref<HTMLElement | null>(null)
const snapButton = ref<HTMLElement | null>(null)
/** 悬停延迟计时器；0 表示没有在计时 */
let snapTimer = 0

/** 浏览器预览没有桥，也就不该弹一个点了没反应的浮窗 */
function canSnap(): boolean {
  return typeof window.xbaos?.window?.snap === 'function'
}

function scheduleSnap(): void {
  if (snapOpen.value) return
  if (!canSnap() || isFullScreen.value) return
  window.clearTimeout(snapTimer)
  snapTimer = window.setTimeout(() => {
    snapTimer = 0
    snapOpen.value = true
  }, 220)
}

function closeSnap(): void {
  window.clearTimeout(snapTimer)
  snapTimer = 0
  snapOpen.value = false
}

function applySnap(cell: SnapCell): void {
  closeSnap()
  window.xbaos?.window?.snap(cell)
}

function onSnapPointerMove(event: PointerEvent): void {
  // 指针在按钮或面板里：什么都不做（面板开着就继续开着）
  if (snapButton.value?.contains(event.target as Node)) return
  if (snapPanel.value?.contains(event.target as Node)) return

  if (!snapOpen.value && !snapTimer) return
  if (snapOpen.value && insideSnapZone(event.clientX, event.clientY)) return

  closeSnap()
}

/** 「按钮 ∪ 面板」外扩 6px：按钮与面板之间那条缝不能让面板中途关掉 */
function insideSnapZone(x: number, y: number): boolean {
  const rects: DOMRect[] = []
  const b = snapButton.value?.getBoundingClientRect()
  const p = snapPanel.value?.getBoundingClientRect()
  if (b) rects.push(b)
  if (p) rects.push(p)
  if (rects.length === 0) return false
  const pad = 6
  const left = Math.min(...rects.map((r) => r.left)) - pad
  const right = Math.max(...rects.map((r) => r.right)) + pad
  const top = Math.min(...rects.map((r) => r.top)) - pad
  const bottom = Math.max(...rects.map((r) => r.bottom)) + pad
  return x >= left && x <= right && y >= top && y <= bottom
}

function onSnapKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && snapOpen.value) closeSnap()
}

/** 单元格的定位样式：比例摆到绝对定位的盒子上 */
function cellStyle(cell: SnapCell): Record<string, string> {
  return {
    left: `${cell.x * 100}%`,
    top: `${cell.y * 100}%`,
    width: `${cell.w * 100}%`,
    height: `${cell.h * 100}%`,
  }
}
</script>

<template>
  <header class="titlebar">
    <div class="titlebar__brand">
      <span class="titlebar__mark" aria-hidden="true">
        <!-- 品牌图标缩微版：五柱黄金分割双色 + 三色字幕条，全部直角 -->
        <svg viewBox="0 0 20 20" width="16" height="16">
          <rect x="1.2" y="9" width="2.4" height="2.3" fill="#F2EADB" />
          <rect x="1.2" y="11.3" width="2.4" height="3.7" fill="#4A7BA6" />
          <rect x="5" y="6" width="2.4" height="3.4" fill="#C08A5F" />
          <rect x="5" y="9.4" width="2.4" height="5.6" fill="#4A7BA6" />
          <rect x="8.8" y="3.8" width="2.4" height="4.2" fill="#F2EADB" />
          <rect x="8.8" y="8" width="2.4" height="7" fill="#4A7BA6" />
          <rect x="12.6" y="7" width="2.4" height="3.1" fill="#C08A5F" />
          <rect x="12.6" y="10.1" width="2.4" height="4.9" fill="#4A7BA6" />
          <rect x="16.4" y="10" width="2.4" height="1.9" fill="#F2EADB" />
          <rect x="16.4" y="11.9" width="2.4" height="3.1" fill="#4A7BA6" />
          <rect x="1.2" y="17.2" width="9.9" height="1.6" fill="#4A7BA6" />
          <rect x="11.9" y="17.2" width="3.8" height="1.6" fill="#F2EADB" />
          <rect x="16.5" y="17.2" width="2.3" height="1.6" fill="#C08A5F" />
        </svg>
      </span>
      <span class="titlebar__name">{{ branding.productName }}</span>
    </div>

    <div class="titlebar__center">
      <span class="titlebar__view">{{ viewTitle }}</span>
    </div>

    <div class="titlebar__right">
      <button
        class="titlebar__btn"
        type="button"
        :title="themeTitle"
        :aria-label="themeTitle"
        @click="cycleTheme"
      >
        <Icon :name="themeIcon" :size="15" />
      </button>

      <!-- 通知中心：弹出的通知最多 4 条、靠近就收，看不见的那些在这里 -->
      <NoticeCenter />

      <span class="titlebar__sep" aria-hidden="true" />

      <button
        class="titlebar__btn"
        type="button"
        title="最小化"
        aria-label="最小化"
        @click="windowControl('minimize')"
      >
        <Icon name="window-min" :size="15" />
      </button>
      <button
        ref="snapButton"
        class="titlebar__btn"
        type="button"
        :title="isMaximized ? '还原' : '最大化'"
        :aria-label="isMaximized ? '还原' : '最大化'"
        @click="windowControl('maximize')"
        @pointerenter="scheduleSnap"
      >
        <Icon :name="isMaximized ? 'window-restore' : 'window-max'" :size="15" />
      </button>
      <button
        class="titlebar__btn titlebar__btn--close"
        type="button"
        title="关闭"
        aria-label="关闭"
        @click="windowControl('close')"
      >
        <Icon name="x" :size="15" />
      </button>
    </div>

    <!-- 贴靠布局浮窗：悬停最大化 220ms 后出现，点一格把窗口贴过去 -->
    <div
      v-if="snapOpen"
      ref="snapPanel"
      class="snap"
      role="dialog"
      aria-label="贴靠布局"
    >
      <div
        v-for="preset in SNAP_PRESETS"
        :key="preset.key"
        class="snap__preset"
        role="group"
        :aria-label="preset.label"
      >
        <!-- 每一格自己是一个按钮：点击区就是那格，标题给读屏与悬停提示 -->
        <button
          v-for="(cell, index) in preset.cells"
          :key="index"
          class="snap__cell"
          type="button"
          :style="cellStyle(cell)"
          :title="preset.label"
          :aria-label="preset.label"
          @click="applySnap(cell)"
        />
      </div>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-height);
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-left: var(--space-4);
  background: var(--color-bg-surface);
  border-bottom: 1px solid var(--color-border);
  user-select: none;
  /* 无边框窗口靠这个区域拖动。设了 drag 之后 Electron 会自动支持
     双击最大化、拖到屏幕边缘贴靠，不用自己写鼠标事件 */
  -webkit-app-region: drag;
}

/* 按钮必须显式排除，否则点不动 —— 拖动区域会吞掉鼠标事件 */
.titlebar__btn {
  -webkit-app-region: no-drag;
}

.titlebar__brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 190px;
}

.titlebar__mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  /* 品牌深灰底：固定色，保证米白/陶土块在深浅两套主题下都清晰 */
  background: #2e3236;
  border-radius: var(--radius-sm);
}

.titlebar__name {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.titlebar__center {
  flex: 1;
  display: flex;
  justify-content: center;
  min-width: 0;
}

.titlebar__view {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.titlebar__right {
  display: flex;
  align-items: center;
  height: 100%;
}

.titlebar__btn {
  display: grid;
  place-items: center;
  width: 42px;
  height: var(--titlebar-height);
  color: var(--color-text-secondary);
  transition: background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.titlebar__btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

/*
 * 关闭键的悬停底色固定用系统那一档深红 + 白色叉号。
 * 不用 `--color-text-inverse`：深色主题里那是「近黑」，压在红底上几乎看不见。
 */
.titlebar__btn--close:hover {
  background: var(--color-window-close, #c42b1c);
  color: #fff;
}

.titlebar__sep {
  width: 1px;
  height: 16px;
  margin: 0 var(--space-1);
  background: var(--color-border);
}

/* ---------------------------------------------------------------- 贴靠布局 */

/*
 * 面板挂在窗口右上角、标题栏下面，右边缘对齐最大化键的左沿再让 8px ——
 * 系统那个浮窗也是贴在按钮下方偏左的位置，不是正中。
 */
.snap {
  position: fixed;
  top: calc(var(--titlebar-height) + 4px);
  right: 34px;
  z-index: var(--z-dropdown);
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  width: 424px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-md);
  -webkit-app-region: no-drag;
}

.snap__preset {
  position: relative;
  height: 74px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-base);
}

/*
 * 单元格绝对定位、四周留 3px：并排的两格之间才有缝，看得出是两块。
 * 用 padding 而不是给每个格缩尺寸 —— 比例是算出来的，再减去固定像素会让
 * 三等分不再等分。
 */
.snap__cell {
  position: absolute;
  padding: 3px;
  box-sizing: border-box;
}

.snap__cell::after {
  content: '';
  display: block;
  width: 100%;
  height: 100%;
  border: 1px solid var(--color-border-strong);
  border-radius: 3px;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

/*
 * 悬停用半透明叠加（`--color-accent-subtle` 就是 8% 的白），不是实心浅灰：
 * 实心会把格子填成一块白板，看不出「这格多大、旁边还剩多少」。
 */
.snap__cell:hover::after,
.snap__cell:focus-visible::after {
  background: var(--color-accent-subtle);
  border-color: var(--color-accent-border);
}
</style>
