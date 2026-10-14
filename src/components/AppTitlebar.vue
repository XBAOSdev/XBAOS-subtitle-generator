<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useI18n } from '@/composables/useI18n'
import { branding } from '@/branding'
import Icon from '@/components/Icon.vue'

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
  ui.notify('info', '浏览器预览模式下不可用', '窗口控制需要以桌面应用方式运行')
}

/**
 * 最大化/还原的图标要跟着实际窗口状态走。
 * 光靠点击时翻转本地变量是不行的 —— 用户还可以双击标题栏、
 * 拖到屏幕边缘触发贴靠，这些都绕过了按钮，只能由主进程回推。
 */
const isMaximized = ref(false)
let unsubscribeState: (() => void) | undefined

onMounted(() => {
  unsubscribeState = window.xbaos?.window?.onStateChange((state) => {
    isMaximized.value = state.maximized || state.fullScreen
  })
})

onUnmounted(() => unsubscribeState?.())
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
        class="titlebar__btn"
        type="button"
        :title="isMaximized ? '还原' : '最大化'"
        :aria-label="isMaximized ? '还原' : '最大化'"
        @click="windowControl('maximize')"
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

.titlebar__btn--close:hover {
  background: var(--color-danger);
  color: var(--color-text-inverse);
}

.titlebar__sep {
  width: 1px;
  height: 16px;
  margin: 0 var(--space-1);
  background: var(--color-border);
}
</style>
