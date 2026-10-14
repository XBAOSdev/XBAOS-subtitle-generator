/**
 * VAD（静音检测与切分）场景预设。
 *
 * 不同录音场景的最优切分参数差别很大：讲座句间停顿长、切得太碎会把一句话
 * 断成两半；街采背景嘈杂、阈值太灵敏会把噪声当语音。与其让用户理解
 * 「最短静音」「起判倍数」这些底层参数，不如按场景直接给一整组调好的值。
 *
 * 维护约定：每个场景的参数**完整独立**、互不继承 —— 哪怕两个场景的数值
 * 相近，也要各写各的。用户看到的是「场景」这一层，底层将来单独微调某个
 * 场景时不能牵连其他场景。
 *
 * 字段含义（与引擎 vad.hpp 的 VadOptions 对应）：
 *   minSpeechSec   短于此的语音碎片当作噪声丢弃（秒）
 *   minSilenceSec  短于此的间隔视为句内停顿、合并（秒）—— 越大越不容易切断长句
 *   longSilenceSec 长于此的静音直接跨过不识别（秒）—— 防止在空窗上产生幻觉
 *   noisePercentile 噪声底取全片段 RMS 的百分位 —— 背景越嘈杂取越高
 *   startFactor    起判倍数（超过噪声底多少倍才算开始说话）
 *   stopFactor     判停倍数（回落到多少倍以内算停顿），必须低于起判倍数
 *   targetSec      单块目标时长（秒），whisper 窗口 30s 留余量
 *   overlapSec     超长连续语音硬切时的重叠时长（秒）
 */

import type { VadOptionsPayload } from '@/types/engine'

export interface VadPreset {
  id: string
  /** 展示名（下拉列表里显示） */
  name: string
  /** 一句话说明（选中后显示） */
  note: string
  /** 该场景的完整切分参数 */
  options: VadOptionsPayload
}

export const VAD_PRESETS: VadPreset[] = [
  {
    id: 'general',
    name: '通用',
    note: '均衡默认值，不确定选什么时的安全选择',
    options: {
      minSpeechSec: 0.2,
      minSilenceSec: 0.3,
      longSilenceSec: 4.0,
      noisePercentile: 0.2,
      startFactor: 2.0,
      stopFactor: 1.2,
      targetSec: 24.0,
      overlapSec: 1.0,
    },
  },
  {
    id: 'lecture',
    name: '课程 / 讲座',
    note: '单人长篇讲授，句间停顿较长，避免把长句切散',
    options: {
      minSpeechSec: 0.25,
      minSilenceSec: 0.5,
      longSilenceSec: 5.0,
      noisePercentile: 0.2,
      startFactor: 2.0,
      stopFactor: 1.2,
      targetSec: 26.0,
      overlapSec: 1.0,
    },
  },
  {
    id: 'interview',
    name: '访谈 / 对话',
    note: '两人问答、话轮转换快，短句多',
    options: {
      minSpeechSec: 0.15,
      minSilenceSec: 0.25,
      longSilenceSec: 3.0,
      noisePercentile: 0.25,
      startFactor: 1.8,
      stopFactor: 1.2,
      targetSec: 20.0,
      overlapSec: 1.0,
    },
  },
  {
    id: 'podcast',
    name: '播客 / 闲谈',
    note: '轻松多话轮，笑声与插话多，容忍短停顿',
    options: {
      minSpeechSec: 0.2,
      minSilenceSec: 0.35,
      longSilenceSec: 3.5,
      noisePercentile: 0.25,
      startFactor: 1.8,
      stopFactor: 1.25,
      targetSec: 22.0,
      overlapSec: 1.0,
    },
  },
  {
    id: 'audiobook',
    name: '有声书 / 朗读',
    note: '字正腔圆，句间停顿规整',
    options: {
      minSpeechSec: 0.25,
      minSilenceSec: 0.4,
      longSilenceSec: 4.0,
      noisePercentile: 0.15,
      startFactor: 2.2,
      stopFactor: 1.2,
      targetSec: 24.0,
      overlapSec: 0.8,
    },
  },
  {
    id: 'meeting',
    name: '会议记录',
    note: '多人发言、插话与抢话频繁',
    options: {
      minSpeechSec: 0.15,
      minSilenceSec: 0.22,
      longSilenceSec: 3.0,
      noisePercentile: 0.25,
      startFactor: 1.7,
      stopFactor: 1.2,
      targetSec: 20.0,
      overlapSec: 1.2,
    },
  },
  {
    id: 'narration',
    name: '旁白 / 配音',
    note: '录音环境干净的解说词，句间留白短',
    options: {
      minSpeechSec: 0.2,
      minSilenceSec: 0.25,
      longSilenceSec: 3.0,
      noisePercentile: 0.15,
      startFactor: 2.0,
      stopFactor: 1.15,
      targetSec: 24.0,
      overlapSec: 0.8,
    },
  },
  {
    id: 'street',
    name: '街采 / 现场嘈杂',
    note: '背景噪声大，阈值相应抬高，避免把噪声当语音',
    options: {
      minSpeechSec: 0.3,
      minSilenceSec: 0.45,
      longSilenceSec: 4.0,
      noisePercentile: 0.3,
      startFactor: 2.4,
      stopFactor: 1.3,
      targetSec: 24.0,
      overlapSec: 1.0,
    },
  },
  {
    id: 'phone',
    name: '电话 / 低质量录音',
    note: '窄频、电平不稳的通话或老旧录音',
    options: {
      minSpeechSec: 0.25,
      minSilenceSec: 0.4,
      longSilenceSec: 4.0,
      noisePercentile: 0.3,
      startFactor: 2.2,
      stopFactor: 1.3,
      targetSec: 22.0,
      overlapSec: 1.0,
    },
  },
  {
    id: 'stage',
    name: '演讲 / 舞台',
    note: '远场收音，带观众掌声与哄笑',
    options: {
      minSpeechSec: 0.3,
      minSilenceSec: 0.5,
      longSilenceSec: 5.0,
      noisePercentile: 0.3,
      startFactor: 2.4,
      stopFactor: 1.25,
      targetSec: 26.0,
      overlapSec: 1.2,
    },
  },
  {
    id: 'dictation',
    name: '口述 / 听打',
    note: '近距麦克风，逐句停顿明显',
    options: {
      minSpeechSec: 0.2,
      minSilenceSec: 0.35,
      longSilenceSec: 3.0,
      noisePercentile: 0.15,
      startFactor: 1.8,
      stopFactor: 1.15,
      targetSec: 20.0,
      overlapSec: 0.8,
    },
  },
]

/** 按 id 取预设，未知 id 回退到「通用」 */
export function vadPreset(id: string | undefined): VadPreset {
  return VAD_PRESETS.find((p) => p.id === id) ?? VAD_PRESETS[0]
}

/** 按关键字过滤场景（匹配名称与说明，不区分大小写） */
export function filterVadPresets(query: string): VadPreset[] {
  const q = query.trim().toLowerCase()
  if (!q) return VAD_PRESETS
  return VAD_PRESETS.filter(
    (p) => p.name.toLowerCase().includes(q) || p.note.toLowerCase().includes(q),
  )
}
