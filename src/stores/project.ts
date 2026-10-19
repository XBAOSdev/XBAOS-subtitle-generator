import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  AudioFile,
  AudioPeaks,
  BatchMode,
  ExportLangBundle,
  FileStatus,
  SubtitleSegment,
} from '@/types'
import { makeAudioFile, mockFiles } from '@/mock/mockData'
import { extOf, isSupported, unsupportedReason, isSubtitleExt } from '@/utils/formats'
import { parseSubtitle } from '@/utils/subtitleParse'
import { dirOf, nameOf, extOfPath } from '@/utils/path'
import { applyPunctuation, hasContent } from '@/utils/punctuation'
import { buildMergedTimeline } from '@/utils/mergeTimeline'
import { buildPrompt, pickPresentTerms } from '@/utils/prompt'
import { depthPreset } from '@/utils/reasoningDepth'
import { mergeRuns, runText, type RecognitionRun } from '@/utils/transcriptMerge'
import { applyRescue, planRescueRanges, RESCUE_BEAM_SIZE } from '@/utils/lowConfRescue'
import { applyLineWrap } from '@/utils/lineWrap'
import { vadPreset } from '@/data/vadPresets'
import {
  applyTranslation as applyTranslationTo,
  cuesToSegments,
  type ParsedCue,
} from '@/utils/llmResult'
import { validateSegment, countIssues } from '@/utils/validate'
import { alignOrigin, enforceMonotonicCues, hasText, segmentsSignature } from '@/utils/segmentOps'
import { MAX_LANES, overflowLaneIds } from '@/utils/timelineLayout'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useHistoryStore } from '@/stores/history'

/**
 * 浏览器预览模式下文件没有真实路径，统一给一个演示目录。
 * Electron 里走 pathForFile / dialog.pickAudio，拿到的一律是真实路径。
 */
const PREVIEW_DIR = 'D:\\Import'

/**
 * 合并模式产物的虚拟条目 id。它不是文件，只是一个把多段音频的字幕
 * 拼到同一条时间轴上的容器；编辑器、校验、导出在合并模式下都以它为准。
 */
export const MERGED_FILE_ID = '__merged__'

/**
 * 批量处理的默认模式：独立处理。
 * 清空队列时会复位到这里 —— 「清空」是彻底重来，不该把上一次的合并模式留下。
 */
export const DEFAULT_BATCH_MODE: BatchMode = 'separate'

/** 合并视图里的一段：某个音频在合并时间轴上的位置 */
export interface MergedPart {
  fileId: string
  /** 该段在合并时间轴上的起点（秒） */
  offsetSec: number
  durationSec: number
}

/**
 * 一个条目上一次导出出去的文件。
 *
 * 除了路径还要记住「这个文件里装的是哪种语言」：就地保存必须照原样重写一遍，
 * 否则双语工程里按一次保存，会把自己刚导出的中英对照文件悄悄改成纯中文。
 */
export interface ExportRecord {
  /** 该文件里装的语言组合 */
  bundle: ExportLangBundle
  /** `bundle` 为 both / translation 时的语言码 */
  lang: string
  /** 绝对路径 */
  path: string
}

/** 演示模式下：文件识别完成后应呈现的最终状态 */
const finalStatus = new Map<string, FileStatus>()

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function round3(v: number): number {
  return Number(v.toFixed(3))
}

/** 识别线程数。超过 8 线程反而更慢（E 核参与同步屏障），这是实测结论 */
function threadCount(): number {
  const cores = navigator.hardwareConcurrency || 4
  return Math.min(cores, 8)
}

interface FileMedia {
  peaks: AudioPeaks | null
  /** Blob URL，交给 <audio> 播放真实音频 */
  blobUrl: string | null
  loading: boolean
  /**
   * 上一次读取 / 解码失败的**真实原因**。
   *
   * 读文件失败（路径失效、权限、文件被占用）与「这一段本来就没有音频轨」
   * 是两回事，但界面上曾经共享同一句提示 —— 用户只会说「检测不到音轨」，
   * 完全看不出是文件读不到。失败原因必须记下来，让播放器据实说话。
   */
  error: string | null
  /** 合并产物才有的分段表：用于按段加载音频与拼接波形 */
  parts?: MergedPart[]
}

export const useProjectStore = defineStore('project', () => {
  const files = ref<AudioFile[]>([])
  const batchMode = ref<BatchMode>(DEFAULT_BATCH_MODE)
  /**
   * 批量处理模式是否已锁定。选过一次（或已经开始识别）就钉死：
   * 切换模式会让已经识别出来的内容归属发生变化（先前的成果被卷进合并、
   * 时间轴错位），所以必须先清空队列才允许改。
   */
  const batchModeLocked = ref(false)
  /**
   * 合并模式的产物。识别完成后物化成一条虚拟条目，
   * 编辑器与导出在合并模式下都以它为准；队列变动时作废。
   */
  const mergedFile = ref<AudioFile | null>(null)
  const activeFileId = ref<string | null>(null)

  const recognizing = ref(false)
  const progress = ref(0)
  const progressLabel = ref('')
  const elapsedSec = ref(0)
  const remainingSec = ref(0)
  /** 当前正在识别的文件 id（取消按钮与高亮用） */
  const currentFileId = ref<string | null>(null)
  /** 当前识别任务的引擎侧标识，用于把流式消息归属到正确文件 */
  const currentTaskId = ref<string | null>(null)

  /**
   * 音频媒体数据（波形峰值、可播放地址）。按文件 id 存放，
   * 不放进 AudioFile 本体 —— 这份数据大，且不参与序列化。
   */
  const media = ref(new Map<string, FileMedia>())

  /**
   * 媒体表的内容版本号。
   *
   * ⚠ **不能再指望 Vue 对 `media` 这张 Map 的插桩。**实测（探针 media-ui-flow）：
   * `loadMedia()` 把 `blobUrl` / `peaks` 写进条目之后，
   * ① `AudioPlayer` 的 `singleUrl` computed 永远停在第一次算出的 `null`
   *    → 界面判定「这一段没有音轨」，`<audio>` 的 src 从来没被设过；
   * ② 时间轴读 `peaksOf()` 也拿不到新值，且**没有任何东西被触发重绘**
   *    → 波形要么画不出来、要么画成空白。
   * 对 Map 做一次同值 `set` 立刻就好了 —— 说明读得到、就是没人被通知。
   *
   * 所以这里给一张自己记账的版本号：媒体表任何一处变动都 `touchMedia()`，
   * 需要它的 computed / watcher 读一下 `mediaVersion` 就会重新求值。
   * 这是显式依赖，不依赖框架对集合类型插桩的细节。
   */
  const mediaVersion = ref(0)
  function touchMedia(): void {
    mediaVersion.value += 1
  }

  /**
   * 导出过的字幕落点。
   *
   * **纯内存，不落盘**：关掉软件就随进程释放，也不用操心历史路径过期后的清理。
   * 用途是「导出完又改了几个字」—— 不必再走一遍导出对话框（选目录、选格式、
   * 处理重名），直接覆盖写回原位置。合并产物的落点挂在 `MERGED_FILE_ID` 下。
   */
  const exportRecords = ref(new Map<string, ExportRecord[]>())

  /** 记下某个条目这次导出到了哪些文件（**整体替换**上一次的记录） */
  function rememberExport(fileId: string, records: ExportRecord[]): void {
    if (records.length === 0) return
    exportRecords.value.set(fileId, records)
  }

  /** 该条目上一次导出的文件列表。没有就是空数组 */
  function exportRecordsOf(fileId: string | null): ExportRecord[] {
    if (!fileId) return []
    return exportRecords.value.get(fileId) ?? []
  }

  /**
   * 各文件**最后一次成功写盘时**的内容签名（fileId → 签名）。
   *
   * 与 `exportRecords` 的区别：那个记的是「写到哪了」（用来就地覆盖保存），
   * 这个记的是「写出去的内容长什么样」（用来判断**关窗时会不会丢东西**）。
   *
   * 只在写盘成功后登记，所以「导出过、之后又改了几个字」会正确地表现为
   * 有未保存内容 —— 用户的口径是「保存的版本必须是最新版本」。
   */
  const savedSignatures = ref(new Map<string, string>())

  /** 写盘成功后登记一次。所有落盘路径都必须调它，否则关窗会误报 */
  function markSaved(fileId: string, segments: SubtitleSegment[]): void {
    savedSignatures.value.set(fileId, segmentsSignature(segments))
  }

  /**
   * 关窗时判断「有没有会丢的东西」。
   *
   * 三种情况算有：① 还有文件在排队 / 正在识别；② 有产出内容的文件，其当前
   * 内容与最后一次写盘时不一致；③ 有内容但从没写盘过（导入进来就没动过的
   * 字幕也算 —— 用户明确要求「只要导入了内容就该提示」）。
   *
   * 演示数据（`?demo=1`）不参与，否则开发时每次关窗都要点一次确认。
   *
   * 刻意**不是 computed**：这是全量序列化，做成 computed 会让每次编辑都付一次
   * 全量字符串化的代价。只在真的要关窗时算一次。
   */
  function unsavedSummary(): { count: number; recognizing: number; names: string[] } {
    const list = files.value.filter((f) => !f.demo)
    let recognizingCount = 0
    const names: string[] = []
    for (const f of list) {
      if (f.status === 'queued' || f.status === 'processing') {
        recognizingCount += 1
        names.push(f.name)
        continue
      }
      // 合并产物按它的内容算，不按参与合并的源文件算
      if (f.merged && f.segments.length === 0) continue
      const hasContent = f.segments.some(hasText) || f.segments.some((s) => s.translations)
      if (!hasContent) continue
      if (savedSignatures.value.get(f.id) !== segmentsSignature(f.segments)) names.push(f.name)
    }
    return { count: names.length, recognizing: recognizingCount, names }
  }

  /* ---------------------------------------------------------------- 派生 */

  const supportedFiles = computed(() => files.value.filter((f) => f.status !== 'unsupported'))
  const unsupportedFiles = computed(() => files.value.filter((f) => f.status === 'unsupported'))
  const hasFiles = computed(() => files.value.length > 0)

  const activeFile = computed(
    () => files.value.find((f) => f.id === activeFileId.value) ?? null,
  )

  const isMerge = computed(() => batchMode.value === 'merge')

  /**
   * 编辑器 / 波形 / 播放器 / 工具栏统一看这个「当前视图条目」。
   *
   * 独立模式下就是被选中的那个文件；合并模式下是拼接产物 ——
   * 这样一切换到合并模式，界面上呈现的就只有一条合并时间轴，
   * 不会再因为点队列里的某个音频而整个换掉预览内容。
   */
  const viewFile = computed<AudioFile | null>(() =>
    isMerge.value ? mergedFile.value : activeFile.value,
  )

  const viewFileId = computed(() => viewFile.value?.id ?? null)

  /**
   * 参与合并的分段表。偏移量按各音频的时长累加 —— 时长是解码后
   * 由引擎回报的，识别完成后才可靠，所以合并产物在识别结束时才物化。
   */
  const mergedParts = computed<MergedPart[]>(() => {
    const out: MergedPart[] = []
    let offset = 0
    for (const f of supportedFiles.value) {
      const durationSec = f.durationSec ?? 0
      out.push({ fileId: f.id, offsetSec: round3(offset), durationSec })
      offset += durationSec
    }
    return out
  })

  /** 合并模式下的总时长（用真实时长累加，不用最后一条字幕的时间码） */
  const totalDuration = computed(() =>
    supportedFiles.value.reduce((sum, f) => sum + (f.durationSec ?? 0), 0),
  )

  const totalSegments = computed(() =>
    isMerge.value && mergedFile.value
      ? mergedFile.value.segments.length
      : supportedFiles.value.reduce((sum, f) => sum + f.segments.length, 0),
  )

  /* ---------------------------------------------------------- 字幕校验 */

  const settings = useSettingsStore()

  /**
   * 校验输入签名。
   *
   * 只取会左右校验结论的字段（时间码与文字），**故意不含 issues** ——
   * 否则回写 issues 会再次触发 watch，变成死循环。
   */
  function validationSignature(): string {
    const parts: string[] = []
    for (const f of files.value) {
      if (f.status === 'unsupported') continue
      for (const s of f.segments) parts.push(`${s.start}|${s.end}|${s.text}`)
    }
    if (mergedFile.value) {
      for (const s of mergedFile.value.segments) parts.push(`${s.start}|${s.end}|${s.text}`)
    }
    return parts.join('\u0001')
  }

  /** 规格签名：改了设置也要重新校验一遍 */
  const specSignature = computed(
    () =>
      `${settings.maxCharsPerLine}|${settings.maxCharsPerLineEn}|` +
      `${settings.maxLinesPerSegment}|${settings.maxSegmentDuration}`,
  )

  /**
   * 只写结论真的变了的条目，少一些无谓的响应式触发。
   *
   * 除了常规校验，这里还挂一条**时间轴专属**的结论：同时重叠的字幕超过
   * `MAX_LANES` 条。它不是某一条自己的毛病，而是「这几条凑在一起」才成立的
   * 性质，所以先整体排一遍泳道，再把超出的那些标出来 —— 否则时间轴上会
   * 出现一堆叠在同一层、既看不清也分不出谁是谁的色块，而校验结果里一个字
   * 都不提，用户完全无从下手。
   */
  function applyIssues(segments: SubtitleSegment[]): void {
    const spec = {
      maxCharsPerLine: settings.maxCharsPerLine,
      maxCharsPerLineEn: settings.maxCharsPerLineEn,
      maxLinesPerSegment: settings.maxLinesPerSegment,
      maxSegmentDuration: settings.maxSegmentDuration,
    }
    const overflow = overflowLaneIds(segments)
    for (let i = 0; i < segments.length; i += 1) {
      const next = validateSegment(segments[i], segments[i - 1], spec)
      if (overflow.has(segments[i].id)) {
        next.push({
          level: 'error',
          code: 'LANE_OVERFLOW',
          message: `同一时刻重叠的字幕超过 ${MAX_LANES} 条`,
        })
      }
      const cur = segments[i].issues
      if (cur.length === next.length && cur.every((issue, k) => issue.code === next[k].code)) {
        continue
      }
      segments[i].issues = next
    }
  }

  /**
   * 重算全部条目的校验结论。
   *
   * 以前 `issues` 永远是空数组 —— 「校验结果」面板只有演示数据会亮，真实识别完
   * 永远显示「没有问题」。现在让它跟着字幕与规格设置一起更新。
   */
  function revalidate(): void {
    for (const f of files.value) {
      if (f.status === 'unsupported') continue
      applyIssues(f.segments)
    }
    if (mergedFile.value) applyIssues(mergedFile.value.segments)
  }

  // 字幕或规格一变就重算。flush: 'post' 让它排在渲染之后，不挡用户输入
  watch([validationSignature, specSignature], revalidate, { flush: 'post', immediate: true })

  /**
   * 全工程的告警条数（底部状态栏用）。
   *
   * 合并模式下只算**拼接产物**：用户看到的、编辑的、导出的都是那一条时间轴，
   * 而各源文件里存的还是识别原始结果 —— 继续统计它们会让状态栏在一个用户
   * 根本看不到的数字上闪红。这与 `totalSegments` 的取舍一致。
   *
   * 已整条「忽略」的字幕不计入（`countIssues` 里判的）。
   */
  const errorCount = computed(() => {
    if (isMerge.value && mergedFile.value) return countIssues(mergedFile.value.segments).errors
    return supportedFiles.value.reduce((n, f) => n + countIssues(f.segments).errors, 0)
  })

  const warningCount = computed(() => {
    if (isMerge.value && mergedFile.value) return countIssues(mergedFile.value.segments).warnings
    return supportedFiles.value.reduce((n, f) => n + countIssues(f.segments).warnings, 0)
  })

  const pendingReviewCount = computed(
    () => files.value.filter((f) => f.status === 'pending').length,
  )

  /** 未支持的格式，按扩展名归并计数 */
  const unsupportedExts = computed(() => {
    const map = new Map<string, number>()
    for (const f of unsupportedFiles.value) {
      map.set(f.ext, (map.get(f.ext) ?? 0) + 1)
    }
    return [...map.entries()].map(([ext, count]) => ({ ext, count }))
  })

  /** 本次导出会涉及几个输出目录 */
  const outputDirs = computed(() => {
    if (batchMode.value === 'merge') {
      const first = supportedFiles.value[0]
      return first ? [first.dir] : []
    }
    return [...new Set(supportedFiles.value.map((f) => f.dir))]
  })

  /* ------------------------------------------------- 合并模式（单条时间轴） */

  /**
   * 把所有参与合并的音频的字幕拼到一条时间轴上。
   *
   * 时间码按各音频时长依次累加；只保留有实际内容的条目 —— 模型在纯静音上
   * 偶尔会吐出一个孤零零的句号，那种条目留着只会让人以为「什么都没识别到」。
   *
   * **增量规则（关键）**：合并时间轴同时是编辑器的唯一入口，用户会直接在上面
   * 改内容（人工编辑、工具、AI 校对都是改它）。所以重新拼接**绝不能**无脑从
   * 源文件重来 —— 源文件里存的还是识别原始结果，用户的修改只在产物上，
   * 重来一次就等于把修改全丢了。
   *
   * 真踩过：合并模式下改完内容，只是往队列里追加一段音频（还没重新识别），
   * 之前的修改就「原封不动地回去」了（`addFiles` → `onQueueChanged` →
   * 全量重拼）。独立处理模式没这个问题，因为每个文件自己就是编辑对象。
   *
   * 规则：
   *   - 上一轮已经参与过合并的文件 → 整组条目原样保留，只按偏移差整体平移；
   *   - 这一轮新加入（或刚识别出内容）的文件 → 从源文件生成新条目；
   *   - 产物上手动新增的条目（没有来源标记）→ 保留，按时间码插回原位。
   */
  function buildMergedFile(): AudioFile | null {
    const list = supportedFiles.value
    if (list.length === 0) return null

    const previous = mergedFile.value
    const built = buildMergedTimeline(
      list.map((f) => ({ id: f.id, durationSec: f.durationSec, segments: f.segments })),
      previous ? { segments: previous.segments, offsets: previous.mergedOffsets ?? {} } : null,
    )

    const first = list[0]
    return {
      id: MERGED_FILE_ID,
      name: '合并时间轴',
      path: first.path,
      dir: first.dir,
      ext: 'merged',
      sizeBytes: 0,
      durationSec: built.durationSec,
      status: 'pending',
      segments: built.segments,
      merged: true,
      mergedOffsets: built.offsets,
      // 演示数据（浏览器预览）没有真实音频，波形交给合成峰值
      demo: list.every((f) => f.demo === true),
    }
  }

  /** 媒体序号：队列变动后，还在跑的拼接任务要能自行作废 */
  let mergedMediaToken = 0

  /**
   * 合并视图的媒体。
   *
   * 合并产物没有单一音频流，所以波形按分段依次解码后拼起来（边解码边刷新，
   * 波形从左往右长出来）；试听交给播放器按段切 src。顺序加载而非并发，
   * 避免一次解码多个长音频把内存顶爆。
   */
  async function syncMergedMedia(): Promise<void> {
    const token = (mergedMediaToken += 1)
    const parts = mergedParts.value
    if (parts.length === 0) return

    // 与 ensureMedia 里的采样率一致，拼接时靠它对齐时间轴
    const RATE = 50
    const data: number[] = []
    /** 是否至少有一段真的解出了波形 */
    let hasAny = false

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      if (token !== mergedMediaToken) return

      await ensureMedia(part.fileId)
      if (token !== mergedMediaToken) return

      // 先补齐到这一段应有的长度（缺波形的段用静音占位），再把峰值覆盖进去，
      // 保证后面几段不会因为前一段短了半拍而整体错位
      const target = Math.round((part.offsetSec + part.durationSec) * RATE)
      while (data.length < target) data.push(0)

      const peaks = media.value.get(part.fileId)?.peaks
      if (peaks) {
        hasAny = true
        const from = Math.round(part.offsetSec * RATE)
        for (let k = 0; k < peaks.data.length; k += 1) {
          if (from + k >= data.length) break
          data[from + k] = peaks.data[k]
        }
      }

      // 一段波形都没解出来时不要写一条全零的「直线波形」，
      // 那会让人以为音频是静音的；留给上层用合成峰值或空态兜底
      if (!hasAny) continue

      media.value.set(MERGED_FILE_ID, {
        peaks: {
          peaksPerSecond: RATE,
          data: [...data],
          durationSec: round3(totalDuration.value),
        },
        blobUrl: null,
        loading: i < parts.length - 1,
        error: null,
        parts,
      })
      touchMedia()
    }

    if (!hasAny) {
      media.value.set(MERGED_FILE_ID, { peaks: null, blobUrl: null, loading: false, error: null, parts })
      touchMedia()
    }
  }

  /**
   * 重新生成合并产物。识别完成后调用；队列结构变化时走 onQueueChanged。
   *
   * `buildMergedFile()` 是纯本地计算（遍历文件累加偏移再拼接），不需要重新
   * 识别，所以队列一变就该「重算」而不是「作废」—— 以前的作废会把所有文件
   * 退回待识别、清空合并产物，表现为「在导入页调一下顺序，编辑页就空了」。
   *
   * 注意「重算」不等于「重来」：`buildMergedFile()` 会把上一轮已经参与过的
   * 文件整组保留下来（见该函数的说明），所以用户的编辑不会被冲掉。
   */
  function rebuildMerged(): void {
    if (!isMerge.value) return
    mergedFile.value = buildMergedFile()
    void syncMergedMedia()
  }

  /**
   * 队列结构变化（新增 / 移除 / 重排）后调用。
   *
   * 判据是「队列里有没有已经产出内容的文件」，而不是「有没有合并产物」：
   *   - 导入页刚添加音频（还没识别，个个都没内容）→ 什么都不做，
   *     否则会凭空造出一条空的「合并时间轴」混进文件列表；
   *   - 已经有产物，或者导入的本来就是字幕文件（解析完就有内容）→ 重算。
   *
   * 后一种情况是真踩到的坑：合并模式下清空队列、再直接导入一个 SRT，
   * 那时 `mergedFile` 已被清空，旧写法直接 return，编辑器就永远停在
   * 「合并模式下需要先完成识别」的空状态 —— 文件读进来了却什么都看不见。
   *
   * 这里刻意不再弹「合并结果已作废」的警告：队列调整本来就不该影响已经
   * 识别出来的内容，弹警告反而会让用户以为自己的成果没了。
   */
  function onQueueChanged(): void {
    if (!mergedFile.value && !supportedFiles.value.some((f) => f.segments.length > 0)) return
    rebuildMerged()
  }

  /**
   * 应用 AI 校对的结果。
   *
   * 整体替换该条目的字幕 —— P1 拍板允许大模型重排（删掉识别产生的无意义句子、
   * 合并或拆分条目），因此条数与时间码都可能变化，不能只做逐条文本替换。
   * 写回走 history.commit，编辑器里 Ctrl+Z 可以整体撤回。
   *
   * @returns 是否成功写回
   */
  function applyAiReview(fileId: string, cues: ParsedCue[]): boolean {
    if (cues.length === 0) return false

    const file =
      files.value.find((f) => f.id === fileId) ??
      (mergedFile.value && mergedFile.value.id === fileId ? mergedFile.value : null)
    if (!file) return false

    const history = useHistoryStore()
    const ui = useUiStore()
    const next = cuesToSegments(cues, file.segments)

    history.commit(file.id, file.segments, 'AI 校对', () => {
      file.segments = next
    })

    ui.notify('success', 'AI 校对结果已应用', `${file.name}：${next.length} 条，可用 Ctrl+Z 撤回`)
    return true
  }

  /**
   * 应用翻译结果：按序号把译文贴到条目上。
   *
   * 与 AI 校对最关键的差别 —— **它不改结构**：不动条数、不动时间码、不动原文。
   * 条数一致性在辅助窗口那边已经卡过一道（对不上整份拒绝），这里再兜一次底：
   * 数量不符就直接不写，宁可什么都不发生，也不能错位贴出一堆读起来通顺、
   * 却与画面对不上的译文。
   *
   * 写回走 history.commit，编辑器里 Ctrl+Z 可以整体撤回。
   *
   * @returns 是否成功写回
   */
  function applyTranslation(fileId: string, lang: string, lines: string[]): boolean {
    if (!lang || lines.length === 0) return false

    const file =
      files.value.find((f) => f.id === fileId) ??
      (mergedFile.value && mergedFile.value.id === fileId ? mergedFile.value : null)
    if (!file) return false
    // 条数必须一一对应。译文是按序号贴的，差一条就会从那里开始整体错位
    if (file.segments.length !== lines.length) return false

    const history = useHistoryStore()
    const ui = useUiStore()
    const settings = useSettingsStore()
    const next = applyTranslationTo(file.segments, lang, lines)

    history.commit(file.id, file.segments, '载入译文', () => {
      file.segments = next
    })

    // 记下当前工作语言：译文行与「仅译文」视图都按它取内容
    settings.translationLang = lang
    ui.notify('success', `已载入 ${next.length} 条译文`, `${file.name}：${lang}，可用 Ctrl+Z 撤回`)
    return true
  }

  /**
   * 切换批量处理模式。
   *
   * 识别开始**之前**可以随便改 —— 点选即锁太严苛，用户点错了就没有退路。
   * 真正需要钉死的是「开始识别」那一刻（见 lockBatchMode）：从那时起，切换会让
   * 已经识别出来的内容归属发生变化（先前的成果被卷进合并、时间轴错位、显示错乱），
   * 所以锁定后想改必须先清空队列。
   *
   * @returns 是否接受了这次切换
   */
  function setBatchMode(mode: BatchMode): boolean {
    if (batchModeLocked.value && mode !== batchMode.value) return false
    batchMode.value = mode
    return true
  }

  /** 开始识别即锁定模式：此刻起队列内容与产物归属都不能再变 */
  function lockBatchMode(): void {
    batchModeLocked.value = true
  }

  /* ---------------------------------------------------------------- 操作 */

  function addFiles(list: AudioFile[]): void {
    files.value.push(...list)
    if (!activeFileId.value) {
      const firstSupported = files.value.find((f) => f.status !== 'unsupported')
      activeFileId.value = firstSupported?.id ?? files.value[0]?.id ?? null
    }
    onQueueChanged()
  }

  /**
   * 用绝对路径批量建文件记录。Electron 里「选择文件」和「拖入文件」
   * 最终都汇到这里。大小从主进程的 stat 拿，拿不到就算 0（不影响识别）。
   */
  async function addFilesFromPaths(paths: string[]): Promise<number> {
    const bridge = window.xbaos
    const created: AudioFile[] = []

    for (const p of paths) {
      const ext = extOfPath(p)
      if (!isSupported(ext)) continue

      let size = 0
      if (bridge) {
        try {
          const stat = await bridge.fs.stat(p)
          if (stat.ok && stat.isFile) size = stat.size ?? 0
        } catch {
          /* stat 失败不拦导入 */
        }
      }

      created.push({
        id: `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: nameOf(p),
        path: p,
        dir: dirOf(p),
        ext,
        sizeBytes: size,
        durationSec: null,
        status: 'queued',
        segments: [],
      })
    }

    if (created.length > 0) addFiles(created)
    return created.length
  }

  /**
   * 导入一个字幕文件（SRT / VTT / ASS）。
   *
   * 与音频导入共用同一条目结构：解析出的字幕直接作为识别结果呈现，
   * 状态置为 pending（处理完成），用户在编辑器里改完可以覆盖保存回
   * 原文件或另存。没有音频，波形与播放相关能力自然不可用。
   *
   * @returns 是否成功导入
   */
  async function addSubtitleFromPath(p: string): Promise<boolean> {
    const bridge = window.xbaos
    if (!bridge) return false
    const ui = useUiStore()
    const ext = extOfPath(p)
    if (!isSubtitleExt(ext)) return false

    try {
      const { text, encoding } = await bridge.fs.readTextAuto(p)
      const parsed = parseSubtitle(text, ext)
      if (parsed.segments.length === 0) {
        ui.notify('warning', '没有解析到字幕', '文件里没有可用的字幕条目')
        return false
      }

      // 时长取最后一条的结束时间，让编辑器的时间轴与校验有界可用
      const duration = Math.max(...parsed.segments.map((s) => s.end))
      const file: AudioFile = {
        id: `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: nameOf(p),
        path: p,
        dir: dirOf(p),
        ext,
        sizeBytes: 0,
        durationSec: Number(duration.toFixed(2)),
        status: 'pending',
        segments: parsed.segments,
        subtitleFormat: parsed.format,
        sourceEncoding: encoding,
      }
      addFiles([file])
      ui.notify(
        'success',
        '字幕文件已导入',
        `${nameOf(p)}：${parsed.segments.length} 条（${parsed.format.toUpperCase()}，编码 ${encoding}）`,
      )
      return true
    } catch (err) {
      ui.notify('error', '导入字幕失败', err instanceof Error ? err.message : String(err))
      return false
    }
  }

  function removeFile(id: string): void {
    const media1 = media.value.get(id)
    if (media1?.blobUrl) URL.revokeObjectURL(media1.blobUrl)
    media.value.delete(id)
    touchMedia()
    // 文件都移出队列了，它的导出落点也没有意义了
    exportRecords.value.delete(id)
    savedSignatures.value.delete(id)
    files.value = files.value.filter((f) => f.id !== id)
    if (activeFileId.value === id) {
      activeFileId.value = files.value[0]?.id ?? null
    }
    onQueueChanged()
  }

  function reorder(from: number, to: number): void {
    if (from === to || from < 0 || to < 0) return
    const list = files.value
    if (from >= list.length || to >= list.length) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    onQueueChanged()
  }

  function clearAll(): void {
    for (const m of media.value.values()) {
      if (m.blobUrl) URL.revokeObjectURL(m.blobUrl)
    }
    media.value.clear()
    touchMedia()
    files.value = []
    activeFileId.value = null
    progress.value = 0
    // 清空是唯一能解除模式锁定的入口，所以这里必须一起复位
    mergedMediaToken += 1
    mergedFile.value = null
    batchModeLocked.value = false
    // 模式也一并复位：锁解了却留着「合并时间轴」，下一次导入字幕文件就会掉进
    // 一个没有产物的合并视图里 —— 文件读进来了却什么都看不见。
    // 真踩到过：合并模式 → 清空队列 → 直接拖入 SRT，界面上空空如也。
    batchMode.value = DEFAULT_BATCH_MODE
    // 导出记录指向的是已经不在队列里的文件，一起释放
    exportRecords.value.clear()
    savedSignatures.value.clear()
    finalStatus.clear()
  }

  function setActiveFile(id: string): void {
    activeFileId.value = id
  }

  /**
   * 载入演示数据（浏览器预览专用）
   * @param applyResult 为 true 时直接呈现识别完成后的状态
   */
  function loadDemo(applyResult = false): void {
    finalStatus.clear()
    const list = clone(mockFiles)
    for (const file of list) {
      /* 演示数据必须**自己声明**是演示数据。
       *
       * 播放器 `AudioPlayer.vue` 的 `loadAt()` 靠这个字段区分两种「没有 blobUrl」：
       * 演示数据（正常，播放交给定时器）与导入的字幕文件（真没音频，提示无法试听）。
       * 这个字段曾经只在类型定义里出现过、**全库没有一处赋值** —— 判据恒为
       * undefined，于是演示数据一点播放就被当成无音频段落：置 spanHasNoAudio
       * 并 stopPlayback()，表现为「播放头不动 + 弹『这一段没有音频轨』」。
       */
      file.demo = true
      finalStatus.set(file.id, file.status)
      if (file.status !== 'unsupported') {
        file.status = applyResult ? (finalStatus.get(file.id) ?? 'pending') : 'queued'
      }
    }
    files.value = list
    activeFileId.value = list.find((f) => f.status !== 'unsupported')?.id ?? null
  }

  /* ------------------------------------------------------- 媒体（波形/播放） */

  function mediaOf(fileId: string): FileMedia {
    let m = media.value.get(fileId)
    if (!m) {
      m = { peaks: null, blobUrl: null, loading: false, error: null }
      media.value.set(fileId, m)
      touchMedia()
    }
    return m
  }

  function peaksOf(fileId: string | null): AudioPeaks | null {
    if (!fileId) return null
    void mediaVersion.value // 建立依赖：媒体表一变，这里重新求值
    return media.value.get(fileId)?.peaks ?? null
  }

  /** 读不到音频的真实原因（读取 / 解码失败时非空），给播放器提示用 */
  function mediaErrorOf(fileId: string | null): string | null {
    if (!fileId) return null
    void mediaVersion.value
    return media.value.get(fileId)?.error ?? null
  }

/**
 * Blob 的 MIME 必须跟扩展名走，不能统一写一个类型：
 * 实测（Chromium headless，同一段 WAV 数据）——
 *   type='audio/mpeg' 时元素能解析出时长（元数据是嗅探的），
 *   但解码管线按 MP3 走，播放头卡在 0 附近、无声、界面却显示「播放中」；
 *   type='' 或正确的 'audio/wav' 才正常推进。
 */
const MIME_BY_EXT: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
}

  /**
   * 正在进行的媒体加载任务。
   *
   * **并发调用者必须共享同一个 Promise，不能各自为政。**早期版本用
   * `if (m.loading) return` 直接放走后来的调用者 —— 而真实链路上两个调用方
   * 几乎同时到达：`TimelineTrack` 的 `watch(viewFileId)` 先发起读取，
   * 用户紧接着点「播放」，`AudioPlayer.loadAt()` 再进来一次，拿到的却是
   * 「还没就绪」的空地址，误报「这一段没有音频轨」并且不再设置 `<audio>`
   * 的 src。任务 A 稍后把 blobUrl 备好了，也没有任何代码再触发装载 ——
   * 表现就是「导入自己的音频，检测不到音轨，没声音」。
   */
  const mediaJobs = new Map<string, Promise<void>>()

  async function ensureMedia(fileId: string): Promise<void> {
    const file = files.value.find((f) => f.id === fileId)
    if (!file || file.demo || !window.xbaos) return
    // 字幕导入的条目没有音频，不进媒体管线
    if (!isSupported(file.ext)) return

    const m = mediaOf(fileId)
    if (m.peaks) return
    const running = mediaJobs.get(fileId)
    if (running) return running

    const job = loadMedia(file, m).finally(() => mediaJobs.delete(fileId))
    mediaJobs.set(fileId, job)
    return job
  }

  /**
   * 真正的读取与解码。**失败不抛给调用者**：调用者（loadAt）只看 blobUrl
   * 有没有就绪，失败原因记进 `m.error` 让界面据实提示，读取失败时下次
   * 播放会自然重试（peaks 仍为 null，guard 放行）。
   *
   * 读文件字节后用 AudioContext 解码：Chromium 原生支持 WAV / MP3 /
   * FLAC / OGG / Opus，正好覆盖软件承诺的全部格式，引擎侧不用重复
   * 输出波形数据。解码出峰值后立刻丢掉 PCM（内存大头），
   * 只保留原始压缩字节做的 Blob 交给 <audio> 播放。
   */
  async function loadMedia(file: AudioFile, m: FileMedia): Promise<void> {
    const bridge = window.xbaos
    // ensureMedia 的 guard 已保证桥存在，这里再兜一层纯粹为类型收窄
    if (!bridge) return
    m.loading = true
    m.error = null
    touchMedia()

    try {
      const bytes = await bridge.fs.readArrayBuffer(file.path)

      // Blob 要复制一份：decodeAudioData 会把传进去的 buffer 转移走（detach）
      const forAudio = bytes.slice(0)
      m.blobUrl = URL.createObjectURL(
        new Blob([forAudio], { type: MIME_BY_EXT[file.ext] ?? '' }),
      )
      // 地址一就位就通知：播放器不必等波形解完就能出声
      touchMedia()

      const ctx = new AudioContext()
      try {
        const buf = await ctx.decodeAudioData(bytes)
        const rate = 50 // 每秒 50 个峰值，够画波形了
        const count = Math.ceil(buf.duration * rate)
        const data = new Array<number>(count)

        const chCount = buf.numberOfChannels
        for (let i = 0; i < count; i += 1) {
          const from = Math.floor((i / count) * buf.length)
          const to = Math.max(from + 1, Math.floor(((i + 1) / count) * buf.length))
          let max = 0
          for (let c = 0; c < chCount; c += 1) {
            const ch = buf.getChannelData(c)
            for (let j = from; j < to && j < ch.length; j += 1) {
              const v = Math.abs(ch[j])
              if (v > max) max = v
            }
          }
          data[i] = Math.min(1, max)
        }

        m.peaks = { peaksPerSecond: rate, data, durationSec: buf.duration }
        if (file.durationSec === null) file.durationSec = Number(buf.duration.toFixed(2))
        // 波形到位：时间轴靠这一次通知重画
        touchMedia()
      } finally {
        void ctx.close()
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      m.error = reason
      console.warn('[media] 音频读取/解码失败', file.name, err)
      // 读得到字节时解码失败也能播：只给 blobUrl，不给波形
    } finally {
      m.loading = false
      touchMedia()
    }
  }

  /* -------------------------------------------------------------- 识别 */

  /** 取消当前识别。正在跑的那一步结束后整个流程停止 */
  let cancelRequested = false

  function cancelRecognition(): void {
    if (!recognizing.value) return
    cancelRequested = true
    void window.xbaos?.engine.abort()
  }

  /**
   * 开始识别。
   *
   * 有 Electron 桥时走真实引擎（engine.transcribe + 流式进度 + 标点后处理）；
   * 浏览器预览（无桥）保留演示进度，方便 UI 开发。
   */
  async function startRecognition(): Promise<void> {
    if (recognizing.value) return
    const queue = files.value.filter((f) => f.status === 'queued' || f.status === 'failed')
    if (queue.length === 0) return

    // 一旦开跑，队列与产物归属就定下来了，模式随之锁死
    lockBatchMode()

    const ui = useUiStore()
    const settings = useSettingsStore()
    const history = useHistoryStore()

    // 浏览器预览：没有桥就走旧的模拟进度，演示数据里已备好「结果」
    if (!window.xbaos) {
      recognizing.value = true
      progress.value = 0
      elapsedSec.value = 0
      remainingSec.value = queue.length * 2.2

      const TOTAL_MS = queue.length * 2200
      const startedAt = performance.now()

      await new Promise<void>((resolve) => {
        const timer = window.setInterval(() => {
          const elapsed = performance.now() - startedAt
          const ratio = Math.min(1, elapsed / TOTAL_MS)
          progress.value = Math.round(ratio * 100)
          elapsedSec.value = Math.round(elapsed / 1000)
          remainingSec.value = Math.max(0, Math.round((TOTAL_MS - elapsed) / 1000))

          const index = Math.min(queue.length - 1, Math.floor(ratio * queue.length))
          const current = queue[index]
          if (current) {
            const label = `正在识别 ${current.name}`
            if (progressLabel.value !== label) {
              progressLabel.value = label
              for (const f of queue) {
                if (f.status === 'processing') f.status = finalStatus.get(f.id) ?? 'pending'
              }
              current.status = 'processing'
            }
          }

          if (ratio >= 1) {
            window.clearInterval(timer)
            for (const f of queue) f.status = finalStatus.get(f.id) ?? 'pending'
            recognizing.value = false
            progress.value = 100
            progressLabel.value = ''
            remainingSec.value = 0
            resolve()
          }
        }, 80)
      })
      // 演示数据同样走一遍合并，浏览器里也能看到合并视图的样子
      rebuildMerged()
      return
    }

    // ---- 真实识别 ----
    recognizing.value = true
    cancelRequested = false
    progress.value = 0
    elapsedSec.value = 0
    remainingSec.value = 0

    const engine = window.xbaos.engine
    const language = settings.autoDetectLanguage ? 'auto' : settings.language
    const preset = depthPreset(settings.reasoningDepth)
    const passes = preset.passes
    const terms = settings.promptTerms.trim()
    const threads = threadCount()

    // 基础提示词：手填热词 + 勾选词库（自动去重、预算截断）
    const basePrompt = buildPrompt({ terms, lexiconIds: settings.lexiconIds })

    const startedAt = performance.now()
    let doneCount = 0
    let currentPass = 0

    // 流式进度：只更新整体百分比，字幕段的收集走 done 的完整返回更可靠
    // —— segment 流式消息只用来驱动「当前句」预览，这里不逐条入库。
    const offStream = engine.onStream(({ taskId, msg }) => {
      if (taskId !== currentTaskId.value || msg.type !== 'progress') return
      const perFile = 100 / queue.length
      const perPass = perFile / passes
      progress.value = Math.min(
        99,
        Math.round(doneCount * perFile + currentPass * perPass + (msg.percent * perPass) / 100),
      )
    })

    try {
      for (const file of queue) {
        if (cancelRequested) {
          file.status = 'queued'
          continue
        }

        currentFileId.value = file.id
        file.status = 'processing'

        // 每一遍的结果都留下来，跑完统一整合（见 utils/transcriptMerge.ts）
        const runs: RecognitionRun[] = []
        // 深度模式的第二遍起改用「带精选词」的提示词
        let runPrompt = basePrompt
        let lastResult: Awaited<ReturnType<typeof engine.transcribe>> | null = null
        let failed = false

        for (let k = 0; k < passes; k++) {
          if (cancelRequested) break

          currentPass = k
          currentTaskId.value = `t-${file.id}-${k}`
          progressLabel.value =
            passes > 1 ? `正在识别 ${file.name}（第 ${k + 1}/${passes} 遍）` : `正在识别 ${file.name}`

          // 每个文件每一遍开一个段收集器：流式 segment 用于收集结果，
          // 引擎 done 不回传段落明细
          const collected: SubtitleSegment[] = []

          const off = engine.onStream(({ taskId, msg }) => {
            if (taskId !== currentTaskId.value) return
            if (msg.type === 'segment') {
              const text = msg.text.trim()
              if (!text) return
              collected.push({
                id: `seg_${Date.now().toString(36)}_${collected.length.toString(36)}`,
                start: msg.start,
                end: msg.end,
                text,
                origin: text,
                issues: [],
                avgLogprob: msg.avgLogprob,
              })
            } else if (msg.type === 'fallback') {
              ui.notify('warning', 'GPU 加速不可用，已回退到 CPU', msg.reason)
            }
          })

          let result
          try {
            // 束搜索仅在「深度」档自动启用（高级选项可关）；手动宽度 > 1 时以手填为准
            const deepBeam = settings.beamSearch && preset.id === 'deep' ? 5 : undefined
            result = await engine.transcribe({
              taskId: currentTaskId.value,
              audio: file.path,
              model: settings.modelFile || undefined,
              language,
              prompt: runPrompt.prompt || undefined,
              threads,
              // 变速：温度为 0 时解码是确定性的，多跑几遍结果完全相同，
              // 必须靠微升温度拿到互补候选，整合才有意义
              temperature: preset.temperatures[k] ?? 0,
              beamSize: settings.beamSize > 1 ? settings.beamSize : deepBeam,
              bestOf: settings.bestOf > 1 ? settings.bestOf : undefined,
              vad: settings.vadEnabled,
              // 场景预设开启时把整组切分参数交给引擎；关闭则用引擎默认
              vadOptions: settings.vadSceneEnabled
                ? vadPreset(settings.vadScene).options
                : undefined,
              normalize: settings.normalizeAudio,
              highPass: settings.highPassFilter,
            })
          } finally {
            off()
          }

          if (result.canceled) {
            cancelRequested = true
            break
          }

          if (!result.ok) {
            failed = true
            file.status = 'failed'
            file.message = result.message ?? '识别失败'
            break
          }

          lastResult = result
          runs.push({
            temperature: preset.temperatures[k] ?? 0,
            segments: collected,
            stats: {
              avgLogprob: result.avgLogprob,
              noSpeechRatio: result.noSpeechRatio,
              count: result.count,
              duration: result.duration,
              elapsed: result.elapsed,
            },
          })

          // 两遍策略：第一遍跑完后挑出「这段音频里真的出现过的词库词」，
          // 后续几遍只带这些词 —— 预算全花在刀刃上
          if (preset.twoPass && k === 0 && settings.lexiconIds.length > 0) {
            const present = pickPresentTerms(runText(runs[0]), settings.lexiconIds)
            if (present.length > 0) {
              const refined = buildPrompt({
                terms,
                lexiconIds: settings.lexiconIds,
                preferWords: present,
              })
              if (refined.prompt) runPrompt = refined
            }
          }
        }

        if (failed || runs.length === 0) {
          if (!failed) file.status = 'queued'
          doneCount += 1
          continue
        }

        // ---- 整合多遍结果 ----
        const merged = mergeRuns(runs)
        const chosen = merged.best

        // ---- 低置信度复核：只重跑不可信的那几秒 ----
        // 置信度偏低的片段单独用更高束宽重识别，新结果确实更好才替换。
        // 正常录音里低置信段很少甚至没有，这一步零开销直接跳过。
        if (settings.lowConfRescue && !cancelRequested && !failed && lastResult) {
          const ranges = planRescueRanges(chosen.segments, lastResult.duration ?? 0)
          if (ranges.length > 0) {
            // 进度沿用最后一个 pass 的槽位，标签切换成「复核」
            currentPass = passes - 1
            currentTaskId.value = `t-${file.id}-rescue`
            progressLabel.value = `正在复核低置信段落 ${file.name}`

            const rescued: SubtitleSegment[] = []
            const offRescue = engine.onStream(({ taskId, msg }) => {
              if (taskId !== currentTaskId.value || msg.type !== 'segment') return
              const text = msg.text.trim()
              if (!text) return
              rescued.push({
                id: `seg_${Date.now().toString(36)}_${rescued.length.toString(36)}`,
                start: msg.start,
                end: msg.end,
                text,
                origin: text,
                issues: [],
                avgLogprob: msg.avgLogprob,
              })
            })

            try {
              await engine.transcribe({
                taskId: currentTaskId.value,
                audio: file.path,
                model: settings.modelFile || undefined,
                language,
                prompt: basePrompt.prompt || undefined,
                threads,
                temperature: 0,
                beamSize: RESCUE_BEAM_SIZE,
                vad: false,
                ranges,
              })
            } finally {
              offRescue()
            }

            if (!cancelRequested && rescued.length > 0) {
              const applied = applyRescue(chosen.segments, rescued, ranges)
              if (applied.replaced > 0) chosen.segments = applied.segments
            }
          }
        }

        // ---- 时间轴夹成单调：重叠的两条在这里被拉开 ----
        // 引擎侧 VAD 对连续说话超过 24 秒的段落会硬切，块间刻意留 1 秒音频重叠
        // （否则容易把词切两半），重叠区的文本已裁掉、时间码却是原样发的。
        // 不夹的话用户会看到「相邻两条字幕重叠，上一条结束时间偏长」。
        const monotonic = enforceMonotonicCues(chosen.segments)

        // ---- 标点后处理：识别结果进入编辑器之前完成 ----
        const processed = applyPunctuation(monotonic, settings.punctuation)

        // 只保留有实际内容的条目。模型在纯静音上偶尔会吐出一个孤零零的句号，
        // 留着会让整段识别看起来像「什么都没识别出来」
        const kept = processed.segments.filter((s) => hasContent(s.text))
        const noiseCount = processed.segments.length - kept.length

        // ---- 字幕规格落位：单行字数 / 行数上限在识别结果上即刻生效 ----
        // 超出的条目按宽度折行，折不下的按占比拆时间成多条 —— 否则设置了
        // 「单行 16 字」识别结果却全是 20 字长句，规格形同虚设。
        const wrapped = applyLineWrap(kept, {
          maxCharsPerLine: settings.maxCharsPerLine,
          maxCharsPerLineEn: settings.maxCharsPerLineEn,
          maxLinesPerSegment: settings.maxLinesPerSegment,
        })

        /*
         * 到这里为止，用户一个字都还没碰过，所以「第一次呈现给用户时的文本」
         * 就是 `wrapped` 里的这个结果。上面各步（繁转简、标点后处理、按规格
         * 折行）都会改写 text 却不同步 origin，若不在这里对齐一次，识别一完成
         * 就有一批条目顶着「已改动」的小圆点 —— 那个圆点本该只表示人改过。
         */
        const baseline = alignOrigin(wrapped.segments)

        // 用历史提交的方式写入，识别结果本身也可以整体撤销
        history.commit(file.id, file.segments, '识别结果', () => {
          file.segments = baseline
          file.durationSec = lastResult?.duration ?? file.durationSec
          file.status = 'pending'
          file.message = undefined
        })

        if (processed.splitCount > 0 || processed.strippedCount > 0) {
          const parts: string[] = []
          if (processed.strippedCount > 0) parts.push(`去除 ${processed.strippedCount} 条的停顿标点`)
          if (processed.splitCount > 0) parts.push(`按标点切分出 ${processed.splitCount} 条`)
          ui.notify('info', '标点后处理完成', parts.join('，'))
        }

        if (wrapped.splitCount > 0) {
          ui.notify(
            'info',
            '已按字幕规格排版',
            `超长条目按单行上限折行并拆分为多条（新增 ${wrapped.splitCount} 条）`,
          )
        } else if (wrapped.rewrapped > 0) {
          ui.notify('info', '已按字幕规格排版', `${wrapped.rewrapped} 条按单行上限折行`)
        }

        // 只有标点、没有实际内容的条目被清掉时单独说明一次，
        // 否则用户看到「0 条」会以为是识别失败
        if (kept.length === 0 && noiseCount > 0) {
          ui.notify(
            'warning',
            `${file.name} 没有识别到有效内容`,
            `模型只在这段音频上输出了标点（${noiseCount} 条），已丢弃。建议检查音频或改用「标准」推理深度重试`,
          )
        }

        // 引擎的提示（整段没人声、跳过静音、多遍整合方式）如实转达给用户
        if (lastResult?.warning) {
          ui.notify('info', `${file.name}：${lastResult.warning}`)
        }
        if (passes > 1) {
          const extras: string[] = [merged.reason]
          if (kept.length === 0) extras.push('未识别出内容，建议检查音频或调高推理深度')
          ui.notify('success', `${file.name} 多遍识别完成`, extras.join('；'))
        } else if ((lastResult?.skipped ?? 0) > 0) {
          ui.notify(
            'info',
            `${file.name} 已跳过长静音`,
            `跳过 ${lastResult?.skipped} 段静音，共 ${lastResult?.chunks ?? 1} 个识别块`,
          )
        }

        doneCount += 1
        currentPass = 0
        elapsedSec.value = Math.round((performance.now() - startedAt) / 1000)
        const speed = doneCount > 0 ? elapsedSec.value / doneCount : 0
        remainingSec.value = Math.max(0, Math.round(speed * (queue.length - doneCount)))
        progress.value = Math.round((doneCount / queue.length) * 100)
      }

      // 每段音频都跑完了才拼合并产物：偏移量依赖各段的真实时长，而这些
      // 时长要等引擎回报。中途取消就不拼，避免把残缺结果当成成品
      if (!cancelRequested) {
        if (isMerge.value) {
          rebuildMerged()
        } else {
          // 识别完跳去编辑器时，视图要落在**本轮**的成果上。
          // 不这么做的话 activeFileId 还停在上一次识别选中的文件上，
          // 用户看到的是旧内容，得手动点一遍才找到刚识别好的。
          const firstDone = queue.find((f) => f.status !== 'failed' && f.segments.length > 0)
          if (firstDone) activeFileId.value = firstDone.id
        }
      }
    } catch (err) {
      // 引擎进程崩溃或 IPC 异常：把正在跑的文件标记失败，其余退回队列
      const current = files.value.find((f) => f.id === currentFileId.value)
      if (current && current.status === 'processing') {
        current.status = 'failed'
        current.message = err instanceof Error ? err.message : String(err)
      }
      for (const f of queue) {
        if (f.status === 'processing') {
          f.status = 'failed'
          f.message = f.message ?? '识别中断'
        }
      }
      ui.notify('error', '识别中断', err instanceof Error ? err.message : String(err))
    } finally {
      offStream()
      recognizing.value = false
      progressLabel.value = ''
      currentFileId.value = null
      progress.value = cancelRequested ? 0 : 100
      cancelRequested = false
    }
  }

  /** 接收拖入的文件：Electron 里取真实路径入库，浏览器里退回演示数据 */
  function receiveDroppedFiles(list: File[]): void {
    const ui = useUiStore()
    const bridge = window.xbaos

    if (!bridge) {
      // 浏览器预览：拿不到真实路径，沿用演示工厂
      const accepted: AudioFile[] = []
      const rejected: { name: string; ext: string; reason: string }[] = []

      for (const file of list) {
        if (isSupported(file.name)) {
          accepted.push(makeAudioFile(file.name, file.size, PREVIEW_DIR))
        } else {
          rejected.push({
            name: file.name,
            ext: extOf(file.name),
            reason: unsupportedReason(file.name),
          })
        }
      }

      if (accepted.length > 0) addFiles(accepted)
      if (rejected.length > 0) ui.openDialog('unsupported-format', { items: rejected })
      return
    }

    // Electron：webUtils 取真实绝对路径。音频与字幕分两路：
    // 音频进识别队列，字幕文件解析后直接进编辑器。
    const accepted: string[] = []
    const subtitles: string[] = []
    const rejected: { name: string; ext: string; reason: string }[] = []

    for (const file of list) {
      const realPath = bridge.pathForFile(file)
      if (!realPath) continue
      if (isSubtitleExt(extOf(file.name))) {
        subtitles.push(realPath)
      } else if (isSupported(file.name)) {
        accepted.push(realPath)
      } else {
        rejected.push({
          name: file.name,
          ext: extOf(file.name),
          reason: unsupportedReason(file.name),
        })
      }
    }

    if (accepted.length > 0) void addFilesFromPaths(accepted)
    for (const p of subtitles) void addSubtitleFromPath(p)
    if (rejected.length > 0) ui.openDialog('unsupported-format', { items: rejected })
  }

  return {
    files,
    batchMode,
    batchModeLocked,
    mergedFile,
    activeFileId,
    recognizing,
    progress,
    progressLabel,
    elapsedSec,
    remainingSec,
    currentFileId,
    media,
    supportedFiles,
    unsupportedFiles,
    hasFiles,
    activeFile,
    isMerge,
    mergedParts,
    viewFile,
    viewFileId,
    totalDuration,
    totalSegments,
    errorCount,
    warningCount,
    pendingReviewCount,
    unsupportedExts,
    outputDirs,
    addFiles,
    addFilesFromPaths,
    addSubtitleFromPath,
    removeFile,
    reorder,
    clearAll,
    setActiveFile,
    exportRecords,
    rememberExport,
    exportRecordsOf,
    savedSignatures,
    markSaved,
    unsavedSummary,
    setBatchMode,
    applyAiReview,
    applyTranslation,
    loadDemo,
    startRecognition,
    cancelRecognition,
    receiveDroppedFiles,
    ensureMedia,
    peaksOf,
    mediaErrorOf,
    mediaVersion,
  }
})
