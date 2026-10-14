/**
 * 多遍识别结果的整合（「推理深度」的核心）。
 *
 * 背景：whisper 的贪心解码在失败片段上会升温重采样，同一段音频跑多次结果
 * 并不相同 —— 有时很准，有时漏句。多次取样能拿到互补的候选，但必须有个
 * 算法把「最优版本」挑出来。这里用的是两层，都不依赖任何模型：
 *
 *   第一层（客观打分）：用引擎给出的置信度（avgLogprob）、无语音段占比，
 *            再减去「重复退化」惩罚，给每一遍打分。
 *   第二层（MBR 共识挑选）：在得分接近的候选之间，两两算相似度，
 *            选「和其他版本最像」的那一份（Minimum Bayes Risk 的直观形式）。
 *
 * 为什么不是逐句拼接：那是 ROVER 的做法，需要词级对齐，中文还要处理分词，
 * 投入产出比很低；整份投票虽然粒度粗，但时间轴天然自洽，不会出现错位。
 *
 * 相似度用字符二元组 Dice 系数而不是编辑距离：O(n) 而非 O(n*m)，
 * 对「漏句 / 多句」这类长度差异也很敏感，正好是我们最关心的错误形态。
 */

import type { SubtitleSegment } from '@/types'
import { toSimplified } from '@/utils/punctuation'

export interface RunStats {
  /** 分段平均对数概率（引擎 done 返回，越接近 0 越好） */
  avgLogprob?: number
  /** 无语音段占比 0–1 */
  noSpeechRatio?: number
  /** 识别出的段数 */
  count?: number
  /** 音频时长 */
  duration?: number
  /** 耗时（秒） */
  elapsed?: number
}

export interface RecognitionRun {
  /** 这一遍用的采样温度，便于诊断 */
  temperature: number
  segments: SubtitleSegment[]
  stats?: RunStats
}

export type MergeMethod = 'single' | 'score' | 'mbr' | 'fallback'

export interface MergeResult {
  /** 被选中的那一遍 */
  best: RecognitionRun
  /** 每一遍的得分，顺序与输入一致 */
  scores: number[]
  /** 每一遍的重复度惩罚 0–1 */
  penalties: number[]
  method: MergeMethod
  /** 选中原因，直接显示给用户 */
  reason: string
  /** 相似度矩阵（仅当遍数 > 1） */
  similarity?: number[][]
}

/** 置信度换算：avgLogprob -0.3 → 0.7，-1.0 → 0；越接近 1 越可信 */
function confidenceOf(avgLogprob: number | undefined): number {
  if (avgLogprob === undefined) return 0.6 // 引擎没给就按中性处理
  return Math.max(0, Math.min(1, 1 + avgLogprob))
}

/**
 * 重复退化惩罚 0–1。
 * 模型跑飞时最典型的产物是「同一小段文字无限循环」——这类结果在
 * 多次投票里也可能重复出现（同一段音频触发同样的循环），所以必须显式识别。
 */
export function repetitionPenalty(text: string): number {
  if (text.length < 12) return 0
  const chars = [...text]
  let worst = 0
  // 检查 2~4 字的最小循环单元连续重复的情况
  for (let unit = 2; unit <= 4; unit++) {
    let run = 0
    let repeated = 0
    for (let i = unit; i + unit <= chars.length; i++) {
      const same = chars.slice(i, i + unit).join('') === chars.slice(i - unit, i).join('')
      if (same) {
        run++
        repeated = Math.max(repeated, run)
      } else {
        run = 0
      }
    }
    if (repeated > 0) worst = Math.max(worst, Math.min(1, repeated / 6))
  }
  // 另有「整句反复」的情况：统计重复出现的段文本占比
  const trimmed = text.split('\n').map((s) => s.trim()).filter(Boolean)
  if (trimmed.length >= 6) {
    const counts = new Map<string, number>()
    for (const line of trimmed) counts.set(line, (counts.get(line) ?? 0) + 1)
    const top = Math.max(...counts.values())
    worst = Math.max(worst, Math.min(1, (top - 1) / 4))
  }
  return Math.round(worst * 100) / 100
}

export function runText(run: RecognitionRun): string {
  return run.segments.map((s) => s.text.trim()).filter(Boolean).join('')
}

/**
 * 客观打分。权重是经验值：置信度是主要信号，无语音占比次之，
 * 重复退化作为扣分项（它几乎必然意味着这一遍已经不可用）。
 */
export function scoreRun(run: RecognitionRun): number {
  const stats = run.stats ?? {}
  const conf = confidenceOf(stats.avgLogprob)
  const noSpeech = Math.max(0, Math.min(1, stats.noSpeechRatio ?? 0))
  const penalty = repetitionPenalty(runText(run))
  const score = conf - 0.6 * noSpeech - 0.3 * penalty
  return Math.round(score * 1000) / 1000
}

/** 字符二元组计数表 */
function gramsOf(s: string): Map<string, number> {
  const chars = [...s]
  const map = new Map<string, number>()
  if (chars.length === 1) {
    map.set(chars[0], 1)
    return map
  }
  for (let i = 0; i + 2 <= chars.length; i++) {
    const gram = chars[i] + chars[i + 1]
    map.set(gram, (map.get(gram) ?? 0) + 1)
  }
  return map
}

/** 两侧 bigram 的重叠量与各自总量 */
function gramOverlap(a: string, b: string): { overlap: number; totalA: number; totalB: number } {
  const ga = gramsOf(a)
  const gb = gramsOf(b)
  let overlap = 0
  let totalA = 0
  let totalB = 0
  for (const n of ga.values()) totalA += n
  for (const [gram, n] of gb) {
    totalB += n
    const hit = ga.get(gram)
    if (hit) overlap += Math.min(hit, n)
  }
  return { overlap, totalA, totalB }
}

/** 字符二元组 Dice 相似度，0–1（两边长度相当时用它） */
export function diceSimilarity(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  if (a === b) return 1
  const { overlap, totalA, totalB } = gramOverlap(a, b)
  if (totalA === 0 || totalB === 0) return 0
  return (2 * overlap) / (totalA + totalB)
}

/**
 * 比对前的归一化：繁转简 → 小写 → 去掉所有标点与空白。
 *
 * 缺了这一步会凭空丢分：识别结果走的是「去标点管道」（`那么以上就是本期视频的全部内容`），
 * 而用户粘贴的旁白稿带标点（`……的全部内容，也欢迎各位在评论区补充。`），
 * 标点参与的 bigram 全都不匹配，相似度会被无谓地压低一截。
 */
export function normalizeForCompare(text: string): string {
  return toSimplified(text)
    .toLowerCase()
    .replace(/[\p{P}\s]+/gu, '')
}

/**
 * 覆盖率：`overlap / min(两侧 bigram 数)`，非对称的「包含度」。
 *
 * 为什么不直接用对称 Dice：文案纠偏的两个输入天然**长度差一个量级** ——
 * 用户手上往往是整期视频的旁白稿（几百上千字），识别结果可能只是其中一段
 * （几十上百字）。对称 Dice 的分母是两边之和，长度差会把它硬压在天花板
 * `2×短/(长+短)` 之下：730 字的稿子对 180 字的字幕，就算短的那段**一字不差**地
 * 出现在长文里，也只有约 39% —— 被误判成「不是同一段内容，不交给 AI」。
 *
 * 覆盖率只看「较短的一侧有多少能在另一侧找到」，超集与子集两种情况都能正确给高分，
 * 两端确实无关时依然接近 0。
 *
 * 只有**极短**输入（较短一侧不足 3 个 bigram，也就是一两个词）才退回对称判据：
 * 那种长度下覆盖率本身就是噪声（随便一篇文稿都可能碰巧包含「好的」），
 * 而一旦有了一句话以上的长度，也就谈不上「长度差把分数压死」了。
 */
export function containmentSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a)
  const nb = normalizeForCompare(b)
  if (!na && !nb) return 1
  if (!na || !nb) return 0
  if (na === nb) return 1
  const { overlap, totalA, totalB } = gramOverlap(na, nb)
  const shortSide = Math.min(totalA, totalB)
  if (shortSide === 0) return 0
  if (shortSide < 3) return diceSimilarity(na, nb)
  return overlap / shortSide
}

/** 一遍结果是否已被重复退化判定为不可用 */
export function isDegenerate(run: RecognitionRun): boolean {
  return repetitionPenalty(runText(run)) >= 0.6 || run.segments.length === 0
}

/**
 * 整合多遍结果。
 *
 * 单遍（或全部候选同分到无法区分）时直接返回，不做无意义的投票；
 * 多遍时先按分数筛掉明显劣化与退化的候选，再在剩余候选里做共识挑选。
 */
export function mergeRuns(runs: RecognitionRun[]): MergeResult {
  const valid = runs.filter((r) => r.segments.length > 0)
  const pool = valid.length > 0 ? valid : runs
  if (pool.length === 0) {
    throw new Error('没有可用的识别结果')
  }

  const scores = pool.map(scoreRun)
  const penalties = pool.map((r) => repetitionPenalty(runText(r)))

  if (pool.length === 1) {
    return {
      best: pool[0],
      scores,
      penalties,
      method: 'single',
      reason: '只有一遍结果，直接采用',
    }
  }

  const usable = pool
    .map((run, i) => ({ run, i, score: scores[i] }))
    .filter((item) => !isDegenerate(item.run))

  if (usable.length === 0) {
    // 全部疑似退化：取分数最高的一份，但明确告诉用户
    let bestIdx = 0
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bestIdx]) bestIdx = i
    return {
      best: pool[bestIdx],
      scores,
      penalties,
      method: 'fallback',
      reason: '多遍结果都疑似重复退化，已采用其中置信度最高的一遍，建议复核',
    }
  }

  const texts = usable.map((item) => runText(item.run))
  const similarity: number[][] = texts.map(() => texts.map(() => 0))
  const meanSim: number[] = texts.map(() => 0)
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const s = diceSimilarity(texts[i], texts[j])
      similarity[i][j] = s
      similarity[j][i] = s
    }
    similarity[i][i] = 1
  }
  for (let i = 0; i < texts.length; i++) {
    let sum = 0
    for (let j = 0; j < texts.length; j++) if (i !== j) sum += similarity[i][j]
    meanSim[i] = texts.length > 1 ? sum / (texts.length - 1) : 1
  }

  const bestScore = Math.max(...usable.map((item) => item.score))
  // 得分差距很小时不迷信打分，交给共识投票（分数受硬件浮点误差影响会有抖动）
  const nearBest = usable.filter((item) => item.score >= bestScore - 0.15)
  const candidates = nearBest.length > 1 ? nearBest : usable

  // 注意：meanSim 的下标是「在 usable 里的位置」，candidates 是它的子集，
  // 必须先把子集位置映射回 usable 位置再用，否则会选错。
  const positionInUsable = new Map<number, number>()
  usable.forEach((item, u) => positionInUsable.set(item.i, u))

  let chosen = candidates[0]
  for (let k = 1; k < candidates.length; k++) {
    const cand = candidates[k]
    const cur = chosen
    const simCand = meanSim[positionInUsable.get(cand.i) ?? 0]
    const simCur = meanSim[positionInUsable.get(cur.i) ?? 0]
    if (simCand > simCur + 1e-9 || (Math.abs(simCand - simCur) <= 1e-9 && cand.score > cur.score)) {
      chosen = cand
    }
  }

  // 共识最佳是否恰好也是打分最高的一遍？
  let scoreLeader = usable[0]
  for (let i = 1; i < usable.length; i++) {
    if (usable[i].score > scoreLeader.score) scoreLeader = usable[i]
  }
  const agree = chosen.i === scoreLeader.i

  return {
    best: chosen.run,
    scores,
    penalties,
    method: 'mbr',
    reason: agree
      ? `${pool.length} 遍结果中，置信度最高的一遍同时获得多数共识，已采用`
      : `${pool.length} 遍结果按多数共识整合（与单看置信度的选择不同）`,
    similarity,
  }
}
