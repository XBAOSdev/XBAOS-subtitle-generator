/**
 * 「推理深度」档位定义。
 *
 * 关键点：多遍识别必须**变速**。温度为 0 时贪心解码在 CPU（fp32）上是完全
 * 确定性的 —— 同一段音频跑十遍结果一模一样，整合算法拿到的候选全都相同，
 * 纯属白花算力。每遍给一个略高的温度，才会产生「互补的错法」，整合才有意义。
 * （GPU 走 fp16，实测同温两次也会有一两个字的抖动，但那是不可控的噪声，
 *  不能当作多样性来源。）
 *
 * 温度上限控制在 0.8：再往上 whisper 的幻觉率会明显上升，
 * 而且高阶温度带来的多样性对 small 模型来说大多是噪声而非信息。
 */

export type ReasoningDepth = 'standard' | 'enhanced' | 'deep'

export interface DepthPreset {
  id: ReasoningDepth
  label: string
  /** 识别遍数 */
  passes: number
  /** 每一遍的采样温度，长度等于 passes */
  temperatures: number[]
  /** 是否启用「两遍词库精选」（先用一遍探出音频里出现的词，再带着这些词重跑） */
  twoPass: boolean
  /** 界面上的说明 */
  hint: string
  /** 相对标准档的时间倍率，用于给用户预估耗时 */
  timeFactor: number
}

export const DEPTH_PRESETS: Record<ReasoningDepth, DepthPreset> = {
  standard: {
    id: 'standard',
    label: '标准',
    passes: 1,
    temperatures: [0],
    twoPass: false,
    hint: '识别一次，速度最快',
    timeFactor: 1,
  },
  enhanced: {
    id: 'enhanced',
    label: '增强',
    passes: 3,
    temperatures: [0, 0.2, 0.4],
    twoPass: false,
    hint: '识别三遍并整合最优结果，适合正式交付',
    timeFactor: 3,
  },
  deep: {
    id: 'deep',
    label: '深度',
    passes: 5,
    temperatures: [0, 0.2, 0.4, 0.6, 0.8],
    twoPass: true,
    hint: '识别五遍 + 词库两遍精选，重要素材用，耗时明显',
    timeFactor: 5.5,
  },
}

export const DEPTH_ORDER: ReasoningDepth[] = ['standard', 'enhanced', 'deep']

export function depthPreset(depth: ReasoningDepth | string | undefined): DepthPreset {
  if (depth === 'enhanced' || depth === 'deep') return DEPTH_PRESETS[depth]
  return DEPTH_PRESETS.standard
}

/**
 * 按音频时长与后端速度给出粗略耗时预估（秒）。
 * 只是给用户一个量级参考，标称倍率取实测中位数：GPU 约 14× 实时、CPU 约 5×。
 */
export function estimateSeconds(
  durationSec: number,
  depth: ReasoningDepth,
  backend: 'gpu' | 'cpu' | 'unknown' = 'unknown',
): number {
  const rate = backend === 'gpu' ? 14 : backend === 'cpu' ? 5 : 8
  const preset = depthPreset(depth)
  return Math.round((durationSec / rate) * preset.timeFactor)
}
