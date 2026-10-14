/**
 * 引擎多格式解码测试：用同一模型识别 WAV 与各压缩格式样本，
 * 校验每个格式都能解码、时长与 WAV 基本一致、并给出文本对照。
 *
 * 用法：node tools/engine-formats.mjs [引擎exe路径]
 * 不传引擎路径时默认用 vulkan 构建产物，没有则退回 cpu。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const ENGINE =
  process.argv[2] ??
  [
    path.join(root, 'engine/build/vulkan/bin/xbaos-engine.exe'),
    path.join(root, 'engine/build/cpu/bin/xbaos-engine.exe'),
  ].find((p) => existsSync(p))
const MODEL = path.join(root, 'models/ggml-small.bin')
const FORMATS = ['wav', 'mp3', 'flac', 'ogg', 'opus', 'aiff']
const audioOf = (ext) => path.join(root, 'engine/test-data', `zh-sample.${ext}`)

if (!ENGINE || !existsSync(ENGINE)) {
  console.error('找不到引擎 exe')
  process.exit(1)
}
for (const ext of FORMATS) {
  if (!existsSync(audioOf(ext))) {
    console.error(`缺少样本：${ext}。用 ffmpeg 从 zh-sample.wav 转一份放进 engine/test-data/`)
    process.exit(1)
  }
}

const proc = spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buf = ''
const results = new Map() // ext -> { duration, count, text }
let cur = null
let pending = []

function send(obj) {
  proc.stdin.write(JSON.stringify(obj) + '\n')
}

proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buf += chunk
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === 'pong') {
      send({ id: 10, cmd: 'load', model: MODEL, backend: 'auto' })
    } else if (msg.type === 'loaded') {
      next()
    } else if (cur && msg.type === 'segment') {
      cur.parts.push(msg.text.trim())
    } else if (cur && msg.type === 'done') {
      cur.result = msg
      next()
    } else if (cur && msg.type === 'error') {
      cur.error = msg.message
      next()
    }
  }
})
proc.stderr.on('data', () => {})

let idx = 0
function next() {
  if (!cur) {
    if (idx >= FORMATS.length) return finish()
    const ext = FORMATS[idx]
    cur = { ext, parts: [], result: null, error: null }
    idx += 1
  } else {
    results.set(cur.ext, cur)
    cur = null
    if (idx >= FORMATS.length) return finish()
    const ext = FORMATS[idx]
    cur = { ext, parts: [], result: null, error: null }
    idx += 1
  }
  send({
    id: 100 + idx,
    cmd: 'transcribe',
    audio: audioOf(cur.ext),
    language: 'zh',
    threads: 4,
  })
}

function finish() {
  proc.kill()
  const wav = results.get('wav')
  const baseDur = wav?.result?.duration ?? 0
  console.log(`\n基线 WAV：duration=${baseDur?.toFixed(2)}s count=${wav?.result?.count}`)
  let pass = true
  for (const ext of FORMATS) {
    const r = results.get(ext)
    if (!r || r.error || !r.result) {
      console.log(`  ${ext.padEnd(5)} FAIL  ${r?.error ?? '无结果'}`)
      pass = false
      continue
    }
    const durDiff = Math.abs(r.result.duration - baseDur)
    const okDur = durDiff <= Math.max(0.4, baseDur * 0.03)
    const okCount = r.result.count > 0
    const preview = r.parts.join('').replace(/\s+/g, '').slice(0, 24)
    console.log(
      `  ${ext.padEnd(5)} ${okDur && okCount ? 'PASS' : 'FAIL'}  duration=${r.result.duration.toFixed(2)}s` +
        ` (差${durDiff.toFixed(2)}s) count=${r.result.count}  首段「${preview}…」`,
    )
    if (!okDur || !okCount) pass = false
  }
  console.log(pass ? '\n多格式解码测试 通过' : '\n多格式解码测试 失败')
  process.exit(pass ? 0 : 1)
}

send({ id: 1, cmd: 'ping' })
