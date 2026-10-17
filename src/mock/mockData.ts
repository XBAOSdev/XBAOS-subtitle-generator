/**
 * 阶段 1 界面演示用的假数据。
 * 接入真实引擎后，这个文件只在开发模式下用于 UI 调试。
 */

import type {
  AudioFile,
  AudioPeaks,
  SegmentIssue,
  SubtitleSegment,
} from '@/types'
import { uid } from '@/utils/id'

/** 中文语速约 4.2 字/秒 */
const SEC_PER_CHAR = 0.24

interface BuildOptions {
  /** 起始时间 */
  startAt?: number
  /** 默认句间间隔 */
  gap?: number
  /** 指定某几条之后插入较大的停顿，键为「第几条之后」（从 0 开始） */
  longGaps?: Record<number, number>
  /** 指定某几条的文本替换 */
  overrides?: Record<number, string>
  /** 指定某些条的问题 */
  issues?: Record<number, SegmentIssue[]>
}

function buildSegments(lines: string[], options: BuildOptions = {}): SubtitleSegment[] {
  const {
    startAt = 0.4,
    gap = 0.35,
    longGaps = {},
    overrides = {},
    issues = {},
  } = options

  const result: SubtitleSegment[] = []
  let cursor = startAt

  lines.forEach((line, index) => {
    const text = overrides[index] ?? line
    const duration = Math.max(0.6, text.length * SEC_PER_CHAR)
    const start = Number(cursor.toFixed(3))
    const end = Number((start + duration).toFixed(3))

    result.push({
      id: uid('seg'),
      start,
      end,
      text,
      origin: text,
      issues: issues[index] ?? [],
    })

    cursor = end + (longGaps[index] ?? gap)
  })

  return result
}

/* -------------------------------------------------------------------------- */
/* 文本素材（自撰，无版权问题）                                                */
/* -------------------------------------------------------------------------- */

const EPISODE_LINES = [
  '大家好，欢迎回到这一期的节目。',
  '今天我们要聊的是开放式耳机。',
  '这类产品这两年增长得非常快。',
  '我手上这三款都是今年的新品。',
  '价格从四百多一直到一千出头。',
  '先说结论，最贵的那个不一定最好。',
  '我们先从佩戴说起。',
  '开放式耳机最大的优势就是不堵耳道。',
  '长时间戴着不会有明显的胀痛感。',
  '但代价是低频的量感会明显少一些。',
  '这是物理结构决定的，不是调音能解决的。',
  '第二点是漏音控制。',
  '在安静的办公室里，音量开到六成。',
  '半米之外基本听不清具体内容。',
  '三款里面有两款做到了这个水平。',
  '第三点是通话降噪。',
  '我在地铁站和路口各录了一段。',
  '风噪抑制的差距非常明显。',
  '有一款在大风里几乎是不可用状态。',
  '接下来是延迟。',
  '用视频软件实测，游戏模式下都在八十毫秒以内。',
  '看剧完全没有问题。',
  '音质部分我做了主观评分。',
  '中频人声的解析力差别不大。',
  '差距主要在高频的毛刺感上。',
  '续航方面官方标称都是八小时以上。',
  '实测大概打个八折。',
  '具体的数据我都放在评论区了。',
]

const CHAT_LINES = [
  '好，那我们今天就随便聊聊。',
  '最近在棚里遇到一个挺有意思的问题。',
  '就是关于底噪的。',
  '很多人以为是麦克风的问题。',
  '其实大部分时候是接口或者线材。',
  '我做过一个对比测试。',
  '同一支话筒换三根线。',
  '底噪的差别能到六七个分贝。',
  '这个差距在后期是能听出来的。',
  '所以别急着换设备。',
  '先检查一遍线材和接地。',
  '通常能省下一笔钱。',
  '下一期我们聊聊声卡。',
  '如果你有想听的话题可以留言。',
  '我们下期再见。',
]

const INTRO_LINES = [
  '欢迎收看这一期的节目。',
  '今天带来一期对比实测。',
  '所有数据均为实测。',
]

/* -------------------------------------------------------------------------- */
/* 文件数据                                                                    */
/* -------------------------------------------------------------------------- */

const EPISODE_SEGMENTS = buildSegments(EPISODE_LINES, {
  longGaps: { 5: 2.4, 18: 2.1 },
  issues: {
    2: [
      {
        level: 'warning',
        code: 'CPS_HIGH',
        message: '每秒字符数 27，高于 25 的建议上限',
      },
    ],
    10: [
      {
        level: 'warning',
        code: 'TOO_LONG',
        message: '单条时长 8.2 秒，超过 7 秒的建议上限',
      },
    ],
  },
})

const CHAT_SEGMENTS = buildSegments(CHAT_LINES, {
  startAt: 0.6,
  gap: 0.42,
  longGaps: { 6: 1.9 },
  issues: {
    0: [
      {
        level: 'error',
        code: 'OVERLAP',
        message: '与上一条时间码重叠',
      },
    ],
    4: [
      {
        level: 'error',
        code: 'TOO_SHORT',
        message: '单条时长 0.5 秒，低于 1 秒的下限',
      },
    ],
    9: [
      {
        level: 'warning',
        code: 'LINE_TOO_LONG',
        message: '单行 23 字，超过 20 字的建议上限',
      },
    ],
  },
})

const INTRO_SEGMENTS = buildSegments(INTRO_LINES, { startAt: 0.3, gap: 0.3 })
// 演示「已编辑」状态：其中一条被人工改过
INTRO_SEGMENTS[2].text = '所有数据均为实测，仅供参考。'

function lastEnd(segments: SubtitleSegment[], fallback: number): number {
  return segments.length > 0 ? segments[segments.length - 1].end : fallback
}

export const mockFiles: AudioFile[] = [
  {
    id: uid('file'),
    name: 'S03E12 开放式耳机横评.mp3',
    path: 'D:\\Podcast\\S03E12 开放式耳机横评.mp3',
    dir: 'D:\\Podcast',
    ext: 'mp3',
    sizeBytes: 2_318_745,
    durationSec: Number((lastEnd(EPISODE_SEGMENTS, 0) + 1.2).toFixed(2)),
    status: 'pending',
    segments: EPISODE_SEGMENTS,
  },
  {
    id: uid('file'),
    name: '录音棚闲聊 第7期.mp3',
    path: 'D:\\Podcast\\录音棚闲聊 第7期.mp3',
    dir: 'D:\\Podcast',
    ext: 'mp3',
    sizeBytes: 1_204_889,
    durationSec: Number((lastEnd(CHAT_SEGMENTS, 0) + 1.5).toFixed(2)),
    status: 'issue',
    segments: CHAT_SEGMENTS,
  },
  {
    id: uid('file'),
    name: '片头开场白.mp3',
    path: 'D:\\Audio\\Jingle\\片头开场白.mp3',
    dir: 'D:\\Audio\\Jingle',
    ext: 'mp3',
    sizeBytes: 186_223,
    durationSec: Number((lastEnd(INTRO_SEGMENTS, 0) + 0.8).toFixed(2)),
    status: 'edited',
    segments: INTRO_SEGMENTS,
  },
  {
    id: uid('file'),
    name: '手机实测录音.m4a',
    path: 'D:\\Downloads\\手机实测录音.m4a',
    dir: 'D:\\Downloads',
    ext: 'm4a',
    sizeBytes: 3_902_110,
    durationSec: null,
    status: 'unsupported',
    segments: [],
    message: 'M4A 使用 AAC 编码，因专利原因本软件未内置该解码器',
  },
]

/** 生成一段看起来合理的波形峰值 */
export function makeMockPeaks(durationSec: number, peaksPerSecond = 50): AudioPeaks {
  const count = Math.max(1, Math.ceil(durationSec * peaksPerSecond))
  const data = new Array<number>(count)

  for (let i = 0; i < count; i += 1) {
    const t = i / peaksPerSecond
    // 宏观包络：模拟语音段落有起有伏
    const envelope = 0.42 + 0.38 * Math.sin(t * 0.31 + 1.1) * Math.cos(t * 0.11)
    // 微观细节：模拟音节抖动
    const detail = 0.5 + 0.5 * Math.abs(Math.sin(t * 7.7) * Math.cos(t * 2.3))
    const noise = Math.random() * 0.22
    data[i] = Math.min(1, Math.max(0.03, envelope * detail + noise))
  }

  return { peaksPerSecond, data, durationSec }
}

/** 演示用的长音频时长（合并模式） */
export const mockMergeDuration = mockFiles
  .filter((f) => f.status !== 'unsupported')
  .reduce((sum, f) => sum + (f.durationSec ?? 0), 0)

/* -------------------------------------------------------------------------- */
/* 拖放导入用的工厂（阶段 1 模拟；接入引擎后删除）                              */
/* -------------------------------------------------------------------------- */

const FACTORY_POOL: string[][] = [EPISODE_LINES, CHAT_LINES, INTRO_LINES]

function hashText(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return hash
}

/** 根据拖入的文件名与大小生成一条模拟记录 */
export function makeAudioFile(name: string, sizeBytes: number, dir: string): AudioFile {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  const lines = FACTORY_POOL[Math.abs(hashText(name)) % FACTORY_POOL.length]
  const segments = buildSegments(lines, { startAt: 0.4, gap: 0.35 })

  return {
    id: uid('file'),
    name,
    path: `${dir}\\${name}`,
    dir,
    ext,
    sizeBytes,
    /* 浏览器预览里拖进来的文件拿不到真实内容，造出来的条目**必须自报是演示数据** ——
       播放器的 `loadAt()` 靠它区分「没有 blobUrl 属正常」与「这一段真没音频轨」。
       漏了它，预览里拖文件后点播放会被判成无音频段落并停播。 */
    demo: true,
    durationSec: Number((lastEnd(segments, 0) + 1.1).toFixed(2)),
    status: 'queued',
    segments,
  }
}
