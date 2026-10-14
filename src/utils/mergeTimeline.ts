/**
 * 合并时间轴（批量处理 → 「合并为一条时间轴」）的拼接逻辑。
 *
 * 抽成纯函数是为了能在 Node 里直接测 —— 这段逻辑的坑全在「重新拼接时
 * 哪些条目该保留、哪些该重建」上，这些分支靠界面手点很难覆盖全。
 *
 * 核心约束（真踩过，用户报的严重问题）：
 *
 *   合并时间轴同时是编辑器的唯一入口，用户会直接在上面改内容 —— 人工编辑、
 *   工具面板、AI 校对，改的都是它。所以重新拼接**绝不能**无脑从源文件重来：
 *   源文件里存的还是识别原始结果，用户的修改只在产物上，重来一次就等于把
 *   修改全丢了。表现是「往队列里追加一段音频（还没重新识别），之前改过的
 *   内容就原封不动地变回去了」。独立处理模式没有这个问题，因为每个文件
 *   自己就是编辑对象，不经过任何拼接。
 *
 * 于是拼接规则是增量的：
 *   1. 上一轮已经参与过合并的文件 → 整组条目原样保留，只按偏移差整体平移；
 *   2. 这一轮新加入（或刚识别出内容）的文件 → 从源文件生成新条目；
 *   3. 产物上手动新增、没有来源标记的条目 → 保留，按时间码插回原位。
 */

import type { SubtitleSegment } from '@/types'
import { uid } from '@/utils/id'
import { hasContent } from '@/utils/punctuation'

/** 参与合并的一个音频 */
export interface MergeSourceFile {
  id: string
  durationSec: number | null
  segments: SubtitleSegment[]
}

/** 上一轮拼接的产物，用于增量保留 */
export interface MergeCarry {
  segments: SubtitleSegment[]
  offsets: Record<string, number>
}

export interface MergeOutput {
  segments: SubtitleSegment[]
  /** 各文件在本轮时间轴上的起始秒数（fileId → 秒），写回产物供下次拼接用 */
  offsets: Record<string, number>
  /** 全部文件时长之和 */
  durationSec: number
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/**
 * 拼接合并时间轴。
 *
 * @param files 参与合并的文件，数组顺序就是时间轴顺序
 * @param carry 上一轮的产物；传 null 表示首次拼接（全部从源文件生成）
 */
export function buildMergedTimeline(
  files: MergeSourceFile[],
  carry: MergeCarry | null,
): MergeOutput {
  const prevOffsets = carry?.offsets
  const prevSegments = carry?.segments ?? []

  const offsets: Record<string, number> = {}
  const segments: SubtitleSegment[] = []
  let offset = 0

  for (const file of files) {
    const offsetNow = round3(offset)
    // 判据是「上一轮的偏移表里有没有它」，而不是「能不能找到它的条目」：
    // 用户在合并视图里把某个文件的条目全删了也是合法编辑，不能因此又生成回来
    const participated = prevOffsets?.[file.id] !== undefined

    if (participated) {
      const delta = offsetNow - (prevOffsets?.[file.id] ?? offsetNow)
      for (const seg of prevSegments) {
        if (seg.originFileId !== file.id) continue
        segments.push({
          ...seg,
          start: round3(seg.start + delta),
          end: round3(seg.end + delta),
        })
      }
      offsets[file.id] = offsetNow
    } else {
      let produced = false
      for (const seg of file.segments) {
        if (!hasContent(seg.text)) continue
        segments.push({
          ...seg,
          id: uid('seg'),
          originFileId: file.id,
          start: round3(seg.start + offsetNow),
          end: round3(seg.end + offsetNow),
        })
        produced = true
      }
      // 只有真的产出了条目才登记偏移。没识别完的文件不能登记，否则它识别
      // 完成后会被当成「已经参与过」而保留成一片空白
      if (produced) offsets[file.id] = offsetNow
    }

    offset += file.durationSec ?? 0
  }

  // 手动新增的条目没有来源标记，不属于任何文件。直接丢弃会让人以为
  // 「自己加的东西被吃了」，按时间码插回它该在的位置。
  for (const orphan of prevSegments) {
    if (orphan.originFileId) continue
    if (!hasContent(orphan.text)) continue
    const at = segments.findIndex((s) => s.start > orphan.start)
    if (at < 0) segments.push(orphan)
    else segments.splice(at, 0, orphan)
  }

  return { segments, offsets, durationSec: round3(offset) }
}
