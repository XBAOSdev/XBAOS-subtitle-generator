/**
 * 时间码体检：用 CPU 引擎跑长音频，检查 segment 时间码是否与音频时间轴对齐。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

const EXE = path.resolve(process.env.XBAOS_ENGINE_BIN ?? 'engine/build/cpu/bin/xbaos-engine.exe')
const AUDIO = path.resolve(process.argv[2] ?? 'engine/test-data/zh-long.wav')
const MODEL = path.resolve('models/ggml-small-q5_1.bi')

const proc = spawn(EXE, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: process.env.XBAOS_ENABLE_VULKAN ? { ...process.env } : { ...process.env, GGML_DISABLE_VULKAN: '1' },
})

let buf = ''
const segments = []
let done = null
let loaded = false

proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === 'segment') segments.push(msg)
    else if (msg.type === 'done') done = msg
    else if (msg.type === 'loaded') {
      loaded = true
      const opt = process.argv[3] ? JSON.parse(process.argv[3]) : undefined
      send({ id: 2, cmd: 'transcribe', audio: AUDIO, language: 'zh', vad: process.argv[4] !== 'novad', normalize: true, highPass: true, ...(opt ? { vadOptions: opt } : {}) })
    } else if (msg.type === 'error') {
      console.error('引擎报错：', msg.message)
    }
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (d) => process.stderr.write(`[engine] ${d}`))

function send(obj) {
  proc.stdin.write(`${JSON.stringify(obj)}\n`)
}

const t0 = Date.now()
send({ id: 1, cmd: 'load', model: MODEL, backend: 'cpu' })

const poll = setInterval(() => {
  if (!done) return
  clearInterval(poll)
  report()
  send({ id: 9, cmd: 'shutdown' })
  setTimeout(() => proc.kill(), 300)
}, 500)

function report() {
  const dur = done.duration
  console.log(`\n音频时长 ${dur.toFixed(2)} 秒 | 识别 ${segments.length} 段 | 块数 ${done.chunks} | 跳过静音 ${done.skipped} 段`)
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒\n`)
  if (done.chunkRanges) {
    console.log('=== 引擎报告的块区间 ===')
    done.chunkRanges.forEach((r, i) => {
      const list = segments.filter((s) => Math.abs((s.offset ?? -1) - r.start) < 1e-6)
      const hi = list.length ? Math.max(...list.map((s) => s.end)) : r.start
      const over = hi - r.end
      console.log(
        `  块 ${i + 1}: ${r.start.toFixed(2)} → ${r.end.toFixed(2)}（长 ${(r.end - r.start).toFixed(2)}s）` +
          ` | ${list.length} 段 | 末段到 ${hi.toFixed(2)}` +
          (over > 0.05 ? `  ← 超出块尾 ${over.toFixed(2)}s` : ''),
      )
    })
    console.log('')
  }

  const sorted = [...segments].sort((a, b) => a.start - b.start)
  let overlaps = 0
  let backwards = 0
  let maxEnd = 0
  let biggestGap = 0
  let gapAt = 0

  for (let i = 0; i < sorted.length; i += 1) {
    const s = sorted[i]
    if (s.end <= s.start) backwards += 1
    if (i > 0 && s.start < sorted[i - 1].end - 0.05) overlaps += 1
    maxEnd = Math.max(maxEnd, s.end)
    const gap = s.start - (sorted[i - 1]?.end ?? 0)
    if (i > 0 && gap > biggestGap) {
      biggestGap = gap
      gapAt = s.start
    }
  }

  console.log('=== 结构检查 ===')
  console.log(`  倒置条目（end<=start）      ${backwards}`)
  console.log(`  重叠条目                    ${overlaps}`)
  console.log(`  最后一条 end                ${maxEnd.toFixed(3)}（音频 ${dur.toFixed(3)}）`)
  console.log(`  超出音频时长                ${(maxEnd - dur).toFixed(3)} 秒`)
  console.log(`  最大相邻空隙                ${biggestGap.toFixed(2)} 秒（在 ${gapAt.toFixed(2)} 秒处）`)

  // 按块内序号 i 重置来还原分块归属
  const blocks = []
  for (const s of segments) {
    if (s.i === 0 || blocks.length === 0) blocks.push([])
    blocks[blocks.length - 1].push(s)
  }
  console.log(`\n=== 按块归属（引擎块内序号 i 重置即换块）共 ${blocks.length} 块 ===`)
  for (let b = 0; b < blocks.length; b += 1) {
    const list = blocks[b]
    const lo = Math.min(...list.map((s) => s.start))
    const hi = Math.max(...list.map((s) => s.end))
    console.log(`  块 ${b + 1}：${list.length} 段，实际覆盖 ${lo.toFixed(2)} → ${hi.toFixed(2)} 秒（跨度 ${(hi - lo).toFixed(2)} 秒）`)
    for (const s of list) {
      console.log(`      [i=${String(s.i).padStart(2)}] ${s.start.toFixed(2).padStart(7)} → ${s.end.toFixed(2).padStart(7)}  ${s.text.slice(0, 20)}`)
    }
  }

  console.log('\n=== 时间码明细 ===')
  for (const s of sorted) {
    const flag = s.end <= s.start ? ' << 倒置' : ''
    console.log(
      `  ${s.start.toFixed(2).padStart(7)} → ${s.end.toFixed(2).padStart(7)}  ` +
        `(${(s.end - s.start).toFixed(2)}s)  ${s.text.slice(0, 34)}${flag}`,
    )
  }
}
