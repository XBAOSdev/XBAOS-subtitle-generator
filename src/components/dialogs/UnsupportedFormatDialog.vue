<script setup lang="ts">
import { computed, ref } from 'vue'
import { useUiStore } from '@/stores/ui'
import { SUPPORTED_LABELS, unsupportedLabel } from '@/utils/formats'
import ModalDialog from './ModalDialog.vue'
import Icon from '@/components/Icon.vue'

interface RejectedItem {
  name: string
  ext: string
  reason: string
}

const ui = useUiStore()

const items = computed<RejectedItem[]>(
  () => (ui.dialogPayload.items as RejectedItem[] | undefined) ?? [],
)

const shown = computed(() => items.value.slice(0, 5))
const restCount = computed(() => Math.max(0, items.value.length - 5))

/** 取第一个文件的格式作为弹窗主讲格式 */
const mainFormat = computed(() =>
  items.value[0] ? unsupportedLabel(items.value[0].ext) : '该格式',
)

const mainReason = computed(
  () => items.value[0]?.reason ?? '本软件没有为它内置解码器',
)

const suppress = ref(false)

function close(): void {
  if (suppress.value) {
    ui.notify('info', '已关闭该格式的提示', '下次拖入相同格式将静默标记')
  }
  ui.closeDialog()
}

function openLocation(): void {
  ui.notify('info', '桌面版会定位到该文件', '当前为界面预览模式')
}
</script>

<template>
  <ModalDialog
    title="暂不支持该格式"
    subtitle="文件已保留在列表中，但不会进入识别队列"
    width="560px"
    :mask-closable="false"
    @close="close"
  >
    <div class="unsupported">
      <p class="unsupported__lead">
        该文件是 <strong>{{ mainFormat }}</strong> 格式，本软件未内置相应解码器。
      </p>

      <div class="unsupported__note">
        <span class="unsupported__note-icon">
          <Icon name="shield" :size="14" />
        </span>
        <div>
          <p class="unsupported__note-title">原因</p>
          <p class="unsupported__note-text">
            {{ mainReason }}。本软件只内置可自由分发的开源解码实现，故未提供支持。
          </p>
        </div>
      </div>

      <div class="unsupported__block">
        <p class="unsupported__block-title">解决办法</p>
        <p class="unsupported__block-text">
          请先用其他工具转换为下列格式，再导入本软件。
        </p>
        <ul class="unsupported__formats">
          <li v-for="label in SUPPORTED_LABELS" :key="label">{{ label }}</li>
        </ul>
        <p class="unsupported__tip">
          可先用任意音频格式转换工具，或用系统自带播放器导出为 MP3。
        </p>
      </div>

      <div v-if="items.length > 1" class="unsupported__list">
        <p class="unsupported__block-title">本次共 {{ items.length }} 个文件不支持</p>
        <ul>
          <li v-for="item in shown" :key="item.name" class="unsupported__row">
            <Icon name="ban" :size="13" />
            <span class="unsupported__row-name">{{ item.name }}</span>
            <span class="unsupported__row-ext">{{ unsupportedLabel(item.ext) }}</span>
          </li>
          <li v-if="restCount > 0" class="unsupported__row unsupported__row--muted">
            等另外 {{ restCount }} 个文件
          </li>
        </ul>
      </div>
    </div>

    <template #footer>
      <label class="checkbox">
        <input v-model="suppress" type="checkbox" />
        <span>不再提示此格式</span>
      </label>
      <span class="unsupported__spacer" />
      <button class="btn" type="button" @click="openLocation">打开文件所在位置</button>
      <button class="btn btn--primary" type="button" @click="close">知道了</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.unsupported {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.unsupported__lead {
  font-size: var(--font-size-base);
  line-height: var(--line-loose);
}

.unsupported__lead strong {
  color: var(--color-warning);
  font-weight: var(--weight-semibold);
}

.unsupported__note {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-info-border);
  border-radius: var(--radius-md);
  background: var(--color-info-subtle);
}

.unsupported__note-icon {
  margin-top: 1px;
  color: var(--color-info);
}

.unsupported__note-title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}

.unsupported__note-text {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}

.unsupported__block-title {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
}

.unsupported__block-text {
  margin-top: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.unsupported__formats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.unsupported__formats li {
  padding: 3px var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-bg-inset);
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
}

.unsupported__tip {
  margin-top: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.unsupported__list ul {
  margin-top: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.unsupported__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.unsupported__row + .unsupported__row {
  border-top: 1px solid var(--color-border-subtle);
}

.unsupported__row--muted {
  color: var(--color-text-tertiary);
  font-style: normal;
}

.unsupported__row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unsupported__row-ext {
  flex: none;
  color: var(--color-text-tertiary);
}

.unsupported__spacer {
  flex: 1;
}
</style>
