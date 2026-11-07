<script setup lang="ts">
import { computed } from 'vue'
import { useUiStore, type ViewKey } from '@/stores/ui'
import { useProjectStore } from '@/stores/project'
import { useUpdateStore } from '@/stores/update'
import { useI18n } from '@/composables/useI18n'
import { appVersion } from '@/branding'
import Icon from '@/components/Icon.vue'

const ui = useUiStore()
const project = useProjectStore()
const update = useUpdateStore()
const { t } = useI18n()

interface NavItem {
  key: ViewKey
  icon: string
  label: string
  badge?: number
}

/**
 * 五个入口**都常驻可点**。
 *
 * 曾经「字幕工作台」在没有可编辑文件时是灰的（`disabled`）。那条规则在
 * 「第一批识别完成、又拖入第二批」时变成了纯障碍：项目里明明有字幕可看，
 * 却因为此刻正在识别而进不去 —— 按钮拿识别状态当了门槛，而用户要的恰恰是
 * 「一边识别一边翻已完成的那些」。有内容就显示内容，没内容就显示空态，
 * 这在任何时刻都是成立的。
 */
const items = computed<NavItem[]>(() => [
  {
    key: 'home',
    icon: 'import',
    label: t('nav.home'),
    // 角标是「还有几个没识别」，导入页才是排队的地方
    badge: project.pendingIntake.length || undefined,
  },
  {
    key: 'editor',
    icon: 'list',
    label: t('nav.editor'),
    // 角标报**全部项目**的子项目数：这一栏在界面最外层，说的是「整个软件里
    // 有多少条」。只看当前项目的话，切一下项目数字就变，且刚识别完的一批
    // 会顶掉原来的数，看起来像「新识别了几条」而不是「一共有几条」
    badge: project.allFiles || undefined,
  },
  { key: 'models', icon: 'cpu', label: t('nav.models') },
  { key: 'settings', icon: 'settings', label: t('nav.settings') },
  { key: 'about', icon: 'info', label: t('nav.about') },
])

function go(item: NavItem): void {
  ui.navigate(item.key)
}

/**
 * 左下角提示条的唯一动作。
 *
 *   有新版本 → 打开更新详情弹窗
 *   查不到   → 再查一次；查到了就直接把弹窗打开，省一次点击
 */
async function onUpdateClick(): Promise<void> {
  // 已经在提示新版本：直接看详情，不必再跑一次请求。
  // 这里用 hasUpdate 而不是 `phase === 'update'` —— 后者会让 TS 把 phase 收窄，
  // 下面那句 await 之后的同类比较就会被判成「不可能成立」。
  if (update.hasUpdate) {
    ui.openDialog('update')
    return
  }
  await update.check()
  if (update.phase === 'update') ui.openDialog('update')
  else if (update.phase === 'latest') ui.notify('success', '已是最新版本', `当前 v${update.current}`)
}
</script>

<template>
  <nav class="sidebar" aria-label="主导航">
    <ul class="sidebar__list">
      <li v-for="item in items" :key="item.key">
        <button
          class="sidebar__item"
          type="button"
          :class="{ 'is-active': ui.currentView === item.key }"
          :aria-current="ui.currentView === item.key ? 'page' : undefined"
          @click="go(item)"
        >
          <Icon :name="item.icon" :size="16" />
          <span class="sidebar__label">{{ item.label }}</span>
          <span v-if="item.badge" class="sidebar__badge">{{ item.badge }}</span>
        </button>
      </li>
    </ul>

    <div class="sidebar__foot">
      <!--
        更新提示。只在「有新版本」或「查不到」时出现 ——
        「已是最新」「还没查过」不该在侧边栏常驻占位置。
      -->
      <button
        v-if="update.hintLabel"
        class="sidebar__update"
        :class="{ 'is-error': update.phase === 'error' }"
        type="button"
        :title="update.phase === 'update' ? '查看这个版本更新了什么' : '点击重试'"
        @click="onUpdateClick"
      >
        <Icon :name="update.phase === 'update' ? 'download' : 'refresh'" :size="13" />
        <span class="sidebar__update-text">{{ update.hintLabel }}</span>
      </button>

      <div class="sidebar__meta">
        <span class="sidebar__version">v{{ appVersion }}</span>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border);
}

.sidebar__list {
  flex: 1;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar__item {
  width: 100%;
  height: 36px;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.sidebar__item:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.sidebar__item.is-active {
  background: var(--color-accent-subtle);
  color: var(--color-accent-text);
}

.sidebar__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__badge {
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-pill);
  background: var(--color-bg-subtle);
  color: var(--color-text-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.sidebar__item.is-active .sidebar__badge {
  background: var(--color-bg-surface);
  color: var(--color-accent-text);
}

.sidebar__foot {
  flex: none;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border-subtle);
}

/**
 * 更新提示条。
 *
 * 用 info 色系（本项目调色板里的中性灰蓝）而不是新造一个强调色 ——
 * 界面里唯一的彩色例外已经给了「AI 校对」，这里再插一个高饱和色会打乱整体。
 * 有真更新时用 primary 文字色加粗，靠字重而不是色相把注意力拉过来。
 */
.sidebar__update {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: 6px var(--space-2);
  border: 1px solid var(--color-info-border);
  border-radius: var(--radius-md);
  background: var(--color-info-subtle);
  color: var(--color-text-primary);
  font-size: 11px;
  font-weight: var(--weight-medium);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.sidebar__update:hover {
  border-color: var(--color-info);
  background: var(--color-bg-raised);
}

/* 查不到更新是「没成功」，不是「有事要做」—— 降一档，别抢视线 */
.sidebar__update.is-error {
  border-color: var(--color-border);
  background: var(--color-bg-inset);
  color: var(--color-text-tertiary);
  font-weight: var(--weight-regular);
}

.sidebar__update.is-error:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text-secondary);
}

.sidebar__update-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
