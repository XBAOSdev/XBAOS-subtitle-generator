/**
 * WAV（PCM 16 位）编码器。
 *
 * 为什么不直接落 MediaRecorder 出来的 webm/opus：
 *   1. 识别引擎对 WAV 支持最稳（dr_libs 原生解码，且是唯一无专利顾虑又无损的形态）；
 *   2. 封装 opus 得拉一个 muxer，属于「为了少写 60 行代码引入一个依赖」；
 *   3. 录音本来就在内存里留了原始 PCM（画波形、做裁剪都要它），编码只是顺手一转，
 *      再走一遍「录 → 解码 → 再编码」纯属绕路。
 *
 * 零依赖，纯函数，可直接单测。
 */

/** 把 [-1, 1] 的浮点样本收敛成 16 位整数。超范围先夹住，不做软削波 —— 录音场景宁可听出失真也不要音量忽大忽小 */
function toInt16(v: number): number {
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v
  // 32767 而不是 32768：正边界乘 32768 会溢出成 -32768（爆音）
  return Math.round(clamped * 32767)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
}

export interface WavOptions {
  /** 每个声道一份样本，长度必须一致 */
  channels: Float32Array[]
  sampleRate: number
}

export function encodeWav({ channels, sampleRate }: WavOptions): Uint8Array {
  const channelCount = Math.max(1, channels.length)
  const frames = channels[0]?.length ?? 0
  const bytesPerSample = 2
  const blockAlign = channelCount * bytesPerSample
  const dataBytes = frames * blockAlign

  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  // ---- RIFF 头
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')

  // ---- fmt 块（16 字节，PCM）
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // 1 = PCM，未压缩
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)

  // ---- data 块：逐帧交错
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const src = channels[c]
      view.setInt16(offset, toInt16(src ? src[f] : 0), true)
      offset += 2
    }
  }

  return new Uint8Array(buffer)
}

/**
 * 从音频缓冲里抽峰值包络，供波形绘制。
 *
 * 每个桶取该区间内的**最大绝对值**而不是平均值：平均值会把短促的辅音削平，
 * 波形看起来比实际安静，用户会以为没录进去。
 */
export function peakEnvelope(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(Math.max(1, buckets))
  if (samples.length === 0) return out
  const per = samples.length / out.length
  for (let i = 0; i < out.length; i += 1) {
    const from = Math.floor(i * per)
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * per)))
    let peak = 0
    for (let j = from; j < to; j += 1) {
      const v = samples[j] < 0 ? -samples[j] : samples[j]
      if (v > peak) peak = v
    }
    out[i] = peak
  }
  return out
}
