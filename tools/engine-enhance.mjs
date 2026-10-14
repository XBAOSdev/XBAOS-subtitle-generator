/**
 * 识别增强参数的引擎侧冒烟测试。
 *
 * 验证四件事（对应「准确率方案 1 / 4 / 5 / 6」的引擎改动）：
 *   1. highPass=false 与 true 都能正常出结果（高通滤波不破坏正常识别）
 *   2. vadOptions 传整组场景参数时引擎照常工作且切块行为受参数影响
 *   3. ranges 指定区间模式：只返回落在区间内的段，时间戳为全局时间
 *   4. ranges 越界 / 全部无效时优雅回退整段识别
 *
 * 用法：node tools/engine-enhance.mjs [引擎exe路径]
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
  process.exit(1)
}

const CASES = [
  { name: 'highPass 默认开', req: { vad: false } },
  { name: 'highPass 关', req: { vad: false, highPass: false } },
  {
    name: 'vadOptions 场景参数（长句合并）',
    req: {
      vad: true,
      // 样本的静音正好 5s，判定是严格大于，所以这里把长静音阈值压到 3s
      vadOptions: { minSilenceSec: 0.5, minSpeechSec: 0.25, longSilenceSec: 3.0, targetSec: 26.0 },
    },
  },
  { name: 'ranges 只识别中段', req: { vad: false, ranges: [{ start: 25, end: 46 }] } },
  { name: 'ranges 全部越界回退整段', req: { vad: false, ranges: [{ start: 500, end: 600 }] } },
]

const proc = spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buf = ''
let idx = 0
const results = []
let loaded = null

const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n')

let segSink = []
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
    if (msg.type === 'loaded') {
      loaded = msg
      sendNext()
    } else if (msg.type === 'segment') {
      segSink.push(msg)
    } else if (msg.type === 'done') {
      console.log(`  ..  [${msg.id}] 用例完成：${msg.count} 段 / ${msg.elapsed?.toFixed?.(1)}s`)
      // idx 在发送时就已自增，必须按请求 id 回查用例，不能用当前 idx
      results.push({ case: CASES[msg.id - 100], done: msg, segments: segSink })
      sendNext()
    } else if (msg.type === 'error') {
      results.push({ case: CASES[msg.id - 100], error: msg.message })
      sendNext()
    }
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', () => {})
proc.on('exit', () => report())

function sendNext() {
  if (idx >= CASES.length) {
    // 用例全部完成：主动结束引擎进程，exit 事件里出报告
    proc.kill()
    return
  }
  const seg = CASES[idx]
  segSink = []
  send({ id: 100 + idx, cmd: 'transcribe', audio: AUDIO, language: 'zh', ...seg.req })
  idx++
}

function report() {
  console.log(`引擎: ${path.basename(ENGINE)} | 模型复用: ${loaded?.reused ? '是' : '否'}`)
  let fail = 0
  const assert = (name, cond, detail = '') => {
    if (cond) console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`)
    else {
      fail++
      console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
    }
  }

  const byName = new Map(results.map((r) => [r.case.name, r]))
  const base = byName.get('highPass 默认开')
  const noHp = byName.get('highPass 关')

  assert('高通滤波开：正常出结果', base?.done?.count > 0, `count=${base?.done?.count}`)
  assert('高通滤波关：正常出结果', noHp?.done?.count > 0, `count=${noHp?.done?.count}`)
  assert(
    '两种模式识别文本都非空',
    (base?.segments ?? []).some((s) => s.text.trim()) &&
      (noHp?.segments ?? []).some((s) => s.text.trim()),
  )

  const scene = byName.get('vadOptions 场景参数（长句合并）')
  assert('vadOptions：识别成功', scene?.done?.count > 0, `count=${scene?.done?.count}`)
  assert(
    'vadOptions：长静音照常被跨过',
    (scene?.done?.skipped ?? 0) >= 2,
    `skipped=${scene?.done?.skipped}`,
  )

  const ranged = byName.get('ranges 只识别中段')
  const inRange = (r) => (r?.segments ?? []).every((s) => s.start >= 25 - 0.5 && s.end <= 46 + 0.5)
  assert('ranges：识别成功', ranged?.done?.count > 0, `count=${ranged?.done?.count}`)
  assert('ranges：段落都落在指定区间内', inRange(ranged), JSON.stringify(ranged?.segments?.map((s) => [s.start, s.end]) ?? []).slice(0, 120))
  assert(
    'ranges：speechSeconds 等于区间总长',
    Math.abs((ranged?.done?.speechSeconds ?? -1) - 21) < 0.01,
    String(ranged?.done?.speechSeconds),
  )

  const fallback = byName.get('ranges 全部越界回退整段')
  assert('ranges 越界：回退整段识别', (fallback?.done?.count ?? 0) > 0, `count=${fallback?.done?.count}`)

  console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail} 项`)
  proc.kill()
  process.exit(fail === 0 ? 0 : 1)
}

// ---- 启动 ----
send({ id: 1, cmd: 'ping' })
send({ id: 2, cmd: 'load', model: MODEL, backend: 'cpu' })

setTimeout(() => {
  console.error('引擎 420 秒内没有完成全部用例')
  proc.kill()
  process.exit(1)
}, 420000)

// 报告里 kill 之后的兜底：保证 stdout 缓冲冲干净再退
process.on('exit', () => proc.kill())
