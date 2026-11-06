/**
 * `.xbsgp` 项目文件的序列化与解析。
 *
 * 格式是**明文 JSON**（UTF-8，2 空格缩进）：能手工救、能 diff、不引压缩依赖。
 * 一条字幕约 120 B，5000 条的项目约 9.6 MB，读写都在百毫秒级。
 *
 * 三条写死的取舍：
 *
 * 1. **时间码是子项目本地的（从 0 起）**，项目里没有「绝对时间码」字段。
 *    偏移是派生值，不落盘 —— 打开文件时哪怕某个 `durationSec` 被改过，
 *    拼接结果依然自洽。
 * 2. **不存派生数据**：`issues`（校验结论）每次都现算，存下来只会变成
 *    「打开文件看到一堆去年的报错」。`originFileId` 是拼接视图专用的标记，
 *    落盘时也不写（写下去会让「本地的这一条属于谁」出现两套说法）。
 * 3. **不存会话状态**：批量模式、侧栏折叠、面板宽度、模型目录一概不进项目文件。
 *    分界线是「换一台电脑打开，内容一模一样」。
 */

import { isSupported } from '@/utils/formats'
import type {
  FileStatus,
  ProjectDoc,
  ProjectItemDoc,
  SubtitleFormat,
  SubtitleSegment,
  TextEncoding,
} from '@/types'

/** 当前格式版本。读到更高的版本要拒绝，而不是猜着读 */
export const PROJECT_DOC_VERSION = 1

/**
 * 一条字幕落盘时保留的字段。
 *
 * 白名单而不是黑名单：`SubtitleSegment` 将来加字段时，默认不写进文件 ——
 * 免得某个内部状态被悄无声息地固化进格式，之后再想删就要做兼容。
 */
function segmentToDoc(seg: SubtitleSegment): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: seg.id,
    start: seg.start,
    end: seg.end,
    text: seg.text,
    origin: seg.origin,
  }
  if (seg.translations && Object.keys(seg.translations).length > 0) {
    out.translations = seg.translations
  }
  if (seg.staleSlots && seg.staleSlots.length > 0) out.staleSlots = seg.staleSlots
  if (typeof seg.avgLogprob === 'number') out.avgLogprob = seg.avgLogprob
  // 用户「我看过了，别再提醒」的批注：是他的意图，必须跟着项目走
  if (seg.acked) out.acked = true
  if (typeof seg.speaker === 'number') out.speaker = seg.speaker
  return out
}

/** 解析回来的一条字幕。缺字段时补一个合理默认，不让一条坏数据放倒整份文件 */
function segmentFromDoc(raw: unknown): SubtitleSegment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  const start = typeof r.start === 'number' && Number.isFinite(r.start) ? r.start : null
  const end = typeof r.end === 'number' && Number.isFinite(r.end) ? r.end : null
  if (start === null || end === null) return null
  const text = typeof r.text === 'string' ? r.text : ''
  const seg: SubtitleSegment = {
    id: r.id,
    start,
    end,
    text,
    // 早期版本没写 origin 时用当前文本兜底：宁可把「改没改过」判错一次，
    // 也不能让一条没有基线文本的条目在编辑器里到处报错
    origin: typeof r.origin === 'string' ? r.origin : text,
    issues: [],
  }
  if (r.translations && typeof r.translations === 'object') {
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.translations as Record<string, unknown>)) {
      if (typeof v === 'string') map[k] = v
    }
    if (Object.keys(map).length > 0) seg.translations = map
  }
  if (Array.isArray(r.staleSlots)) {
    const slots = r.staleSlots.filter((s): s is string => typeof s === 'string')
    if (slots.length > 0) seg.staleSlots = slots
  }
  if (typeof r.avgLogprob === 'number') seg.avgLogprob = r.avgLogprob
  if (r.acked === true) seg.acked = true
  if (typeof r.speaker === 'number') seg.speaker = r.speaker
  return seg
}

/** 子项目落盘 */
export interface ProjectItemLike {
  id: string
  name: string
  path: string
  sizeBytes: number
  durationSec: number | null
  status: FileStatus
  segments: SubtitleSegment[]
  subtitleFormat?: SubtitleFormat
  sourceEncoding?: TextEncoding
  /** 字幕源文件（导入的是字幕时才有）；与音频路径分开，见 AudioFile 的说明 */
  subtitlePath?: string
  ext: string
}

function itemToDoc(item: ProjectItemLike, mtimeMs: number): ProjectItemDoc {
  /*
   * 判据是「**有没有音频**」，不是「导入时是不是字幕」。
   *
   * 一个纯字幕子项目被用户映射了音频之后，两样都有：音频（`path` + `ext`）
   * 与字幕源（`subtitlePath`）。按 `subtitleFormat` 判 kind 会把它算成
   * subtitle、把音频路径丢掉 —— 存一次再打开，刚映射好的音频又没了。
   */
  const kind = item.path && isSupported(item.ext) ? 'audio' : 'subtitle'
  const doc: ProjectItemDoc = {
    id: item.id,
    name: item.name,
    kind,
    /*
     * `media` 只写给音频条目。
     *
     * 纯字幕条目的 `path` 是那个 srt 的路径，早先无差别写进 `media`，
     * 于是打开项目后它被当成音频去读、去解码 —— 波形区报错，播放器提示
     * 「没有音频轨」，而它本来就没有。字幕的来源改记在 `sourcePath`。
     */
    media:
      kind === 'audio' && item.path
        ? { path: item.path, sizeBytes: item.sizeBytes, mtimeMs }
        : null,
    durationSec: item.durationSec ?? 0,
    status: item.status,
    segments: item.segments.map(segmentToDoc) as unknown as SubtitleSegment[],
  }
  // 字幕源与音频是两件独立的事实，各记各的
  if (item.subtitlePath) doc.sourcePath = item.subtitlePath
  if (item.subtitleFormat) doc.subtitleFormat = item.subtitleFormat
  if (item.sourceEncoding) doc.sourceEncoding = item.sourceEncoding
  return doc
}

export interface BuildProjectDocInput {
  name: string
  activeItemId: string | null
  shared: boolean
  /** 时间 → mtime 的查表函数；没有就传 0 */
  mtimeOf: (path: string) => number
  items: ProjectItemLike[]
  appVersion: string
  savedAt?: string
  /** 讲话人表（P0 先按原样存，键仍是子项目 id） */
  speakers?: ProjectDoc['speakers']
  outputs?: ProjectDoc['outputs']
}

/**
 * 组装要写盘的文档。
 *
 * 键顺序固定输出（`magic` → `version` → …）：diff 时才是「改了几行」，
 * 而不是「整个文件重排」。
 */
export function buildProjectDoc(input: BuildProjectDocInput): ProjectDoc {
  const doc: ProjectDoc = {
    magic: 'xbsgp',
    version: PROJECT_DOC_VERSION,
    app: input.appVersion,
    savedAt: input.savedAt ?? new Date().toISOString(),
    project: {
      name: input.name,
      activeItemId: input.activeItemId,
      shared: input.shared,
      items: input.items.map((it) => itemToDoc(it, input.mtimeOf(it.path))),
    },
  }
  if (input.speakers) doc.speakers = input.speakers
  if (input.outputs) doc.outputs = input.outputs
  return doc
}

/** 序列化成写盘用的字符串（结尾带一个换行，符合文本文件的惯例） */
export function toProjectText(doc: ProjectDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export type ParseResult =
  | { ok: true; doc: ProjectDoc }
  | { ok: false; error: string }

/**
 * 解析项目文件。
 *
 * 失败一律返回可读的原因 —— 这个函数的结果会直接显示在「打开项目」失败
 * 的提示里，用户据此判断是文件坏了、还是自己点错了文件。
 */
export function fromProjectText(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '不是有效的项目文件（内容无法解析）' }
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '不是有效的项目文件（内容为空）' }
  }
  const r = raw as Record<string, unknown>
  if (r.magic !== 'xbsgp') {
    return { ok: false, error: '不是本软件的项目文件' }
  }
  const version = typeof r.version === 'number' ? r.version : 0
  if (version > PROJECT_DOC_VERSION) {
    return {
      ok: false,
      error: `这个项目由更新的版本创建（格式 v${version}），当前版本只能读到 v${PROJECT_DOC_VERSION}`,
    }
  }
  const proj = r.project
  if (!proj || typeof proj !== 'object') {
    return { ok: false, error: '项目文件缺少内容' }
  }
  const p = proj as Record<string, unknown>
  if (!Array.isArray(p.items)) {
    return { ok: false, error: '项目文件里没有子项目列表' }
  }

  const items: ProjectItemDoc[] = []
  for (const rawItem of p.items) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const it = rawItem as Record<string, unknown>
    if (typeof it.id !== 'string' || !it.id) continue
    const media = it.media as Record<string, unknown> | null | undefined
    const segments: SubtitleSegment[] = []
    if (Array.isArray(it.segments)) {
      for (const s of it.segments) {
        const seg = segmentFromDoc(s)
        if (seg) segments.push(seg)
      }
    }
    const doc: ProjectItemDoc = {
      id: it.id,
      name: typeof it.name === 'string' && it.name ? it.name : '未命名',
      kind: it.kind === 'subtitle' ? 'subtitle' : 'audio',
      media:
        media && typeof media.path === 'string'
          ? {
              path: media.path,
              sizeBytes: typeof media.sizeBytes === 'number' ? media.sizeBytes : 0,
              mtimeMs: typeof media.mtimeMs === 'number' ? media.mtimeMs : 0,
            }
          : null,
      durationSec: typeof it.durationSec === 'number' ? it.durationSec : 0,
      status: (typeof it.status === 'string' ? it.status : 'pending') as FileStatus,
      segments,
    }
    if (typeof it.sourcePath === 'string' && it.sourcePath) doc.sourcePath = it.sourcePath
    if (typeof it.subtitleFormat === 'string') {
      doc.subtitleFormat = it.subtitleFormat as SubtitleFormat
    }
    if (typeof it.sourceEncoding === 'string') {
      doc.sourceEncoding = it.sourceEncoding as TextEncoding
    }
    items.push(doc)
  }

  if (items.length === 0) {
    return { ok: false, error: '项目文件里没有任何子项目' }
  }

  const doc: ProjectDoc = {
    magic: 'xbsgp',
    version,
    app: typeof r.app === 'string' ? r.app : '',
    savedAt: typeof r.savedAt === 'string' ? r.savedAt : '',
    project: {
      name: typeof p.name === 'string' && p.name ? p.name : '未命名项目',
      activeItemId: typeof p.activeItemId === 'string' ? p.activeItemId : null,
      shared: p.shared === true,
      items,
    },
  }
  if (r.speakers && typeof r.speakers === 'object') {
    doc.speakers = r.speakers as ProjectDoc['speakers']
  }
  if (r.outputs && typeof r.outputs === 'object') {
    doc.outputs = r.outputs as ProjectDoc['outputs']
  }
  return { ok: true, doc }
}
