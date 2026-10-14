<script setup lang="ts">
import { computed } from 'vue'
import { useUiStore } from '@/stores/ui'
import { useUpdateStore } from '@/stores/update'
import ModalDialog from './ModalDialog.vue'
import Icon from '@/components/Icon.vue'

const ui = useUiStore()
const update = useUpdateStore()

/** 有清单给的官网就用它，否则退回内置品牌地址 */
const targetLabel = computed(() => {
  try {
    return new URL(update.targetUrl).host
  } catch {
    return update.targetUrl
  }
})

function close(): void {
  ui.closeDialog()
}

/** 「稍后再说」：收起侧边栏的提示条，本次运行内不再打扰（下次启动会重新提示） */
function later(): void {
  update.dismiss()
  close()
}

async function goDownload(): Promise<void> {
  const ok = await update.openTarget()
  if (!ok) {
    ui.notify('error', '打不开官网', '请手动在浏览器里访问 ' + update.targetUrl)
    return
  }
  update.dismiss()
  close()
}
</script>

<template>
  <ModalDialog
    title="发现新版本"
    :subtitle="`当前 v${update.current}，最新 v${update.latest}`"
    width="560px"
    @close="close"
  >
    <div class="update">
      <div class="update__head">
        <span class="update__mark" aria-hidden="true">
          <Icon name="download" :size="18" />
        </span>
        <div class="update__head-text">
          <p class="update__version">
            <span class="mono">v{{ update.latest }}</span>
            <span v-if="update.updated" class="update__date mono">{{ update.updated }}</span>
          </p>
          <p v-if="update.releaseTitle" class="update__title">{{ update.releaseTitle }}</p>
        </div>
      </div>

      <p v-if="update.highlight" class="update__lead">{{ update.highlight }}</p>

      <section v-if="update.notes.length > 0" class="update__block">
        <p class="update__block-title">这次更新了什么</p>
        <ul class="update__list">
          <li v-for="(line, index) in update.notes" :key="index">{{ line }}</li>
        </ul>
      </section>

      <p v-else class="update__lead">
        这一版没有附更新说明。可以到官网查看完整更新日志。
      </p>

      <div class="update__note">
        <Icon name="info" :size="14" />
        <span>
          {{ update.upgradeHint || '直接运行新版安装包覆盖安装即可，设置与已下载的模型都会保留。' }}
        </span>
      </div>

      <p class="update__where">
        安装包在官网
        <span class="mono">{{ targetLabel }}</span>
        上提供<template v-if="update.downloadLabel">（{{ update.downloadLabel }}）</template>。
      </p>
    </div>

    <template #footer>
      <button class="btn" type="button" @click="later">稍后再说</button>
      <button class="btn btn--primary" type="button" @click="goDownload">
        <Icon name="external" :size="13" />
        <span>前往官网更新</span>
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.update {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.update__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.update__mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: none;
  border: 1px solid var(--color-info-border);
  border-radius: var(--radius-lg);
  background: var(--color-info-subtle);
  color: var(--color-info);
}

.update__head-text {
  min-width: 0;
}

.update__version {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  font-size: var(--font-size-lg);
  font-weight: var(--weight-semibold);
}

.update__date {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-regular);
  color: var(--color-text-tertiary);
}

.update__title {
  margin-top: 2px;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.update__lead {
  font-size: var(--font-size-base);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}

.update__block-title {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
}

.update__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
  font-size: var(--font-size-sm);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}

.update__list li {
  position: relative;
  padding-left: var(--space-4);
}

.update__list li::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 8px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent);
}

.update__note {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}

.update__note > :first-child {
  flex: none;
  margin-top: 2px;
  color: var(--color-text-tertiary);
}

.update__where {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}
</style>
