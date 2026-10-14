import type { SubtitleSegment } from '@/types'

/**
 * 泳道布局：把时间轴上互相重叠的字幕分层摆放。
 *
 * 这是「剪辑软件多轨」的核心：同一条泳道上不许有时间重叠，重叠的条目自动
 * 落到下面（或上面）一条空泳道上。好处是**布局永远是数据的函数** ——
 * 无论是拖拽改了边界、还是用户在下方表格里手动输入时间码、还是批量工具
 * 整体偏移，只要数据变了，泳道就重算，不需要任何额外的同步代码。
 *
 * 算法是经典的「区间图着色」贪心：
 *   1. 按起点排序（起点相同按终点，保证结果稳定、不随数组顺序抖动）；
 *   2. 每条依次找**第一条**「上一条的终点已经让开了」的泳道；
 *   3. 都占着就新开一条。
 *
 * 同一泳道内条目既然互不重叠，且按起点递增处理，那么「该泳道最后一条的终点」
 * 就是这条泳道上最大的终点 —— 所以每个泳道只需要记一个数字，不必遍历。
 * 复杂度 O(n × 泳道数)，泳道数在真实字幕里通常只有 1～3。
 */

/** 判定「让开」时额外留出的间隙（秒）。贴着 0 会让首尾相接的两条在视觉上粘住 */
const LANE_EPS = 1e-6

/**
 * 同时重叠的字幕**最多几条**。
 *
 * 取 5 不是随便定的：真实字幕里同时出现 3 条已经很少见了，5 条基本等于数据
 * 出了问题（或者时间码被改乱了）。与其让它把泳道区撑成一片看不清的重叠色块，
 * 不如当**硬上限**——界面按上限铺，超出的直接拦下来并说明原因。
 * 这个值同时决定了时间轴泳道区的高度，所以只在这里定义一处。
 */
export const MAX_LANES = 5

export interface LaneLayout {
  /** 条目 id → 泳道序号（从 0 起） */
  laneOf: Map<string, number>
  /** 用到的泳道总数。没有任何条目时为 0 */
  laneCount: number
}

const EMPTY_LAYOUT: LaneLayout = { laneOf: new Map(), laneCount: 0 }

export function assignLanes(segments: SubtitleSegment[]): LaneLayout {
  if (segments.length === 0) return EMPTY_LAYOUT

  const ordered = [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
  /** 每条泳道上当前最后一条的终点 */
  const laneEnds: number[] = []
  const laneOf = new Map<string, number>()

  for (const seg of ordered) {
    const lane = laneEnds.findIndex((end) => end <= seg.start + LANE_EPS)
    if (lane < 0) {
      laneOf.set(seg.id, laneEnds.length)
      laneEnds.push(seg.end)
    } else {
      laneOf.set(seg.id, lane)
      laneEnds[lane] = seg.end
    }
  }

  return { laneOf, laneCount: laneEnds.length }
}

/** 超出上限的泳道序号集合（空的 Set 表示没超）。用于给条目挂上「超限」告警 */
export function overflowLaneIds(segments: SubtitleSegment[]): Set<string> {
  const layout = assignLanes(segments)
  const out = new Set<string>()
  if (layout.laneCount <= MAX_LANES) return out
  for (const [id, lane] of layout.laneOf) {
    if (lane >= MAX_LANES) out.add(id)
  }
  return out
}

/**
 * 把某一条改成给定时间码之后，占用泳道数会不会超过上限。
 *
 * 时间码是可以手输的，所以「同一时刻重叠 6 条」在数据层是能造出来的 ——
 * 拦在输入那一刻比事后显示一个混乱的时间轴有用得多。只做一次试算，不改数据。
 */
export function exceedsLaneLimit(
  segments: SubtitleSegment[],
  patch: { id: string; start?: number; end?: number },
): boolean {
  const next = segments.map((s) =>
    s.id === patch.id
      ? { ...s, start: patch.start ?? s.start, end: patch.end ?? s.end }
      : s,
  )
  return assignLanes(next).laneCount > MAX_LANES
}

/**
 * 按给定时间码搬动一个**区间**（整条平移）后，会不会超过泳道上限。
 *
 * 与 `exceedsLaneLimit` 分开写是因为拖整条时起点终点一起变、而且是相对量，
 * 用补丁式接口表达会把调用方绕晕。
 */
export function exceedsLaneLimitByShift(
  segments: SubtitleSegment[],
  id: string,
  deltaSec: number,
): boolean {
  const next = segments.map((s) =>
    s.id === id ? { ...s, start: s.start + deltaSec, end: s.end + deltaSec } : s,
  )
  return assignLanes(next).laneCount > MAX_LANES
}

/**
 * 取某条泳道上的左邻与右邻。
 *
 * 拖拽调整边界时要用它「顶住」——同一泳道上不许重叠，所以可拖的范围被
 * 邻居夹住。返回值里没有邻居时是 null，由调用方按 0 / 总时长兜底。
 */
export function laneNeighbours(
  segments: SubtitleSegment[],
  laneOf: Map<string, number>,
  id: string,
  lane: number,
): { prev: SubtitleSegment | null; next: SubtitleSegment | null } {
  const self = segments.find((s) => s.id === id)
  if (!self) return { prev: null, next: null }

  let prev: SubtitleSegment | null = null
  let next: SubtitleSegment | null = null
  for (const seg of segments) {
    if (seg.id === id) continue
    if (laneOf.get(seg.id) !== lane) continue
    if (seg.end <= self.start + LANE_EPS) {
      if (!prev || seg.end > prev.end) prev = seg
      continue
    }
    if (seg.start >= self.end - LANE_EPS) {
      if (!next || seg.start < next.start) next = seg
    }
  }
  return { prev, next }
}
