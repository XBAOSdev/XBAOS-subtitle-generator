<script setup lang="ts">
import { useUiStore } from '@/stores/ui'
import ModalDialog from './ModalDialog.vue'
import Icon from '@/components/Icon.vue'
import { SUPPORTED_FORMATS, UNSUPPORTED_FORMATS, type FormatSpec } from '@/utils/formats'

const ui = useUiStore()

/** 同一标签只展示一行（ogg 与 oga 合并） */
function dedupe(list: FormatSpec[]): FormatSpec[] {
  const seen = new Set<string>()
  return list.filter((item) => {
    if (seen.has(item.label)) return false
    seen.add(item.label)
    return true
  })
}

const supported = dedupe(SUPPORTED_FORMATS)
const unsupported = dedupe(UNSUPPORTED_FORMATS)

function close(): void {
  ui.closeDialog()
}
</script>

<template>
  <ModalDialog
    title="支持的音频格式"
    subtitle="解码全部由本机完成，不联网、不上传"
    width="640px"
    @close="close"
  >
    <div class="formats">
      <section>
        <h3 class="formats__title">
          <Icon name="check" :size="14" />
          <span>可以直接导入</span>
        </h3>
        <table class="formats__table">
          <thead>
            <tr>
              <th style="width: 90px">格式</th>
              <th style="width: 150px">解码实现</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in supported" :key="item.ext">
              <td class="formats__label">{{ item.label }}</td>
              <td class="mono formats__impl">{{ item.impl }}</td>
              <td>{{ item.note }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3 class="formats__title formats__title--muted">
          <Icon name="ban" :size="14" />
          <span>暂不支持</span>
        </h3>
        <table class="formats__table">
          <thead>
            <tr>
              <th style="width: 90px">格式</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in unsupported" :key="item.ext">
              <td class="formats__label formats__label--muted">{{ item.label }}</td>
              <td>{{ item.reason }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p class="formats__note">
        本软件的硬性原则是完全免费可商用，因此不内置任何<strong>需要付费授权</strong>的解码实现。
        支持的格式在上表里逐项写明了专利状态；不支持的格式中，AC3 与 EAC3 属于专利已到期、
        但本软件尚未内置解码器的情况，与专利风险无关。
        遇到不支持的格式，请先转换成上表中的任一格式。
      </p>
    </div>

    <template #footer>
      <button class="btn btn--primary" type="button" @click="close">知道了</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.formats {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.formats__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-success);
  margin-bottom: var(--space-2);
}

.formats__title--muted {
  color: var(--color-text-tertiary);
}

.formats__table {
  width: 100%;
  font-size: var(--font-size-xs);
}

.formats__table th {
  padding: var(--space-2);
  text-align: left;
  font-weight: var(--weight-medium);
  color: var(--color-text-tertiary);
  border-bottom: 1px solid var(--color-border);
}

.formats__table td {
  padding: var(--space-2);
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border-subtle);
}

.formats__label {
  font-weight: var(--weight-medium);
  color: var(--color-text-primary);
}

.formats__label--muted {
  color: var(--color-text-secondary);
}

.formats__impl {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.formats__note {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}
</style>
