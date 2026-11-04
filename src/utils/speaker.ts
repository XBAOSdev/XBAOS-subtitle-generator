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

/** 导出时加在文本前的说话人标签 */
export function speakerLabel(speaker: number | undefined): string {
  return typeof speaker === 'number' ? `说话人 ${speaker + 1}` : ''
}
