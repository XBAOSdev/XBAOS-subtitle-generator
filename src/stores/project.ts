import { defineStore } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'
import type {
  AudioFile,
  AudioPeaks,
  BatchMode,
  ExportLangBundle,
  FileStatus,
  SegmentIssue,
  SubtitleSegment,
} from '@/types'
import { makeAudioFile, mockFiles } from '@/mock/mockData'
import { extOf, isSupported, unsupportedReason, isSubtitleExt } from '@/utils/formats'
import { parseSubtitle } from '@/utils/subtitleParse'
import { dirOf, nameOf, extOfPath, stemOf, joinPath } from '@/utils/path'
import { applyPunctuation, hasContent } from '@/utils/punctuation'
import { buildPrompt, pickPresentTerms } from '@/utils/prompt'
import { depthPreset } from '@/utils/reasoningDepth'
import { mergeRuns, runText, type RecognitionRun } from '@/utils/transcriptMerge'
import { applyRescue, planRescueRanges, RESCUE_BEAM_SIZE } from '@/utils/lowConfRescue'
import { applyLineWrap } from '@/utils/lineWrap'
import { buildWrapWords } from '@/utils/wrapWords'
import { vadPreset } from '@/data/vadPresets'
import {
  applyTranslation as applyTranslationTo,
  cuesToSegments,
  mergeCuesIntoSelection,
  type ParsedCue,
} from '@/utils/llmResult'
import { validateSegment, countIssues } from '@/utils/validate'
import { alignOrigin, enforceMonotonicCues, hasText, segmentsSignature } from '@/utils/segmentOps'
import { applyTermFix, collectFixTerms } from '@/utils/termFix'
import { assignSpeakers } from '@/utils/speaker'
import { MAX_LANES, overflowLaneIds } from '@/utils/timelineLayout'
import { useUiStore } from '@/stores/ui'
import { useLogStore } from '@/stores/logs'
import { useSettingsStore } from '@/stores/settings'
import { useModelStore } from '@/stores/model'
import { useHistoryStore } from '@/stores/history'
import { useSpeakerStore } from '@/stores/speakers'
import { buildProjectDoc, fromProjectText, toProjectText } from '@/utils/xbsgp'
import { appVersion } from '@/branding'
import {
  defaultProjectName,
  isProjectPath,
  projectFileName,
  samePath,
  sanitizeFileName,
} from '@/utils/projectName'
import type { ProjectDoc } from '@/types'

/**
 * 浏览器预览模式下文件没有真实路径，统一给一个演示目录。
 * Electron 里走 pathForFile / dialog.pickAudio，拿到的一律是真实路径。
 */
const PREVIEW_DIR = 'D:\\Import'

/**
 * 项目视图的虚拟条目 id。
 *
 * 它不是文件，而是「一个项目的全部子项目按顺序拼接成的那一条时间轴」的标识。
 * 编辑器、校验、导出、回退记录在项目视图下都以它为准。
 *
 * 值沿用历史上的 `__merged__`：media（波形）／exportRecords（导出落点）／
 * speakers（讲话人表）都按这个键存过数据，改名只会换来一次没有收益的迁移。
 */
export const MERGED_FILE_ID = '__merged__'

/** 视图文件在拼接意义上的扩展名，用来区分「这不是一个真实音频」 */
export const MERGED_EXT = 'merged'

/**
 * 批量处理的默认模式：独立处理。
 * 清空队列时会复位到这里 —— 「清空」是彻底重来，不该把上一次的合并模式留下。
 */
export const DEFAULT_BATCH_MODE: BatchMode = 'separate'

/**
 * 识别进度的三个阶段。
 *
 * `prepare` 与 `diarize` 都是**总量未知**的工作（解码/加载模型、聚类），
 * 硬算一个百分比只会让进度条停住；`decode` 才有模型给的真实百分比。
 */
export type ProgressStage = 'idle' | 'prepare' | 'decode' | 'diarize'

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

  /* ------------------------------------------------------------ 项目元信息 */

  /**
   * 项目名。
   *
   * 空串表示「还没算过」，此时显示名取 `defaultProjectName(子项目名)` ——
   * 项目名只在建项目时算一次，之后删第一个子项目、改子项目名都不再跟着变，
   * 所以这里不能做成跟随子项目的 computed，只能是一个可以由用户覆盖的值。
   */
  const projectName = ref('')
  /** 项目文件路径。null = 还没落过盘（侧栏要标「未保存」） */
  const projectPath = ref<string | null>(null)
  /**
   * 有没有未保存到 `.xbsgp` 的改动。
   *
   * 与 `savedSignatures`（导出落点那套）是两回事：那个回答「导出的成品是不是
   * 最新的」，这个回答「工程本身存过没有」。P0 先把两个都留着，等就地保存
   * 挪进导出弹窗之后再合并成一条。
   */
  const projectDirty = ref(false)
  /** 上一次保存项目时选的目录，下次对话框默认落到这里 */
  const lastProjectDir = ref('')

  const activeFileId = ref<string | null>(null)

  const recognizing = ref(false)
  const progress = ref(0)
  const progressLabel = ref('')
  /**
   * 进度所处的阶段（只用于文案与日志，不再改变进度条的形态）。
   *
   * 三段：
   *  - `prepare`  预处理：解码音频、加载模型，这一段引擎报不出百分比
   *  - `decode`   识别：模型给的真实百分比
   *  - `diarize`  分离：引擎给的真实百分比
   */
  const progressStage = ref<ProgressStage>('idle')
  /**
   * 当前这一段**拿不到**可信的百分比（预处理 / 分离聚类）。
   *
   * 曾经据此把进度条切成「短条来回滑」的不确定态，结果是：一有进度就切回
   * 数字条、一超时就切回滑动条，2.5 秒来回一次 —— 观感上就是进度条在跳，
   * 原本连贯的推进也被切碎了。现在**界面不再跟着它换形态**，进度条老老实实
   * 按百分比走；「现在到底在等什么」交给进度区悬停弹出的运行日志回答。
   */
  const progressStalled = ref(false)
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
    /*
     * 项目视图的签名要**按子项目拆开记**：`unsavedSummary()` 是逐个条目
     * 判断的，如果只在 `MERGED_FILE_ID` 上记一份拼接签名，各子项目永远
     * 对不上，关窗时就会误报「全都没保存」。
     */
    if (fileId === MERGED_FILE_ID) {
      for (const f of supportedFiles.value) {
        savedSignatures.value.set(f.id, segmentsSignature(f.segments))
      }
      savedSignatures.value.set(MERGED_FILE_ID, segmentsSignature(segments))
      return
    }
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
   * 项目显示名。
   *
   * 用户改过（`projectName` 非空）就用他的；没改过就现算一个默认名 ——
   * 「第一个子项目名去扩展名，多个加『等』」。默认名**不写回** `projectName`：
   * 写回去之后就再也分不清"这是用户起的"还是"我们替他起的"，删掉第一个
   * 子项目时也没法再跟着变。
   */
  const displayProjectName = computed(() => {
    if (projectName.value.trim()) return projectName.value.trim()
    return defaultProjectName(supportedFiles.value.map((f) => f.name))
  })

  /* ------------------------------------------------------ 项目视图（拼接） */

  /**
   * 各子项目在项目时间轴上的起点。
   *
   * **派生值，不存盘**：第 i 个的偏移 = 前面所有子项目时长之和。换顺序、
   * 重识别后时长变了、换音频，都只是让这张表重算一次 —— 一条字幕数据都不用
   * 搬动。这就是「子项目各自独立存、显示时首尾相接」的全部收益。
   */
  const itemOffsets = computed<MergedPart[]>(() => {
    const out: MergedPart[] = []
    let offset = 0
    for (const f of supportedFiles.value) {
      const durationSec = f.durationSec ?? 0
      out.push({ fileId: f.id, offsetSec: round3(offset), durationSec })
      offset += durationSec
    }
    return out
  })

  /** 某个子项目的起点秒数。找不到时按 0 处理（比抛错温和，界面不会因此白屏） */
  function offsetOfItem(id: string): number {
    return itemOffsets.value.find((p) => p.fileId === id)?.offsetSec ?? 0
  }

  /**
   * 拼接后的全部字幕：本地时间码 + 偏移，并标上来源子项目。
   *
   * 返回的是**拷贝**：调用方写进去不会直接改到存储层，必须整份赋回来
   * （`viewFile.segments = …` 由 setter 拆回各子项目）。这条约定是 3 处
   * 「直接写下标」的编辑点必须改成 store 方法的根本原因。
   *
   * 不过滤空文本：识别结果在入库前已经滤过一遍（`startRecognition` 里），
   * 这里再滤会让「用户把某条文字清空」变成「这一条凭空消失」。
   */
  function concatSegments(): SubtitleSegment[] {
    const out: SubtitleSegment[] = []
    for (const f of supportedFiles.value) {
      const offset = offsetOfItem(f.id)
      for (const seg of f.segments) {
        out.push({
          ...seg,
          originFileId: f.id,
          start: round3(seg.start + offset),
          end: round3(seg.end + offset),
        })
      }
    }
    return out
  }

  /**
   * 绝对时间码落在哪个子项目的区间里。
   *
   * 边界取左闭右开：正好落在交界处的条目归**后**一个，否则交叉点上的字幕会
   * 被塞回上一段的末尾，看起来像"跑到别人的时间轴里了"。
   */
  function ownerAtTime(t: number): string {
    const list = supportedFiles.value
    for (let i = 0; i < list.length; i += 1) {
      const offset = offsetOfItem(list[i].id)
      const duration = list[i].durationSec ?? 0
      if (t >= offset && t < offset + duration) return list[i].id
    }
    // 落在所有区间之外（拖到末尾之后、或项目里全是零时长条目）→ 归最后一个
    return list.length > 0 ? list[list.length - 1].id : ''
  }

  /**
   * 把拼接视图的整份内容拆回各子项目。
   *
   * 归属按 `originFileId`（视图拷贝上一定带着），没有标记的是用户新加的
   * 条目，按绝对时间码归入区间。写回时减掉偏移、剥掉标记 —— 存储层永远
   * 只放本地时间码，`originFileId` 只是视图层的东西，落盘也不写它。
   */
  function spreadSegments(next: SubtitleSegment[]): void {
    const list = supportedFiles.value
    const known = new Set(list.map((f) => f.id))
    const groups = new Map<string, SubtitleSegment[]>()
    const pushTo = (id: string, seg: SubtitleSegment): void => {
      const arr = groups.get(id)
      if (arr) arr.push(seg)
      else groups.set(id, [seg])
    }

    for (const seg of next) {
      const owner = seg.originFileId
      if (owner && known.has(owner)) pushTo(owner, seg)
      else pushTo(ownerAtTime(seg.start), seg)
    }

    for (const f of list) {
      const offset = offsetOfItem(f.id)
      const arr = (groups.get(f.id) ?? [])
        .map((seg) => {
          const { originFileId: _drop, ...rest } = seg
          return {
            ...rest,
            start: round3(seg.start - offset),
            end: round3(seg.end - offset),
          }
        })
        // 排序是必须的：视图里可以乱序交回（合并、拆分都会重排），
        // 存储层按时间码有序，后面的校验与折行都默认这件事成立
        .sort((a, b) => a.start - b.start)
      f.segments = arr
    }
  }

  /**
   * 构造项目视图条目。
   *
   * `segments` 用访问器而不是快照：写回时自动拆到各子项目，读时自动拼回来。
   * 现有编辑链路的形态是 `file = viewFile; file.segments = …`，21 处赋值式
   * 因此完全不用改。
   */
  function makeViewFile(): AudioFile | null {
    const list = supportedFiles.value
    if (list.length === 0) return null
    const first = list[0]
    const view: AudioFile = {
      id: MERGED_FILE_ID,
      name: displayProjectName.value,
      path: first.path,
      dir: first.dir,
      ext: MERGED_EXT,
      sizeBytes: 0,
      durationSec: totalDuration.value,
      status: 'pending',
      segments: [],
      // 演示数据（浏览器预览）没有真实音频，波形交给合成峰值
      demo: list.every((f) => f.demo === true),
    }
    Object.defineProperty(view, 'segments', {
      get: () => concatSegments(),
      set: (next: SubtitleSegment[]) => spreadSegments(next),
      enumerable: true,
      configurable: true,
    })
    return view
  }

  /**
   * 编辑器 / 波形 / 播放器 / 工具栏统一看这个「当前视图条目」。
   *
   * 独立模式下就是被选中的那个文件；合并模式下是项目视图 —— 整个项目呈现为
   * 一条完整的时间轴，点队列里的某个音频不会换掉预览内容。
   */
  const viewFile = computed<AudioFile | null>(() =>
    isMerge.value ? makeViewFile() : activeFile.value,
  )

  const viewFileId = computed(() => viewFile.value?.id ?? null)

  /** 合并模式下参与拼接的分段表（波形按段解码后拼接，顺序加载避免顶爆内存） */
  const mergedParts = computed<MergedPart[]>(() => itemOffsets.value)

  /** 合并模式下的总时长（用真实时长累加，不用最后一条字幕的时间码） */
  const totalDuration = computed(() =>
    supportedFiles.value.reduce((sum, f) => sum + (f.durationSec ?? 0), 0),
  )

  /**
   * 参与跨项目讲话人对应关系的条目：**一个子项目一列**。
   *
   * 早先合并模式下只给一列「合并时间轴」，于是各段的讲话人全挤在同一格里 ——
   * 两段各有一位「讲话人 1」，表上分不出谁是第一段那个、谁是第二段那个，
   * 想让它们「其实是同一个人」都无从下手。
   *
   * 编号是子项目本地的（两个子项目都有 0 号很正常），所以列必须按子项目分；
   * 「是不是同一个人」由 `mapping` 显式指定，推断只认用户起的名字。
   */
  const speakerMappingFiles = computed(() =>
    supportedFiles.value.map((f) => ({
      id: f.id,
      name: f.name,
      durationSec: f.durationSec ?? 0,
      segments: f.segments,
    })),
  )

  const totalSegments = computed(() =>
    isMerge.value
      ? concatSegments().length
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
    return parts.join('\u0001')
  }

  /** 规格签名：改了设置也要重新校验一遍 */
  const specSignature = computed(
    () =>
      `${settings.maxCharsPerLine}|${settings.maxCharsPerLineEn}|` +
      `${settings.maxLinesPerSegment}|${settings.maxSegmentDuration}`,
  )

  /** 校验规格。改设置时它变，校验结论跟着重算 */
  function specOf() {
    return {
      maxCharsPerLine: settings.maxCharsPerLine,
      maxCharsPerLineEn: settings.maxCharsPerLineEn,
      maxLinesPerSegment: settings.maxLinesPerSegment,
      maxSegmentDuration: settings.maxSegmentDuration,
    }
  }

  /**
   * 算出一整条时间轴上每条的校验结论（只算不写）。
   *
   * 抽出来是因为要算两遍：一次按各子项目**自己的**时间码，一次按**拼接后**的
   * 时间码。后者才能发现「上一段末尾与下一段开头重叠」这种跨边界的毛病，
   * 而前者是独立模式下唯一成立的算法。
   */
  function computeIssues(segments: SubtitleSegment[]): Map<string, SegmentIssue[]> {
    const spec = specOf()
    const overflow = overflowLaneIds(segments)
    const out = new Map<string, SegmentIssue[]>()
    for (let i = 0; i < segments.length; i += 1) {
      const next = validateSegment(segments[i], segments[i - 1], spec)
      if (overflow.has(segments[i].id)) {
        next.push({
          level: 'error',
          code: 'LANE_OVERFLOW',
          message: `同一时刻重叠的字幕超过 ${MAX_LANES} 条`,
        })
      }
      out.set(segments[i].id, next)
    }
    return out
  }

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
    const issues = computeIssues(segments)
    for (const seg of segments) {
      const next = issues.get(seg.id) ?? []
      const cur = seg.issues
      if (cur.length === next.length && cur.every((issue, k) => issue.code === next[k].code)) {
        continue
      }
      seg.issues = next
    }
  }

  /**
   * 合并模式下按**拼接视图**重算，再把结论写回各子项目。
   *
   * 视图里的条目是拷贝（`concatSegments()`），算出来的 conclusions 挂在拷贝上
   * 就丢了 —— 必须按 id 找回来写进存储层，否则界面上永远看不到校验结果。
   */
  function applyViewIssues(): void {
    const issues = computeIssues(concatSegments())
    for (const f of files.value) {
      if (f.status === 'unsupported') continue
      for (const seg of f.segments) {
        const next = issues.get(seg.id)
        if (!next) continue
        const cur = seg.issues
        if (cur.length === next.length && cur.every((issue, k) => issue.code === next[k].code)) {
          continue
        }
        seg.issues = next
      }
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
    // 合并模式再按拼接时间码算一遍，覆盖上面按子项目算出来的结论
    if (isMerge.value) applyViewIssues()
  }

  // 字幕或规格一变就重算。flush: 'post' 让它排在渲染之后，不挡用户输入
  watch([validationSignature, specSignature], revalidate, { flush: 'post', immediate: true })

  /**
   * 内容一变就标「工程有未保存的改动」。
   *
   * 挂在签名上而不是散落到 30 个编辑点：那些点清一色是 `segments = …`，
   * 逐个补 `projectDirty = true` 一定会漏一个，而漏掉的那个正好是用户
   * 关窗时丢掉的那段工作。
   *
   * `suppressDirty` 是给「打开项目」用的：整套替换 files 会让签名变一次，
   * 那不是用户的改动，不该把刚打开的项目标成脏的。
   */
  let suppressDirty = false
  watch(validationSignature, () => {
    if (suppressDirty) return
    if (supportedFiles.value.length > 0) projectDirty.value = true
  })

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
    if (isMerge.value) return countIssues(concatSegments()).errors
    return supportedFiles.value.reduce((n, f) => n + countIssues(f.segments).errors, 0)
  })

  const warningCount = computed(() => {
    if (isMerge.value) return countIssues(concatSegments()).warnings
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
   * 重算合并视图的波形。
   *
   * 名字保留成 `rebuildMerged` 是有意的：调用点（识别结束、队列变动）说的
   * 都是「拼接关系变了，重新拼一遍」。但现在**没有产物需要重建** —— 视图是
   * 派生的，偏移是现算的，唯一还需要动手的只有波形（它需要真的解码音频）。
   *
   * 这一句就是「独立存 + 拼接显示」换来的简化：以前整段 `buildMergedTimeline`
   * 的增量保留逻辑（哪些条目该留、哪些该重生）全部消失了，因为拼接不再产生
   * 数据，也就不存在「重拼会把用户的修改冲掉」这个坑。
   */
  function rebuildMerged(): void {
    if (!isMerge.value) return
    void syncMergedMedia()
  }

  /**
   * 队列结构变化（新增 / 移除 / 重排）后调用。
   *
   * 判据是「有没有已经产出内容的条目」：
   *   - 刚导入音频（还没识别，个个都没内容）→ 不解码波形，省掉无用的重活；
   *   - 已有内容，或导入的本来就是字幕文件（解析完就有内容）→ 重算波形。
   *
   * 视图本身不需要"重算"：偏移是 `itemOffsets` 现算的，改顺序、加文件、
   * 删文件都会让它自动变对。这里只处理需要真解码的那一件事。
   *
   * 也刻意不弹「合并结果已作废」的警告：队列调整本来就不该影响已经识别出来
   * 的内容，弹警告反而会让用户以为自己的成果没了。
   */
  function onQueueChanged(): void {
    if (!isMerge.value) return
    if (!supportedFiles.value.some((f) => f.segments.length > 0)) return
    rebuildMerged()
  }

  /**
   * 按 id 取一个「可写回的编辑目标」。
   *
   * 项目视图的 id（`MERGED_FILE_ID`）返回带访问器的那条视图 —— 往里写
   * `segments` 会自动按 `originFileId` 拆回各子项目、并减掉偏移；其余 id
   * 直接走存储层。AI 校对、翻译、回退恢复都经这里，不必各自判断模式。
   */
  function targetOf(fileId: string | null): AudioFile | null {
    if (!fileId) return null
    if (fileId === MERGED_FILE_ID) return isMerge.value ? viewFile.value : null
    return files.value.find((f) => f.id === fileId) ?? null
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
  function applyAiReview(fileId: string, cues: ParsedCue[], ids?: string[]): boolean {
    if (cues.length === 0) return false

    const file = targetOf(fileId)
    if (!file) return false

    /*
     * 分段校对：`ids` 是这次交给 AI 的那一段条目。
     *
     * 必须逐个校验它们在这个文件里还存在 —— 工程可能已经被改过（删了条目、
     * 清空重识别）。对不上的时候宁可什么都不做，也不能把结果按位置贴到
     * 别的条目上：那样错误读起来完全通顺，用户根本发现不了。
     */
    const scope = Array.isArray(ids) && ids.length > 0 ? ids : null
    if (scope) {
      const known = new Set(file.segments.map((s) => s.id))
      if (!scope.every((id) => known.has(id))) return false
    }

    const history = useHistoryStore()
    const ui = useUiStore()
    // 范围外的条数要在写回**之前**算：commit 的回调是同步执行的，写完再数就变了
    const rest = scope ? file.segments.length - scope.length : 0
    const next = scope
      ? mergeCuesIntoSelection(file.segments, cues, scope)
      : cuesToSegments(cues, file.segments)

    history.commit(file.id, file.segments, 'AI 校对', () => {
      file.segments = next
    })

    if (scope) {
      ui.notify(
        'success',
        'AI 校对结果已应用',
        `${file.name}：这一段 ${scope.length} 条整理为 ${cues.length} 条，其余 ${rest} 条保持不变，可用 Ctrl+Z 撤回`,
      )
    } else {
      ui.notify('success', 'AI 校对结果已应用', `${file.name}：${next.length} 条，可用 Ctrl+Z 撤回`)
    }
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
  function applyTranslation(fileId: string, lang: string, lines: string[], ids?: string[]): boolean {
    if (!lang || lines.length === 0) return false

    const file = targetOf(fileId)
    if (!file) return false

    // 分段翻译：`ids` 是这次交给 AI 的那一段，条数必须与译文完全一致，
    // 并且每个 id 都得还在（工程可能已被改过）。对不上就不写，绝不按位置猜。
    const scope = Array.isArray(ids) && ids.length > 0 ? ids : null
    if (scope) {
      if (scope.length !== lines.length) return false
      const known = new Set(file.segments.map((s) => s.id))
      if (!scope.every((id) => known.has(id))) return false
    } else if (file.segments.length !== lines.length) {
      // 整份翻译：条数必须一一对应，差一条就会从那里开始整体错位
      return false
    }

    const history = useHistoryStore()
    const ui = useUiStore()
    const settings = useSettingsStore()
    const next = applyTranslationTo(file.segments, lang, lines, scope ?? undefined)

    history.commit(file.id, file.segments, '载入译文', () => {
      file.segments = next
    })

    // 记下当前工作语言：译文行与「仅译文」视图都按它取内容
    settings.translationLang = lang
    ui.notify(
      'success',
      `已载入 ${scope ? scope.length : next.length} 条译文`,
      scope
        ? `${file.name}：${lang}，只写了这一段，其余条目的译文未改动，可用 Ctrl+Z 撤回`
        : `${file.name}：${lang}，可用 Ctrl+Z 撤回`,
    )
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
    /*
     * 「共用一套称呼」的默认值跟着模式走：合并成一条时间轴，本来就是一条
     * 完整的时间线，讲话人自然是一套；独立处理时各文件各拍各的，默认不该绑。
     *
     * **换模式就是换一套默认**：上一版留了「用户点过就再也不自动改」的例外，
     * 结果是「合并过再切回独立处理，勾选框还留着勾」—— 独立处理下几个文件
     * 根本互不相干，却共享一套称呼，正是这个开关不该有的状态。
     * 所以切模式时一律重置，用户想留着自己再点一下。
     */
    useSpeakerStore().shared = mode === 'merge'
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
    // 加减文件不改字幕签名（新文件还没有字幕），所以这里单独标一次
    if (!suppressDirty) projectDirty.value = true
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
        // 记一份「字幕从哪来」：`path` 之后可能被映射成音频
        subtitlePath: p,
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
    if (!suppressDirty) projectDirty.value = true
    onQueueChanged()
  }

  function reorder(from: number, to: number): void {
    if (from === to || from < 0 || to < 0) return
    const list = files.value
    if (from >= list.length || to >= list.length) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    if (!suppressDirty) projectDirty.value = true
    onQueueChanged()
  }

  /* ------------------------------------------- 编辑：三处「直接写下标」的出口 */

  /**
   * 在存储层里按 id 找一条字幕。
   *
   * 三处编辑点（忽略告警、替换单条、插入单条）以前都是 `file.segments[at] = …`
   * 直接写下标。项目视图的 `segments` 是 getter 返回的拷贝，写下标改的是那份
   * 临时数组，**不会生效也不报错** —— 这类"看起来改成功了、其实什么都没发生"
   * 的 bug 最难查，所以统一收口到下面三个方法。
   */
  function locateSegment(segId: string): { item: AudioFile; seg: SubtitleSegment } | null {
    for (const f of files.value) {
      if (f.status === 'unsupported') continue
      const seg = f.segments.find((s) => s.id === segId)
      if (seg) return { item: f, seg }
    }
    return null
  }

  /** 绝对时间码 → 目标子项目的本地条目（剥掉视图标记） */
  function toLocal(itemId: string, seg: SubtitleSegment): SubtitleSegment {
    const offset = offsetOfItem(itemId)
    const { originFileId: _drop, ...rest } = seg
    return {
      ...rest,
      start: round3(seg.start - offset),
      end: round3(seg.end - offset),
    }
  }

  /** 把某条标记为「告警我已看过」/ 取消标记 */
  function setAcked(segId: string, acked: boolean): void {
    const target = locateSegment(segId)
    if (!target) return
    const at = target.item.segments.findIndex((s) => s.id === segId)
    if (at < 0) return
    const next = { ...target.item.segments[at] }
    if (acked) next.acked = true
    else delete next.acked
    const arr = [...target.item.segments]
    arr[at] = next
    target.item.segments = arr
  }

  /** 用一条新的替换旧条（id 不变） */
  function replaceSegment(next: SubtitleSegment): void {
    const target = locateSegment(next.id)
    if (!target) return
    const at = target.item.segments.findIndex((s) => s.id === next.id)
    if (at < 0) return
    const arr = [...target.item.segments]
    arr[at] = toLocal(target.item.id, next)
    target.item.segments = arr
  }

  /**
   * 在视图第 `index` 条之后插入一条。
   *
   * 归属跟着**前一条**走（用户在它下面点「插入」就是想在同一个子项目里加），
   * 落点也按前一条在存储层里的位置算 —— 直接按时间码插会让"两段之间正好
   * 落在边界上"时跑到后一个子项目去。
   */
  function insertSegmentAfter(index: number, seg: SubtitleSegment): void {
    const list = concatSegments()
    const anchor = list[Math.min(Math.max(index, 0), list.length - 1)]
    const ownerId = anchor?.originFileId ?? ownerAtTime(seg.start)
    const item = files.value.find((f) => f.id === ownerId)
    if (!item) return
    const at = anchor ? item.segments.findIndex((s) => s.id === anchor.id) : -1
    const arr = [...item.segments]
    arr.splice(at >= 0 ? at + 1 : arr.length, 0, toLocal(item.id, seg))
    item.segments = arr
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
    batchModeLocked.value = false
    // 项目元信息一并回到「空白、未保存」：清空之后这已经不是一个项目了
    projectName.value = ''
    projectPath.value = null
    projectDirty.value = false
    // 模式也一并复位：锁解了却留着「合并时间轴」，下一次导入字幕文件就会掉进
    // 一个没有产物的合并视图里 —— 文件读进来了却什么都看不见。
    // 真踩到过：合并模式 → 清空队列 → 直接拖入 SRT，界面上空空如也。
    batchMode.value = DEFAULT_BATCH_MODE
    /*
     * 讲话人整套复位，不只是「共用」开关。
     *
     * 清空队列之后这就是一个新项目，旧子项目的称呼与对应关系留着没有任何
     * 用处；更要紧的是 `mapping` 里挂着已经不存在的人，下次打开对应关系表
     * 会看到一串无主的行。
     */
    useSpeakerStore().resetAll()
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

  /**
   * 音频缺失 / 被换过的判定结果（键是子项目 id）。
   *
   * 判断要问一次磁盘，所以不放进 `computed`：几百个子项目的话，每次渲染
   * 都会发一轮 `stat`。只在「打开项目」「映射过音频」「用户点重新检查」
   * 这三种时机算一次。
   */
  const mediaState = ref<Record<string, 'missing' | 'changed'>>({})

  function mediaStateOf(fileId: string): 'missing' | 'changed' | null {
    return mediaState.value[fileId] ?? null
  }

  /** 音频有问题（缺失或被换过）的子项目，供编辑器顶部提示条用 */
  const audioProblemFiles = computed(() =>
    supportedFiles.value.filter((f) => mediaState.value[f.id] !== undefined),
  )

  /**
   * 逐个核对音频还在不在、还是不是原来那一个。
   *
   * - **纯字幕子项目不参与**：它本来就没有音频，把它标成「缺失」会让
   *   每一个导入 SRT 的项目一打开就满屏警告；
   * - 大小或修改时间对不上 → `changed`：字幕还在，但波形与时间码可能
   *   已经与实际声音错位，这件事必须让用户知道，不能悄悄放着；
   * - 文件读不到 → `missing`。
   *
   * @returns 有问题的子项目数量
   */
  async function checkMedia(): Promise<number> {
    const bridge = window.xbaos
    if (!bridge) return 0
    const next: Record<string, 'missing' | 'changed'> = {}

    await Promise.all(
      supportedFiles.value.map(async (f) => {
        if (!f.path || f.demo || !isSupported(f.ext)) return
        try {
          const st = await bridge.fs.stat(f.path)
          if (!st.ok || !st.isFile) {
            next[f.id] = 'missing'
            return
          }
          if (f.sizeBytes > 0 && typeof st.size === 'number' && st.size !== f.sizeBytes) {
            next[f.id] = 'changed'
            return
          }
          // 1.5 秒的容差：某些文件系统的 mtime 精度只到秒
          if (
            f.mediaMtimeMs &&
            typeof st.mtimeMs === 'number' &&
            Math.abs(st.mtimeMs - f.mediaMtimeMs) > 1500
          ) {
            next[f.id] = 'changed'
          }
        } catch {
          next[f.id] = 'missing'
        }
      }),
    )

    mediaState.value = next
    return Object.keys(next).length
  }

  /**
   * 把某个子项目映射到另一份音频。
   *
   * **不动字幕、也不提示时长变化**（方案的 #25）：慢速版 / 加速版字幕会
   * 因此对不上，但那是用户自己的判断 —— 软件替他缩放时间码，等于替他
   * 改内容。时长置空，交给解码重新回填。
   *
   * 也**不触发重新识别**（#26）：映射只是「告诉软件音频在哪」，
   * 什么时候重识别由用户决定。
   */
  async function remapMedia(fileId: string, nextPath: string): Promise<boolean> {
    const ui = useUiStore()
    const bridge = window.xbaos
    const file = files.value.find((f) => f.id === fileId)
    if (!file || !bridge) return false

    const ext = extOfPath(nextPath)
    if (!isSupported(ext)) {
      ui.notify('error', '不能用作音频', '请选择 wav / mp3 / flac / ogg 这类音频文件')
      return false
    }
    const st = await bridge.fs.stat(nextPath)
    if (!st.ok || !st.isFile) {
      ui.notify('error', '读不到这个文件', nextPath)
      return false
    }

    // 旧媒体的 blob 地址要释放，否则内存只增不减
    const old = media.value.get(fileId)
    if (old?.blobUrl) URL.revokeObjectURL(old.blobUrl)
    media.value.delete(fileId)
    mediaJobs.delete(fileId)

    file.path = nextPath
    file.dir = dirOf(nextPath)
    file.ext = ext
    file.sizeBytes = st.size ?? 0
    file.mediaMtimeMs = st.mtimeMs
    // 时长未知：`loadMedia()` 只在 null 时回填，正好
    file.durationSec = null
    delete mediaState.value[fileId]

    touchMedia()
    if (!suppressDirty) projectDirty.value = true
    void ensureMedia(fileId)
    // 拼接播放流也换了，重建一次
    void syncMergedMedia()
    return true
  }

  /**
   * 重新读取字幕源文件（子项目本身就是字幕、没有音频时尤其有用）。
   *
   * 走 `history.commit`：读回旧内容等于把用户在编辑器里的修改全抹掉，
   * 所以必须能 Ctrl+Z 撤回一次。
   */
  async function reloadSubtitle(fileId: string): Promise<boolean> {
    const ui = useUiStore()
    const bridge = window.xbaos
    const history = useHistoryStore()
    const file = files.value.find((f) => f.id === fileId)
    if (!file || !bridge) return false
    if (!file.subtitleFormat) {
      ui.notify('warning', '这个子项目没有字幕源文件', '它是由音频识别出来的')
      return false
    }
    /*
     * 读的是 `subtitlePath`，不是 `path`。
     *
     * 纯字幕条目被映射过音频之后，`path` 已经指向音频了；照着它去解析字幕，
     * 得到的是「不是有效的字幕文件」。源文件位置只有 `subtitlePath` 记着。
     */
    const source = file.subtitlePath ?? file.path
    if (!source) return false

    try {
      const { text } = await bridge.fs.readTextAuto(source)
      const parsed = parseSubtitle(text, file.subtitleFormat)
      if (parsed.segments.length === 0) {
        ui.notify('warning', '没有解析到字幕', '源文件里没有可用的字幕条目')
        return false
      }
      history.commit(file.id, file.segments, '重新读取源文件', () => {
        file.segments = parsed.segments
        file.durationSec = Number(Math.max(...parsed.segments.map((s) => s.end)).toFixed(2))
        file.status = 'pending'
      })
      ui.notify('success', '已重新读取', `${nameOf(source)}：${parsed.segments.length} 条`)
      return true
    } catch (err) {
      ui.notify('error', '读取失败', err instanceof Error ? err.message : String(err))
      return false
    }
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
    const model = useModelStore()
    const logs = useLogStore()

    // 浏览器预览：没有桥就走旧的模拟进度，演示数据里已备好「结果」
    if (!window.xbaos) {
      recognizing.value = true
      progress.value = 0
      elapsedSec.value = 0
      remainingSec.value = queue.length * 2.2
      // 演示进度是模拟出来的百分比，一直是确定态
      progressStage.value = 'decode'
      progressStalled.value = false

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
            const label = `正在处理 ${current.name}`
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
            progressStage.value = 'idle'
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
    // 刚点下「开始识别」到模型吐出第一个百分比之间有一段真空：解码音频、
    // 加载几百 MB 的模型都要时间。文案先说清在弄哪个文件（此时第一个文件
    // 已经定性，就是它），免得底栏一片空白像没点上。
    progressStage.value = 'prepare'
    progressLabel.value = queue[0] ? `正在处理 ${queue[0].name}` : '正在准备'
    progressStalled.value = true

    const engine = window.xbaos.engine
    const language = settings.autoDetectLanguage ? 'auto' : settings.language
    const preset = depthPreset(settings.reasoningDepth)
    /*
     * 多遍只对「能改解码参数」的引擎有意义：贪心 CTC 每遍结果完全一致，
     * 跑三遍等于把耗时翻三倍、结果一个字不差。所以按架构能力把遍数压到 1
     * —— 界面上那一栏此时也是灰的，两边结论必须一致。
     */
    const passes = model.caps.decode ? preset.passes : 1
    const terms = settings.promptTerms.trim()
    const threads = threadCount()

    // 基础提示词：手填热词 + 勾选词库（自动去重、预算截断）
    const basePrompt = buildPrompt({ terms, lexiconIds: settings.lexiconIds })

    const startedAt = performance.now()
    let doneCount = 0
    let currentPass = 0

    // 新一轮识别开一本新账：上一轮的日志留着只会让人对错时间
    logs.clear()
    logs.push(
      'info',
      `开始识别 ${queue.length} 个文件，每份 ${passes} 遍，批量模式：${isMerge.value ? '合并为一条时间轴' : '独立处理'}`,
    )

    /*
     * ---- 进度：按「工作单元」累计 ----
     *
     * 以前是「每个文件占 1/队列长度，识别占其中一段」，讲话人分离**没有位置**：
     * 它只能把进度钉在 99%，用户看到的就是「卡在 99% 不动了」。
     *
     * 现在把每个文件要干的活拆成**单元**：识别一遍算一单元，启用分离再加
     * 一单元（分离）。识别与分离因此共用**同一条**进度条，分离阶段推着它
     * 继续往前走，而不是另起一个进度。
     *
     * 各文件的单元数不一样（没开分离、演示文件取不到真实路径都不占分离
     * 单元），所以总量按文件累加，起点用前缀和 —— 失败的文件照常占位，
     * 下一个文件的起点不会往回退。
     */
    const canDiarize = (f: AudioFile): boolean =>
      settings.speakerDiarization && !f.demo && Boolean(f.path)
    const unitPrefix: number[] = []
    let unitAcc = 0
    let diarizeUnits = 0
    for (const f of queue) {
      unitPrefix.push(unitAcc)
      const units = passes + (canDiarize(f) ? 1 : 0)
      unitAcc += units
      if (canDiarize(f)) diarizeUnits += 1
    }
    const totalUnits = Math.max(1, unitAcc)
    /** 合并模式把所有分离并成一段，它占的也是这 diarizeUnits 个单元 */
    const diarizeBase = unitAcc - diarizeUnits

    /** 当前文件已完成的单元数（识别算 passes 个，分离算 1 个） */
    let currentUnitBase = 0
    /** 当前单元的标题文案（底栏只显示「正在处理 某个文件」） */
    let currentUnitLabel = ''

    /** 把「单元内的完成比例」换算成整体百分比 */
    const setUnitProgress = (base: number, slot: number, fraction: number): void => {
      const pct = ((base + slot + fraction) / totalUnits) * 100
      // 封顶 99：整体完成由收尾那一步置 100，提前显示 100 属于撒谎
      progress.value = Math.max(progress.value, Math.min(99, Math.round(pct)))
    }

    /*
     * ---- 停滞检测 ----
     *
     * 判断的是「有没有新进度」，不是「现在是什么阶段」：引擎长时间不报
     * 百分比（分离的聚类阶段就不报）时，百分比会钉在原地 —— 那正是用户
     * 最难受的观感。改成不确定态，短条左右滑，至少看得见还在动。
     */
    let lastProgressAt = performance.now()
    const markProgress = (): void => {
      lastProgressAt = performance.now()
      progressStalled.value = false
    }
    const stallTimer = window.setInterval(() => {
      if (!recognizing.value) return
      if (performance.now() - lastProgressAt > 2500) progressStalled.value = true
    }, 500)

    // 低置信复核是**另一个任务**，它的百分比不能混进主进度里
    let rescueActive = false

    // 流式进度：只更新整体百分比，字幕段的收集走 done 的完整返回更可靠
    // —— segment 流式消息只用来驱动「当前句」预览，这里不逐条入库。
    const offStream = engine.onStream(({ taskId, msg }) => {
      if (taskId !== currentTaskId.value || msg.type !== 'progress') return
      if (rescueActive) return
      markProgress()
      progressStage.value = 'decode'
      progressLabel.value = currentUnitLabel
      setUnitProgress(currentUnitBase, currentPass, msg.percent / 100)
    })

    try {
      for (const [fileIndex, file] of queue.entries()) {
        if (cancelRequested) {
          file.status = 'queued'
          continue
        }

        currentFileId.value = file.id
        file.status = 'processing'
        // 这个文件在整体进度里的起点（前面若干文件的单元已折算成百分比）
        currentUnitBase = unitPrefix[fileIndex] ?? 0

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
          /*
           * 界面只留「正在处理哪个文件」。
           *
           * 遍数、阶段这些细节写进日志（下面一行），不再塞进底栏：
           * 文字一变长度就变，底栏中间那一块跟着左右晃，进度条看着像在抖。
           */
          currentUnitLabel = `正在处理 ${file.name}`
          logs.push('info', `${file.name}：开始第 ${k + 1}/${passes} 遍识别`)
          // 先顶着同一个文案：这一遍要解码音频、加载模型，那段时间引擎报不出百分比，
          // 进度条只能先停着等第一个真实百分比
          progressStage.value = 'prepare'
          progressLabel.value = currentUnitLabel
          progressStalled.value = true
          lastProgressAt = performance.now()

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
            logs.push('error', `${file.name}：第 ${k + 1} 遍失败 —— ${file.message}`)
            break
          }

          lastResult = result
          logs.push(
            'info',
            `${file.name}：第 ${k + 1} 遍完成，${result.count ?? collected.length} 条，音频 ${Math.round(result.duration ?? 0)} 秒，引擎耗时 ${((result.elapsed ?? 0) / 1000).toFixed(1)} 秒`,
          )
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
            // 复核是**另一件事**，不占识别那一遍的进度槽位：它的百分比
            // 相对的是几秒复核区间，混进去会让进度条来回跳。
            // 这里让它走不确定态，标签说清楚在做什么。
            currentPass = passes - 1
            currentTaskId.value = `t-${file.id}-rescue`
            progressStage.value = 'decode'
            progressLabel.value = `正在处理 ${file.name}`
            progressStalled.value = true
            lastProgressAt = performance.now()
            rescueActive = true
            logs.push('info', `${file.name}：复核低置信段落 ${ranges.length} 处`)

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
              rescueActive = false
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

        /*
         * ---- 按热词做同音纠正 ----
         *
         * 放在标点后处理**之前**：这时文本还是识别原始句，上下文最完整，
         * 而标点处理会按标点把长句拆成多条，拆完再改容易让一个词跨两条。
         * 替换严格等长，所以这一步不会动任何时间码。
         *
         * 与提示词是两条独立通道：提示词受预算限制、且只对 whisper 有效；
         * 这里用全量热词，SenseVoice 这类不支持提示词的模型同样生效。
         */
        const fixTerms = settings.termFix
          ? collectFixTerms(settings.promptTerms, settings.lexiconIds)
          : []
        const termFixed = applyTermFix(monotonic, fixTerms)

        // ---- 标点后处理：识别结果进入编辑器之前完成 ----
        const processed = applyPunctuation(termFixed.segments, settings.punctuation)

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
          // 词表决定切点落在哪，不改变任何文字：常用词 + 选中词库 + 手填术语
          wrapWords: buildWrapWords(settings.lexiconIds, settings.promptTerms),
        })

        /*
         * 到这里为止，用户一个字都还没碰过，所以「第一次呈现给用户时的文本」
         * 就是 `wrapped` 里的这个结果。上面各步（繁转简、标点后处理、按规格
         * 折行）都会改写 text 却不同步 origin，若不在这里对齐一次，识别一完成
         * 就有一批条目顶着「已改动」的小圆点 —— 那个圆点本该只表示人改过。
         */
        let baseline = alignOrigin(wrapped.segments)

        logs.push(
          'info',
          `${file.name}：保留 ${kept.length} 条${noiseCount > 0 ? `（丢弃无内容 ${noiseCount} 条）` : ''}，标点切分 ${processed.splitCount} 条，按规格折行 ${wrapped.splitCount} 条`,
        )

        /*
         * ---- 讲话人分离 ----
         *
         * 放在整条流水线的**最后**：它既不读文本也不改文本，只按音色给每个条目
         * 补一个编号。放前面的话，后面按标点切分、按规格折行都会重排条目，
         * 编号就跟着错位了。
         *
         * 失败不算识别失败 —— 字幕已经拿到了，少一个标签不是硬伤。提示一句
         * 让用户知道这次没有分离结果，但不要因此把整段识别标成失败。
         */
        /*
         * 合并模式下**不在这里分离**：所有文件识别完再统一跑一遍（见循环之后）。
         *
         * 一边识别一边分离的话，A 文件的 0 号与 B 文件的 0 号各自独立编号，
         * 拼到同一条时间轴上就变成「同一个人」—— 两段不同人说话却共用一个
         * 称呼。统一放到最后，编号按序接着排，不会张冠李戴。
         */
        if (!isMerge.value && settings.speakerDiarization && !cancelRequested && !file.demo && file.path) {
          const owner = `diarize:${file.id}`
          ui.beginTask(owner, '分析讲话人')
          /*
           * 分离也有真实百分比：引擎的聚类回调按「已处理音频块 / 总块数」
           * 报进度，主进程原样转上来。把它折算进**同一条**进度条 —— 这一步
           * 过去完全没有位置，用户只能看着 99% 干等。
           */
          progressStage.value = 'diarize'
          progressLabel.value = `正在处理 ${file.name}`
          progressStalled.value = true
          logs.push('info', `分析讲话人：${file.name}`)
          lastProgressAt = performance.now()
          const offProgress = window.xbaos?.engine.onDiarizeProgress?.(
            ({ taskId, percent }) => {
              if (taskId && taskId !== owner) return
              ui.updateTask(owner, percent, '分析讲话人')
              markProgress()
              setUnitProgress(currentUnitBase, passes, percent / 100)
              // 回调报 100 只代表「音频块都过完了」，聚类与结果整理还在跑。
              // 这时候再显示 100% 就是骗人，改回不确定态让短条继续滑。
              if (percent >= 100) progressStalled.value = true
            },
          )
          try {
            const diar = await engine.diarize({
              taskId: owner,
              audio: file.path,
              numSpeakers: settings.speakerCount > 0 ? settings.speakerCount : undefined,
              threads,
            })
            const assigned = assignSpeakers(baseline, diar.spans)
            baseline = assigned.segments
            logs.push(
              'info',
              `分析讲话人完成：${file.name}，${assigned.speakers} 位讲话人，${assigned.tagged} 条已标注`,
            )
            if (assigned.speakers > 1) {
              ui.notify(
                'info',
                '讲话人分析完成',
                `${file.name}：${assigned.speakers} 位讲话人，${assigned.tagged} 条已标注`,
              )
            }
          } catch (err) {
            ui.notify(
              'warning',
              '讲话人分析未完成',
              `${file.name}：${err instanceof Error ? err.message : String(err)}`,
            )
          } finally {
            offProgress?.()
            ui.endTask(owner)
            // 分离这一单元走完了，进度落到单元末尾（聚类耗时也算在里面）
            setUnitProgress(currentUnitBase, passes, 1)
            progressStalled.value = true
          }
        }

        // 用历史提交的方式写入，识别结果本身也可以整体撤销
        history.commit(file.id, file.segments, '识别结果', () => {
          file.segments = baseline
          file.durationSec = lastResult?.duration ?? file.durationSec
          file.status = 'pending'
          file.message = undefined
        })

        if (termFixed.hits.length > 0) {
          // 只报前几组：几十处全列出来没人看，但「改了哪些词」必须能一眼看到
          const grouped = new Map<string, number>()
          for (const hit of termFixed.hits) {
            const key = `${hit.from} → ${hit.to}`
            grouped.set(key, (grouped.get(key) ?? 0) + 1)
          }
          const top = [...grouped.entries()]
            .slice(0, 3)
            .map(([key, count]) => (count > 1 ? `${key}（${count}）` : key))
          const more = grouped.size > 3 ? ` 等 ${grouped.size} 组` : ''
          ui.notify(
            'info',
            '已按热词纠正同音字',
            `${file.name}：${termFixed.hits.length} 处，${top.join('、')}${more}`,
          )
        }

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
        // 整体进度由「工作单元」累计（见 setUnitProgress），这里不再按文件数
        // 另算一份 —— 两套算法混用会让进度条在某些文件组合下卡住不前
      }

      /*
       * ---- 合并模式：讲话人分离放到最后，统一跑 ----
       *
       * 一条时间轴上只能有一套编号。逐文件各跑各的，A 的 0 号与 B 的 0 号
       * 拼到一起就成了「同一个人」—— 两段不同人说话共用一个称呼，改名字
       * 还会一起改。所以这里按队列顺序依次分离，每个文件的编号**接着往下排**
       * （前一个文件占了 0..n-1，后一个从 n 起），不做任何按编号的强行绑定。
       */
      if (isMerge.value && settings.speakerDiarization && !cancelRequested) {
        const targets = queue.filter((f) => canDiarize(f) && f.segments.length > 0)
        /*
         * 每份的讲话人编号**都从 0 起**，不接着上一份往下排。
         *
         * 编号是子项目本地的（`.xbsgp` 里两个子项目都有 0 号是正常的）。
         * 曾经为了「合并成一条时间轴时不撞号」加过一个 `nextIndex` 偏移，
         * 那与「编号本地」自相矛盾，也和白送的猜错绑在一起；跨子项目
         * 「谁是谁」交给对应关系表 —— 它只按**用户起的名字**推断，
         * 不按编号推断，所以两段都有「讲话人 1」不会误绑。
         */
        for (const [i, file] of targets.entries()) {
          const owner = `diarize:${file.id}`
          logs.push('info', `分析讲话人（${i + 1}/${targets.length}）：${file.name}`)
          ui.beginTask(owner, '分析讲话人')
          progressStage.value = 'diarize'
          progressLabel.value = `正在处理 ${file.name}`
          const offProgress = window.xbaos?.engine.onDiarizeProgress?.(
            ({ taskId, percent }) => {
              if (taskId && taskId !== owner) return
              ui.updateTask(owner, percent, '分析讲话人')
              // 这一段是所有分离合成的，按「第几份 + 这一份的百分比」折算
              const share =
                (diarizeBase + ((i + percent / 100) / targets.length) * diarizeUnits) / totalUnits
              progress.value = Math.max(progress.value, Math.min(99, Math.round(share * 100)))
            },
          )
          try {
            const diar = await engine.diarize({
              taskId: owner,
              audio: file.path,
              numSpeakers: settings.speakerCount > 0 ? settings.speakerCount : undefined,
              threads,
            })
            const assigned = assignSpeakers(file.segments, diar.spans)
            file.segments = assigned.segments
            logs.push(
              'info',
              `${file.name}：${assigned.speakers} 位讲话人，${assigned.tagged} 条已标注`,
            )
            if (assigned.speakers > 1) {
              ui.notify(
                'info',
                '讲话人分析完成',
                `${file.name}：${assigned.speakers} 位讲话人，${assigned.tagged} 条已标注`,
              )
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            logs.push('error', `分析讲话人失败（${file.name}）：${reason}`)
            ui.notify('warning', '讲话人分析未完成', `${file.name}：${reason}`)
          } finally {
            offProgress?.()
            ui.endTask(owner)
          }
        }
        progress.value = Math.max(
          progress.value,
          Math.min(99, Math.round(((diarizeBase + diarizeUnits) / totalUnits) * 100)),
        )
      }

      // 每段音频都跑完了才拼合并产物：偏移量依赖各段的真实时长，而这些
      // 时长要等引擎回报。中途取消就不拼，避免把残缺结果当成成品
      if (!cancelRequested) {
        logs.push(
          'info',
          `识别结束：${doneCount} 个文件，整体用时 ${Math.round((performance.now() - startedAt) / 1000)} 秒`,
        )
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
      window.clearInterval(stallTimer)
      recognizing.value = false
      progressLabel.value = ''
      progressStage.value = 'idle'
      progressStalled.value = false
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

  /* ------------------------------------------------------------ 项目文件 */

  /** 保存对话框的默认目录：上次选的 → 首个子项目所在目录 → 空（交给系统） */
  function defaultProjectDir(): string {
    if (lastProjectDir.value) return lastProjectDir.value
    return supportedFiles.value[0]?.dir ?? ''
  }

  /** 保存对话框的默认文件名（带 `.xbsgp`） */
  function defaultProjectFile(): string {
    return projectFileName(displayProjectName.value)
  }

  /**
   * 组装要写盘的文档。
   *
   * `mtimeMs` 要现问主进程：识别与导入阶段只记了字节数，没有修改时间。
   * 拿不到不影响存盘（写 0），它的用途只是将来判断「音频有没有被换过」。
   */
  async function buildDoc(): Promise<ProjectDoc> {
    const bridge = window.xbaos
    const speakers = useSpeakerStore()
    const mtimes = new Map<string, number>()
    if (bridge) {
      await Promise.all(
        supportedFiles.value.map(async (f) => {
          if (!f.path) return
          try {
            const st = await bridge.fs.stat(f.path)
            if (st.ok && typeof st.mtimeMs === 'number') mtimes.set(f.path, st.mtimeMs)
          } catch {
            /* 拿不到就不记，不影响内容 */
          }
        }),
      )
    }
    return buildProjectDoc({
      name: displayProjectName.value,
      activeItemId: activeFileId.value,
      shared: speakers.shared,
      mtimeOf: (p) => mtimes.get(p) ?? 0,
      items: supportedFiles.value,
      appVersion,
      speakers: {
        byFile: speakers.byFile,
        globals: speakers.globals,
        mapping: speakers.mapping,
        declared: speakers.declared,
        confirmed: speakers.mappingConfirmed,
      },
    })
  }

  /**
   * 写到指定路径。
   *
   * `allowOverwrite` 只在自己这个路径上为 true —— 其余情况一律由主进程拒绝，
   * 连"提醒一下然后允许覆盖"都不给：`.xbsgp` 里可能是一整部片子的字幕。
   *
   * 项目名会跟着文件名走（`S03E12 等.xbsgp` → `S03E12 等`），保证「侧栏看到的
   * 名字」与「磁盘上的文件名」永远一致；写失败则整次回滚。
   */
  async function saveProjectTo(target: string): Promise<boolean> {
    const ui = useUiStore()
    const bridge = window.xbaos
    if (!bridge || !target) return false
    if (supportedFiles.value.length === 0) {
      ui.notify('warning', '没有可保存的内容', '先导入音频或字幕')
      return false
    }

    const previousName = projectName.value
    const finalName = sanitizeFileName(stemOf(nameOf(target))).value
    projectName.value = finalName

    const doc = await buildDoc()
    const isSelf = !!projectPath.value && samePath(target, projectPath.value)
    const result = await bridge.project.write(target, toProjectText(doc), isSelf)
    if (!result.ok) {
      projectName.value = previousName
      ui.notify(
        'error',
        result.code === 'exists' ? '该目录已有同名项目' : '保存失败',
        result.code === 'exists'
          ? `${nameOf(target)} 已存在，请换个名字`
          : (result.message ?? '写入时出错，原文件未改动'),
      )
      return false
    }

    projectPath.value = target
    projectDirty.value = false
    lastProjectDir.value = dirOf(target)
    const view = viewFile.value
    if (view) markSaved(MERGED_FILE_ID, view.segments)
    ui.notify('success', '项目已保存', target)
    return true
  }

  /**
   * 「保存项目」按钮的落点。
   *
   * 有路径就直接写（同一路径 = 覆盖自己，不校验重名）；没有路径时调系统
   * 保存对话框兜底 —— 正常路径是界面先弹自己的保存框（能实时校验重名），
   * 这里只是万一被直接调用也不至于什么都不做。
   */
  async function saveProject(): Promise<boolean> {
    if (projectPath.value) return saveProjectTo(projectPath.value)
    const bridge = window.xbaos
    if (!bridge) {
      useUiStore().notify('warning', '浏览器预览无法保存项目', '请在桌面应用里使用')
      return false
    }
    const picked = await bridge.project.pickSave({
      defaultName: defaultProjectFile(),
      defaultDir: defaultProjectDir(),
    })
    if (!picked) return false
    return saveProjectTo(picked)
  }

  /** 把文档里的子项目转成运行期条目 */
  function itemsFromDoc(doc: ProjectDoc): AudioFile[] {
    return doc.project.items.map((it) => {
      // 打开时不可能有"正在识别"：那些状态在进程里才有意义，一律回到 pending
      const status: FileStatus =
        it.status === 'queued' || it.status === 'processing' || it.status === 'unsupported'
          ? 'pending'
          : it.status
      return {
        id: it.id,
        name: it.name,
        // 音频条目取 media；纯字幕条目取 sourcePath（原来的 srt 在哪）
        path: it.media?.path ?? it.sourcePath ?? '',
        dir: dirOf(it.media?.path ?? it.sourcePath ?? ''),
        // 扩展名跟着**音频**走：子项目名用户可以随意改（改成「第 1 期」就
        // 没有扩展名了），而能不能解码只看音频文件本身
        ext: extOfPath(it.media?.path ?? it.name),
        sizeBytes: it.media?.sizeBytes ?? 0,
        mediaMtimeMs: it.media?.mtimeMs,
        durationSec: it.durationSec,
        status,
        segments: it.segments,
        subtitleFormat: it.subtitleFormat,
        sourceEncoding: it.sourceEncoding,
        subtitlePath: it.sourcePath,
      }
    })
  }

  /**
   * 打开项目。
   *
   * 有未保存改动时先问（原生三按钮），用户取消就什么都不做 —— 这里必须
   * 在**读文件之前**问，否则读完才发现用户不想开，前面做的都白费。
   */
  async function openProject(target?: string): Promise<boolean> {
    const ui = useUiStore()
    const bridge = window.xbaos
    if (!bridge) {
      ui.notify('warning', '浏览器预览无法打开项目', '请在桌面应用里使用')
      return false
    }

    if (projectDirty.value && supportedFiles.value.length > 0) {
      const choice = await bridge.dialog.confirm({
        type: 'question',
        title: '打开其他项目',
        message: `「${displayProjectName.value}」有未保存的改动`,
        detail: '不保存就打开，这些改动会丢失。',
        buttons: ['取消', '不保存，直接打开', '先保存再打开'],
        defaultId: 2,
        cancelId: 0,
      })
      if (choice === 0) return false
      if (choice === 2) {
        const saved = await saveProject()
        if (!saved) return false
      }
    }

    const picked = target ?? (await bridge.project.pickOpen())
    if (!picked) return false
    if (!isProjectPath(picked)) {
      ui.notify('error', '不是项目文件', '请选择 .xbsgp 文件')
      return false
    }

    let text = ''
    try {
      text = (await bridge.fs.readTextAuto(picked)).text
    } catch (err) {
      ui.notify('error', '读取项目失败', err instanceof Error ? err.message : String(err))
      return false
    }
    const parsed = fromProjectText(text)
    if (!parsed.ok) {
      ui.notify('error', '打开项目失败', parsed.error)
      return false
    }

    const doc = parsed.doc
    const items = itemsFromDoc(doc)

    // ---- 替换整个工程：先把上一份的媒体地址释放掉，否则内存只增不减
    for (const m of media.value.values()) {
      if (m.blobUrl) URL.revokeObjectURL(m.blobUrl)
    }
    media.value.clear()
    mergedMediaToken += 1
    touchMedia()

    suppressDirty = true
    files.value = items
    activeFileId.value =
      doc.project.activeItemId && items.some((f) => f.id === doc.project.activeItemId)
        ? doc.project.activeItemId
        : (items[0]?.id ?? null)
    projectName.value = doc.project.name
    projectPath.value = picked
    projectDirty.value = false
    lastProjectDir.value = dirOf(picked)

    /*
     * 打开的项目一律按「一个项目 N 项」呈现 —— 合并模式正是这个视图。
     * 批量处理方式本身是会话状态、不进项目文件（4.3），这里只是选一个
     * 与"项目"语义相符的显示方式。
     */
    batchMode.value = 'merge'
    batchModeLocked.value = false

    // 讲话人表：打开的项目自带的称呼必须恢复，否则整份工程读回来就少了信息
    const speakers = useSpeakerStore()
    const sp = doc.speakers
    speakers.resetAll()
    speakers.byFile = sp?.byFile ?? {}
    speakers.globals = sp?.globals ?? []
    speakers.mapping = sp?.mapping ?? {}
    speakers.declared = sp?.declared ?? {}
    speakers.mappingConfirmed = sp?.confirmed === true
    // `shared` 是项目级属性：打开哪一份工程，就用它自己记的那个值
    speakers.shared = doc.project.shared

    exportRecords.value.clear()
    savedSignatures.value.clear()
    markSaved(MERGED_FILE_ID, concatSegments())

    // 波形与校验都要跟着新内容重来
    onQueueChanged()
    revalidate()

    /*
     * 核对音频还在不在。这一条必须在「打开」时就做：项目文件里存的只是一个
     * 路径，换台电脑、换个盘符、或者原始素材被挪走之后，那个路径随时会失效。
     * 不主动问一次，用户会先看到一片空波形，再以为是软件坏了。
     */
    const bad = await checkMedia()

    // 等这一轮响应式触发跑完，再解除抑制并确认「刚打开 = 没改过」
    await nextTick()
    suppressDirty = false
    projectDirty.value = false

    ui.notify(
      'success',
      '项目已打开',
      bad > 0
        ? `${doc.project.name}：${items.length} 个子项目，其中 ${bad} 个的音频对不上`
        : `${doc.project.name}：${items.length} 个子项目`,
    )
    return true
  }

  /** 改项目名。已有文件的要同步改磁盘文件名，失败则整次回滚 */
  async function renameProject(raw: string): Promise<boolean> {
    const ui = useUiStore()
    const bridge = window.xbaos
    const clean = sanitizeFileName(raw.trim()).value
    if (!clean) {
      ui.notify('warning', '名字不能为空', '项目名会变成文件名，不能只有空格')
      return false
    }
    if (clean === displayProjectName.value) return true

    if (!projectPath.value || !bridge) {
      projectName.value = clean
      projectDirty.value = true
      return true
    }

    const nextPath = joinPath(dirOf(projectPath.value), projectFileName(clean))
    if (samePath(nextPath, projectPath.value)) {
      projectName.value = clean
      return true
    }
    if (await bridge.fs.exists(nextPath)) {
      ui.notify('error', '该目录已有同名项目', `${nameOf(nextPath)} 已存在，请换个名字`)
      return false
    }

    const res = await bridge.project.rename(projectPath.value, nextPath)
    if (!res.ok) {
      ui.notify(
        'error',
        res.code === 'exists' ? '该目录已有同名项目' : '改名失败',
        res.message ?? '磁盘文件名没有改动，请稍后再试',
      )
      return false
    }
    // 名字与磁盘同时改：任何一步失败都不允许出现「侧栏叫 B、磁盘还是 A」
    projectName.value = clean
    projectPath.value = nextPath
    lastProjectDir.value = dirOf(nextPath)
    return true
  }

  /** 有没有选中任何子项目（侧栏 / 空态用） */
  function hasProjectContent(): boolean {
    return supportedFiles.value.length > 0
  }

  return {
    files,
    batchMode,
    batchModeLocked,
    projectName,
    displayProjectName,
    projectPath,
    projectDirty,
    lastProjectDir,
    activeFileId,
    recognizing,
    progress,
    progressLabel,
    progressStage,
    progressStalled,
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
    speakerMappingFiles,
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
    setAcked,
    replaceSegment,
    insertSegmentAfter,
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
    mediaOf,
    mediaState,
    mediaStateOf,
    audioProblemFiles,
    checkMedia,
    remapMedia,
    reloadSubtitle,
    peaksOf,
    mediaErrorOf,
    mediaVersion,
    defaultProjectDir,
    defaultProjectFile,
    saveProject,
    saveProjectTo,
    openProject,
    renameProject,
    hasProjectContent,
  }
})
