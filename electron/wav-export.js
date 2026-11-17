/**
 * WAV 顺序拼接。
 *
 * 只做「把若干段 PCM 接成一段」这一件事：不重采样、不混音、不改声道数。
 * 调用方（渲染层）负责先把每一段解成同一规格（采样率 / 声道数 / 16 位 PCM），
 * 这里只校验规格一致然后顺序追加 —— 在主进程做重采样要连整套 DSP 一起搬，
 * 为一个导出功能不值得。
 *
 * 为什么走文件而不是在内存里拼：一小时 48kHz 立体声就是 690MB，
 * 全塞进内存拼一遍再写出去，轻薄本会直接开始换页。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 走一遍 chunk 链，取 fmt 与 data 的位置（不假设 44 字节定长头） */
function scanChunks(buf) {
  if (buf.length < 12) throw new Error('不是有效的 WAV 文件')
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件')
  }

  let fmt = null
  let data = null
  let p = 12
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4)
    const size = buf.readUInt32LE(p + 4)
    const body = p + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = { offset: body, length: Math.max(0, Math.min(size, buf.length - body)) }
      break
    }
    // chunk 按偶数字节对齐，奇数长度后面补一个填充字节
    p = body + size + (size % 2)
  }

  if (!fmt) throw new Error('WAV 缺少 fmt 段')
  if (!data) throw new Error('WAV 缺少 data 段')
  return { fmt, data }
}

/** 规格不一致时的说明要能照着改，不能只说「格式不一致」 */
function describe(f) {
  return `${f.sampleRate}Hz / ${f.channels} 声道 / ${f.bits} 位`
}

/**
 * 把 `parts` 里的 WAV 按顺序拼成一个，写到 `outPath`。
 *
 * @param {string[]} parts 中间文件路径（调用方负责清理）
 * @param {string} outPath 目标文件
 * @returns {{ path: string, bytes: number, seconds: number }}
 */
export function concatWav(parts, outPath) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('没有可拼接的音频')

  const parsed = parts.map((p) => {
    const buf = fs.readFileSync(p)
    return { buf, ...scanChunks(buf) }
  })

  const head = parsed[0].fmt
  for (let i = 1; i < parsed.length; i += 1) {
    const f = parsed[i].fmt
    if (
      f.channels !== head.channels ||
      f.sampleRate !== head.sampleRate ||
      f.bits !== head.bits
    ) {
      throw new Error(`第 ${i + 1} 段是 ${describe(f)}，第 1 段是 ${describe(head)}`)
    }
  }

  const totalData = parsed.reduce((n, it) => n + it.data.length, 0)
  const riffSize = 36 + totalData
  if (riffSize > 0xffffffff) throw new Error('拼出来的音频超过 4GB，WAV 装不下，请分段导出')

  const blockAlign = head.channels * (head.bits / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(riffSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(head.channels, 22)
  header.writeUInt32LE(head.sampleRate, 24)
  header.writeUInt32LE(head.sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(head.bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(totalData, 40)

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const fd = fs.openSync(outPath, 'w')
  try {
    fs.writeSync(fd, header)
    for (const item of parsed) {
      fs.writeSync(fd, item.buf.subarray(item.data.offset, item.data.offset + item.data.length))
    }
  } finally {
    fs.closeSync(fd)
  }

  return {
    path: outPath,
    bytes: 44 + totalData,
    seconds: totalData / (head.sampleRate * blockAlign),
  }
}
