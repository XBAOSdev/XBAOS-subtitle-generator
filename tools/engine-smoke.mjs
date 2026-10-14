/**
 * 引擎直连冒烟测试：验证前端 startRecognition 消费的协议字段真实存在。
 * 用后即弃的开发脚本，不进入打包产物。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'

const EXE = path.resolve('engine/build/vulkan/bin/xbaos-engine.exe')
const AUDIO = path.resolve('engine/test-data/zh-sample.wav')
const MODEL = path.resolve('models/ggml-small.bin')

if (!existsSync(EXE) || !existsSync(AUDIO) || !existsSync(MODEL)) {
  console.error('缺少引擎 / 样本 / 模型')
  process.exit(1)
}

const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buf = ''
const seen = { progress: 0, segments: 0, done: null }
const fieldsOk = { segmentFields: false, doneFields: false, progressFields: false }

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
      console.log('pong ok, backends =', JSON.stringify(msg.backends))
      send({ id: 2, cmd: 'load', model: MODEL, backend: 'auto' })
    } else if (msg.type === 'loaded') {
      console.log(`loaded: backend=${msg.backend} loadMs=${msg.loadMs}`)
      send({ id: 3, cmd: 'transcribe', audio: AUDIO, language: 'zh', threads: 4 })
    } else if (msg.type === 'progress') {
      seen.progress += 1
      if (typeof msg.percent === 'number') fieldsOk.progressFields = true
    } else if (msg.type === 'segment') {
      seen.segments += 1
      if (
        typeof msg.start === 'number' &&
        typeof msg.end === 'number' &&
        typeof msg.text === 'string' &&
        typeof msg.avgLogprob === 'number'
      ) {
        fieldsOk.segmentFields = true
      }
      if (seen.segments <= 3) {
        console.log(`seg[${msg.i}] ${msg.start.toFixed(2)}-${msg.end.toFixed(2)} ${msg.text}`)
      }
    } else if (msg.type === 'done') {
      seen.done = msg
      const need = ['count', 'elapsed', 'duration', 'language']
      fieldsOk.doneFields = need.every((k) => k in msg)
      console.log(
        `done: count=${msg.count} duration=${msg.duration}s elapsed=${msg.elapsed}s lang=${msg.language}`,
      )
      console.log('字段校验:', JSON.stringify(fieldsOk))
      send({ id: 4, cmd: 'shutdown' })
      setTimeout(() => proc.kill(), 1500)
    } else if (msg.type === 'error') {
      console.error('引擎错误:', msg.message)
      process.exit(1)
    }
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', () => {} /* 引擎日志，测试不关心 */)
proc.on('exit', (code) => {
  const pass =
    fieldsOk.progressFields && fieldsOk.segmentFields && fieldsOk.doneFields && seen.segments > 0
  console.log(
    `progress 消息 ${seen.progress} 条，segment ${seen.segments} 条。` +
      (pass ? '直连冒烟测试 通过' : '直连冒烟测试 失败'),
  )
  process.exit(pass ? 0 : 1)
})

function send(obj) {
  proc.stdin.write(JSON.stringify(obj) + '\n')
}

send({ id: 1, cmd: 'ping' })
