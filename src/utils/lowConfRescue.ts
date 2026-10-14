/**
 * 低置信度复核（精准补短板）。
 *
 * 思路：逐段的 avgLogprob 引擎一直在回传，「哪几句不可信」这个信息
 * 一直都有，只是之前没人消费它。与其把整篇音频多跑几遍大模型，
 * 不如只把置信度明显偏低的那几秒圈出来，换更高的束宽单独重识别一遍，
 * 新结果的平均置信度更高才替换 —— 算力花在真正不确定的地方。
 *
 * 区间以 `ranges` 参数直接交给引擎（跳过 VAD，区间本身就是刀口），
 * 替换按「时间重叠 + 置信度比较」逐区间裁决，任何一步不满意都保留原结果。
 */

import type { SubtitleSegment } from '@/types'

/** 低置信阈值：avgLogprob 低于它（约等于置信度 < 0.55）就送去复核 */
export const LOW_CONF_LOGPROB = -0.45

/** 复核用的束搜索宽度（比普通束搜索更高，宁慢勿错） */
export const RESCUE_BEAM_SIZE = 8

/** 比这还短的区间没有复核价值（切出来的碎句多半是误触发） */
const MIN_RANGE_SEC = 1.0

/** 引擎单窗 30s，复核区间也要留余量 */
const MAX_RANGE_SEC = 26.0

/** 相邻低置信段的间隔小于它就并成一个区间，避免反复起停 */
const MERGE_GAP_SEC = 0.6

/** 区间前后各多留一点，给 whisper 的窗口边界留余量 */
const PAD_SEC = 0.3

export interface TimeRange {
  start: number
  end: number
}

/** 置信度 0-1：与 transcriptMerge 的换算一致（avgLogprob -0.3 → 0.7） */
function confidenceOf(seg: SubtitleSegment): number {
  if (typeof seg.avgLogprob !== 'number') return 0.6
  return Math.max(0, Math.min(1, 1 + seg.avgLogprob))
}

/** 段与区间的重叠时长占比（相对段自身时长） */
function overlapRatio(seg: SubtitleSegment, range: TimeRange): number {
  const from = Math.max(seg.start, range.start)
  const to = Math.min(seg.end, range.end)
  const overlap = to - from
  const dur = seg.end - seg.start
  if (overlap <= 0 || dur <= 0) return 0
  return overlap / dur
}

/** 把超长区间按 MAX_RANGE_SEC 切开（切点之间留重叠，引擎侧会按字符去重） */
function splitLong(range: TimeRange): TimeRange[] {
  const out: TimeRange[] = []
  let start = range.start
  while (range.end - start > MAX_RANGE_SEC) {
    const end = start + MAX_RANGE_SEC
    out.push({ start, end })
    start = end - 1.0
  }
  out.push({ start, end: range.end })
  return out
}

/**
 * 从识别结果里挑出需要复核的时间区间。
 * 返回空数组说明没有值得复核的段落（多数正常录音走这条路，零额外开销）。
 */
export function planRescueRanges(segments: SubtitleSegment[], durationSec: number): TimeRange[] {
  const low = segments.filter(
    (s) => typeof s.avgLogprob === 'number' && s.avgLogprob < LOW_CONF_LOGPROB,
  )
  if (low.length === 0) return []

  const limit = durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY
  const padded: TimeRange[] = low
    .map((s) => ({
      start: Math.max(0, s.start - PAD_SEC),
      end: Math.min(limit, s.end + PAD_SEC),
    }))
    .sort((a, b) => a.start - b.start)

  // 合并相邻（间隔小于 MERGE_GAP_SEC 的并成一段）
  const merged: TimeRange[] = []
  for (const r of padded) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end <= MERGE_GAP_SEC) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }

  return merged.filter((r) => r.end - r.start >= MIN_RANGE_SEC).flatMap(splitLong)
}

/** 一组段的平均置信度（空组按 0 处理，必然输给任何有内容的候选） */
function meanConfidence(segs: SubtitleSegment[]): number {
  if (segs.length === 0) return 0
  let sum = 0
  for (const s of segs) sum += confidenceOf(s)
  return sum / segs.length
}

/**
 * 把复核结果应用回主结果：逐区间比较新旧平均置信度，新结果更好才替换。
 *
 * 返回替换后的完整段列表（按时间排序）与被替换的区间数 —— 后者用于在
 * 进度提示里告诉用户「复核了几段」，也为将来的探针断言留观测点。
 */
export function applyRescue(
  segments: SubtitleSegment[],
  rescued: SubtitleSegment[],
  ranges: TimeRange[],
): { segments: SubtitleSegment[]; replaced: number } {
  let out = [...segments]
  let replaced = 0

  for (const range of ranges) {
    const inRange = (s: SubtitleSegment) => overlapRatio(s, range) >= 0.5
    const oldOnes = out.filter(inRange)
    if (oldOnes.length === 0) continue
    const newOnes = rescued.filter(inRange)
    if (newOnes.length === 0) continue

    // 复核结果必须确实更好才换：置信度打平或更差时保留原文，
    // 避免复核本身把原本勉强正确的段落改坏
    if (meanConfidence(newOnes) <= meanConfidence(oldOnes)) continue

    const keep = out.filter((s) => !inRange(s))
    out = [...keep, ...newOnes].sort((a, b) => a.start - b.start)
    replaced++
  }

  return { segments: out, replaced }
}
