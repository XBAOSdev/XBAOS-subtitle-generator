/**
 * 双跑一致性测试：验证「同一进程内连续两次识别」的修复效果。
 *
 * 背景：引擎是常驻进程，whisper_context 跨请求复用。no_context=false 时
 * whisper 把上一轮的转录文本当作下一轮解码的初始提示，第二次识别被第一次
 * 的结果带偏（英文残句、幻觉词）。修复后（no_context=true）两次的输出
 * 应当基本一致 —— 它们本就是同一段音频的独立转写。
 *
 * 用法：node tools/engine-double.mjs [exe 路径]
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'

const EXE = path.resolve(process.argv[2] ?? 'engine/build/cpu/bin/xbaos-engine.exe')
const AUDIO = path.resolve('engine/test-data/zh-sample.wav')
const MODEL = path.resolve('models/ggml-small.bin')

if (!existsSync(EXE) || !existsSync(AUDIO) || !existsSync(MODEL)) {
  console.error('缺少引擎 / 样本 / 模型:', EXE)
  process.exit(1)
}

const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buf = ''
/** @type {string[][]} */
const runs = [[]]
let step = 0 // 0=ping 1=load 2=第一次 3=第二次

proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buf += chunk
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === 'pong') {
      step = 1
      send({ id: 2, cmd: 'load', model: MODEL, backend: 'cpu' })
    } else if (msg.type === 'loaded') {
      step = 2
      console.log(`loaded backend=${msg.backend} loadMs=${msg.loadMs}`)
      send({ id: 3, cmd: 'transcribe', audio: AUDIO, language: 'zh', threads: 4 })
    } else if (msg.type === 'segment') {
      runs[runs.length - 1].push(msg.text)
    } else if (msg.type === 'done') {
      console.log(
        `第 ${runs.length} 次识别完成: count=${msg.count} elapsed=${msg.elapsed}s`,
      )
      if (runs.length === 1) {
        step = 3
        runs.push([])
        send({ id: 4, cmd: 'transcribe', audio: AUDIO, language: 'zh', threads: 4 })
      } else {
        report()
        send({ id: 5, cmd: 'shutdown' })
        setTimeout(() => proc.kill(), 1500)
      }
    } else if (msg.type === 'error') {
      console.error('引擎错误:', msg.message)
      process.exit(1)
    }
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', () => {})
proc.on('exit', () => process.exit(0))

function report() {
  const [a, b] = runs.map((r) => r.join('').replace(/\s+/g, ' ').trim())
  console.log('--- 第 1 次输出 ---')
  console.log(a)
  console.log('--- 第 2 次输出 ---')
  console.log(b)
  // 归一化后比对。允许标点 / 空格差异，字面必须一致才算「无污染」
  const norm = (s) => s.replace(/[\s，。,.、！!？?；;：:"'""'']/g, '')
  const same = norm(a) === norm(b)
  console.log(same ? '结论：两次输出一致，无上下文污染' : '结论：两次输出不一致，仍有污染或随机性')
  process.exitCode = same ? 0 : 1
}

function send(obj) {
  proc.stdin.write(JSON.stringify(obj) + '\n')
}

send({ id: 1, cmd: 'ping' })
