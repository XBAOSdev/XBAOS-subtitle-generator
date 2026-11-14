/**
 * 引擎路径测试：模型与音频都在含中文的目录里。
 *
 * 起因是 GitHub issue #1 —— 模型放在 `E:\小包听幕\models\sensevoice-small`，
 * 界面上认得出、也显示「使用中」，一识别就报「模型目录里没有 model.onnx」。
 * 根因是引擎用窄字符 fopen 打开文件：协议里的路径是 UTF-8，Windows 的窄字符
 * API 按 ANSI 代码页（简体中文系统上是 GBK）解释，中文路径必然打不开。
 *
 * 这条脚本直接打引擎二进制，不经过界面，因此不需要起 Electron：
 *      node tools/engine-paths.mjs
 *
 * 前三条用例不需要任何模型文件（用占位文件验证「路径能不能分辨」），
 * 第四条只在 %APPDATA% 下真的装了 SenseVoice 时才跑（走中文目录联接 + 真实识别）。
 *
 * 用后即弃的开发脚本，不进打包产物。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const EXE = path.resolve('engine-onnx/build/bin/xbaos-engine-asr.exe')
const AUDIO = path.resolve('engine/test-data/zh-sample.wav')
const WORK = path.resolve('.workbuddy/tmp/engine-paths')
const CN = path.join(WORK, '中文 路径测试', 'models')
const CN_AUDIO = path.join(WORK, '中文 路径测试', '音频')
const REAL = path.join(process.env.APPDATA ?? '', 'xbaos-subtitle-generator', 'models', 'sensevoice-small')

if (!fs.existsSync(EXE)) {
  console.error(`缺少引擎：${EXE}\n先跑 npm run engine:onnx`)
  process.exit(1)
}

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 跑一轮引擎：把 lines 发进去，收集响应，stdin 关闭后进程自己退出 */
function run(lines, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const msgs = []
    let buf = ''
    let stderr = ''
    const timer = setTimeout(() => proc.kill(), timeoutMs)

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buf += chunk
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        try {
          msgs.push(JSON.parse(line))
        } catch {
          /* 引擎只往 stdout 写协议，解析不了就是坏行，忽略 */
        }
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => (stderr += chunk))

    proc.on('exit', () => {
      clearTimeout(timer)
      resolve({ msgs, stderr })
    })

    for (const line of lines) proc.stdin.write(JSON.stringify(line) + '\n')
    proc.stdin.end()
  })
}

/** 造一个「长得像模型」的目录：文件名对、内容为空（够引擎判断路径，不足以真正加载） */
function fakeModel(dir) {
  fs.mkdirSync(dir, { recursive: true })
  for (const name of ['model.int8.onnx', 'tokens.txt']) {
    if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), '')
  }
  return dir
}

const firstError = (res) => res.msgs.find((m) => m.type === 'error')?.message ?? ''

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true })

  /*
   * 用例一：中文目录 + 占位模型。
   *
   * 断言的是**错误的种类**：路径能分辨出来时，引擎会走到真正加载那一步，
   * 因为文件是空的而报「模型加载失败」；路径分辨不出来时报的是
   * 「模型目录里没有 model.int8.onnx 或 model.onnx」—— 两者绝不能混。
   */
  const cnModel = fakeModel(path.join(CN, 'sensevoice-small'))
  const cn = await run([
    { cmd: 'load', id: 1, model: cnModel, threads: 2 },
    { cmd: 'shutdown', id: 2 },
  ])
  const cnErr = firstError(cn)
  check(
    '中文目录里的模型文件能被找到',
    cnErr !== '' && !cnErr.includes('目录里没有'),
    cnErr || '（没有响应）',
  )
  check('中文目录的失败原因是文件本身', cnErr.includes('模型加载失败'), cnErr)

  // 用例二：ASCII 对照。同样的占位文件，错误必须与中文目录完全一致 ——
  // 两边一旦不同，说明路径仍在影响判定，只是被别的东西盖住了。
  const asciiModel = fakeModel(path.join(WORK, 'ascii', 'models', 'sensevoice-small'))
  const ascii = await run([
    { cmd: 'load', id: 1, model: asciiModel, threads: 2 },
    { cmd: 'shutdown', id: 2 },
  ])
  check('ASCII 目录给出同样的错误', firstError(ascii) === cnErr, firstError(ascii))

  // 用例三：目录真不存在时要说清楚是目录的问题
  const missing = await run([
    { cmd: 'load', id: 1, model: path.join(CN, '不存在的模型'), threads: 2 },
    { cmd: 'shutdown', id: 2 },
  ])
  const missErr = firstError(missing)
  check('目录不存在时给的是「目录不存在」', missErr.includes('模型目录不存在'), missErr)

  // 用例四（可选）：真的装过 SenseVoice 就跑一遍中文目录下的完整识别。
  // 用目录联接把真实模型挂到中文路径上，不复制那 228MB。
  if (!fs.existsSync(REAL)) {
    console.log(`  跳过  真实模型识别（没有 ${REAL}）`)
  } else if (!fs.existsSync(AUDIO)) {
    console.log(`  跳过  真实模型识别（没有 ${AUDIO}）`)
  } else {
    const link = path.join(CN, 'sensevoice-real')
    fs.mkdirSync(CN, { recursive: true })
    fs.symlinkSync(REAL, link, 'junction')
    fs.mkdirSync(CN_AUDIO, { recursive: true })
    const cnWav = path.join(CN_AUDIO, '我的 录音.wav')
    fs.copyFileSync(AUDIO, cnWav)

    const real = await run(
      [
        { cmd: 'load', id: 1, model: link, threads: 4 },
        { cmd: 'transcribe', id: 2, audio: cnWav, language: 'zh', threads: 4 },
        { cmd: 'shutdown', id: 3 },
      ],
      180_000,
    )
    const loaded = real.msgs.find((m) => m.type === 'loaded')
    const done = real.msgs.find((m) => m.type === 'done')
    const segs = real.msgs.filter((m) => m.type === 'segment')
    check('中文目录下加载真实模型', !!loaded, loaded ? `${loaded.model} / ${loaded.backend}` : '')
    check(
      '中文目录下的音频能识别出字幕',
      (done?.count ?? 0) > 0 && segs.length > 0,
      done ? `${segs.length} 段 / ${done.duration}s` : firstError(real),
    )

    // 联结局部的清理只删链接本身，绝不递归 —— 递归会顺着链接把真实模型删掉
    fs.unlinkSync(link)
  }

  /*
   * 用例五：说话人分离。它走的是另一组模型（随包的 resources/diarization），
   * 同样把路径交给 sherpa —— 换到中文目录下也得能跑。
   * 与识别不同的是这两份模型始终在场，不需要外部下载，所以没有「跳过」分支。
   */
  const diarSrc = path.resolve('resources/diarization')
  if (!fs.existsSync(diarSrc) || !fs.existsSync(AUDIO)) {
    console.log('  跳过  中文目录下的说话人分离（缺 resources/diarization 或样本音频）')
  } else {
    const diarLink = path.join(CN, '声纹模型')
    fs.mkdirSync(CN, { recursive: true })
    fs.symlinkSync(diarSrc, diarLink, 'junction')

    const diar = await run(
      [
        {
          cmd: 'diarize',
          id: 1,
          audio: AUDIO,
          segModel: path.join(diarLink, 'segmentation.onnx'),
          embedModel: path.join(diarLink, 'speaker-embedding.onnx'),
          numSpeakers: 0,
          threshold: 0.5,
          threads: 4,
        },
        { cmd: 'shutdown', id: 2 },
      ],
      180_000,
    )
    const spk = diar.msgs.filter((m) => m.type === 'speaker')
    const diarDone = diar.msgs.find((m) => m.type === 'done')
    check(
      '中文目录下能跑说话人分离',
      !!diarDone && spk.length > 0,
      diarDone ? `${spk.length} 段 / ${diarDone.speakers} 人` : firstError(diar),
    )
    fs.unlinkSync(diarLink)
  }

  // 收尾：联接都已断开，这里递归删的是测试自己造的空壳目录
  fs.rmSync(WORK, { recursive: true, force: true })

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
