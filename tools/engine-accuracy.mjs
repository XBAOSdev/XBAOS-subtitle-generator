/**
 * 多遍识别（推理深度）的引擎侧验证。
 *
 * 要验证三件事：
 *   1. 温度 0 是确定性的 —— 连跑两次结果必须逐字一致。
 *      这正是「多遍识别必须变速」这条设计的依据：不变速就没有互补候选。
 *   2. 微升温度确实产生不同的候选，且每一遍都是可用结果（不是空/乱码）。
 *   3. 束搜索（beamSize>1）可用，结果同样是有效文本。
 *
 * 输出各遍的字数、置信度、两两相似度，整合后的挑选逻辑在单元测试里验证
 * （见 tools/unit-check.ts）。
 *
 * 用法：node tools/engine-accuracy.mjs [引擎exe路径]
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
const AUDIO = path.join(root, 'engine/test-data/zh-sample.wav')

if (!ENGINE || !existsSync(ENGINE)) {
  console.error('找不到引擎 exe')
  process.exit(1)
}

const CASES = [
  { name: 'T=0.00 #1', temperature: 0 },
  { name: 'T=0.00 #2', temperature: 0 },
  { name: 'T=0.20', temperature: 0.2 },
  { name: 'T=0.40', temperature: 0.4 },
  { name: 'T=0.60', temperature: 0.6 },
  { name: 'T=0.80', temperature: 0.8 },
  { name: 'beam=5', temperature: 0, beamSize: 5 },
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
        cur.text += msg.text.trim()
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
    cur = { ...c, text: '', done: null, error: null }
    idx += 1
    send({
      id: 100 + idx,
      cmd: 'transcribe',
      audio: AUDIO,
      language: 'zh',
      threads: 4,
      temperature: c.temperature,
      beamSize: c.beamSize ?? 1,
      vad: true,
      normalize: true,
    })
  }
}

/** 字符二元组 Dice 相似度（与渲染层 transcriptMerge 口径一致） */
function dice(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0
  const grams = (s) => {
    const arr = [...s]
    const m = new Map()
    if (arr.length === 1) {
      m.set(arr[0], 1)
      return m
    }
    for (let i = 0; i + 2 <= arr.length; i++) {
      const g = arr[i] + arr[i + 1]
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(a)
  const gb = grams(b)
  let overlap = 0
  let ta = 0
  let tb = 0
  for (const n of ga.values()) ta += n
  for (const [g, n] of gb) {
    tb += n
    const hit = ga.get(g)
    if (hit) overlap += Math.min(hit, n)
  }
  return ta && tb ? (2 * overlap) / (ta + tb) : 0
}

function finish() {
  proc.kill()
  let pass = true
  const fail = (msg) => {
    console.log(`  FAIL  ${msg}`)
    pass = false
  }

  console.log('\n各遍结果：')
  for (const r of results) {
    if (r.error || !r.done) {
      fail(`${r.name} 未返回结果：${r.error ?? '未知错误'}`)
      continue
    }
    console.log(
      `  ${r.name.padEnd(10)} 段数=${String(r.done.count).padStart(3)} ` +
        `字数=${String(r.text.length).padStart(4)} ` +
        `avgLogprob=${(r.done.avgLogprob ?? 0).toFixed(3)} ` +
        `noSpeech=${(r.done.noSpeechRatio ?? 0).toFixed(3)} ` +
        `耗时=${(r.done.elapsed ?? 0).toFixed(1)}s ` +
        `chunks=${r.done.chunks}`,
    )
  }

  const valid = results.filter((r) => r.done && !r.error && r.text.length > 0)
  if (valid.length !== results.length) fail(`有 ${results.length - valid.length} 遍没有产出文本`)

  // 1. 温度 0 的可复现性。
  //    CPU（fp32）上必须逐字一致；GPU（Vulkan/fp16）上实测会出现一两个字的抖动
  //    —— 核函数浮点累加顺序不稳定，会偶尔改变温度回退的判定。
  //    这不影响整合逻辑（多遍候选本来就允许不同），但足以说明：
  //    指望「同温多跑几遍取一致」在 GPU 上是靠不住的，必须靠温度阶梯 + 共识挑选。
  const isGpuBuild = /[\\/]vulkan[\\/]/.test(ENGINE)
  const t0a = results.find((r) => r.name === 'T=0.00 #1')
  const t0b = results.find((r) => r.name === 'T=0.00 #2')
  if (t0a && t0b) {
    if (t0a.text === t0b.text) {
      console.log('\n  ✓ 温度 0 两次结果逐字一致（CPU 上确定性成立）')
    } else if (isGpuBuild) {
      console.log('\n  ! 温度 0 两次结果不同 —— GPU fp16 下的浮点抖动，属已知现象')
      console.log('    结论：同温重复没有意义，多遍识别必须走温度阶梯（本脚本已验证温度生效）')
    } else {
      fail('CPU 上温度 0 的两次结果不一致 —— 确定性被破坏，需排查')
    }
  }

  // 2. 各温度之间应当有差异（没有差异说明温度没生效）
  const tempRuns = results.filter((r) => /^T=0\.\d0$/.test(r.name) && r.name !== 'T=0.00 #1')
  const differed = tempRuns.filter((r) => t0a && r.text !== t0a.text).length
  console.log(`  温度 0.2~0.8 共 ${tempRuns.length} 遍，其中 ${differed} 遍与温度 0 的结果不同`)
  if (differed === 0) fail('升高温度后结果完全没变化，说明 temperature 参数没有生效')
  if (t0a) {
    const sims = tempRuns.map((r) => `${r.name}:${dice(t0a.text, r.text).toFixed(3)}`)
    console.log(`  与温度 0 的相似度：${sims.join('  ')}`)
  }

  // 3. 束搜索可用
  const beam = results.find((r) => r.name === 'beam=5')
  if (!beam?.done || beam.text.length === 0) fail('束搜索（beamSize=5）没有产出文本')
  else console.log(`\n  ✓ 束搜索可用：字数=${beam.text.length}`)

  console.log(pass ? '\n多遍识别引擎侧验证 通过' : '\n多遍识别引擎侧验证 失败')
  process.exit(pass ? 0 : 1)
}

send({ id: 1, cmd: 'ping' })
