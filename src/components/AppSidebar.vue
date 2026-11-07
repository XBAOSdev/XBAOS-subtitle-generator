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
  <nav class="sidebar" :class="{ 'is-collapsed': ui.sidebarCollapsed }" aria-label="主导航">
    <ul class="sidebar__list">
      <li v-for="item in items" :key="item.key">
        <button
          class="sidebar__item"
          type="button"
          :class="{ 'is-active': ui.currentView === item.key }"
          :aria-current="ui.currentView === item.key ? 'page' : undefined"
          :title="ui.sidebarCollapsed ? item.label : undefined"
          :data-badge="item.badge ? '1' : undefined"
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
        收起后只留图标（那里放不下一行字）。
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
        <!--
          收起 / 展开。放在版本号这一行：截图里用户圈的正是左下角那一带，
          而它也确实是「这一栏的开关」最该待的地方 —— 离栏本身近，离内容远。
        -->
        <button
          class="sidebar__collapse"
          type="button"
          :title="ui.sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
          :aria-label="ui.sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
          @click="ui.sidebarCollapsed = !ui.sidebarCollapsed"
        >
          <Icon :name="ui.sidebarCollapsed ? 'chevron-right' : 'chevron-left'" :size="13" />
        </button>

        <!-- 版本号：收起时淡出，位置让给开关本身 -->
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
  /*
   * 收起 / 展开走宽度过渡，配合下面各元素一起收 —— 单改宽度会看到文字先溢出、
   * 再被裁掉的错位感。`overflow: hidden` 是收窄过程中唯一能挡住文字的措施
   * （窄到 52px 时里面的 208px 宽的行本来就在外面）。
   */
  overflow: hidden;
  transition: width var(--dur-base) var(--ease-out);
}

.sidebar__list {
  flex: 1;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar__item {
  position: relative;
  width: 100%;
  height: 36px;
  display: flex;
  /* 单个图标时靠它居中；展开时标签 flex: 1 撑满，这条不起作用 */
  justify-content: center;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    padding var(--dur-base) var(--ease-out),
    gap var(--dur-base) var(--ease-out);
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
  /* 收起时靠 max-width 归零收掉（width 从 auto 到 0 不可过渡），同时淡出 */
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    max-width var(--dur-base) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
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
  transition:
    width var(--dur-base) var(--ease-out),
    padding var(--dur-base) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}

/*
 * 收起态用一个 6px 圆点代替数字角标：位置放不下数字，但「这儿有东西」要留记号。
 * 单独用伪元素而不是改角标本身 —— 从「行内胶囊」跳到「图标右上角」不是位置过渡
 * 能表达的，换一个元素纯淡入反而干净。
 */
.sidebar__item[data-badge]::after {
  content: '';
  position: absolute;
  top: 6px;
  right: 8px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
  pointer-events: none;
}

.sidebar.is-collapsed .sidebar__item[data-badge]::after {
  opacity: 1;
}

.sidebar__item.is-active .sidebar__badge {
  background: var(--color-bg-surface);
  color: var(--color-accent-text);
}

.sidebar__foot {
  flex: none;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border-subtle);
  transition: padding var(--dur-base) var(--ease-out);
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
  justify-content: center;
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
    border-color var(--dur-fast) var(--ease-out),
    padding var(--dur-base) var(--ease-out);
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
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    max-width var(--dur-base) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}

.sidebar__version {
  white-space: nowrap;
  overflow: hidden;
  max-width: 140px;
  transition:
    max-width var(--dur-base) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}

.sidebar__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.sidebar__collapse {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.sidebar__collapse:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

/* ---- 收起态：只留图标 ---- */
/*
 * 宽度压到只够放一个图标 + 两侧留白。标签、角标数字、版本号一起收掉，
 * 这一块就只剩「一列能点的图标」—— 要认是哪一个，靠 hover 的 title。
 *
 * 全部用 max-width / opacity / padding 过渡，不用 `display: none` ——
 * 后者是瞬时切换，宽度动画走到一半时会看到文字先凭空消失。
 */
.sidebar.is-collapsed {
  width: 52px;
}

.sidebar.is-collapsed .sidebar__item {
  padding: 0;
  gap: 0;
}

.sidebar.is-collapsed .sidebar__label {
  max-width: 0;
  opacity: 0;
}

.sidebar.is-collapsed .sidebar__badge {
  min-width: 0;
  width: 0;
  height: 0;
  padding: 0;
  opacity: 0;
  overflow: hidden;
  font-size: 0;
}

.sidebar.is-collapsed .sidebar__update-text,
.sidebar.is-collapsed .sidebar__version {
  max-width: 0;
  opacity: 0;
}

.sidebar.is-collapsed .sidebar__update {
  padding: 6px 0;
}

.sidebar.is-collapsed .sidebar__foot {
  padding: var(--space-3) var(--space-2);
}

.sidebar.is-collapsed .sidebar__meta {
  gap: var(--space-1);
}
</style>
