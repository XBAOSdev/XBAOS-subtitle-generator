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
import { useSpeakerStore } from '@/stores/speakers'
import ModalDialog from './ModalDialog.vue'
import Icon from '@/components/Icon.vue'

const ui = useUiStore()
const settings = useSettingsStore()
const project = useProjectStore()
const speakerStore = useSpeakerStore()

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

/**
 * 拉起系统的选文件夹框。
 *
 * 光给一个文本框是不行的 —— 用户得自己把 `D:\Podcast\第12期` 这种路径一字不差地敲进去，
 * 敲错一个字符就是导出失败，而失败提示还只能说「目录不存在」。能选就让人选。
 *
 * `target` 传 `'unified'` 走统一目录，传文件 id 走那一行。选中之后顺手把输出模式切过去：
 * 用户点这个按钮，本来就是想去那个目录。
 */
async function pickDir(target: 'unified' | string, current: string): Promise<void> {
  const api = window.xbaos?.dialog
  if (!api) {
    ui.notify('info', '浏览器预览无法选择文件夹', '请在桌面应用中使用')
    return
  }
  const dir = await api.pickDirectory({
    title: target === 'unified' ? '选择输出目录' : '选择这个文件的输出目录',
    defaultPath: current || undefined,
  })
  if (!dir) return

  if (target === 'unified') {
    unifiedDir.value = dir
    locationMode.value = 'unified'
    return
  }
  perFileDirs.value = { ...perFileDirs.value, [target]: dir }
}

/** 合并模式下导出的是那条拼接产物，不是随便某个音频 */
function mergedSegments(): SubtitleSegment[] {
  // 识别完成后 store 里已经物化了拼接产物（编辑器看到的、改过的就是它），
  // 导出必须以它为准，否则用户在合并视图里的编辑会白做。
  // 这里刻意**不**剔除空文本的条目 —— 那是序列化层的活（只导译文时，
  // 原文为空但译文有内容的条目必须留下）。
  return project.mergedFile?.segments ?? []
}

/** 未筛选的全部来源。筛选只影响真正写出去的内容，选项本身要一直看得见 */
const baseSources = computed<PlanSource[]>(() => {
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

/**
 * 这批要导出的字幕里有没有讲话人标签。
 *
 * 没跑过分离就整块不显示 —— 一个永远打不上标签的开关，只会让人以为
 * 「勾了却没生效」。
 */
const hasSpeakers = computed(() =>
  baseSources.value.some((s) => s.segments.some((seg) => typeof seg.speaker === 'number')),
)

/**
 * 可选（可按）的讲话人清单。
 *
 * 键是「来源文件 + 编号」而不是光一个编号：分别导出多个文件时，A 里的 0 号
 * 和 B 里的 0 号未必是同一个人，只按编号勾会把两个人一起勾上。
 */
interface SpeakerOption {
  key: string
  index: number
  name: string
  count: number
  sourceId: string
  sourceName: string
}

const speakerOptions = computed<SpeakerOption[]>(() =>
  baseSources.value.flatMap((source) =>
    speakerStore
      .speakersOf(source.id, source.segments)
      .filter((entry) => entry.count > 0)
      .map((entry) => ({
        key: `${source.id}:${entry.index}`,
        index: entry.index,
        name: entry.name,
        count: entry.count,
        sourceId: source.id,
        sourceName: source.name,
      })),
  ),
)

/** 勾了谁。缺省即「全选」—— 关掉对话框再打开不该丢掉上一次的选择也没意义，默认重新全选 */
const speakerPicked = ref<Record<string, boolean>>({})

function isPicked(option: SpeakerOption): boolean {
  return speakerPicked.value[option.key] !== false
}

function toggleSpeaker(option: SpeakerOption): void {
  speakerPicked.value = { ...speakerPicked.value, [option.key]: !isPicked(option) }
}

const pickedAll = computed(() => speakerOptions.value.every((o) => isPicked(o)))
const pickedCount = computed(() => speakerOptions.value.filter(isPicked).length)

/** 多文件时同名的「讲话人 1」会撞在一起，只有撞上了才在 chip 上带出处 */
const multiSource = computed(() => baseSources.value.length > 1)

const duplicateNames = computed(() => {
  const counts = new Map<string, number>()
  for (const option of speakerOptions.value) {
    counts.set(option.name, (counts.get(option.name) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name))
})

function pickAllSpeakers(): void {
  speakerPicked.value = {}
}

/** 全部取消：至少留一位，否则导出会变成一份空文件 */
function pickNoneSpeakers(): void {
  const next: Record<string, boolean> = {}
  for (const option of speakerOptions.value) next[option.key] = false
  speakerPicked.value = next
}

/** 每个来源里被筛掉的人数统计，用来给一句实话 */
const filteredSummary = computed(() => {
  let kept = 0
  let dropped = 0
  let unlabeled = 0
  for (const source of baseSources.value) {
    const options = speakerOptions.value.filter((o) => o.sourceId === source.id)
    if (options.length === 0) {
      kept += source.segments.length
      continue
    }
    const allowed = new Set(options.filter(isPicked).map((o) => o.index))
    const all = allowed.size === options.length
    for (const seg of source.segments) {
      if (typeof seg.speaker !== 'number') {
        if (all) kept += 1
        else unlabeled += 1
        continue
      }
      if (allowed.has(seg.speaker)) kept += 1
      else dropped += 1
    }
  }
  return { kept, dropped, unlabeled }
})

/**
 * 真正要写出去的来源。
 *
 * 筛选只在「没有全选」时生效；全选时原样放行，未标记的条目也一并留下 ——
 * 用户什么都没取消，却少了几条，那是纯粹的惊吓。
 */
const sources = computed<PlanSource[]>(() => {
  if (pickedAll.value) return baseSources.value
  return baseSources.value.map((source) => {
    const options = speakerOptions.value.filter((o) => o.sourceId === source.id)
    if (options.length === 0) return source
    const allowed = new Set(options.filter(isPicked).map((o) => o.index))
    return {
      ...source,
      segments: source.segments.filter(
        (seg) => typeof seg.speaker === 'number' && allowed.has(seg.speaker),
      ),
    }
  })
})

/** 讲话人标签在所选格式里怎么落笔 —— 三种写法差别很大，必须说清楚 */
const speakerStyleHint = computed(() => {
  switch (format.value) {
    case 'ass':
      return 'ASS 有 Name 列，称呼写在那里，播放器能认出来'
    case 'vtt':
      return 'VTT 用 <v 称呼> 语音标签，符合 WebVTT 规范'
    default:
      return '这个格式没有讲话人字段，写成「称呼：字幕」'
  }
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
  // 称呼跟着来源走：分别导出时每个文件的讲话人各有一套名字
  const namesOf = new Map(sources.value.map((s) => [s.id, speakerStore.namesOf(s.id)]))
  const written: string[] = []
  const records = new Map<string, ExportRecord[]>()
  let missing = 0

  try {
    for (const entry of outputs.value) {
      const body = serializeSubtitle(format.value, segmentsOf.get(entry.fileId) ?? [], {
        lang: entry.bundle,
        translationLang: entry.lang,
        sourceFirst: sourceFirst.value,
        speakerPrefix: hasSpeakers.value && settings.speakerPrefix,
        speakerNames: namesOf.get(entry.fileId) ?? {},
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

      <!-- 讲话人 -->
      <section v-if="hasSpeakers" class="export__section">
        <h3 class="export__section-title">
          讲话人
          <span class="export__section-note">{{ speakerOptions.length }} 位</span>
        </h3>

        <label class="checkbox export__spk-toggle">
          <input v-model="settings.speakerPrefix" type="checkbox" />
          <span>导出讲话人标签</span>
        </label>
        <p class="hint export__spk-hint">{{ speakerStyleHint }}</p>

        <div class="spkfilter">
          <div class="spkfilter__head">
            <span class="spkfilter__label">导出哪些人</span>
            <button class="spkfilter__act" type="button" @click="pickAllSpeakers">全选</button>
            <button class="spkfilter__act" type="button" @click="pickNoneSpeakers">全不选</button>
            <span class="spacer" />
            <span class="hint">
              {{ pickedAll ? '全部' : `已选 ${pickedCount} / ${speakerOptions.length}` }}
            </span>
          </div>

          <div class="spkchips">
            <label
              v-for="opt in speakerOptions"
              :key="opt.key"
              class="spkchip"
              :class="{ 'is-on': isPicked(opt) }"
              :title="multiSource ? `${opt.name}｜${opt.sourceName}` : opt.name"
            >
              <input type="checkbox" :checked="isPicked(opt)" @change="toggleSpeaker(opt)" />
              <span class="spkchip__name">{{ opt.name }}</span>
              <span v-if="multiSource && duplicateNames.has(opt.name)" class="spkchip__src">
                {{ opt.sourceName.replace(/\.[^.]+$/, '') }}
              </span>
              <span class="spkchip__count">{{ opt.count }}</span>
            </label>
          </div>

          <p v-if="!pickedAll" class="hint spkfilter__warn">
            将筛掉 {{ filteredSummary.dropped }} 条字幕<template
              v-if="filteredSummary.unlabeled > 0"
              >，另有 {{ filteredSummary.unlabeled }} 条未标记的不导出</template
            >。
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
              <span class="export__dirrow">
                <input
                  v-model="unifiedDir"
                  class="input input--mono export__dir-input"
                  type="text"
                  spellcheck="false"
                  :disabled="locationMode !== 'unified'"
                />
                <button
                  class="btn btn--sm btn--icon"
                  type="button"
                  title="选择文件夹"
                  @click.stop.prevent="pickDir('unified', unifiedDir)"
                >
                  <Icon name="folder" :size="13" />
                </button>
              </span>
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
      <section class="export__section">
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

                <span
                  v-if="locationMode === 'per-file' && item.firstOfSource"
                  class="plan__dirrow"
                >
                  <input
                    v-model="perFileDirs[item.fileId]"
                    class="input input--mono plan__dir"
                    type="text"
                    :placeholder="item.sourceDir"
                    spellcheck="false"
                  />
                  <button
                    class="btn btn--sm btn--icon"
                    type="button"
                    title="选择文件夹"
                    @click.stop.prevent="pickDir(item.fileId, perFileDirs[item.fileId] ?? item.sourceDir)"
                  >
                    <Icon name="folder" :size="12" />
                  </button>
                </span>
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

/* 路径框和「选文件夹」按钮同一行：按钮贴着输入框，别让它飘到右边去 */
.export__dirrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  max-width: 460px;
}

.export__dir-input {
  flex: 1;
  min-width: 0;
  margin-top: 0;
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

.plan__dirrow {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.plan__dir {
  flex: none;
  width: 168px;
  height: 24px;
  font-size: 11px;
}

/* 行内的选目录按钮跟着 24px 的输入框走，别用默认 28px 把行撑高 */
.plan__dirrow .btn--icon {
  width: 24px;
  height: 24px;
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

/* ---- 讲话人 ---- */
.export__spk-toggle {
  margin-bottom: 2px;
}

.export__spk-hint {
  margin-left: 23px;
}

.spkfilter {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
}

.spkfilter__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.spkfilter__label {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
}

.spkfilter__act {
  padding: 0 4px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--color-accent-text);
}

.spkfilter__act:hover {
  background: var(--color-bg-hover);
}

.spkfilter__warn {
  color: var(--color-warning);
}

.spkchips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.spkchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.spkchip:hover {
  border-color: var(--color-border-strong);
}

.spkchip.is-on {
  border-color: var(--color-accent);
  background: var(--color-accent-subtle);
  color: var(--color-text-primary);
}

.spkchip input[type='checkbox'] {
  width: 13px;
  height: 13px;
  flex: none;
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.spkchip__src {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.spkchip__count {
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.export__open {
  margin-top: var(--space-4);
}
</style>
