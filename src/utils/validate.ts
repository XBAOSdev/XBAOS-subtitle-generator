/**
 * 字幕校验。
 *
 * 以前 `issues` 恒为空数组 —— 界面上那个「校验结果」面板只有演示数据会亮，
 * 真实识别完永远是「当前文件没有问题」。这里把它做真：按「字幕规格」设置
 * 逐条检查，让 设置 → 校验能报出来 → AI 校对能修 → 回来再校验 形成闭环。
 *
 * 长度这一项用**显示宽度**而不是字符个数判断：1 个汉字占的横向空间约等于
 * 2 个英文字母，直接数字符会把「一行 20 个汉字」当成合格。
 */

import type { SegmentIssue, SubtitleSegment } from '@/types'

/** 校验用到的规格参数（来自设置页的「字幕规格」） */
export interface ValidateSpec {
  /** 中文单行最大字数 */
  maxCharsPerLine: number
  /** 英文单行最大字符数 */
  maxCharsPerLineEn: number
  /** 单条最多行数 */
  maxLinesPerSegment: number
  /** 单条时长上限（秒），0 表示不限 */
  maxSegmentDuration: number
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 时间码重叠的容差：小于这个量级当浮点误差，不报 */
const OVERLAP_TOLERANCE = 0.05
/** 超出时长上限的容差：卡着上限的那条不该被反复提示 */
const DURATION_TOLERANCE = 0.2
/** 低于这个时长算「一闪而过」 */
const MIN_DURATION = 0.8
/** 低于这个时长连读都来不及，单独再提一档 */
const TINY_DURATION = 0.3

/** 显示宽度：汉字算 2，其余（含标点、字母、数字）算 1 */
export function widthUnits(text: string): number {
  let n = 0
  for (const ch of text) n += CJK.test(ch) ? 2 : 1
  return n
}

/** 汉字是否占了这条的一多半宽度 —— 决定按中文还是英文的规格来衡量 */
function isCjkDominant(text: string): boolean {
  let cjk = 0
  let units = 0
  for (const ch of text) {
    const w = CJK.test(ch) ? 2 : 1
    units += w
    if (w === 2) cjk += 2
  }
  return units > 0 && cjk * 2 >= units
}

/**
 * 校验一条字幕。
 *
 * @param seg 当前条
 * @param prev 上一条（判断时间码重叠用），首条传 undefined
 * @param spec 规格参数
 */
export function validateSegment(
  seg: SubtitleSegment,
  prev: SubtitleSegment | undefined,
  spec: ValidateSpec,
): SegmentIssue[] {
  const issues: SegmentIssue[] = []
  const text = seg.text.trim()

  if (text === '') {
    issues.push({ level: 'warning', code: 'EMPTY', message: '这一条没有内容' })
    return issues
  }

  if (seg.end <= seg.start) {
    issues.push({ level: 'error', code: 'BAD_RANGE', message: '结束时间不晚于开始时间' })
  } else if (prev && seg.start < prev.end - OVERLAP_TOLERANCE) {
    issues.push({ level: 'error', code: 'OVERLAP', message: '与上一条的时间码重叠' })
  }

  const duration = seg.end - seg.start

  if (spec.maxSegmentDuration > 0 && duration > spec.maxSegmentDuration + DURATION_TOLERANCE) {
    issues.push({
      level: 'warning',
      code: 'TOO_LONG',
      message: `单条时长 ${duration.toFixed(1)} 秒，超过 ${spec.maxSegmentDuration} 秒的建议上限`,
    })
  }

  if (duration > 0 && duration < MIN_DURATION) {
    issues.push({
      level: duration < TINY_DURATION ? 'warning' : 'info',
      code: 'TOO_SHORT',
      message: `单条时长仅 ${duration.toFixed(1)} 秒，观众可能来不及看`,
    })
  }

  // 长度：按显示宽度衡量
  const dominant = isCjkDominant(text)
  const units = widthUnits(text)
  const perLine = dominant ? spec.maxCharsPerLine * 2 : spec.maxCharsPerLineEn
  const segmentMax = perLine * Math.max(1, spec.maxLinesPerSegment)

  if (units > segmentMax) {
    issues.push({
      level: 'warning',
      code: 'TOO_LONG',
      message: dominant
        ? `单条约 ${Math.round(units / 2)} 字，超过单条 ${spec.maxCharsPerLine * spec.maxLinesPerSegment} 字的上限`
        : `单条 ${text.length} 字符，超过单条 ${spec.maxCharsPerLineEn * spec.maxLinesPerSegment} 字符的上限`,
    })
  }

  return issues
}

/** 整段字幕的校验结果，按索引对应（用于一次性重算整份文件） */
export function validateSegments(
  segments: SubtitleSegment[],
  spec: ValidateSpec,
): SegmentIssue[][] {
  return segments.map((seg, i) => validateSegment(seg, segments[i - 1], spec))
}

/**
 * 界面上要展示的问题。
 *
 * 用户已经整条「忽略」的条目返回空数组 —— 忽略的语义就是「别再提醒我」，
 * 如果校验结果面板、行首红条、右侧小旗仍然照旧亮着，那个按钮等于没做。
 * 注意数据层的 `segments[i].issues` 本身不动，忽略只是**展示与计数**上的
 * 抑制，取消忽略之后一切照旧。
 */
export function visibleIssues(seg: SubtitleSegment): SegmentIssue[] {
  return seg.acked ? [] : seg.issues
}

/** 统计问题条数（有任意一条问题的条目算一次；已忽略的条目不进统计） */
export function countIssues(segments: SubtitleSegment[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const seg of segments) {
    if (seg.acked) continue
    if (seg.issues.some((i) => i.level === 'error')) errors += 1
    else if (seg.issues.some((i) => i.level === 'warning')) warnings += 1
  }
  return { errors, warnings }
}
