/**
 * 静音检测（VAD）与长音频切分测试。
 *
 * 样本 zh-long.wav = 三段 20.9s 中文语音，中间各夹 5s 纯静音，总长约 70s。
 * 对比 vad 开 / 关两种模式：
 *   - 关：整段送一次 whisper_full（chunks=1）
 *   - 开：在静音处切成多块、跨过长静音逐块识别
 * 断言重点是「开了之后三段话都还在」——也就是用户报告的缺句漏句问题。
 *
 * 用法：node tools/engine-vad.mjs [引擎exe路径]
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
const AUDIO = path.join(root, 'engine/test-data/zh-long.wav')

if (!ENGINE || !existsSync(ENGINE)) {
  console.error('找不到引擎 exe')
  process.exit(1)
}
if (!existsSync(AUDIO)) {
  console.error(`缺少样本 ${AUDIO}`)
  console.error('生成方式：用 ffmpeg 把 engine/test-data/zh-sample.wav 与 5 秒静音交替拼成 70 秒音频')
  process.exit(1)
}

const CASES = [
  { name: 'vad=off', vad: false },
  { name: 'vad=on', vad: true },
]

const proc = spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buf = ''
let idx = 0
let cur = null
const results = []

const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n')

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
      startCase()
    } else if (cur) {
      if (msg.type === 'segment') {
        cur.segments.push({ start: msg.start, end: msg.end, text: msg.text.trim(), noSpeech: msg.noSpeech })
      } else if (msg.type === 'done') {
        cur.done = msg
        results.push(cur)
        cur = null
        startCase()
      } else if (msg.type === 'error') {
        cur.error = msg.message
        results.push(cur)
        cur = null
        startCase()
      }
    }
  }
})
proc.stderr.on('data', () => {})

function startCase() {
  if (!cur) {
    if (idx >= CASES.length) return finish()
    const c = CASES[idx]
    cur = { name: c.name, segments: [], done: null, error: null }
    idx += 1
    send({
      id: 100 + idx,
      cmd: 'transcribe',
      audio: AUDIO,
      language: 'zh',
      threads: 4,
      vad: c.vad,
      normalize: true,
    })
  }
}

function finish() {
  proc.kill()
  const off = results.find((r) => r.name === 'vad=off')
  const on = results.find((r) => r.name === 'vad=on')
  let pass = true
  const fail = (msg) => {
    console.log(`  FAIL  ${msg}`)
    pass = false
  }

  for (const r of results) {
    if (r.error || !r.done) {
      fail(`${r.name} 未返回结果：${r.error ?? '未知错误'}`)
      continue
    }
    const text = r.segments.map((s) => s.text).join('').replace(/\s+/g, '')
    console.log(
      `\n${r.name}：chunks=${r.done.chunks} skipped=${r.done.skipped} 段数=${r.segments.length} ` +
        `字数=${text.length} 语音时长=${(r.done.speechSeconds ?? 0).toFixed(1)}s ` +
        `avgLogprob=${(r.done.avgLogprob ?? 0).toFixed(3)} noSpeech=${(r.done.noSpeechRatio ?? 0).toFixed(3)}`,
    )
    const tail = r.segments.slice(-2).map((s) => `[${s.start.toFixed(1)}s] ${s.text.slice(0, 12)}`)
    console.log(`  末尾两段：${tail.join(' | ')}`)
  }

  if (!off || !on || !off.done || !on.done) {
    console.log('\n样本不完整，无法对比')
    process.exit(1)
  }

  // 1. 关掉 VAD 时应当只有一块
  if (off.done.chunks !== 1) fail(`vad=off 期望 chunks=1，实际 ${off.done.chunks}`)
  // 2. 开启后应当切出多块并跨过长静音
  if (!(on.done.chunks >= 3)) fail(`vad=on 期望 chunks>=3，实际 ${on.done.chunks}`)
  if (!(on.done.skipped >= 2)) fail(`vad=on 期望 skipped>=2，实际 ${on.done.skipped}`)
  // 3. 三段语音都要被识别出来（用户报告的「缺句漏句」正是这里会挂）
  const regions = [
    [0, 25],
    [25, 51],
    [51, 75],
  ]
  const covered = regions.map(([a, b]) => on.segments.some((s) => s.start >= a && s.start < b))
  if (!covered.every(Boolean)) fail(`vad=on 有语音区没有识别结果，覆盖情况 ${covered.join(',')}`)
  // 4. 时间轴必须递增（分块偏移没加错）
  for (let i = 1; i < on.segments.length; i++) {
    if (on.segments[i].start + 0.05 < on.segments[i - 1].start) {
      fail(`vad=on 时间轴回退：第 ${i} 段 ${on.segments[i].start} < 前一段 ${on.segments[i - 1].start}`)
      break
    }
  }
  // 5. 内容不该比整段识别明显变少
  const charsOff = off.segments.map((s) => s.text).join('').replace(/\s+/g, '').length
  const charsOn = on.segments.map((s) => s.text).join('').replace(/\s+/g, '').length
  if (charsOn < charsOff * 0.7) fail(`vad=on 字数 ${charsOn} 明显少于 vad=off 的 ${charsOff}`)

  // 6. 语言漂移检查：中文音频跑出成串拉丁字母，是 whisper 的典型幻觉输出。
  //    段数一多、窗口一长就容易出现（实测 GPU 上 vad=off 的 70 秒整段识别确实
  //    在后半段漂成了英文）。开启切分后不应再出现这种退化。
  const latinRun = (text) => (text.match(/[A-Za-z][A-Za-z ,.'-]{19,}/g) ?? []).length
  const driftOff = latinRun(off.segments.map((s) => s.text).join(' '))
  const driftOn = latinRun(on.segments.map((s) => s.text).join(' '))
  console.log(`\n  语言漂移（成串拉丁字母段）：vad=off ${driftOff} 处，vad=on ${driftOn} 处`)
  if (driftOn > 0) fail(`vad=on 仍出现 ${driftOn} 处英文漂移，切分未解决问题`)

  console.log(pass ? '\nVAD 切分测试 通过' : '\nVAD 切分测试 失败')
  process.exit(pass ? 0 : 1)
}

send({ id: 1, cmd: 'ping' })
