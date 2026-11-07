<script setup lang="ts">
/**
 * 内置词表查看器（只读）。
 *
 * 为什么要给用户看：自动断行会把切点放在词边界上，用户遇到「这里切得不对」
 * 时，最想知道的是「软件到底认哪些词」。看不见就只能猜，还会误以为是识别错了。
 *
 * 这里**只能看不能改**：常用词库是随版本发布的通用数据，领域词库的 core /
 * extended 还要发给识别引擎当提示词，开放编辑会同时影响转录结果与提示词预算。
 * 用户自己的词应该加到导入页的「领域词」里，那条通道才是留给用户的。
 */
import { computed, ref } from 'vue'
import { COMMON_WORDS, COMMON_WORD_GROUPS } from '@/data/commonWords'
import { LEXICONS } from '@/data/lexicons'
import { useSettingsStore } from '@/stores/settings'
import Icon from '@/components/Icon.vue'
import ModalDialog from './ModalDialog.vue'

const emit = defineEmits<{ close: [] }>()

const settings = useSettingsStore()

/** 这套领域词库当前有没有被勾选 —— 直接决定这些词现在参不参与断句 */
const isChecked = (id: string): boolean => settings.lexiconIds.includes(id)

interface WordSection {
  label: string
  note: string
  words: readonly string[]
}

interface WordTab {
  id: string
  label: string
  intro: string
  count: number
  sections: WordSection[]
}

const TABS: WordTab[] = [
  {
    id: 'common',
    label: '常用词库',
    intro:
      '断行时始终生效，与勾选的领域词库无关。按语类分组，共 ' +
      `${COMMON_WORDS.length} 词。仅参与切点判断，不会发送给识别引擎。`,
    count: COMMON_WORDS.length,
    sections: COMMON_WORD_GROUPS.map((g) => ({
      label: g.label,
      // 常用词库整份都只用于断句，每节重复同一句说明纯属噪音，留空
      note: '',
      words: g.words,
    })),
  },
  ...LEXICONS.map<WordTab>((lexicon) => {
    const wrapWords = lexicon.wrapWords ?? []
    return {
      id: lexicon.id,
      label: lexicon.name,
      intro:
        `${lexicon.note}。勾选这个词库后：核心词恒定注入提示词，` +
        `扩展词在深度模式下按本段音频实际出现的词精选后注入，断句专用词只参与断行。`,
      count: lexicon.core.length + lexicon.extended.length + wrapWords.length,
      sections: [
        { label: '核心词', note: '进提示词', words: lexicon.core },
        { label: '扩展词', note: '深度模式精选后进提示词', words: lexicon.extended },
        ...(wrapWords.length > 0
          ? [{ label: '断句专用词', note: '只参与断行', words: wrapWords }]
          : []),
      ],
    }
  }),
]

const activeId = ref(TABS[0].id)
const query = ref('')

const active = computed(() => TABS.find((t) => t.id === activeId.value) ?? TABS[0])

/** 过滤后的分组：空组直接不显示，免得留一堆空标题 */
const filtered = computed<WordSection[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return active.value.sections
  return active.value.sections
    .map((s) => ({ ...s, words: s.words.filter((w) => w.toLowerCase().includes(q)) }))
    .filter((s) => s.words.length > 0)
})

const matchedCount = computed(() =>
  filtered.value.reduce((sum, s) => sum + s.words.length, 0),
)
</script>

<template>
  <ModalDialog
    title="内置词表"
    subtitle="只读。这些词决定自动断行把切点放在哪里，不改动识别出的文字。"
    width="760px"
    @close="emit('close')"
  >
    <div class="wb">
      <div class="wb__tabs">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="wb__tab"
          :class="{ 'is-active': tab.id === activeId }"
          type="button"
          @click="activeId = tab.id"
        >
          <span>{{ tab.label }}</span>
          <span class="wb__tab-num">{{ tab.count }}</span>
        </button>
      </div>

      <div class="wb__bar">
        <div class="wb__search">
          <Icon name="search" :size="13" class="wb__search-icon" />
          <input
            v-model="query"
            class="wb__search-input"
            type="text"
            :placeholder="`在「${active.label}」里查找`"
            spellcheck="false"
          />
          <button
            v-if="query"
            class="wb__search-clear"
            type="button"
            aria-label="清空"
            @click="query = ''"
          >
            <Icon name="x" :size="12" />
          </button>
        </div>
        <span v-if="activeId !== 'common'" class="wb__state" :class="{ 'is-on': isChecked(activeId) }">
          {{ isChecked(activeId) ? '已勾选，参与断句' : '未勾选，暂不生效' }}
        </span>
        <span class="wb__count">
          {{ query.trim() ? `命中 ${matchedCount} / ${active.count} 词` : `共 ${active.count} 词` }}
        </span>
      </div>

      <p class="wb__intro">{{ active.intro }}</p>

      <div class="wb__body scroll-y">
        <p v-if="filtered.length === 0" class="wb__empty">没有匹配的词条</p>

        <section v-for="section in filtered" :key="section.label" class="wb__section">
          <div class="wb__section-head">
            <span class="wb__section-title">{{ section.label }}</span>
            <span v-if="section.note" class="wb__section-note">{{ section.note }}</span>
            <span class="wb__section-num">{{ section.words.length }}</span>
          </div>
          <div class="wb__words">
            <span v-for="word in section.words" :key="word" class="wb__word">{{ word }}</span>
          </div>
        </section>
      </div>
    </div>

    <template #footer>
      <div class="wb__foot">
        <span class="wb__foot-note">
          内置词表随版本提供，不可修改。自定义词请添加到导入页识别设置中的「领域词」。
        </span>
        <button class="btn" type="button" @click="emit('close')">关闭</button>
      </div>
    </template>
  </ModalDialog>
</template>

<style scoped>
.wb {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: var(--space-3);
}

.wb__tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
  overflow-x: auto;
}

.wb__tab {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-3);
  height: 30px;
  border-radius: calc(var(--radius-md) - 2px);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  transition: color var(--dur-fast) var(--ease-out);
}

.wb__tab:hover {
  color: var(--color-text-primary);
}

/* 选中态与左侧分组导航一致：填充 + 描边，不靠字重 */
.wb__tab.is-active {
  background: var(--color-accent-subtle);
  box-shadow: inset 0 0 0 1px var(--color-accent-border);
  color: var(--color-text-primary);
  font-weight: var(--weight-medium);
}

.wb__tab-num {
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.wb__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.wb__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  height: var(--control-height-sm);
  padding: 0 var(--space-2) 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.wb__search:focus-within {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-subtle);
}

.wb__search-icon {
  flex: none;
  color: var(--color-text-tertiary);
}

.wb__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
}

.wb__search-input:focus {
  outline: none;
}

.wb__search-input::placeholder {
  color: var(--color-text-tertiary);
}

.wb__search-clear {
  flex: none;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  color: var(--color-text-tertiary);
}

.wb__search-clear:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.wb__count {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 领域词库的勾选状态：只改颜色深浅，不用红绿 —— 这不是错误提示 */
.wb__state {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 999px;
  background: var(--color-bg-inset);
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.wb__state.is-on {
  border-color: var(--color-accent-border);
  color: var(--color-text-secondary);
}

.wb__intro {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

/* 词条区可以很长（常用词库近千条），限制高度内部滚动，弹窗本身不再往下长 */
.wb__body {
  max-height: 46vh;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-right: var(--space-1);
}

.wb__empty {
  padding: var(--space-6) 0;
  text-align: center;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.wb__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.wb__section-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.wb__section-title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}

.wb__section-note {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.wb__section-num {
  margin-left: auto;
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.wb__words {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
}

.wb__word {
  padding: 2px 7px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  user-select: text;
}

.wb__foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
}

.wb__foot-note {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.wb__foot .btn {
  flex-shrink: 0;
}
</style>
