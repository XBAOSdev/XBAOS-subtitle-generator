<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useHistoryStore } from '@/stores/history'
import { useEditorStore } from '@/stores/editor'
import Icon from '@/components/Icon.vue'
import { applyReplaceRules, parseReplaceDict } from '@/utils/dictReplace'
import { applyLineWrap } from '@/utils/lineWrap'
import { buildWrapWords } from '@/utils/wrapWords'
import { SOURCE_SLOT, otherSlotsWithText } from '@/utils/segmentOps'
import type { SubtitleSegment } from '@/types'

const project = useProjectStore()
const ui = useUiStore()
const settings = useSettingsStore()
const history = useHistoryStore()
const editor = useEditorStore()

/**
 * 原文被工具改过之后，把该条目各语言的译文转回「待确认」。
 *
 * 这些工具只动 `text`，译文会原封不动地留着 —— 那恰恰是最危险的情形：文本
 * 看着还在，内容却已经和原文对不上了，而界面上毫无差别。标红让用户知道
 * 哪几条需要重新核对。本来就没有译文的条目不受影响。
 *
 * 就地改（工具本身就是就地改 `segment.text` 的），所以不返回新对象。
 * `segmentOps.markTranslationsStale` 是同一语义的纯函数版，供不入增量改动的
 * 调用点使用。
 */
function flagTranslations(segment: SubtitleSegment): void {
  const extra = otherSlotsWithText(segment, SOURCE_SLOT)
  if (extra.length === 0) return
  segment.staleSlots = [...new Set([...(segment.staleSlots ?? []), ...extra])]
}

interface ToolItem {
  key: string
  icon: string
  label: string
  hint: string
}

const TOOLS: ToolItem[] = [
  { key: 'gap', icon: 'wand', label: '填充空隙', hint: '让相邻字幕之间不留空隙' },
  { key: 'offset', icon: 'shift', label: '整体偏移', hint: '全部时间码一起前后平移' },
  { key: 'find', icon: 'replace', label: '查找替换', hint: '逐处查找定位，或一次替换全部' },
  { key: 'rewrap', icon: 'type', label: '重新断行', hint: '按当前字数上限重排换行' },
  { key: 'punct', icon: 'spell-check', label: '标点规范', hint: '统一中英文标点与空格' },
  { key: 'dict', icon: 'book', label: '词表替换', hint: '用自定义词表批量纠错' },
]

const offsetOpen = ref(false)
const offsetValue = ref(-0.5)

const findOpen = ref(false)
const findText = ref('')
const replaceText = ref('')
/** 查找范围。合并模式下只有一条拼接产物，这个开关不出现，始终按当前文件走 */
const findScope = ref<'file' | 'all'>('file')
/** 当前停在第几处匹配（从 0 起） */
const matchIndex = ref(0)

/**
 * Ctrl+H 打开查找替换。
 *
 * 它在本项目里**不是弹窗**，而是右侧工具面板里的一块展开区（与「整体偏移」
 * 共用同一个位置）—— 查找替换要一边看字幕一边用，弹窗正好挡住正文。
 * 所以这里把「请求打开对话框」翻译成「展开这块面板」，顺带把偏移面板收起来。
 * （在此之前 `openDialog('find-replace')` 指向一个不存在的弹窗组件，
 * 按 Ctrl+H 什么都不会发生。）
 */
watch(
  () => ui.dialog,
  (key) => {
    if (key !== 'find-replace') return
    findOpen.value = true
    offsetOpen.value = false
    ui.closeDialog()
  },
  { immediate: true },
)

const activeFile = computed(() => project.viewFile)
const disabled = computed(() => !activeFile.value)

/*
 * 撤销 / 重做不在这里。
 *
 * 它们搬到了表格工具栏：那是「正在改字幕」的地方，手和眼都在那张表上，
 * 不必横跨到右侧栏。侧栏这两格让给工具与 AI 入口。
 */

function run(tool: ToolItem): void {
  if (disabled.value) return

  switch (tool.key) {
    case 'gap':
      ui.openDialog('gap-fill')
      break
    case 'offset':
      offsetOpen.value = !offsetOpen.value
      findOpen.value = false
      break
    case 'find':
      findOpen.value = !findOpen.value
      offsetOpen.value = false
      break
    case 'rewrap':
      rewrap()
      break
    case 'punct':
      normalizePunctuation()
      break
    case 'dict':
      applyDictReplace()
      break
  }
}

function applyOffset(): void {
  const file = activeFile.value
  if (!file) return
  const delta = Number(offsetValue.value)
  if (!Number.isFinite(delta) || delta === 0) return

  // 会改字幕条目的地方都必须走 history，撤回才完整。这几个工具以前是直接
  // 改数据，撤回栈里根本没有它们 —— 用户按 Ctrl+Z 会跳过这一步撤到更早的
  // 操作，看起来就像「撤销撤错了位置」。
  const applied = history.commitIfChanged(file.id, () => file.segments, '整体偏移', () => {
    file.segments = file.segments.map((segment) => ({
      ...segment,
      start: Math.max(0, Number((segment.start + delta).toFixed(3))),
      end: Math.max(0, Number((segment.end + delta).toFixed(3))),
    }))
  })

  ui.notify(
    applied ? 'success' : 'info',
    applied ? `已整体偏移 ${delta > 0 ? '+' : ''}${delta.toFixed(2)} 秒` : '时间码没有变化',
    file.name,
  )
  offsetOpen.value = false
}

/* --------------------------------------------------------- 查找与替换 */

/**
 * 查找与替换**分成两件事**。
 *
 * 原先只有一个「替换全部」：想改一处就得先替换全部再手工改回来，或者干脆
 * 不用这个工具去表格里手动找。「查找」和「替换」本来就是两种意图 ——
 * 前者只想定位（核对、听一遍、改别的），后者才动数据。所以这里给出一组
 * 明确的动作：上一个 / 下一个只跳不写，「替换」只动当前这一处，
 * 「全部替换」才是整批。
 *
 * 匹配按**出现次数**算，不是按字幕条数：一条字幕里同一个词出现两次时，
 * 「下一个」应该能分别停在这两处，否则用户没法确认第二处要不要改。
 */

interface FindMatch {
  fileId: string
  fileName: string
  segId: string
  /** 在这条字幕里是第几次出现（从 1 起） */
  nth: number
}

/** 一段文本里 `needle` 全部出现的位置 */
function offsetsOf(text: string, needle: string): number[] {
  const out: number[] = []
  if (!needle) return out
  let from = 0
  while (from <= text.length) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    out.push(at)
    from = at + needle.length
  }
  return out
}

/** 本次查找覆盖哪些文件 */
const scopeFiles = computed(() => {
  if (findScope.value === 'all' && !project.isMerge) return project.supportedFiles
  return activeFile.value ? [activeFile.value] : []
})

const matches = computed<FindMatch[]>(() => {
  const needle = findText.value
  if (!needle) return []
  const out: FindMatch[] = []
  for (const file of scopeFiles.value) {
    for (const segment of file.segments) {
      const total = offsetsOf(segment.text, needle).length
      for (let nth = 1; nth <= total; nth += 1) {
        out.push({ fileId: file.id, fileName: file.name, segId: segment.id, nth })
      }
    }
  }
  return out
})

/** 换词或换范围之后，原来的位置已经没有意义了，回到第一处 */
watch(findText, () => {
  matchIndex.value = 0
})
watch(findScope, () => {
  matchIndex.value = 0
})

/** 「第 3 / 12 处 · 文件名」。跨文件查找时文件名是必需的，否则用户不知道跳到了哪儿 */
const matchLabel = computed(() => {
  if (!findText.value) return ''
  const total = matches.value.length
  if (total === 0) return '没有匹配'
  const at = Math.min(matchIndex.value, total - 1)
  const current = matches.value[at]
  const pos = `第 ${at + 1} / ${total} 处`
  return findScope.value === 'all' && current ? `${pos} ｜ ${current.fileName}` : pos
})

/**
 * 跳到第 `index` 处（循环）。
 *
 * 跨文件时顺带把当前文件切过去 —— 匹配在别的文件里却停在原地不动，
 * 用户看到的是「点了没反应」。
 */
function goTo(index: number): void {
  const list = matches.value
  if (list.length === 0) {
    ui.notify(
      'info',
      '没有找到匹配内容',
      findScope.value === 'all' ? `已查过 ${scopeFiles.value.length} 个文件` : activeFile.value?.name,
    )
    return
  }
  const at = ((index % list.length) + list.length) % list.length
  matchIndex.value = at
  const match = list[at]
  if (project.viewFileId !== match.fileId) project.setActiveFile(match.fileId)
  const segment = project.viewFile?.segments.find((s) => s.id === match.segId)
  if (!segment) return
  editor.setSelection([match.segId])
  // 跳到匹配处要顺带把播放头也挪过去：这条多半是要听一遍确认的
  editor.setPlayhead(segment.start)
}

/** 只替换当前停的这一处 */
function replaceOne(): void {
  const needle = findText.value
  const list = matches.value
  if (!needle || list.length === 0) return
  const match = list[Math.min(matchIndex.value, list.length - 1)]
  // 匹配是在 `scopeFiles` 上算的，找文件也必须回到同一个集合：项目视图的 id
  // 是 `__merged__`，`project.files` 里根本没有这一条 —— 用 files 查会永远查不到，
  // 「替换」按下去什么都不发生（而且不报错）
  const file = scopeFiles.value.find((f) => f.id === match.fileId)
  const segment = file?.segments.find((s) => s.id === match.segId)
  if (!file || !segment) return

  const at = offsetsOf(segment.text, needle)[match.nth - 1]
  if (at === undefined) return

  const applied = history.commitIfChanged(file.id, () => file.segments, '替换当前一处', () => {
    file.segments = file.segments.map((s) => {
      if (s.id !== match.segId) return s
      const target = {
        ...s,
        text: s.text.slice(0, at) + replaceText.value + s.text.slice(at + needle.length),
      }
      flagTranslations(target)
      return target
    })
  })

  ui.notify(
    applied ? 'success' : 'info',
    applied ? `已替换「${needle}」` : '这一处没有变化',
    `${matchLabel.value}${findScope.value === 'all' ? '' : ` ｜ ${file.name}`}`,
  )

  /*
   * 替换文本里如果又包含查找词（比如把「的」换成「的确」），原地再点一次会
   * 命中刚写进去的那一段，「替换」就变成了「不断加长」。往后挪一格避开它。
   * 不含查找词时保持原位是**有意**的：那一处的匹配已经消失，同一下标正好
   * 指向后面的第一处，于是「替换」连点就是逐处往前推。
   */
  if (replaceText.value.includes(needle)) matchIndex.value += 1
}

/** 全部替换（按当前范围） */
function replaceAll(): void {
  const needle = findText.value
  if (!needle) return
  const targets = scopeFiles.value
  if (targets.length === 0) return

  let hits = 0
  let segmentsChanged = 0
  for (const file of targets) {
    // 每个文件各自入历史（history 按 fileId 分桶），撤回时互不影响
    history.commitIfChanged(file.id, () => file.segments, '查找替换', () => {
      file.segments = file.segments.map((segment) => {
        if (!segment.text.includes(needle)) return segment
        hits += offsetsOf(segment.text, needle).length
        const next = {
          ...segment,
          text: segment.text.split(needle).join(replaceText.value),
        }
        flagTranslations(next)
        segmentsChanged += 1
        return next
      })
    })
  }

  ui.notify(
    hits > 0 ? 'success' : 'info',
    hits > 0 ? `已替换 ${hits} 处，涉及 ${segmentsChanged} 条字幕` : '没有找到匹配内容',
    findScope.value === 'all' ? `已查过 ${targets.length} 个文件` : targets[0]?.name,
  )
  matchIndex.value = 0
}

/**
 * 词表替换：按设置里的自定义词表批量纠错。
 *
 * 与「查找替换」的分工：查找替换是一次一组词、临时输入；词表是一组长期
 * 配置（常错的人名、术语、同音字），配好之后一键批量纠正 —— 这是原来
 * 那个按钮的既定意图，但一直只弹了个「请在设置里维护词表」的提示，
 * 而设置里根本没有这个词表，等于功能是空的。
 */
function applyDictReplace(): void {
  const file = activeFile.value
  if (!file) return

  const rules = parseReplaceDict(settings.dictReplacements)
  if (rules.length === 0) {
    ui.notify(
      'info',
      '还没有替换词表',
      '在「设置」里按「错词=正词」每行一条填好词表，这里就能一键批量纠正',
    )
    return
  }

  let changed = 0
  history.commitIfChanged(file.id, () => file.segments, '词表替换', () => {
    file.segments = file.segments.map((segment) => {
      const next = applyReplaceRules(segment.text, rules)
      if (next === segment.text) return segment
      changed += 1
      const patched = { ...segment, text: next }
      flagTranslations(patched)
      return patched
    })
  })

  ui.notify(
    changed > 0 ? 'success' : 'info',
    changed > 0 ? `已按词表纠正 ${changed} 条字幕` : '没有命中词表里的词',
    `词表共 ${rules.length} 条`,
  )
}

const CJK = /[\u4e00-\u9fff]/

function normalizePunctuation(): void {
  const file = activeFile.value
  if (!file) return

  let changed = 0
  history.commitIfChanged(file.id, () => file.segments, '标点规范', () => {
    file.segments = file.segments.map((segment) => {
      if (!CJK.test(segment.text)) return segment
      const before = segment.text
      let text = segment.text
        .replace(/\s+/g, ' ')
        .replace(/,/g, '，')
        .replace(/;/g, '；')
        .replace(/:/g, '：')
        .replace(/\?/g, '？')
        .replace(/!/g, '！')
        .replace(/\(/g, '（')
        .replace(/\)/g, '）')
        .trim()

      if (text && !/[。！？，、；：）]$/.test(text)) text = `${text}。`

      if (text === before) return segment
      changed += 1
      const patched = { ...segment, text }
      flagTranslations(patched)
      return patched
    })
  })

  ui.notify(
    changed > 0 ? 'success' : 'info',
    changed > 0 ? `已规范 ${changed} 条字幕的标点` : '标点已经是规范的',
    file.name,
  )
}

function rewrap(): void {
  const file = activeFile.value
  if (!file) return

  /*
   * 旧实现把放不下的文字**静默丢掉**（lines.length < maxLines 时截断循环），
   * 用户反馈「点击后只会删除超出字幕长度范围的文字」。重做为与识别后处理
   * 同一套逻辑：装得下折行、装不下按宽度占比拆成多条，一个字都不丢。
   */
  const result = applyLineWrap(file.segments, {
    maxCharsPerLine: settings.maxCharsPerLine,
    maxCharsPerLineEn: settings.maxCharsPerLineEn,
    maxLinesPerSegment: settings.maxLinesPerSegment,
    // 与识别后处理同一套词表，否则「重新断行」会退回按宽度硬切
    wrapWords: buildWrapWords(settings.lexiconIds, settings.promptTerms),
  })

  let changed = 0
  let split = 0
  history.commitIfChanged(file.id, () => file.segments, '重新断行', () => {
    changed = result.rewrapped
    split = result.splitCount
    file.segments = result.segments
  })

  const detail = split > 0 ? `折行并拆分出 ${split} 条` : `每行 ${settings.maxCharsPerLine} 字`
  ui.notify(
    changed > 0 ? 'success' : 'info',
    changed > 0 ? '已按单行上限重新断行' : '当前换行已符合设置',
    detail,
  )
}
</script>

<template>
  <div class="toolpanel">
    <div class="toolpanel__head">
      <span class="toolpanel__title">工具</span>
      <span v-if="disabled" class="toolpanel__note">先选择一个文件</span>
    </div>

    <div class="toolpanel__grid">
      <button
        v-for="tool in TOOLS"
        :key="tool.key"
        class="tool"
        type="button"
        :disabled="disabled"
        :title="tool.hint"
        @click="run(tool)"
      >
        <Icon :name="tool.icon" :size="15" />
        <span>{{ tool.label }}</span>
      </button>
    </div>

    <!-- 整体偏移 -->
    <div v-if="offsetOpen" class="inline">
      <p class="inline__title">整体偏移</p>
      <div class="inline__row">
        <input
          v-model.number="offsetValue"
          class="input input--mono"
          type="number"
          step="0.1"
          placeholder="例如 -0.5"
        />
        <span class="inline__unit">秒</span>
        <button class="btn btn--sm btn--primary" type="button" @click="applyOffset">
          应用
        </button>
      </div>
      <p class="inline__hint">正数向后、负数向前；结果不小于 0</p>
    </div>

    <!-- 查找替换 -->
    <div v-if="findOpen" class="inline">
      <div class="inline__head">
        <span class="inline__title">查找替换</span>
        <span v-if="matchLabel" class="inline__count mono">{{ matchLabel }}</span>
      </div>

      <input
        v-model="findText"
        class="input"
        type="text"
        placeholder="查找内容（回车找下一个，Shift+回车找上一个）"
        spellcheck="false"
        @keydown.enter.prevent="goTo(matchIndex + ($event.shiftKey ? -1 : 1))"
      />
      <input
        v-model="replaceText"
        class="input"
        type="text"
        placeholder="替换为（留空表示删除匹配内容）"
        spellcheck="false"
        @keydown.enter.prevent="replaceOne"
      />

      <!-- 只定位，不动数据 -->
      <div class="inline__row">
        <button
          class="btn btn--sm btn--icon"
          type="button"
          :disabled="!findText"
          title="上一个匹配（Shift + 回车）"
          @click="goTo(matchIndex - 1)"
        >
          <Icon name="arrow-up" :size="12" />
        </button>
        <button
          class="btn btn--sm btn--icon"
          type="button"
          :disabled="!findText"
          title="下一个匹配（回车）"
          @click="goTo(matchIndex + 1)"
        >
          <Icon name="arrow-down" :size="12" />
        </button>
        <span class="inline__gap" />
        <button
          class="btn btn--sm"
          type="button"
          :disabled="!findText || matches.length === 0"
          title="只替换当前停的这一处"
          @click="replaceOne"
        >
          替换
        </button>
        <button
          class="btn btn--sm"
          type="button"
          :disabled="!findText || matches.length === 0"
          title="把范围内所有匹配都换掉"
          @click="replaceAll"
        >
          全部替换
        </button>
      </div>

      <!-- 范围：多文件时才有得选。合并模式下只有一条拼接产物，不显示 -->
      <div
        v-if="!project.isMerge && project.supportedFiles.length > 1"
        class="scope"
        role="group"
        aria-label="查找范围"
      >
        <button
          class="scope__item"
          :class="{ 'is-active': findScope === 'file' }"
          type="button"
          @click="findScope = 'file'"
        >
          当前文件
        </button>
        <button
          class="scope__item"
          :class="{ 'is-active': findScope === 'all' }"
          type="button"
          @click="findScope = 'all'"
        >
          全部文件（{{ project.supportedFiles.length }}）
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolpanel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.toolpanel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.toolpanel__title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}

.toolpanel__note {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.toolpanel__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

.tool {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.tool:hover:not(:disabled) {
  background: var(--color-bg-hover);
  border-color: var(--color-border-strong);
  color: var(--color-text-primary);
}

.tool:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.inline {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
}

.inline__title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
}

/* 标题行：右边挂「第 3 / 12 处」这类进度，窄栏里单独占一行才不会挤掉标题 */
.inline__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.inline__count {
  flex: none;
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 把右侧的批量操作推到同一行末尾 */
.inline__gap {
  flex: 1;
}

/* 查找范围：两个选项的细分段控件 */
.scope {
  display: flex;
  gap: 1px;
  padding: 1px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
}

.scope__item {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: 3px;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-tertiary);
}

.scope__item:hover:not(.is-active) {
  color: var(--color-text-primary);
}

.scope__item.is-active {
  background: var(--color-accent-subtle);
  color: var(--color-accent-text);
  font-weight: var(--weight-medium);
}

.inline__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.inline__unit {
  flex: none;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.inline__hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
