import type { GapFillOptions, SubtitleSegment } from '@/types'

/**
 * 一键填充文本空隙
 *
 * 对每一对相邻字幕，令 gap = start[i+1] - end[i]：
 *   gap ≤ 0                     已有重叠，不处理
 *   0 < gap ≤ 阈值               end[i] = start[i+1] - 保留间隙
 *   gap > 阈值                   视为有意停顿，不处理
 *
 * 若开启单条最长时长限制，填充后的结束时间不超过 start[i] + 上限。
 */

export interface GapChange {
  /** 被修改的字幕 id（前一条） */
  id: string
  /** 在数组中的下标 */
  index: number
  /** 修改前的结束时间 */
  beforeEnd: number
  /** 修改后的结束时间 */
  afterEnd: number
  /** 本次消除的空隙长度 */
  filled: number
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

/** 只计算将要发生的变化，不修改数据 */
export function planGapFill(
  segments: SubtitleSegment[],
  options: GapFillOptions,
): GapChange[] {
  const { thresholdSec, keepGapSec, limitEnabled, maxDurationSec } = options
  const changes: GapChange[] = []

  for (let i = 0; i < segments.length - 1; i += 1) {
    const current = segments[i]
    const next = segments[i + 1]

    const gap = next.start - current.end
    if (gap <= 0) continue
    if (gap > thresholdSec) continue

    let target = next.start - keepGapSec

    if (limitEnabled) {
      const cap = current.start + maxDurationSec
      if (target > cap) target = cap
    }

    if (target <= current.end + 0.0005) continue

    changes.push({
      id: current.id,
      index: i,
      beforeEnd: current.end,
      afterEnd: round(target),
      filled: round(target - current.end),
    })
  }

  return changes
}

/** 直接应用修改，返回被修改的字幕条数 */
export function applyGapFill(
  segments: SubtitleSegment[],
  options: GapFillOptions,
): number {
  const changes = planGapFill(segments, options)
  const byId = new Map(segments.map((s) => [s.id, s]))

  for (const change of changes) {
    const target = byId.get(change.id)
    if (target) target.end = change.afterEnd
  }

  return changes.length
}

/** 统计当前有多少处会被填充，用于按钮上的提示 */
export function countGapFill(segments: SubtitleSegment[], options: GapFillOptions): number {
  return planGapFill(segments, options).length
}
