<script setup lang="ts">
/**
 * 用户协议 / 隐私政策的查看窗口。
 *
 * 两份文件共用这一个组件（正文来自 `src/legal/index.ts`），差别只有 `doc` 参数。
 * 做成弹窗而不是独立页面：协议是「要用到的时候翻一下」的参考材料，
 * 不该在图省事的侧栏里再占一格。
 */
import { computed } from 'vue'
import { useUiStore } from '@/stores/ui'
import { LEGAL_DOCS, type LegalKey } from '@/legal'
import ModalDialog from '@/components/dialogs/ModalDialog.vue'

const ui = useUiStore()

const doc = computed(() => {
  const key = ui.dialogPayload.doc
  return LEGAL_DOCS[(typeof key === 'string' ? key : 'terms') as LegalKey] ?? LEGAL_DOCS.terms
})
</script>

<template>
  <ModalDialog :title="doc.title" :subtitle="doc.subtitle" width="680px" @close="ui.closeDialog()">
    <article class="legal">
      <section v-for="(sec, i) in doc.sections" :key="i" class="legal__sec">
        <h3 class="legal__h">{{ sec.heading }}</h3>

        <p v-for="(p, j) in sec.paragraphs ?? []" :key="`p${j}`" class="legal__p">{{ p }}</p>

        <ul v-if="sec.list" class="legal__ul">
          <li v-for="(item, j) in sec.list" :key="`l${j}`">{{ item }}</li>
        </ul>

        <div v-if="sec.table" class="legal__tablewrap">
          <table class="legal__table">
            <thead>
              <tr>
                <th v-for="(h, j) in sec.table.head" :key="`h${j}`">{{ h }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, j) in sec.table.rows" :key="`r${j}`">
                <td v-for="(cell, k) in row" :key="`c${k}`">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </article>

    <template #footer>
      <button class="btn" type="button" @click="ui.closeDialog()">关闭</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
/**
 * 协议正文**必须能选中复制**。
 *
 * 全局有 `html, body, #app { user-select: none }`（界面文字选中只会显得像网页），
 * 这里要显式放行 —— 摘录一段发给别人、或者存一份留档，是正经需求。
 */
.legal {
  user-select: text;
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}

.legal__sec + .legal__sec {
  margin-top: var(--space-5);
}

.legal__h {
  margin-bottom: var(--space-2);
  font-size: var(--font-size-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

.legal__p + .legal__p {
  margin-top: var(--space-2);
}

.legal__p {
  /* 协议是长文，段首缩进两格比加空行更像文件、也更好读 */
  text-indent: 2em;
}

.legal__ul {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.legal__ul li {
  position: relative;
  padding-left: var(--space-4);
}

.legal__ul li::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 8px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent);
}

/* ---- 联网功能对照表 ---- */

.legal__tablewrap {
  margin-top: var(--space-3);
  /* 窄窗口下横向滚动，而不是把字挤成竖排 */
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.legal__table {
  width: 100%;
  min-width: 520px;
  border-collapse: collapse;
}

.legal__table th,
.legal__table td {
  padding: 6px var(--space-3);
  text-align: left;
  vertical-align: top;
  line-height: var(--line-base);
}

.legal__table th {
  font-size: 11px;
  font-weight: var(--weight-semibold);
  color: var(--color-text-tertiary);
  background: var(--color-bg-inset);
  white-space: nowrap;
}

.legal__table td {
  border-top: 1px solid var(--color-border-subtle);
}

.legal__table td:first-child {
  white-space: nowrap;
  color: var(--color-text-primary);
}
</style>
