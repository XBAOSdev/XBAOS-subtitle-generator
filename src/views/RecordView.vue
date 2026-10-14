<script setup lang="ts">
/**
 * 录制音频窗口（`?window=record`）。
 *
 * 与「AI 校对」辅助窗口同构：独立窗口、自绘标题栏、关窗两段式、主界面压暗。
 *
 * 三条设计决定值得单独说明：
 *
 * 1. **不引入任何第三方依赖**。采集用 `getDisplayMedia`（系统声音，走主进程挂的
 *    `setDisplayMediaRequestHandler`，直接给桌面音频、不弹选择框）与 `getUserMedia`
 *    （麦克风）；混音用 Web Audio；落盘用 `utils/wav.ts` 里自写的 WAV 编码器。
 *
 * 2. **不落 opus/webm，直接留原始 PCM**。画波形、裁剪、拼接本来就要 PCM，
 *    绕一圈「录成 webm → decodeAudioData → 再编码」只是多一次有损转换。
 *    用 `ScriptProcessorNode` 收样本（已废弃但 Chromium 仍在，且不需要额外加载
 *    AudioWorklet 模块 —— 打包后 worklet 的 URL 解析是另一个坑）。
 *
 * 3. **编辑的真相是「保留段列表」而不是「播放列表」**。删掉中间一段之后，剩下的
 *    两段在源音频里是有洞的，这与「一串首尾相接的边界」表达不了。所以模型是
 *    `clips: {start, end}[]`（源时间坐标，可留空隙），拼接后的时长/波形/播放位置
 *    全部由它派生 —— 删段之后的「自动补位」于是不需要任何额外逻辑，它就是派生结果。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { useUiStore } from '@/stores/ui'
import { encodeWav, peakEnvelope } from '@/utils/wav'
import { toTimecode } from '@/utils/format'
import { isTypingTarget } from '@/utils/typing'
import { uid } from '@/utils/id'

/**
 * 这个窗口**不碰任何 store**。
 *
 * 它是独立窗口，与主窗口是两个渲染进程 —— 主窗口里的 Pinia 实例跟这里不是一份。
 * 保存好的文件走 `record.submit(path)` 交给主进程转发，由主窗口入队。
 */
const ui = useUiStore()

/* ------------------------------------------------------------------ 类型 */

interface Clip {
  id: string
  /** 源音频里的起点（秒） */
  start: number
  /** 源音频里的终点（秒） */
  end: number
}

interface Recording {
  /** 每个声道一份样本 */
  channels: Float32Array[]
  sampleRate: number
}

type Phase = 'idle' | 'recording' | 'editing'

/* ------------------------------------------------------------------ 设置记忆 */

const PREF_KEY = 'xbaos.record.v1'

/**
 * 记住勾选与设备。
 *
 * **设备记 label 不记 deviceId** —— deviceId 每个会话（甚至每次授权）都可能变，
 * 存下来下次一定匹配不上；label 是设备名，跨会话稳定（除非用户改了设备名）。
 */
interface Prefs {
  system: boolean
  mic: boolean
  micLabel: string
  channelMode: 'mono' | 'stereo'
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { system: true, mic: true, micLabel: '', channelMode: 'stereo' }
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      // 默认全勾：用户点「录制音频」多半是想录点什么，默认什么都不勾会让第一次打开像个坏界面
      system: parsed.system !== false,
      mic: parsed.mic !== false,
      micLabel: typeof parsed.micLabel === 'string' ? parsed.micLabel : '',
      channelMode: parsed.channelMode === 'mono' ? 'mono' : 'stereo',
    }
  } catch {
    return fallback
  }
}

const prefs0 = loadPrefs()
const wantSystem = ref(prefs0.system)
const wantMic = ref(prefs0.mic)
const micLabel = ref(prefs0.micLabel)
const channelMode = ref<'mono' | 'stereo'>(prefs0.channelMode)

function savePrefs(): void {
  try {
    localStorage.setItem(
      PREF_KEY,
      JSON.stringify({
        system: wantSystem.value,
        mic: wantMic.value,
        micLabel: micLabel.value,
        channelMode: channelMode.value,
      }),
    )
  } catch {
    /* 存不进去不影响本次使用 */
  }
}

/* ------------------------------------------------------------------ 设备 */

const micDevices = ref<{ deviceId: string; label: string }[]>([])
const micDeviceId = ref('')

async function refreshDevices(): Promise<void> {
  const md = navigator.mediaDevices
  if (!md?.enumerateDevices) return
  try {
    const all = await md.enumerateDevices()
    const inputs = all.filter((d) => d.kind === 'audioinput')
    // 未授权时 label 是空串，这时候只能给出序号 —— 直接写「麦克风 1/2」比写一列空行好
    micDevices.value = inputs.map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `麦克风 ${i + 1}`,
    }))

    const remembered = micDevices.value.find((d) => d.label === micLabel.value)
    const fallback = micDevices.value[0]
    const target = remembered ?? fallback
    micDeviceId.value = target?.deviceId ?? ''
    if (target && !remembered && micLabel.value) {
      micNote.value = `上次用的「${micLabel.value}」这次没找到，已改用「${target.label}」`
    }
  } catch (err) {
    deviceError.value = err instanceof Error ? err.message : String(err)
  }
}

const micNote = ref('')
const deviceError = ref('')

watch([micLabel, wantMic, wantSystem, channelMode], savePrefs)

function onMicPicked(): void {
  const hit = micDevices.value.find((d) => d.deviceId === micDeviceId.value)
  micLabel.value = hit?.label ?? ''
  micNote.value = ''
}

/* ------------------------------------------------------------------ 录制 */

const phase = ref<Phase>('idle')
const elapsed = ref(0)
const levels = ref({ system: 0, mic: 0 })
const errorText = ref('')

let captureCtx: AudioContext | null = null
let proc: ScriptProcessorNode | null = null
let sourceStreams: MediaStream[] = []
let chunksL: Float32Array[] = []
let chunksR: Float32Array[] = []
let meterNodes: { analyser: AnalyserNode; key: 'system' | 'mic' }[] = []
let rafId = 0
let startedAt = 0

const recording = shallowRef<Recording | null>(null)
const totalSec = computed(() => {
  const rec = recording.value
  return rec ? (rec.channels[0]?.length ?? 0) / rec.sampleRate : 0
})

const systemSupported = computed(() => typeof navigator.mediaDevices?.getDisplayMedia === 'function')

function stopTracks(): void {
  for (const s of sourceStreams) {
    for (const t of s.getTracks()) t.stop()
  }
  sourceStreams = []
}

async function startRecording(): Promise<void> {
  errorText.value = ''
  if (!wantSystem.value && !wantMic.value) {
    errorText.value = '至少要勾选一个输入源'
    return
  }
  const md = navigator.mediaDevices
  if (!md) {
    errorText.value = '当前环境不支持音频采集（需要以桌面应用方式运行）'
    return
  }

  try {
    const ctx = new AudioContext()
    // 必须 resume 到 running 再接线：挂起状态下接进去的节点拿不到时钟
    if (ctx.state !== 'running') await ctx.resume()
    captureCtx = ctx

    const merger = ctx.createGain()
    merger.gain.value = 1

    const attach = (stream: MediaStream, key: 'system' | 'mic') => {
      sourceStreams.push(stream)
      const src = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      gain.gain.value = 1
      src.connect(gain)
      gain.connect(merger)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      gain.connect(analyser)
      meterNodes.push({ analyser, key })
    }

    if (wantSystem.value) {
      // 主进程侧的 setDisplayMediaRequestHandler 已经把「共享哪个屏幕」定死成
      // 主屏 + loopback 音频，所以这里**不会**弹选择框。视频轨必须一起去请求，
      // 但拿到之后放着不管 —— 主动停掉视频轨在部分平台上会把音频轨一起带走。
      const sys = await md.getDisplayMedia({ video: true, audio: true })
      if (sys.getAudioTracks().length === 0) {
        throw new Error('没有取到系统声音（该平台可能不支持桌面音频回环）')
      }
      attach(sys, 'system')
    }

    if (wantMic.value) {
      const constraints: MediaStreamConstraints = {
        audio: micDeviceId.value ? { deviceId: { exact: micDeviceId.value } } : true,
      }
      attach(await md.getUserMedia(constraints), 'mic')
      // 授权之后 label 才有值，补一次列举
      void refreshDevices()
    }

    // 采集通道固定 2 进 2 出：单声道源会被 Web Audio 自动上混，
    // 要不要单声道是**保存时**的选择，不影响采集链路。
    proc = ctx.createScriptProcessor(4096, 2, 2)
    chunksL = []
    chunksR = []
    proc.onaudioprocess = (event) => {
      const input = event.inputBuffer
      const l = input.getChannelData(0)
      const r = input.numberOfChannels > 1 ? input.getChannelData(1) : l
      // 必须**拷贝**：这里的 Float32Array 是复用的缓冲区，直接 push 下去整段都会被最后一块覆盖
      chunksL.push(new Float32Array(l))
      chunksR.push(new Float32Array(r))
    }
    merger.connect(proc)
    // ScriptProcessorNode 只有连到 destination 才会被拉数据；经一个 0 增益节点转一道，
    // 这样既被拉起来又不会把麦克风外放出去（外放会啸叫）
    const sink = ctx.createGain()
    sink.gain.value = 0
    proc.connect(sink)
    sink.connect(ctx.destination)

    phase.value = 'recording'
    startedAt = performance.now()
    tick()
  } catch (err) {
    await teardown()
    errorText.value = describeError(err)
  }
}

function describeError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError') return '权限被拒绝。请在系统设置里允许本应用访问麦克风或屏幕录制'
  if (name === 'NotFoundError') return '找不到可用的音频设备'
  if (name === 'NotReadableError') return '设备被其他程序占用了'
  if (name === 'AbortError') return '采集被中断了'
  return err instanceof Error ? err.message : String(err)
}

function tick(): void {
  rafId = requestAnimationFrame(() => {
    elapsed.value = (performance.now() - startedAt) / 1000
    for (const { analyser, key } of meterNodes) {
      const buf = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      // 换算成 0–1 的视觉区间：RMS 本身很小，开方之后才像常见电平表
      const level = Math.min(1, Math.sqrt(rms * 3))
      levels.value[key] = levels.value[key] * 0.6 + level * 0.4
    }
    if (phase.value === 'recording') tick()
  })
}

async function teardown(): Promise<void> {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  try {
    proc?.disconnect()
    for (const { analyser } of meterNodes) analyser.disconnect()
  } catch {
    /* 已经断开了 */
  }
  proc = null
  meterNodes = []
  stopTracks()
  const ctx = captureCtx
  captureCtx = null
  if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {})
  levels.value = { system: 0, mic: 0 }
}

async function stopRecording(): Promise<void> {
  const rate = captureCtx?.sampleRate ?? 48000
  const l = concatChunks(chunksL)
  const r = concatChunks(chunksR)
  await teardown()

  if (l.length === 0) {
    phase.value = 'idle'
    errorText.value = '没有采到任何音频'
    return
  }

  recording.value = { channels: [l, r], sampleRate: rate }
  // 换了录音就得重算峰值 —— 它是按录音算一次的缓存，不清会画出上一条的波形
  sourcePeaks = null
  resetClips()
  phase.value = 'editing'
  requestDraw()
}

function concatChunks(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/* ------------------------------------------------------------------ 片段模型 */

const clips = ref<Clip[]>([])
const selection = ref<string[]>([])
const playhead = ref(0)
const playing = ref(false)

/** 不能比这更短：再短就是一条看不见的线，也拖不回来 */
const MIN_CLIP_SEC = 0.08

function resetClips(): void {
  const rec = recording.value
  clips.value = rec ? [{ id: uid('clip'), start: 0, end: totalSec.value }] : []
  selection.value = []
  playhead.value = 0
  history = []
  future = []
}

/** 拼接后的总时长（= 各保留段之和） */
const joinedSec = computed(() => clips.value.reduce((n, c) => n + (c.end - c.start), 0))

/** 每个片段在拼接时间轴上的位置 */
const spans = computed(() => {
  let at = 0
  return clips.value.map((c) => {
    const from = at
    const to = at + (c.end - c.start)
    at = to
    return { clip: c, from, to }
  })
})

/** 拼接时间 → 源时间 */
function sourceOf(joined: number): number {
  let at = 0
  for (const c of clips.value) {
    const dur = c.end - c.start
    if (joined <= at + dur || c === clips.value[clips.value.length - 1]) {
      return c.start + Math.max(0, Math.min(dur, joined - at))
    }
    at += dur
  }
  return 0
}

/** 源时间 → 拼接时间 */
function joinedOf(source: number): number {
  let at = 0
  for (const c of clips.value) {
    if (source < c.start) return at
    if (source <= c.end) return at + (source - c.start)
    at += c.end - c.start
  }
  return at
}

/* ------------------------------------------------------------------ 撤销重做 */

/**
 * 历史只存 `clips` 的快照。
 *
 * 录音本身（PCM）是不可变的 —— 所有编辑都是在「保留哪些区间」上做文章，
 * 所以快照一个轻量的区间数组就够了，不必深拷几 MB 的样本。
 */
interface ClipSnapshot {
  clips: Clip[]
  label: string
}

let history: ClipSnapshot[] = []
let future: ClipSnapshot[] = []

const canUndo = computed(() => history.length > 0)
const canRedo = computed(() => future.length > 0)

/**
 * 把 `state` 压进历史栈。
 *
 * 拖边界那种「连续改」的场景不能每帧都压 —— 撤销一次只退 3px，撤到天荒地老。
 * 所以那个场景在按下时把**改动前**的整份 `clips` 留一份，松手时若真的变了才
 * 用 `pushHistory(before, …)` 把它补进去。
 */
function pushHistory(state: Clip[], label: string): void {
  history.push({ clips: state.map((c) => ({ ...c })), label })
  if (history.length > 100) history.shift()
  future = []
}

/** 「现在这一刻」的状态压栈（动作发生前调用） */
function snapshot(label: string): void {
  pushHistory(clips.value, label)
}

function undo(): void {
  const prev = history.pop()
  if (!prev) return
  future.push({ clips: clips.value.map((c) => ({ ...c })), label: prev.label })
  clips.value = prev.clips
  prunedAfterEdit()
  ui.notify('info', '已撤销', prev.label)
}

function redo(): void {
  const next = future.pop()
  if (!next) return
  history.push({ clips: clips.value.map((c) => ({ ...c })), label: next.label })
  clips.value = next.clips
  prunedAfterEdit()
  ui.notify('info', '已重做', next.label)
}

/* ------------------------------------------------------------------ 编辑动作 */

function pruneSelection(): void {
  const alive = new Set(clips.value.map((c) => c.id))
  selection.value = selection.value.filter((id) => alive.has(id))
}

function prunedAfterEdit(): void {
  pruneSelection()
  if (playhead.value > joinedSec.value) playhead.value = joinedSec.value
  stopPlayback()
  bufferDirty = true
  requestDraw()
}

function selectClip(id: string, additive: boolean): void {
  if (!additive) {
    selection.value = [id]
    return
  }
  selection.value = selection.value.includes(id)
    ? selection.value.filter((x) => x !== id)
    : [...selection.value, id]
}

const selectedCount = computed(() => selection.value.length)

/** 在游标处把所在片段切成两半 */
function splitAtPlayhead(): void {
  if (phase.value !== 'editing' || clips.value.length === 0) return
  const source = sourceOf(playhead.value)
  const index = clips.value.findIndex((c) => source > c.start + 1e-6 && source < c.end - 1e-6)
  if (index < 0) {
    ui.notify('info', '游标不在任何片段内部', '把它拖到片段中间再切')
    return
  }
  const target = clips.value[index]
  snapshot('在游标处分割')
  const next = clips.value.slice()
  next.splice(
    index,
    1,
    { id: target.id, start: target.start, end: source },
    { id: uid('clip'), start: source, end: target.end },
  )
  clips.value = next
  pruneSelection()
  stopPlayback()
  bufferDirty = true
  requestDraw()
}

/** 删除选中的片段；剩下的自动补位（拼接时长是派生的，不需要额外逻辑） */
function deleteSelected(): void {
  if (selection.value.length === 0) return
  const kill = new Set(selection.value)
  if (kill.size >= clips.value.length) {
    ui.notify('warning', '不能删掉全部片段', '至少保留一段')
    return
  }
  snapshot(`删除 ${kill.size} 段`)
  clips.value = clips.value.filter((c) => !kill.has(c.id))
  selection.value = []
  stopPlayback()
  bufferDirty = true
  requestDraw()
}

/** 把剪辑恢复成「整段保留」 */
function resetAllClips(): void {
  if (clips.value.length === 1 && clips.value[0].start === 0 && clips.value[0].end === totalSec.value) {
    return
  }
  snapshot('还原全部剪辑')
  clips.value = [{ id: uid('clip'), start: 0, end: totalSec.value }]
  selection.value = []
  stopPlayback()
  bufferDirty = true
  requestDraw()
}

const isDirty = computed(() => {
  const only = clips.value
  return !(only.length === 1 && only[0].start === 0 && Math.abs(only[0].end - totalSec.value) < 1e-6)
})

/* ------------------------------------------------------------------ 拼接音频 */

/**
 * 按保留段拼出完整音频。
 *
 * 只在**播放 / 保存 / 画波形**时需要，所以做了脏标记 + 按需重建：
 * 拖边界时每一帧都重建几 MB 的 Float32Array 会明显卡手。
 */
let bufferDirty = true
// 两处都显式标 `<ArrayBuffer>`：变量默认会放宽成 `ArrayBufferLike`，而
// `copyToChannel` 只收 ArrayBuffer 版本 —— 其实下面 `new Float32Array(n)`
// 产出的本来就是普通缓冲，只是类型被声明放宽了
let joinedChannels: Float32Array<ArrayBuffer>[] = []
let joinedMono: Float32Array<ArrayBuffer> | null = null

function ensureJoined(): void {
  const rec = recording.value
  if (!rec) return
  if (!bufferDirty && joinedMono) return
  const rate = rec.sampleRate
  joinedChannels = rec.channels.map((ch) => {
    const pieces: Float32Array[] = []
    let total = 0
    for (const c of clips.value) {
      const from = Math.max(0, Math.round(c.start * rate))
      const to = Math.min(ch.length, Math.round(c.end * rate))
      if (to <= from) continue
      pieces.push(ch.subarray(from, to))
      total += to - from
    }
    const out = new Float32Array(total)
    let at = 0
    for (const p of pieces) {
      out.set(p, at)
      at += p.length
    }
    return out
  })

  const frames = joinedChannels[0]?.length ?? 0
  const mono = new Float32Array(frames)
  const n = joinedChannels.length
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < n; c += 1) sum += joinedChannels[c][i]
    mono[i] = sum / Math.max(1, n)
  }
  joinedMono = mono
  bufferDirty = false
}

/* ------------------------------------------------------------------ 波形绘制 */

const trackRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
let drawRaf = 0

function requestDraw(): void {
  if (drawRaf) return
  drawRaf = requestAnimationFrame(() => {
    drawRaf = 0
    draw()
  })
}

/**
 * 源音频的峰值包络。**只算一次**：它不随剪辑变化 —— 片段只是截取它的不同区间。
 * 取左右声道的较大者：只画左声道的话，只在右声道出现的声音在波形上会凭空消失。
 */
let sourcePeaks: Float32Array | null = null

function computeSourcePeaks(rec: Recording): Float32Array {
  const [a, b] = rec.channels
  if (!b) return peakEnvelope(a, 4000)
  const frames = Math.min(a.length, b.length)
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const x = a[i]
    const y = b[i]
    mono[i] = x < 0 === y < 0 ? (x + y) / 2 : Math.abs(x) > Math.abs(y) ? x : y
  }
  return peakEnvelope(mono, 4000)
}

function draw(): void {
  const canvas = canvasRef.value
  const track = trackRef.value
  const rec = recording.value
  if (!canvas || !track || !rec) return

  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(track.clientWidth))
  const height = Math.max(1, Math.round(track.clientHeight))
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  sourcePeaks ??= computeSourcePeaks(rec)

  const joined = Math.max(0.001, joinedSec.value)
  const mid = height / 2
  const wave = getComputedStyle(track).getPropertyValue('--wave-color').trim() || '#4A7BA6'
  ctx.fillStyle = wave
  ctx.globalAlpha = 0.5

  // 只画保留段：被删掉的部分不该在波形上留下痕迹，否则用户会以为它还留着
  for (const { clip } of spans.value) {
    const x0 = (joinedOf(clip.start) / joined) * width
    const x1 = (joinedOf(clip.end) / joined) * width
    const w = Math.max(1, Math.round(x1 - x0))
    const from = Math.max(0, Math.floor((clip.start / totalSec.value) * sourcePeaks.length))
    const to = Math.min(sourcePeaks.length, Math.ceil((clip.end / totalSec.value) * sourcePeaks.length))
    const count = Math.max(1, to - from)
    for (let i = 0; i < w; i += 1) {
      const at = from + Math.floor((i / w) * count)
      const peak = sourcePeaks[Math.min(sourcePeaks.length - 1, at)] ?? 0
      const h = Math.max(1, peak * (height * 0.42))
      ctx.fillRect(x0 + i, mid - h, 1, h * 2)
    }
  }
  ctx.globalAlpha = 1
}

let resizeObs: ResizeObserver | null = null

/* ------------------------------------------------------------------ 播放 */

let playCtx: AudioContext | null = null
let playNode: AudioBufferSourceNode | null = null
let playStartedWall = 0
let playStartedAt = 0

async function togglePlay(): Promise<void> {
  if (playing.value) {
    stopPlayback()
    return
  }
  ensureJoined()
  if (!joinedMono || joinedMono.length === 0) return
  const rec = recording.value
  if (!rec) return

  playCtx ??= new AudioContext()
  if (playCtx.state !== 'running') await playCtx.resume()

  const buffer = playCtx.createBuffer(1, joinedMono.length, rec.sampleRate)
  buffer.copyToChannel(joinedMono, 0)

  const from = playhead.value >= joinedSec.value - 0.01 ? 0 : playhead.value
  playNode = playCtx.createBufferSource()
  playNode.buffer = buffer
  playNode.connect(playCtx.destination)
  playStartedWall = performance.now()
  playStartedAt = from
  playNode.start(0, Math.max(0, from))
  playNode.onended = () => {
    if (playing.value) {
      playing.value = false
      playhead.value = joinedSec.value
    }
  }
  playing.value = true
  pumpPlayhead()
}

function pumpPlayhead(): void {
  if (!playing.value) return
  const t = playStartedAt + (performance.now() - playStartedWall) / 1000
  if (t >= joinedSec.value) {
    playing.value = false
    playhead.value = joinedSec.value
    return
  }
  playhead.value = t
  requestAnimationFrame(pumpPlayhead)
}

function stopPlayback(): void {
  playing.value = false
  if (playNode) {
    try {
      playNode.onended = null
      playNode.stop()
    } catch {
      /* 已经停了 */
    }
    playNode.disconnect()
    playNode = null
  }
}

/* ------------------------------------------------------------------ 轨道交互 */

function pointerSec(event: PointerEvent): number {
  const track = trackRef.value
  if (!track) return 0
  const rect = track.getBoundingClientRect()
  const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
  return Math.max(0, Math.min(joinedSec.value, ratio * joinedSec.value))
}

/**
 * 点轨道空白处：取消选中 + 把游标定过去。
 *
 * 「取消选中」必须有 —— 以前点空白只挪游标，选中的片段永远高亮着，
 * 用户没有办法表达「我不要选了」。片段自身的 pointerdown 会 stopPropagation，
 * 不会走到这里。
 */
function onTrackPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || phase.value !== 'editing') return
  selection.value = []
  stopPlayback()
  playhead.value = pointerSec(event)
}

/* ---- 游标拖拽（与主时间轴 startScrub 同一套交互语义） ---- */

const scrubbing = ref(false)
const scrubLabel = ref<string | null>(null)
let scrubPointer: number | null = null

function startScrub(event: PointerEvent): void {
  if (event.button !== 0 || joinedSec.value <= 0) return
  // 掐掉冒泡：track 的 pointerdown 会把游标定位 + 取消选中再来一遍，
  // 一次拖拽被解读成两件事。preventDefault 防止拖出选区。
  event.preventDefault()
  event.stopPropagation()
  scrubPointer = event.pointerId
  scrubbing.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  stopPlayback()
  playhead.value = pointerSec(event)
  scrubLabel.value = toTimecode(playhead.value, '.')
}

function onScrubMove(event: PointerEvent): void {
  if (scrubPointer !== event.pointerId) return
  playhead.value = pointerSec(event)
  scrubLabel.value = toTimecode(playhead.value, '.')
}

function endScrub(event: PointerEvent): void {
  if (scrubPointer !== event.pointerId) return
  scrubPointer = null
  scrubbing.value = false
  scrubLabel.value = null
}

function resetPlayhead(): void {
  stopPlayback()
  playhead.value = 0
  scrubLabel.value = null
}

interface EdgeDrag {
  clipId: string
  edge: 'start' | 'end'
  pointerId: number
  /** 鼠标位置 → 秒 的比例在按下那一刻冻结：拖的过程中总时长会变，用实时比例会漂 */
  secPerPx: number
  originX: number
  originValue: number
  lo: number
  hi: number
  /** 按下时的整份片段，松手时若确实变了才拿它压历史（见 pushHistory 的注释） */
  before: Clip[]
}

let edgeDrag: EdgeDrag | null = null

function startEdgeDrag(event: PointerEvent, clip: Clip, edge: 'start' | 'end'): void {
  if (event.button !== 0 || phase.value !== 'editing') return
  event.preventDefault()
  event.stopPropagation()
  const track = trackRef.value
  if (!track) return

  const index = clips.value.findIndex((c) => c.id === clip.id)
  const prev = index > 0 ? clips.value[index - 1] : null
  const next = index >= 0 && index + 1 < clips.value.length ? clips.value[index + 1] : null

  // 边界只能在本段的「可用空间」里挪：不能越过邻居，也不能把自己压没了。
  // 与时间轴同一条规则 —— 邻居的约束在**按下时算死**，拖动过程中不再重新计算。
  const lo = edge === 'start' ? (prev ? prev.end : 0) : clip.start + MIN_CLIP_SEC
  const hi = edge === 'start' ? clip.end - MIN_CLIP_SEC : next ? next.start : totalSec.value

  edgeDrag = {
    clipId: clip.id,
    edge,
    pointerId: event.pointerId,
    secPerPx: joinedSec.value / Math.max(1, track.clientWidth),
    originX: event.clientX,
    originValue: edge === 'start' ? clip.start : clip.end,
    lo,
    hi,
    before: clips.value.map((c) => ({ ...c })),
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onEdgeMove(event: PointerEvent): void {
  const drag = edgeDrag
  if (!drag || drag.pointerId !== event.pointerId) return
  const delta = (event.clientX - drag.originX) * drag.secPerPx
  const value = Math.max(drag.lo, Math.min(drag.hi, drag.originValue + delta))
  clips.value = clips.value.map((c) =>
    c.id === drag.clipId
      ? drag.edge === 'start'
        ? { ...c, start: value }
        : { ...c, end: value }
      : c,
  )
  bufferDirty = true
  requestDraw()
}

function onEdgeUp(event: PointerEvent): void {
  const drag = edgeDrag
  if (!drag || drag.pointerId !== event.pointerId) return
  edgeDrag = null

  // 只有真的挪动了才记一条历史 —— 点一下边界不该产生一次可撤销的操作
  const changed = clips.value.some((c, i) => {
    const was = drag.before[i]
    return !was || c.start !== was.start || c.end !== was.end
  })
  if (changed) pushHistory(drag.before, drag.edge === 'start' ? '调整片段起点' : '调整片段终点')

  stopPlayback()
  bufferDirty = true
  requestDraw()
}

/* ------------------------------------------------------------------ 保存 */

const saving = ref(false)

async function save(): Promise<void> {
  const rec = recording.value
  if (!rec || clips.value.length === 0 || saving.value) return
  ensureJoined()

  const api = window.xbaos?.record
  if (!api?.save) {
    ui.notify('info', '浏览器预览模式下无法保存', '请以桌面应用方式运行')
    return
  }

  saving.value = true
  try {
    stopPlayback()
    const channels = channelMode.value === 'mono' ? [joinedMono ?? joinedChannels[0]] : joinedChannels
    const bytes = encodeWav({
      channels: channels.filter(Boolean) as Float32Array[],
      sampleRate: rec.sampleRate,
    })
    const filePath = await api.save({ data: bytes })
    if (!filePath) return

    // 交给主进程转发给**主窗口**入队。在这里直接调 project.addFiles 是无效的 ——
    // 本窗口有自己的 Pinia 实例，加进去的是一份空工程，窗口一关就没了。
    api.submit(filePath)
    ui.notify('success', '录音已保存', filePath)
    forceClose()
  } catch (err) {
    ui.notify('error', '保存失败', err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

/* ------------------------------------------------------------------ 关窗 */

let offCloseRequest: (() => void) | undefined

/** 标题栏的最小化 / 最大化。与 AssistView 同一套桥；浏览器预览里走 window.close 兜底 */
function windowControl(action: 'minimize' | 'maximize' | 'close'): void {
  const api = window.xbaos?.window
  if (api) {
    api.control(action)
    return
  }
  if (action === 'close') window.close()
}

/**
 * 关窗裁决（标题栏 ×、底部「取消」、系统关窗都走这一条）。
 *
 * **只要还有没落盘的内容就要确认** —— 曾经只在「录制中」或「剪辑过」时确认，
 * 「录完了但没剪」这一态被漏掉，直接关窗把整段录音丢了，比剪辑丢失更冤。
 */
async function requestClose(): Promise<void> {
  const api = window.xbaos?.record
  if (!api) {
    window.close()
    return
  }
  // 先撤看门狗再决策：原生确认框可能开很久，不撤的话 4 秒后窗口会自己关掉
  api.ackCloseRequest()

  const nothingToLose = phase.value !== 'recording' && recording.value === null && !isDirty.value
  if (nothingToLose) {
    api.forceClose()
    return
  }

  const ok = await api.confirmDiscard({
    message:
      phase.value === 'recording'
        ? '正在录制，关闭会丢弃已录的内容'
        : isDirty.value
          ? '对录音的裁剪还没有保存'
          : '录音还没有保存',
    detail: '关闭后这些内容无法恢复。',
  })
  if (ok) api.forceClose()
}

function forceClose(): void {
  window.xbaos?.record?.forceClose()
}

/** 主进程转发的关窗请求（标题栏 × / 系统关窗） */
function handleCloseRequest(): void {
  void requestClose()
}

function cancelAll(): void {
  void requestClose()
}

/* ------------------------------------------------------------------ 快捷键 */

function onKeydown(event: KeyboardEvent): void {
  // 与主界面同一条规矩：焦点在能打字的地方就一律让位
  if (isTypingTarget(event.target)) return
  if (phase.value !== 'editing') return

  const mod = event.ctrlKey || event.metaKey
  if (mod && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    splitAtPlayhead()
    return
  }
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (mod && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    redo()
    return
  }
  if (mod && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    selection.value = clips.value.map((c) => c.id)
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    deleteSelected()
    return
  }
  if (event.key === ' ') {
    event.preventDefault()
    void togglePlay()
  }
}

/* ------------------------------------------------------------------ 生命周期 */

function onDeviceChange(): void {
  void refreshDevices()
}

onMounted(() => {
  void refreshDevices()
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
  window.addEventListener('keydown', onKeydown)
  offCloseRequest = window.xbaos?.record?.onCloseRequest(() => void handleCloseRequest())
  if (trackRef.value) {
    resizeObs = new ResizeObserver(() => requestDraw())
    resizeObs.observe(trackRef.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
  offCloseRequest?.()
  resizeObs?.disconnect()
  resizeObs = null
  if (drawRaf) cancelAnimationFrame(drawRaf)
  drawRaf = 0
  stopPlayback()
  void teardown()
  void playCtx?.close().catch(() => {})
  playCtx = null
})

watch(joinedSec, () => requestDraw())
</script>

<template>
  <div class="rec">
    <header class="rbar">
      <div class="rbar__brand">
        <span class="rbar__mark" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="14" height="14">
            <rect x="1.2" y="9" width="2.4" height="2.3" fill="#F2EADB" />
            <rect x="1.2" y="11.3" width="2.4" height="3.7" fill="#4A7BA6" />
            <rect x="5" y="6" width="2.4" height="3.4" fill="#C08A5F" />
            <rect x="5" y="9.4" width="2.4" height="5.6" fill="#4A7BA6" />
            <rect x="8.8" y="3.8" width="2.4" height="4.2" fill="#F2EADB" />
            <rect x="8.8" y="8" width="2.4" height="7" fill="#4A7BA6" />
            <rect x="12.6" y="7" width="2.4" height="3.1" fill="#C08A5F" />
            <rect x="12.6" y="10.1" width="2.4" height="4.9" fill="#4A7BA6" />
            <rect x="16.4" y="10" width="2.4" height="1.9" fill="#F2EADB" />
            <rect x="16.4" y="11.9" width="2.4" height="3.1" fill="#4A7BA6" />
            <rect x="1.2" y="17.2" width="9.9" height="1.6" fill="#4A7BA6" />
            <rect x="11.9" y="17.2" width="3.8" height="1.6" fill="#F2EADB" />
            <rect x="16.5" y="17.2" width="2.3" height="1.6" fill="#C08A5F" />
          </svg>
        </span>
        <span class="rbar__name">录制音频</span>
      </div>

      <div class="rbar__right">
        <button class="rbar__icon" type="button" title="最小化" @click="windowControl('minimize')">
          <Icon name="minus" :size="14" />
        </button>
        <button class="rbar__icon" type="button" title="最大化" @click="windowControl('maximize')">
          <Icon name="square" :size="12" />
        </button>
        <button class="rbar__icon rbar__icon--close" type="button" title="关闭" @click="forceClose()">
          <Icon name="x" :size="14" />
        </button>
      </div>
    </header>

    <div class="rec__body">
      <p v-if="errorText" class="rec__error">
        <Icon name="alert" :size="13" />
        <span>{{ errorText }}</span>
      </p>

      <!-- ---------- 录制前 ---------- -->
      <template v-if="phase !== 'editing'">
        <section class="card">
          <h2 class="card__title">输入源</h2>

          <!-- 两列网格：勾选 / 名称 / 设备选择 / 电平表。
               电平表固定在最后一列，两行才对得齐 —— 原来系统声那行的说明文字
               把表挤到中间，麦克风那行又多了个下拉，两行参差不齐。 -->
          <div class="src">
            <input id="rec-src-system" v-model="wantSystem" type="checkbox" :disabled="phase === 'recording' || !systemSupported" />
            <label class="src__name" for="rec-src-system">系统声音</label>
            <span class="src__mid">
              <span v-if="!systemSupported" class="src__warn">当前平台不支持</span>
            </span>
            <span class="src__meter" aria-hidden="true">
              <span class="src__meter-fill" :style="{ width: `${Math.round(levels.system * 100)}%` }" /></span>
          </div>

          <div class="src">
            <input id="rec-src-mic" v-model="wantMic" type="checkbox" :disabled="phase === 'recording'" />
            <label class="src__name" for="rec-src-mic">麦克风</label>
            <select
              v-model="micDeviceId"
              class="src__select"
              :disabled="!wantMic || phase === 'recording' || micDevices.length === 0"
              @change="onMicPicked"
            >
              <option v-if="micDevices.length === 0" value="">未检测到设备</option>
              <option v-for="d in micDevices" :key="d.deviceId" :value="d.deviceId">{{ d.label }}</option>
            </select>
            <span class="src__meter" aria-hidden="true">
              <span class="src__meter-fill" :style="{ width: `${Math.round(levels.mic * 100)}%` }" /></span>
          </div>

          <p v-if="micNote" class="rec__hint">{{ micNote }}</p>
          <p v-if="deviceError" class="rec__hint">{{ deviceError }}</p>

          <div v-seg-thumb class="chan">
            <span class="chan__label">输出声道</span>
            <button
              class="choice"
              :class="{ 'is-active': channelMode === 'mono' }"
              type="button"
              :disabled="phase === 'recording'"
              @click="channelMode = 'mono'"
            >
              单声道
            </button>
            <button
              class="choice"
              :class="{ 'is-active': channelMode === 'stereo' }"
              type="button"
              :disabled="phase === 'recording'"
              @click="channelMode = 'stereo'"
            >
              立体声
            </button>
          </div>
        </section>

        <section class="card card--rec">
          <div class="timer mono" :class="{ 'is-live': phase === 'recording' }">
            {{ toTimecode(elapsed, '.') }}
          </div>
          <button
            v-if="phase !== 'recording'"
            class="btn btn--primary btn--lg"
            type="button"
            @click="startRecording"
          >
            <Icon name="dot" :size="14" />
            <span>开始录制</span>
          </button>
          <button v-else class="btn btn--lg btn--danger" type="button" @click="stopRecording">
            <Icon name="stop" :size="14" />
            <span>停止录制</span>
          </button>
        </section>
      </template>

      <!-- ---------- 录制后编辑 ---------- -->
      <template v-else>
        <section class="card card--edit">
          <div class="edit__head">
            <h2 class="card__title">
              裁剪
              <span class="edit__count">
                {{ clips.length }} 段 ｜ 共 {{ toTimecode(joinedSec, '.') }}
                <template v-if="selectedCount > 0">｜ 选中 {{ selectedCount }} 段</template>
              </span>
            </h2>
            <div class="edit__tools">
              <button class="btn btn--sm" type="button" title="播放 / 暂停（空格）" @click="togglePlay">
                <Icon :name="playing ? 'pause' : 'play'" :size="13" />
                <span>{{ playing ? '暂停' : '播放' }}</span>
              </button>
              <button class="btn btn--sm" type="button" title="在游标处把这一条切成两条（Ctrl+B）" @click="splitAtPlayhead">
                <Icon name="scissors" :size="13" />
                <span>分割</span>
              </button>
              <button
                class="btn btn--sm"
                type="button"
                :disabled="selectedCount === 0"
                @click="deleteSelected"
              >
                <Icon name="trash" :size="13" />
                <span>删除选中</span>
              </button>
              <span class="edit__sep" aria-hidden="true" />
              <button class="btn btn--sm" type="button" :disabled="!canUndo" @click="undo">
                <Icon name="undo" :size="13" />
                <span>撤销</span>
              </button>
              <button class="btn btn--sm" type="button" :disabled="!canRedo" @click="redo">
                <Icon name="redo" :size="13" />
                <span>重做</span>
              </button>
              <button class="btn btn--sm" type="button" :disabled="!isDirty" @click="resetAllClips">
                <span>还原</span>
              </button>
            </div>
          </div>

          <div
            ref="trackRef"
            class="track"
            @pointerdown.self="onTrackPointerDown"
          >
            <canvas ref="canvasRef" class="track__wave" aria-hidden="true" />

            <TransitionGroup name="clip">
              <div
                v-for="{ clip, from, to } in spans"
                :key="clip.id"
                class="clip"
                :class="{ 'is-selected': selection.includes(clip.id) }"
                :style="{ left: `${(from / Math.max(0.001, joinedSec)) * 100}%`, width: `${((to - from) / Math.max(0.001, joinedSec)) * 100}%` }"
                @pointerdown.stop="selectClip(clip.id, $event.ctrlKey || $event.metaKey || $event.shiftKey)"
              >
                <span
                  class="clip__edge clip__edge--start"
                  title="拖动调整这一段的起点"
                  @pointerdown="startEdgeDrag($event, clip, 'start')"
                  @pointermove="onEdgeMove"
                  @pointerup="onEdgeUp"
                  @pointercancel="onEdgeUp"
                  @lostpointercapture="onEdgeUp"
                />
                <span class="clip__label mono">{{ toTimecode(clip.end - clip.start, '.') }}</span>
                <span
                  class="clip__edge clip__edge--end"
                  title="拖动调整这一段的终点"
                  @pointerdown="startEdgeDrag($event, clip, 'end')"
                  @pointermove="onEdgeMove"
                  @pointerup="onEdgeUp"
                  @pointercancel="onEdgeUp"
                  @lostpointercapture="onEdgeUp"
                />
              </div>
            </TransitionGroup>

            <!-- 游标：可拖拽定位（与主时间轴同一套交互）。
                 定位用 left 百分比而不是 translateX 百分比 —— transform 的百分比
                 是相对**元素自身**（这条线只有 1px 宽），写了等于没动，
                 游标会永远停在轨道最左端。 -->
            <div
              class="track__playhead"
              :class="{ 'is-scrubbing': scrubbing }"
              :style="{ left: `${(playhead / Math.max(0.001, joinedSec)) * 100}%` }"
            >
              <span
                class="track__playhead-hit"
                title="拖动调整播放位置（双击回到开头）"
                @pointerdown="startScrub"
                @pointermove="onScrubMove"
                @pointerup="endScrub"
                @pointercancel="endScrub"
                @lostpointercapture="endScrub"
                @dblclick="resetPlayhead"
              />
            </div>

            <div
              v-if="scrubLabel"
              class="track__bubble mono"
              :style="{ left: `${(playhead / Math.max(0.001, joinedSec)) * 100}%` }"
            >
              {{ scrubLabel }}
            </div>
          </div>

          <p class="rec__hint">
            点片段选中（Ctrl 多选），点空白处取消选中并把游标移过去；拖片段两边微调，
            拖游标定位，<span class="mono">Ctrl+B</span> 在游标处分割，<span class="mono">Delete</span>
            删掉选中的段 —— 后面的段会自动补位接上。
          </p>
        </section>
      </template>
    </div>

    <footer class="rec__foot">
      <button class="btn" type="button" @click="cancelAll">取消</button>
      <span class="spacer" />
      <button
        class="btn btn--primary"
        type="button"
        :disabled="phase !== 'editing' || saving || clips.length === 0"
        @click="save"
      >
        <Icon name="download" :size="14" />
        <span>{{ saving ? '正在保存' : '保存为 WAV' }}</span>
      </button>
    </footer>
  </div>
</template>

<style scoped>
.rec {
  height: 100vh;
  display: flex;
  flex-direction: column;
  /* 原写作 var(--color-bg)，那个令牌不存在 → 等于没铺底，全靠窗口底色兜着 */
  background: var(--color-bg-base);
  color: var(--color-text-primary);
}

/* ---- 自绘标题栏（无边框窗口靠这一条拖动） ---- */
.rbar {
  height: var(--titlebar-height);
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-left: var(--space-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  -webkit-app-region: drag;
}

.rbar__brand {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.rbar__mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--radius-sm);
  background: #2e3236;
}

.rbar__name {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
}

.rbar__right {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.rbar__icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: var(--titlebar-height);
  color: var(--color-text-secondary);
}

.rbar__icon:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.rbar__icon--close:hover {
  background: var(--color-danger);
  color: var(--color-text-inverse);
}

/* ---- 主体 ---- */
.rec__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
}

.rec__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-warning-border, var(--color-border));
  border-radius: var(--radius-md);
  background: var(--color-warning-subtle);
  font-size: var(--font-size-xs);
  line-height: var(--line-base);
  color: var(--color-text-secondary);
}

.card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
  padding: var(--space-4);
}

.card__title {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  font-size: var(--font-size-sm);
  font-weight: var(--weight-semibold);
}

.card--rec {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6);
}

.timer {
  font-size: 34px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}

.timer.is-live {
  color: var(--color-text-primary);
}

/* ---- 输入源：四列网格，两行的电平表对齐在同一列 ---- */
.src {
  display: grid;
  grid-template-columns: 15px 68px minmax(0, 1fr) 120px;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.src input[type='checkbox'] {
  width: 15px;
  height: 15px;
  flex: none;
  accent-color: var(--color-accent);
}

.src__name {
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.src__mid {
  min-width: 0;
}

.src__select {
  width: 100%;
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
}

.src__select:disabled {
  opacity: 0.5;
}

.src__warn {
  font-size: 11px;
  color: var(--color-warning);
}

.src__meter {
  display: block;
  width: 120px;
  height: 5px;
  border-radius: var(--radius-pill);
  background: var(--color-bg-inset);
  overflow: hidden;
  justify-self: end;
}

.src__meter-fill {
  display: block;
  height: 100%;
  background: var(--color-accent);
  transition: width 90ms linear;
}

.chan {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  margin-top: var(--space-3);
  padding-top: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
}

.chan__label {
  margin: 0 var(--space-2) 0 var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

/* 与主界面分段控件同一套滑动指示块（v-seg-thumb）：按钮只管文字 */
.chan .choice {
  position: relative;
  min-width: 84px;
  height: 28px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: calc(var(--radius-md) - 2px);
  background: none;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  transition: color var(--dur-fast) var(--ease-out);
}

.chan .choice:hover:not(:disabled) {
  color: var(--color-text-primary);
}

.chan .choice.is-active {
  color: var(--color-text-primary);
  font-weight: var(--weight-semibold);
}

.chan .choice:disabled {
  opacity: 0.5;
}

.rec__hint {
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-tertiary);
}

.card--rec .rec__hint {
  text-align: center;
}

/* ---- 编辑区 ---- */
.card--edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.edit__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.edit__head .card__title {
  margin-bottom: 0;
}

.edit__count {
  font-size: 11px;
  font-weight: var(--weight-regular, 400);
  color: var(--color-text-tertiary);
}

.edit__tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.edit__sep {
  width: 1px;
  height: 16px;
  background: var(--color-border);
}

.track {
  position: relative;
  height: 132px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  /* 波形画在这条色带上，片段框叠在它上面 */
  --wave-color: #4a7ba6;
  background: var(--color-bg-inset);
  overflow: hidden;
  cursor: default;
  user-select: none;
  touch-action: none;
}

.track__wave {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/*
 * 片段框。
 *
 * `left` / `width` 走过渡，是为了让「删掉中间一段之后后面的自动补位」看起来
 * 是**滑过去**的而不是瞬移 —— 用户删了一段之后最需要确认的就是「接上了没有」，
 * 瞬移等于没有交代。
 */
.clip {
  position: absolute;
  top: 0;
  bottom: 0;
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-bg-raised) 55%, transparent);
  transition: left var(--dur-base) var(--ease-out), width var(--dur-base) var(--ease-out),
    background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}

.clip.is-selected {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
}

.clip__label {
  position: absolute;
  left: 6px;
  bottom: 4px;
  font-size: 10px;
  color: var(--color-text-tertiary);
  pointer-events: none;
}

.clip__edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 9px;
  cursor: ew-resize;
}

.clip__edge--start {
  left: -4px;
}

.clip__edge--end {
  right: -4px;
}

.clip__edge:hover {
  background: color-mix(in srgb, var(--color-accent) 30%, transparent);
}

/* 进出场：删除时淡出，撤销回来时淡入 */
.clip-enter-from,
.clip-leave-to {
  opacity: 0;
}

.clip-leave-active {
  position: absolute;
  transition: opacity var(--dur-fast) var(--ease-out);
}

/* 游标：可拖拽（拖动中关掉过渡，否则线跟不上手）。
 * 用 left 定位（百分比相对轨道宽），不用 translateX —— transform 的百分比
 * 是相对自身宽度的，对一条 1px 的线毫无意义 */
.track__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-accent);
  pointer-events: none;
  transition: left var(--dur-fast) linear;
}

.track__playhead.is-scrubbing {
  transition: none;
}

/* 热区比线宽得多，否则 1px 的线根本点不中。它是唯一 pointer-events:auto 的
 * 游标部件：track 的「点空白定位 + 取消选中」不该被一次拖游标触发两遍 */
.track__playhead-hit {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -5px;
  width: 11px;
  pointer-events: auto;
  cursor: ew-resize;
}

.track__playhead::before {
  content: '';
  position: absolute;
  top: 0;
  left: -3.5px;
  width: 8px;
  height: 8px;
  border-radius: 0 0 4px 4px;
  background: var(--color-accent);
  pointer-events: none;
}

/* 拖游标时的时间码气泡（与主时间轴的 .timeline__bubble 同一语义） */
.track__bubble {
  position: absolute;
  top: 4px;
  transform: translateX(-50%);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--color-accent-border);
  font-size: 10px;
  color: var(--color-text-primary);
  pointer-events: none;
  white-space: nowrap;
}

/* ---- 底栏 ---- */
.rec__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-surface);
}
</style>
