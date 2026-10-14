<script setup lang="ts">
import { computed, ref } from 'vue'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { MERGED_FILE_ID, useProjectStore, type ExportRecord } from '@/stores/project'
import type {
  AudioFile,
  ExportLangMode,
  LineEnding,
  OutputLocationMode,
  SubtitleFormat,
  SubtitleSegment,
  TextEncoding,
} from '@/types'
import { serializeSubtitle, applyLineEnding } from '@/utils/subtitle'
import { planExport, translationLangsOf, type PlanSource } from '@/utils/exportPlan'
import ModalDialog from './ModalDialog.vue'
import Icon from '@/components/Icon.vue'

const ui = useUiStore()
const settings = useSettingsStore()
const project = useProjectStore()

const EXT: Record<SubtitleFormat, string> = {
  srt: 'srt',
  vtt: 'vtt',
  ass: 'ass',
  txt: 'txt',
}

const FORMAT_LABEL: Record<SubtitleFormat, string> = {
  srt: 'SRT  通用字幕',
  vtt: 'VTT  Web 字幕',
  ass: 'ASS  带样式',
  txt: 'TXT  纯文本',
}

const locationMode = ref<OutputLocationMode>(settings.outputMode)
const unifiedDir = ref(settings.unifiedOutputDir || 'D:\\字幕输出')
const perFileDirs = ref<Record<string, string>>({})
const template = ref('{原名}')
const format = ref<SubtitleFormat>(settings.exportFormat)
const encoding = ref<TextEncoding>(settings.exportEncoding)
const lineEnding = ref<LineEnding>(settings.exportLineEnding)
const openAfter = ref(settings.openFolderAfterExport)
const collapsed = ref(false)

/** 语言维度。默认沿用上次的选择（没选过时是「双语」，见 DEFAULT_SETTINGS 的说明） */
const langMode = ref<ExportLangMode>(settings.exportLangMode)
/** 双语时的行序 */
const sourceFirst = ref(settings.exportLangSourceFirst)

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')

const isMerge = computed(() => project.batchMode === 'merge')

function resolveDir(file: AudioFile): string {
  if (locationMode.value === 'unified') return unifiedDir.value
  if (locationMode.value === 'per-file') return perFileDirs.value[file.id] ?? file.dir
  return file.dir
}

/** 合并模式下导出的是那条拼接产物，不是随便某个音频 */
function mergedSegments(): SubtitleSegment[] {
  // 识别完成后 store 里已经物化了拼接产物（编辑器看到的、改过的就是它），
  // 导出必须以它为准，否则用户在合并视图里的编辑会白做。
  // 这里刻意**不**剔除空文本的条目 —— 那是序列化层的活（只导译文时，
  // 原文为空但译文有内容的条目必须留下）。
  return project.mergedFile?.segments ?? []
}

const sources = computed<PlanSource[]>(() => {
  const files = project.supportedFiles
  if (files.length === 0) return []

  if (isMerge.value) {
    const first = files[0]
    // 合并产物是按导入顺序拼出来的，用第一个音频的名字命名会让人以为
    // 只导出了那一个文件。直接用产物的名字，{原名} 也一并替换成它。
    return [
      {
        id: MERGED_FILE_ID,
        name: '合并时间轴',
        dir: first.dir,
        baseName: '合并时间轴',
        outputDir: resolveDir(first),
        segments: mergedSegments(),
      },
    ]
  }

  return files.map((file) => ({
    id: file.id,
    name: file.name,
    dir: file.dir,
    baseName: file.name.replace(/\.[^.]+$/, ''),
    outputDir: resolveDir(file),
    segments: file.segments,
  }))
})

/** 这批字幕里出现过的译文语言 */
const translationLangs = computed(() =>
  translationLangsOf(sources.value.flatMap((s) => s.segments)),
)

const hasTranslation = computed(() => translationLangs.value.length > 0)

/**
 * 当前实际采用的译文语言。
 *
 * 优先设置里的工作语言；它不在这批字幕里时退回第一种 —— 全局设置会记住
 * 上次翻译的语言，死守它会让早先另一个语言的工程导出成一份纯原文。
 */
const activeTrLang = computed(() => {
  const langs = translationLangs.value
  if (langs.length === 0) return ''
  return langs.includes(settings.translationLang) ? settings.translationLang : langs[0]
})

/**
 * 界面上呈现的语言维度。
 *
 * 一条译文都没有时一律呈现「仅原文」，但**不动**用户存的偏好：他只是碰巧
 * 打开了另一个工程，不该因此把之前的选择抹掉。选项本身也是禁用的，
 * 所以这个显示值不会被用户误当成「已经选好双语了」。
 */
const displayLangMode = computed<ExportLangMode>({
  get: () => (hasTranslation.value ? langMode.value : 'source'),
  set: (value) => {
    langMode.value = value
  },
})

const orderPick = computed({
  get: () => (sourceFirst.value ? 'source-first' : 'translation-first'),
  set: (value: string) => {
    sourceFirst.value = value === 'source-first'
  },
})

/** 选项顺序固定：从最少到最多，最后是「拆成两个文件」 */
const LANG_MODES: ExportLangMode[] = ['source', 'both', 'translation', 'separate']

// 说明一律压成一行 —— 四项各占两行会让对话框高出一大截，在矮窗口里要滚动才看得到底部按钮
const LANG_MODE_LABEL: Record<ExportLangMode, { label: string; hint: string }> = {
  source: { label: '仅原文', hint: '每个文件只写原文' },
  both: { label: '双语', hint: '同一个字幕块里两行，共用一个时间码' },
  translation: { label: '仅译文', hint: '只写译文，缺译文的条目用原文顶上' },
  separate: {
    label: '分别导出',
    hint: '原文与译文各一个文件，按 xxx.zh.srt / xxx.en.srt 命名',
  },
}

const outputs = computed(() =>
  planExport(sources.value, {
    langMode: displayLangMode.value,
    sourceFirst: sourceFirst.value,
    sourceLanguage: settings.language,
    autoDetectLanguage: settings.autoDetectLanguage,
    preferredLang: settings.translationLang,
    template: template.value,
    ext: EXT[format.value],
    date: today,
  }),
)

const groups = computed(() => {
  const map = new Map<string, typeof outputs.value>()
  for (const entry of outputs.value) {
    const list = map.get(entry.outputDir)
    if (list) list.push(entry)
    else map.set(entry.outputDir, [entry])
  }
  return [...map.entries()].map(([dir, items]) => ({ dir, items }))
})

const dirCount = computed(() => groups.value.length)

const sourceDirCount = computed(
  () => new Set(project.supportedFiles.map((f) => f.dir)).size,
)

/** 这次一共要写出多少条字幕（双语时一条字幕算两行，所以按输出条数计） */
const totalLines = computed(() => outputs.value.reduce((n, e) => n + e.lineCount, 0))

/** 缺译文的条数：这些位置只能用原文顶上 */
const missingCount = computed(() => outputs.value.reduce((n, e) => n + e.missing, 0))

function unifyTo(dir: string): void {
  unifiedDir.value = dir
  locationMode.value = 'unified'
  ui.notify('info', '已改为统一输出', `全部字幕将保存到 ${dir}`)
}

/** 同名冲突时追加序号：name.srt → name-2.srt → name-3.srt */
async function resolveConflict(dir: string, name: string): Promise<string> {
  const bridge = window.xbaos
  if (!bridge) return `${dir}\\${name}`

  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  let candidate = `${dir}\\${name}`
  for (let n = 2; await bridge.fs.exists(candidate); n += 1) {
    candidate = `${dir}\\${base}-${n}${ext}`
  }
  return candidate
}

const exporting = ref(false)

async function doExport(): Promise<void> {
  const bridge = window.xbaos
  if (!bridge) {
    ui.notify('warning', '浏览器预览无法写文件', '请在桌面应用中执行导出')
    return
  }
  if (outputs.value.length === 0 || exporting.value) return

  exporting.value = true
  settings.outputMode = locationMode.value
  settings.unifiedOutputDir = unifiedDir.value
  settings.exportFormat = format.value
  settings.exportEncoding = encoding.value
  settings.exportLineEnding = lineEnding.value
  settings.openFolderAfterExport = openAfter.value
  // 语言维度也一并记住：下次导出直接沿用，不用重选一遍。
  // **没有译文时不记**：那时界面为了不误导而一律呈现「仅原文」，照抄下来
  // 就等于把用户「以后默认导双语」的偏好悄悄改掉了 —— 等他真翻译完再导出，
  // 默认值已经变成纯原文了。
  if (hasTranslation.value) settings.exportLangMode = displayLangMode.value
  settings.exportLangSourceFirst = sourceFirst.value
  if (activeTrLang.value) settings.translationLang = activeTrLang.value

  const segmentsOf = new Map(sources.value.map((s) => [s.id, s.segments]))
  const written: string[] = []
  const records = new Map<string, ExportRecord[]>()
  let missing = 0

  try {
    for (const entry of outputs.value) {
      const body = serializeSubtitle(format.value, segmentsOf.get(entry.fileId) ?? [], {
        lang: entry.bundle,
        translationLang: entry.lang,
        sourceFirst: sourceFirst.value,
      })
      const content = applyLineEnding(body, lineEnding.value)

      const target = await resolveConflict(entry.outputDir, entry.outputName)
      await bridge.fs.writeSubtitle(target, content, encoding.value)
      written.push(target)
      missing += entry.missing

      // 记下落点：导出后再改几个字就能直接覆盖写回，不必重走一遍导出流程
      //（选目录、选格式、处理重名）。同一条来源可能产生多个文件（分别导出），
      // 所以按来源攒成一个列表整体记下 —— 就地保存时才写得出完整的一份。
      const list = records.get(entry.fileId) ?? []
      list.push({ bundle: entry.bundle, lang: entry.lang, path: target })
      records.set(entry.fileId, list)
    }
  } catch (err) {
    ui.notify('error', '导出失败', err instanceof Error ? err.message : String(err))
    exporting.value = false
    return
  }

  for (const [fileId, list] of records) project.rememberExport(fileId, list)
  // 同时登记内容签名：「落点」用来就地覆盖保存，「签名」用来判断关窗时会不会丢东西。
  // 只记落点是不够的 —— 导出之后又改了字，两者表现完全不同。
  for (const [fileId, segments] of segmentsOf) project.markSaved(fileId, segments)
  exporting.value = false

  const dirs = new Set(written.map((p) => p.replace(/\\[^\\]+$/, '')))
  if (openAfter.value && dirs.size === 1) {
    void bridge.fs.reveal(written[0])
  }

  ui.closeDialog()
  const detail = [dirs.size > 1 ? `分布在 ${dirs.size} 个目录` : written[0]]
  if (missing > 0) detail.push(`${missing} 条缺译文，已用原文顶上`)
  ui.notify('success', `已导出 ${written.length} 个字幕文件`, detail.join('；'))
}

function close(): void {
  ui.closeDialog()
}
</script>

<template>
  <ModalDialog
    title="导出字幕"
    :subtitle="
      isMerge
        ? '合并模式只产生一个字幕文件，保存到第一个音频所在目录'
        : `将导出 ${outputs.length} 个文件`
    "
    width="720px"
    @close="close"
  >
    <div class="export">
      <!-- 多目录时的汇总条 -->
      <div v-if="dirCount > 1" class="export__summary">
        <Icon name="folder" :size="14" />
        <span class="export__summary-text">
          将输出到 <strong>{{ dirCount }}</strong> 个目录，共
          <strong>{{ outputs.length }}</strong> 个文件
        </span>
        <button
          class="export__summary-toggle"
          type="button"
          @click="collapsed = !collapsed"
        >
          {{ collapsed ? '展开清单' : '收起清单' }}
          <Icon :name="collapsed ? 'chevron-down' : 'chevron-up'" :size="13" />
        </button>
      </div>

      <!-- 语言维度 -->
      <section class="export__section">
        <h3 class="export__section-title">
          语言
          <span class="export__section-note">
            {{
              hasTranslation
                ? `这条时间轴上有 ${translationLangs.length} 种译文`
                : '这些字幕还没有译文'
            }}
          </span>
        </h3>

        <div class="export__options">
          <label
            v-for="mode in LANG_MODES"
            :key="mode"
            class="radio"
            :class="{ 'is-off': mode !== 'source' && !hasTranslation }"
          >
            <input
              v-model="displayLangMode"
              type="radio"
              :value="mode"
              :disabled="mode !== 'source' && !hasTranslation"
            />
            <span class="radio__body">
              <span class="radio__label">{{ LANG_MODE_LABEL[mode].label }}</span>
              <span class="radio__hint">{{ LANG_MODE_LABEL[mode].hint }}</span>
            </span>
          </label>
        </div>

        <div v-if="hasTranslation" class="export__langopts">
          <label v-if="translationLangs.length > 1" class="field">
            <span class="field__label">导出哪种译文</span>
            <select v-model="settings.translationLang" class="select">
              <option v-for="code in translationLangs" :key="code" :value="code">
                {{ code }}
              </option>
            </select>
          </label>

          <label v-if="displayLangMode === 'both'" class="field">
            <span class="field__label">行序</span>
            <select v-model="orderPick" class="select">
              <option value="source-first">原文在上</option>
              <option value="translation-first">译文在上</option>
            </select>
          </label>

          <p v-if="missingCount > 0 && displayLangMode !== 'source'" class="hint export__warn">
            有 <strong>{{ missingCount }}</strong> 条还没译文，这些位置会用原文顶上
            ——（不会留空，也不会把那条字幕整条丢掉）。
          </p>
        </div>
      </section>

      <!-- 输出位置 -->
      <section class="export__section">
        <h3 class="export__section-title">输出位置</h3>

        <div class="export__options">
          <label class="radio">
            <input v-model="locationMode" type="radio" value="follow-source" />
            <span class="radio__body">
              <span class="radio__label">跟随音频文件所在目录</span>
              <span class="radio__hint">
                {{
                  sourceDirCount > 1
                    ? `音频来自 ${sourceDirCount} 个目录，字幕将分别保存到各自目录`
                    : '字幕与音频放在一起'
                }}
              </span>
            </span>
          </label>

          <label class="radio">
            <input v-model="locationMode" type="radio" value="unified" />
            <span class="radio__body">
              <span class="radio__label">统一输出到指定目录</span>
              <input
                v-model="unifiedDir"
                class="input input--mono export__dir-input"
                type="text"
                spellcheck="false"
                :disabled="locationMode !== 'unified'"
              />
            </span>
          </label>

          <label class="radio">
            <input v-model="locationMode" type="radio" value="per-file" />
            <span class="radio__body">
              <span class="radio__label">每个文件分别指定</span>
              <span class="radio__hint">在下方清单中逐项修改目录</span>
            </span>
          </label>
        </div>
      </section>

      <!-- 输出清单 -->
      <section v-if="!collapsed" class="export__section">
        <h3 class="export__section-title">
          输出清单
          <span class="export__section-note">
            共 {{ totalLines }} 条字幕
          </span>
        </h3>

        <div class="plan">
          <div v-for="group in groups" :key="group.dir" class="plan__group">
            <div v-if="dirCount > 1" class="plan__group-head">
              <Icon name="folder" :size="13" />
              <span class="plan__group-dir mono">{{ group.dir }}</span>
              <span class="plan__group-count">{{ group.items.length }} 个文件</span>
              <button
                v-if="locationMode !== 'unified'"
                class="plan__group-action"
                type="button"
                @click="unifyTo(group.dir)"
              >
                全部输出到此处
              </button>
            </div>

            <ul class="plan__list">
              <li
                v-for="item in group.items"
                :key="`${item.fileId}|${item.bundle}|${item.lang}`"
                class="plan__row"
              >
                <span class="plan__source mono">{{ item.sourceName }}</span>
                <Icon name="chevron-right" :size="12" class="plan__arrow" />
                <span class="plan__target mono">{{ item.outputName }}</span>
                <span v-if="item.bundle !== 'source'" class="plan__tag">
                  {{ item.bundle === 'both' ? '双语' : '译文' }}
                </span>

                <input
                  v-if="locationMode === 'per-file' && item.firstOfSource"
                  v-model="perFileDirs[item.fileId]"
                  class="input input--mono plan__dir"
                  type="text"
                  :placeholder="item.sourceDir"
                  spellcheck="false"
                />
              </li>
            </ul>
          </div>
        </div>

        <p class="hint export__conflict">
          若目标目录已存在同名文件，会自动追加序号，不会覆盖已有文件。
        </p>
      </section>

      <!-- 导出选项 -->
      <section class="export__section">
        <h3 class="export__section-title">选项</h3>

        <div class="export__grid">
          <label class="field">
            <span class="field__label">文件名模板</span>
            <input
              v-model="template"
              class="input input--mono"
              type="text"
              spellcheck="false"
            />
            <span class="field__hint">
              可用变量：{原名} {序号} {日期} {语言}；含译文时语言后缀会自动追加
            </span>
          </label>

          <label class="field">
            <span class="field__label">格式</span>
            <select v-model="format" class="select">
              <option v-for="(label, key) in FORMAT_LABEL" :key="key" :value="key">
                {{ label }}
              </option>
            </select>
          </label>

          <label class="field">
            <span class="field__label">文本编码</span>
            <select v-model="encoding" class="select">
              <option value="utf-8">UTF-8</option>
              <option value="utf-8-bom">UTF-8 带 BOM</option>
              <option value="gbk">GBK（兼容老播放器）</option>
            </select>
          </label>

          <label class="field">
            <span class="field__label">换行符</span>
            <select v-model="lineEnding" class="select">
              <option value="crlf">CRLF（Windows）</option>
              <option value="lf">LF（Unix）</option>
            </select>
          </label>
        </div>

        <label class="checkbox export__open">
          <input v-model="openAfter" type="checkbox" />
          <span>导出后打开所在文件夹</span>
        </label>
      </section>
    </div>

    <template #footer>
      <button class="btn" type="button" @click="close">取消</button>
      <button class="btn btn--primary" type="button" :disabled="exporting" @click="doExport">
        {{ exporting ? '正在导出' : `导出 ${outputs.length} 个文件` }}
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.export {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.export__summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-info-border);
  border-radius: var(--radius-md);
  background: var(--color-info-subtle);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.export__summary-text {
  flex: 1;
}

.export__summary-text strong {
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
}

.export__summary-toggle {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-accent-text);
}

.export__section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  margin-bottom: var(--space-3);
}

.export__section-note {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-regular);
  color: var(--color-text-tertiary);
}

.export__options {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.radio {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.radio:hover {
  background: var(--color-bg-hover);
}

/* 没有译文时：整行置灰且不可点，明确告诉用户「不是没做，是没得选」 */
.radio.is-off {
  cursor: not-allowed;
  opacity: 0.45;
}

.radio.is-off:hover {
  background: transparent;
}

.radio input[type='radio'] {
  margin-top: 2px;
  width: 15px;
  height: 15px;
  flex: none;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.radio.is-off input[type='radio'] {
  cursor: not-allowed;
}

.radio__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.radio__label {
  font-size: var(--font-size-sm);
}

.radio__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.export__langopts {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-4);
  margin-top: var(--space-2);
  padding: 0 var(--space-3);
}

.export__langopts .field {
  min-width: 160px;
}

.export__warn {
  flex: 1 1 100%;
  color: var(--color-warning);
}

.export__warn strong {
  font-variant-numeric: tabular-nums;
}

.export__dir-input {
  max-width: 460px;
  margin-top: var(--space-1);
}

.plan {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  max-height: 300px;
  overflow-y: auto;
}

.plan__group + .plan__group {
  border-top: 1px solid var(--color-border);
}

.plan__group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-inset);
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-text-secondary);
}

.plan__group-dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-xs);
}

.plan__group-count {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.plan__group-action {
  flex: none;
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--color-accent-text);
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border);
}

.plan__group-action:hover {
  border-color: var(--color-accent-border);
}

.plan__list {
  padding: var(--space-1) 0;
}

.plan__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-3) 3px var(--space-6);
  font-size: var(--font-size-xs);
}

.plan__row:hover {
  background: var(--color-bg-hover);
}

.plan__source {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.plan__arrow {
  flex: none;
  color: var(--color-text-tertiary);
}

.plan__target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}

.plan__tag {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  color: var(--color-text-secondary);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-subtle);
}

.plan__dir {
  flex: none;
  width: 180px;
  height: 24px;
  font-size: 11px;
}

.export__conflict {
  margin-top: var(--space-2);
}

.export__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field__label {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
}

.field__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.export__open {
  margin-top: var(--space-4);
}
</style>
