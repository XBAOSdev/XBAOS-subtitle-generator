/**
 * 说话人归属：把「谁在什么时候说话」映射到字幕条目上。
 *
 * 输入是两条互不相干的时间轴：
 *   · 字幕条目 —— 由识别算法按句子切出来的，边界落在词与标点之间
 *   · 说话人段 —— 由音色分离切出来的，边界落在换人的地方
 *
 * 两者不会严丝合缝：一句话可能横跨换人点，一条字幕也可能只盖住某个说话人段
 * 的一小块。所以判定按**重叠时长**取最长者，而不是「起点落在哪段」——
 * 后者在句首有个短促应答词时会把整句判给错的人。
 *
 * 全部是纯函数，纯粹为了能被守门断言反复喂样本。
 */
import type { DiarizationSpan } from '@/types/engine'

/** 低于这个重叠时长视为擦边，不据此判定（约等于两个字） */
const MIN_OVERLAP_SEC = 0.13

/**
 * 覆盖不到条目这个比例时，宁可沿用上一条的判定，也不硬套。
 *
 * 典型场景：两个字的一条字幕正好卡在两段之间，两边各盖住 0.1 秒 ——
 * 这时候「谁盖得多」是噪声决定的，不构成证据。
 */
const MIN_COVER_RATIO = 0.3

export interface SpeakerAssignResult<T> {
  segments: T[]
  /** 成功打上标签的条目数 */
  tagged: number
  /** 没有任何依据、保持原样的条目数 */
  untouched: number
  /** 判定出的说话人总数（按 spans 里的最大编号 + 1 算，空 spans 为 0） */
  speakers: number
}

/**
 * 给每条字幕打上说话人编号。
 *
 * 规则按优先级：
 *   1. 重叠时长最长的那个说话人段胜出（需过 MIN_OVERLAP_SEC 与 MIN_COVER_RATIO）
 *   2. 否则沿用**上一条**的判定 —— 同一人连续说话被切成几条时，中间那条
 *      即使刚好落在静音缝里，也几乎不会是别人
 *   3. 首条就没有依据时留空，不猜
 *
 * 不改时间码、不改文本，只写 `speaker` 字段。
 */
export function assignSpeakers<T extends { start: number; end: number; speaker?: number }>(
  segments: T[],
  spans: DiarizationSpan[],
): SpeakerAssignResult<T> {
  if (segments.length === 0) {
    return { segments, tagged: 0, untouched: 0, speakers: 0 }
  }
  if (spans.length === 0) {
    return { segments, tagged: 0, untouched: segments.length, speakers: 0 }
  }

  let maxSpeaker = -1
  for (const s of spans) {
    if (Number.isFinite(s.speaker) && s.speaker > maxSpeaker) maxSpeaker = s.speaker
  }

  let tagged = 0
  let untouched = 0
  let last: number | undefined

  const out = segments.map((seg) => {
    const len = Math.max(0.001, seg.end - seg.start)

    let best: number | undefined
    let bestOverlap = 0
    for (const span of spans) {
      const overlap = Math.min(seg.end, span.end) - Math.max(seg.start, span.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = span.speaker
      }
    }

    const reliable = best !== undefined && bestOverlap >= MIN_OVERLAP_SEC && bestOverlap / len >= MIN_COVER_RATIO

    let speaker: number | undefined
    if (reliable) {
      speaker = best
      tagged++
    } else if (last !== undefined) {
      // 落在静音缝或跨段边界：同一人继续说的可能性远大于换人
      speaker = last
      tagged++
    } else {
      untouched++
    }

    if (speaker !== undefined) last = speaker

    // 没有依据就原样返回：既不给对象塞一个值为 undefined 的键（会让「本来就没标」
    // 和「标过又被清空」变成两种形状），也不擦掉重跑前已有的标签
    if (speaker === undefined) return seg
    return { ...seg, speaker }
  })

  return { segments: out, tagged, untouched, speakers: maxSpeaker + 1 }
}

/** 默认称呼：分离结果只给编号，称呼由用户自己改 */
export function defaultSpeakerName(index: number): string {
  return `讲话人 ${index + 1}`
}

/** 导出用的称呼（没人改过时退回默认） */
export function speakerName(
  index: number | undefined,
  names: Record<string, string> = {},
): string {
  if (typeof index !== 'number') return ''
  const custom = names[index]?.trim()
  return custom || defaultSpeakerName(index)
}

/** 导出时加在文本前的说话人标签（旧接口，保留给不需要自定义称呼的调用点） */
export function speakerLabel(speaker: number | undefined): string {
  return typeof speaker === 'number' ? defaultSpeakerName(speaker) : ''
}

export interface SpeakerEntry {
  index: number
  name: string
  /** 这个称呼下有多少条字幕 */
  count: number
}

/**
 * 列出当前文件里有哪些讲话人。
 *
 * 取「条目里出现过的编号」与「用户手动新增过的编号」的并集：
 * 只按条目算的话，刚新增的讲话人在列表里根本不出现，用户会以为按钮没反应。
 * 编号一律不重排 —— 删掉中间一个，后面几位仍然叫原来的名字，否则用户改好的
 * 称呼会跟着错位。
 */
export function listSpeakers(
  segments: { speaker?: number }[],
  names: Record<string, string> = {},
  declared: number[] = [],
): SpeakerEntry[] {
  const counts = new Map<number, number>()
  for (const seg of segments) {
    if (typeof seg.speaker !== 'number') continue
    counts.set(seg.speaker, (counts.get(seg.speaker) ?? 0) + 1)
  }
  for (const index of declared) {
    if (!counts.has(index)) counts.set(index, 0)
  }
  for (const key of Object.keys(names)) {
    const index = Number(key)
    if (Number.isInteger(index) && !counts.has(index)) counts.set(index, 0)
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, count]) => ({ index, name: speakerName(index, names), count }))
}

/** 下一位的编号：不复用已删除的编号，避免「刚删掉的人又冒出来」 */
export function nextSpeakerIndex(
  segments: { speaker?: number }[],
  declared: number[] = [],
): number {
  let max = -1
  for (const seg of segments) {
    if (typeof seg.speaker === 'number' && seg.speaker > max) max = seg.speaker
  }
  for (const index of declared) {
    if (index > max) max = index
  }
  return max + 1
}

export interface SpeakerPatchResult<T> {
  segments: T[]
  changed: number
}

/**
 * 把一批条目改成某个讲话人（`speaker` 传 undefined 即清除标识）。
 *
 * 返回**新数组**：调用点要拿它进撤销栈，就地改会让「撤销」拿到一份已经被改过
 * 的快照。没命中的条目原样返回引用，避免整表重新 patch。
 */
export function setSpeakerFor<T extends { id: string; speaker?: number }>(
  segments: T[],
  ids: string[],
  speaker: number | undefined,
): SpeakerPatchResult<T> {
  const targets = new Set(ids)
  let changed = 0
  const out = segments.map((seg) => {
    if (!targets.has(seg.id)) return seg
    if (seg.speaker === speaker) return seg
    changed += 1
    if (speaker === undefined) {
      const next = { ...seg }
      delete next.speaker
      return next
    }
    return { ...seg, speaker }
  })
  return { segments: changed > 0 ? out : segments, changed }
}

/** 把 `from` 的所有条目并到 `to` 名下 */
export function mergeSpeakerInto<T extends { speaker?: number }>(
  segments: T[],
  from: number,
  to: number,
): SpeakerPatchResult<T> {
  if (from === to) return { segments, changed: 0 }
  let changed = 0
  const out = segments.map((seg) => {
    if (seg.speaker !== from) return seg
    changed += 1
    return { ...seg, speaker: to }
  })
  return { segments: changed > 0 ? out : segments, changed }
}

/** 清除某个讲话人的全部标识（条目回到「未标记」） */
export function clearSpeaker<T extends { speaker?: number }>(
  segments: T[],
  index: number,
): SpeakerPatchResult<T> {
  let changed = 0
  const out = segments.map((seg) => {
    if (seg.speaker !== index) return seg
    changed += 1
    const next = { ...seg }
    delete next.speaker
    return next
  })
  return { segments: changed > 0 ? out : segments, changed }
}
