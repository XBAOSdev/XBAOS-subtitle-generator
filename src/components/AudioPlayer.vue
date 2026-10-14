<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useUiStore } from '@/stores/ui'
import { toTimecode } from '@/utils/format'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const editor = useEditorStore()
const ui = useUiStore()

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const viewFile = computed(() => project.viewFile)

/** 合并视图：没有单一音频流，<audio> 的 src 按当前所在段切换 */
const isMerged = computed(() => project.isMerge && !!project.mergedFile)

const hasAudio = computed(() => (viewFile.value?.durationSec ?? 0) > 0)

/** 播放器当前该盯着的字幕条目（有选中就认选中的，否则认游标压着的那条） */
const currentSegment = computed(() => {
  const segments = viewFile.value?.segments ?? []
  const selected = editor.selectedIds[0]
  if (selected) {
    const found = segments.find((s) => s.id === selected)
    if (found) return found
  }
  return segments.find((s) => editor.playheadSec >= s.start && editor.playheadSec <= s.end) ?? null
})

/* ------------------------------------------------------------------ 段映射 */

/** 合并模式下播放头所在的段序号 */
function partIndexOfTime(t: number): number {
  if (!isMerged.value) return -1
  const parts = project.mergedParts
  if (parts.length === 0) return -1
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (t >= parts[i].offsetSec) return i
  }
  return 0
}

const partIndex = computed(() => partIndexOfTime(editor.playheadSec))

/**
 * 这一段有没有可播的音频。
 *
 * 队列里可能混着**导入的字幕文件**（比如和音频同名的 `.srt`）：它也算一段、
 * 也占时间轴，但根本没有音频轨。以前这种段会让地址变成 null，而 `<audio>`
 * 是 `v-if` 渲染的 —— 元素当场被卸载，正在播的声音直接消失。
 */
function partAudioUrl(index: number): string | null {
  const part = project.mergedParts[index]
  if (!part) return null
  return project.media.get(part.fileId)?.blobUrl ?? null
}

/** 独立模式下的音频地址 */
const singleUrl = computed(() => {
  const id = project.viewFileId
  return id ? (project.media.get(id)?.blobUrl ?? null) : null
})

/** 当前该播哪个地址。只用于判断，真正的赋值走 loadAt / setSrc */
const audioUrl = computed(() => (isMerged.value ? partAudioUrl(partIndex.value) : singleUrl.value))

/** 当前这一段没有音频（例如导入的字幕文件） */
const spanHasNoAudio = ref(false)

/* ------------------------------------------------------------- 播放实现 */
/*
 * 这一版是重写的，上一版的坑都写在下面这几条里：
 *
 *   1. `<audio>` **常驻**，不再 `v-if="audioUrl"`。地址一变就卸载元素，会把
 *      正在播的音频连根拔掉 —— 表现就是「偶尔点了播放没声音」，且极难复现。
 *   2. 所有 `play()` 只走 `tryPlay()`：吞掉 `AbortError`（切 src / pause 打断
 *      play 的正常竞态）。以前它会被当成硬错误，直接把播放态掐掉。
 *   3. 段切换统一走 `loadAt()`，不再依赖「computed 变化 → 渲染 → loadedmetadata」
 *      这条隐式链；把游标挪到还没解码的段也由它兜住（以前那里是个死胡同）。
 *   4. 段与段之间加 8ms 淡入淡出。走 Web Audio 的 GainNode（元素自身的 volume
 *      只能整档赋值，做不到 8ms 的斜线）；接不进音频图时**自动退回直出**，
 *      绝不会因为做淡化反而没声音。
 */

const audioEl = ref<HTMLAudioElement | null>(null)

/** 期望播放态。不用 `editor.isPlaying` 直接判，是因为异步加载期间它会变 */
let wantPlay = false
/** 元素里当前装的是哪一段（合并模式） */
let loadedPart = 0
/** 元素里当前装着哪个地址 */
let loadedSrc: string | null = null
/** 下一次 loadedmetadata 要定位到的段内秒数 */
let pendingLocal: number | null = null
/** 正在切换段：期间忽略游标同步，避免两边抢方向盘 */
let switching = false
/** 这次游标变化是我们自己写进 audio 的，别再反向写一次 */
let seekGuard = false

/* ---- Web Audio：只为段边界的 8ms 淡化 ---- */

/** 段边界淡入淡出的时长 */
const FADE_SEC = 0.008

let audioCtx: AudioContext | null = null
let gainNode: GainNode | null = null
let graphTried = false
let fadeOutTimer: number | null = null

/**
 * 把元素接进 Web Audio 图。
 *
 * 只在**确认上下文跑得起来**之后才接：`createMediaElementSource` 一旦调用，
 * 元素的声音就只从音频图输出，此时上下文若还是 suspended，结果是**全程静音**
 * —— 那正是我们要修的那个 bug。所以先 resume 到 running，拿不到就干脆不接。
 */
async function ensureGraph(el: HTMLAudioElement): Promise<void> {
  if (graphTried) return
  graphTried = true
  try {
    const Ctx = window.AudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    if (ctx.state !== 'running') await ctx.resume()
    if (ctx.state !== 'running') {
      void ctx.close()
      return
    }
    const src = ctx.createMediaElementSource(el)
    const gain = ctx.createGain()
    gain.gain.value = 1
    src.connect(gain)
    gain.connect(ctx.destination)
    audioCtx = ctx
    gainNode = gain
  } catch {
    // 接不进音频图就当无事发生：直出播放，只是少了 8ms 淡化
    audioCtx = null
    gainNode = null
  }
}

function cancelFadeOut(): void {
  if (fadeOutTimer !== null) {
    window.clearTimeout(fadeOutTimer)
    fadeOutTimer = null
  }
}

/** 把增益斜线拉到目标值。没有音频图时是空操作 */
function rampGain(target: number, sec: number): void {
  if (!audioCtx || !gainNode) return
  const t = audioCtx.currentTime
  const g = gainNode.gain
  g.cancelScheduledValues(t)
  g.setValueAtTime(g.value, t)
  g.linearRampToValueAtTime(target, t + sec)
}

/**
 * 在**本段结束前 8ms** 把增益拉到 0，消掉拼接处的爆音。
 *
 * 用定时器按已知时长提前排程，而不是靠 timeupdate 事后判断：timeupdate 大约
 * 每 250ms 才来一次，等它发现「快到结尾了」，这段音频早就播完了。
 */
function scheduleFadeOut(): void {
  cancelFadeOut()
  if (!gainNode || !isMerged.value) return
  const el = audioEl.value
  if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
  const remaining = el.duration - el.currentTime
  if (remaining <= FADE_SEC) return
  const rate = editor.playbackRate || 1
  fadeOutTimer = window.setTimeout(
    () => rampGain(0, FADE_SEC),
    Math.max(0, (remaining - FADE_SEC) * 1000) / rate,
  )
}

/* ---- 载入与定位 ---- */

/** AbortError 是我们自己切 src 打断的正常竞态，不算错误 */
function isAbort(err: unknown): boolean {
  return (err as DOMException | null)?.name === 'AbortError'
}

/** 真正的播放入口。所有 play() 都从这里走 */
async function tryPlay(): Promise<void> {
  const el = audioEl.value
  if (!el || !el.src || !wantPlay) return
  await ensureGraph(el)
  try {
    await el.play()
    rampGain(1, FADE_SEC)
    buffering.value = false
    scheduleFadeOut()
  } catch (err) {
    if (isAbort(err)) return
    reportPlayError(err)
  }
}

function seekTo(local: number): void {
  const el = audioEl.value
  if (!el) return
  seekGuard = true
  try {
    el.currentTime = Math.max(0, local)
  } catch {
    /* 元数据还没到，忽略；loadedmetadata 会再定位一次 */
  }
  seekGuard = false
}

/**
 * 把地址装进元素并定位。地址没变就只定位、不重新加载 ——
 * 重新加载会打断正在进行的 `play()`，那正是 AbortError 的主要来源。
 */
function setSrc(url: string, localSec: number): void {
  const el = audioEl.value
  if (!el) return
  pendingLocal = localSec
  if (loadedSrc === url) {
    pendingLocal = null
    seekTo(localSec)
    if (wantPlay) void tryPlay()
    scheduleFadeOut()
    return
  }
  loadedSrc = url
  el.src = url
}

/**
 * 把「某个全局时间」装进播放器。
 *
 * 合并模式下按段的时长累加换算；遇到没有音频的段，播放中就往后跳到下一个
 * 有音频的段（别让播放停在导入的字幕文件上），暂停中只给一行提示。
 */
async function loadAt(globalSec: number): Promise<void> {
  const el = audioEl.value
  if (!el || switching) return
  switching = true
  try {
    // 演示数据根本没有真实音频（也没有 blobUrl）：播放交给下面的定时器。
    // 这里必须提前放行 —— 否则会被当成「这一段没有音频轨」而立刻停掉播放，
    // 浏览器预览与 UI 探针里的试听会全部失效。
    if (viewFile.value?.demo) {
      spanHasNoAudio.value = false
      return
    }
    if (isMerged.value) {
      const parts = project.mergedParts
      let idx = partIndexOfTime(globalSec)
      if (idx < 0 || idx >= parts.length) return

      await project.ensureMedia(parts[idx].fileId)
      let url = partAudioUrl(idx)
      while (!url && idx + 1 < parts.length) {
        idx += 1
        await project.ensureMedia(parts[idx].fileId)
        url = partAudioUrl(idx)
      }
      if (!url) {
        spanHasNoAudio.value = true
        if (wantPlay) stopPlayback()
        return
      }
      spanHasNoAudio.value = false
      loadedPart = idx
      const local = Math.max(0, globalSec - parts[idx].offsetSec)
      setSrc(url, idx === partIndexOfTime(globalSec) ? local : 0)
      return
    }

    const id = project.viewFileId
    if (!id) return
    await project.ensureMedia(id)
    const url = singleUrl.value
    if (!url) {
      spanHasNoAudio.value = true
      if (wantPlay) stopPlayback()
      return
    }
    spanHasNoAudio.value = false
    setSrc(url, globalSec)
  } finally {
    switching = false
  }
}

/** 往后找第一个真的有音频的段；找不到返回 -1 */
async function nextPlayablePart(from: number): Promise<number> {
  const parts = project.mergedParts
  for (let i = from; i < parts.length; i += 1) {
    await project.ensureMedia(parts[i].fileId)
    if (partAudioUrl(i)) return i
  }
  return -1
}

function stopPlayback(): void {
  wantPlay = false
  editor.isPlaying = false
}

/* ---- 元素事件 ---- */

function applyPlaybackRate(): void {
  if (audioEl.value) audioEl.value.playbackRate = editor.playbackRate
}

function onTimeUpdate(): void {
  const el = audioEl.value
  // 用户正在拖播放头：这一段时间码由拖拽决定，timeupdate 别来抢
  // （scrubbing 是 store 里的共享标志，见 editor store）
  if (!el || seekGuard || editor.scrubbing) return
  if (isMerged.value) {
    const part = project.mergedParts[loadedPart]
    editor.setPlayhead((part?.offsetSec ?? 0) + el.currentTime)
    return
  }
  editor.setPlayhead(el.currentTime)
}

function onLoadedMetadata(): void {
  const el = audioEl.value
  if (!el) return
  applyPlaybackRate()

  const local = pendingLocal
  pendingLocal = null
  if (local !== null) seekTo(local)

  // 独立模式下真实音频的时长以解码结果为准，回写到文件记录
  if (!isMerged.value) {
    const file = viewFile.value
    if (file && Number.isFinite(el.duration) && el.duration > 0 && file.durationSec === null) {
      file.durationSec = Number(el.duration.toFixed(2))
    }
  }

  if (wantPlay) void tryPlay()
  scheduleFadeOut()
}

function onAudioEnded(): void {
  if (isMerged.value && wantPlay) {
    void (async () => {
      const next = await nextPlayablePart(loadedPart + 1)
      if (next >= 0 && wantPlay) {
        await loadAt(project.mergedParts[next].offsetSec)
        return
      }
      finishAtEnd()
    })()
    return
  }
  finishAtEnd()
}

function finishAtEnd(): void {
  const duration = viewFile.value?.durationSec ?? 0
  if (duration > 0) editor.setPlayhead(duration)
  stopPlayback()
}

/** `play()` 被拒（格式 / 自动播放策略）以前是纯静默的，用户只看到「没声音」 */
function reportPlayError(err: unknown): void {
  editor.isPlaying = false
  const e = err as DOMException
  ui.notify(
    'error',
    '音频无法播放',
    e?.name === 'NotSupportedError' ? '该格式不被当前环境支持' : (e?.message ?? String(err)),
  )
}

/** 媒体加载 / 解码失败。以前这里没有任何监听，失败是纯静默的 */
function onAudioError(): void {
  const err = audioEl.value?.error
  // 切段时旧地址会报一次「加载被中断」（code 1），那不是故障
  if (!err || err.code === 1) return
  const detail =
    err.code === 2
      ? '网络错误'
      : err.code === 3
        ? '解码失败'
        : err.code === 4
          ? '格式不受支持或数据损坏'
          : '未知错误'
  editor.isPlaying = false
  ui.notify('error', '音频无法播放', `${viewFile.value?.name ?? ''}：${detail}`)
}

/** 缓冲提示：不弹 toast（会刷屏），只在播放器下方给一行字 */
const buffering = ref(false)

function onWaiting(): void {
  buffering.value = true
}

function onPlaying(): void {
  buffering.value = false
}

/* ---- 游标 → 元素 ---- */

function syncAudioToPlayhead(): void {
  const el = audioEl.value
  if (!el || !loadedSrc) return
  // 拖播放头期间不跟：每帧 seek 一次会让声音碎成一片，等松手再来（见下面那个 watch）
  if (editor.scrubbing) return

  if (isMerged.value) {
    const idx = partIndexOfTime(editor.playheadSec)
    if (idx !== loadedPart) {
      // 跨段：交给 loadAt 重新装载。正在播放且恰好到了段尾时，让 ended 接手
      if (!switching && !(wantPlay && el.ended)) void loadAt(editor.playheadSec)
      return
    }
    const part = project.mergedParts[loadedPart]
    const local = Math.max(0, editor.playheadSec - (part?.offsetSec ?? 0))
    if (Math.abs(el.currentTime - local) > 0.15) {
      seekTo(local)
      scheduleFadeOut()
    }
    return
  }

  // 只在播放头与音频实际位置差得比较远时才跳，微小的解码延迟不折腾
  if (Math.abs(el.currentTime - editor.playheadSec) > 0.15) seekTo(editor.playheadSec)
}

/* ------------------------------------------------------------- 播放控制 */

watch(
  () => editor.isPlaying,
  (playing) => {
    wantPlay = playing
    const el = audioEl.value
    if (!playing) {
      cancelFadeOut()
      buffering.value = false
      el?.pause()
      return
    }
    if (!el) {
      // 元素还没挂上（首帧）：下一拍再装
      void nextTick(() => {
        if (wantPlay) void loadAt(editor.playheadSec)
      })
      return
    }
    void loadAt(editor.playheadSec)
  },
)

// 切文件：游标归零，播放器换源。合并模式下 viewFileId 不变，这条不会打扰段切换
watch(
  () => project.viewFileId,
  () => {
    cancelFadeOut()
    audioEl.value?.pause()
    loadedSrc = null
    loadedPart = 0
    pendingLocal = null
    spanHasNoAudio.value = false
    editor.clearPlayRange()
    editor.setPlayhead(0)
    if (wantPlay) void loadAt(0)
  },
)

// 游标被外部改动（点波形、点字幕、上一句/下一句）时同步给 audio
watch(
  () => editor.playheadSec,
  () => {
    if (loadedSrc) syncAudioToPlayhead()
  },
)

watch(
  () => editor.playbackRate,
  () => {
    applyPlaybackRate()
    scheduleFadeOut()
  },
)

/**
 * 松手那一刻才把元素对齐到新位置。
 *
 * 拖拽过程中刻意不跟（`syncAudioToPlayhead` 里直接 return），否则每帧一次
 * `currentTime` 赋值，声音会碎成一片。松手后：同段内就直接 seek，跨段就重新
 * 装载那一整段。
 */
watch(
  () => editor.scrubbing,
  (on) => {
    if (on || !loadedSrc) return
    if (isMerged.value && partIndexOfTime(editor.playheadSec) !== loadedPart) {
      void loadAt(editor.playheadSec)
      return
    }
    syncAudioToPlayhead()
    scheduleFadeOut()
  },
)

/**
 * 「播放本句」的一次性范围：播到句尾就停，游标留在句尾。
 *
 * 用 rAF 盯着而不是靠 timeupdate：后者约 250ms 才来一次，句尾会明显过冲。
 * 游标被挪到范围之外（用户点了别处）就静默放弃这次一次性播放，别硬拽回来。
 */
let rangeRaf = 0

function stopRangeLoop(): void {
  if (rangeRaf) {
    cancelAnimationFrame(rangeRaf)
    rangeRaf = 0
  }
}

function startRangeLoop(): void {
  const step = (): void => {
    const range = editor.playRange
    if (!range || !editor.isPlaying) {
      rangeRaf = 0
      return
    }
    const t = editor.playheadSec
    if (t > range.end + 0.05) {
      // 用户把游标挪到别处了：放弃这次一次性播放
      editor.clearPlayRange()
      rangeRaf = 0
      return
    }
    if (t >= range.end - 0.005) {
      editor.setPlayhead(range.end)
      editor.clearPlayRange()
      editor.isPlaying = false
      rangeRaf = 0
      return
    }
    rangeRaf = requestAnimationFrame(step)
  }
  rangeRaf = requestAnimationFrame(step)
}

watch(
  () => [editor.playRange, editor.isPlaying] as const,
  ([range, playing]) => {
    stopRangeLoop()
    if (range && playing) startRangeLoop()
  },
  { immediate: true },
)

/** 循环当前句与一次性范围互斥：开循环就把范围撤掉 */
watch(
  () => [editor.loopCurrent, editor.playheadSec] as const,
  ([loop]) => {
    const el = audioEl.value
    if (!loop) return
    editor.clearPlayRange()
    if (!el || !loadedSrc) return
    const seg = currentSegment.value
    if (!seg) return
    const offset = isMerged.value ? (project.mergedParts[loadedPart]?.offsetSec ?? 0) : 0
    if (el.currentTime < seg.start - offset - 0.05 || el.currentTime > seg.end - offset) {
      seekTo(Math.max(0, seg.start - offset))
      editor.setPlayhead(seg.start)
      scheduleFadeOut()
    }
  },
)

/** 阶段 1 没有真实音频（演示数据）时，用定时器驱动播放头 */
let timer: number | null = null

function tick(): void {
  const duration = viewFile.value?.durationSec ?? 0
  if (duration <= 0) {
    editor.isPlaying = false
    return
  }

  const seg = currentSegment.value
  if (editor.loopCurrent && seg) {
    const next = editor.playheadSec + 0.1 * editor.playbackRate
    editor.setPlayhead(next >= seg.end ? seg.start : next)
    return
  }

  const next = editor.playheadSec + 0.1 * editor.playbackRate
  if (next >= duration) {
    editor.setPlayhead(duration)
    editor.isPlaying = false
    return
  }
  editor.setPlayhead(next)
}

watch(
  () => [editor.isPlaying, hasAudio.value, !!audioUrl.value] as const,
  ([playing, audible, hasUrl]) => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    if (!playing || !audible || hasUrl) return
    timer = window.setInterval(tick, 100)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  cancelFadeOut()
  stopRangeLoop()
  detachSpeedListeners()
  void audioCtx?.close()
  audioCtx = null
  gainNode = null
})

/* --------------------------------------------------------------- 交互 */

function toggle(): void {
  if (!hasAudio.value) return
  // 主播放键 = 沿时间轴连续播放，顺手退出「只播本句」的一次性范围
  editor.clearPlayRange()
  editor.togglePlay()
}

function step(direction: -1 | 1): void {
  const segments = viewFile.value?.segments ?? []
  if (segments.length === 0) return
  const index = currentSegment.value
    ? segments.findIndex((s) => s.id === currentSegment.value?.id)
    : -1
  const nextIndex = Math.min(segments.length - 1, Math.max(0, index + direction))
  const target = segments[nextIndex]
  editor.clearPlayRange()
  editor.setPlayhead(target.start)
  editor.select(target.id, 'replace', segments.map((s) => s.id))
}

function playCurrent(): void {
  const seg = currentSegment.value
  if (!seg) return
  editor.playOneShot(seg.id, seg.start, seg.end)
  editor.setPlayhead(seg.start)
  if (!editor.isPlaying) editor.isPlaying = true
}

/**
 * 倍速菜单
 *
 * 菜单不能就地绝对定位。它所在的侧栏是滚动容器（`.scroll-y`），
 * 而绝对定位元素会被祖先的 overflow 裁掉：实测菜单向上弹出时顶部两项
 * （0.5x / 0.75x）直接看不见，窗口一窄还会被横向切边。
 * 所以改成 Teleport 到 body + fixed 定位，坐标按按钮实测矩形算，
 * 并夹在视口内；下方放不下且上方更宽松时翻到上方。
 */
const speedOpen = ref(false)
const speedBtnEl = ref<HTMLButtonElement | null>(null)
const speedMenuEl = ref<HTMLElement | null>(null)
const speedMenuPos = ref({ left: 0, top: 0 })

/** 与 CSS 里的 .player__speed-menu 宽度保持一致，首次渲染前用它估算 */
const MENU_WIDTH = 84
/** 菜单与按钮之间的间隙 */
const MENU_GAP = 4
/** 菜单与视口边缘的最小留白 */
const VIEW_PAD = 8

function placeSpeedMenu(): void {
  const btn = speedBtnEl.value
  if (!btn) return

  const rect = btn.getBoundingClientRect()
  const width = speedMenuEl.value?.offsetWidth || MENU_WIDTH
  const height = speedMenuEl.value?.offsetHeight ?? 0

  // 默认右对齐按钮，再夹回视口内
  const left = Math.min(
    Math.max(VIEW_PAD, rect.right - width),
    Math.max(VIEW_PAD, window.innerWidth - width - VIEW_PAD),
  )

  const roomBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEW_PAD
  const roomAbove = rect.top - MENU_GAP - VIEW_PAD
  // 高度还没量到时（首帧）先朝下，量到之后再做翻转让位
  const flip = height > 0 && roomBelow < height && roomAbove > roomBelow
  const top = flip ? rect.top - MENU_GAP - height : rect.bottom + MENU_GAP

  speedMenuPos.value = { left, top }
}

async function toggleSpeedMenu(): Promise<void> {
  speedOpen.value = !speedOpen.value
  if (!speedOpen.value) return
  await nextTick()
  placeSpeedMenu()
}

function setSpeed(value: number): void {
  editor.playbackRate = value
  speedOpen.value = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (speedBtnEl.value?.contains(target) || speedMenuEl.value?.contains(target)) return
  speedOpen.value = false
}

/** 菜单是 fixed 定位，祖先一滚就会脱离按钮，直接收起最省事也最不容易出错 */
function onViewportChange(): void {
  speedOpen.value = false
}

watch(speedOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return
  }
  detachSpeedListeners()
})

function detachSpeedListeners(): void {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
}
</script>

<template>
  <div class="player">
    <div class="player__controls">
      <button
        class="player__btn"
        type="button"
        title="上一句"
        :disabled="!hasAudio"
        @click="step(-1)"
      >
        <Icon name="chevron-up" :size="15" />
      </button>

      <button
        class="player__btn player__btn--main"
        type="button"
        :title="editor.isPlaying ? '暂停' : '播放'"
        :disabled="!hasAudio"
        @click="toggle"
      >
        <Icon :name="editor.isPlaying ? 'pause' : 'play'" :size="15" />
      </button>

      <button
        class="player__btn"
        type="button"
        title="下一句"
        :disabled="!hasAudio"
        @click="step(1)"
      >
        <Icon name="chevron-down" :size="15" />
      </button>
    </div>

    <div class="player__time mono">
      <span class="player__current">{{ toTimecode(editor.playheadSec) }}</span>
      <span class="player__total">/ {{ toTimecode(viewFile?.durationSec ?? 0) }}</span>
    </div>

    <div class="player__row">
      <button
        class="player__btn"
        type="button"
        :class="{ 'is-on': editor.loopCurrent }"
        title="循环当前句"
        :disabled="!currentSegment"
        @click="editor.loopCurrent = !editor.loopCurrent"
      >
        <Icon name="loop" :size="14" />
      </button>

      <button
        class="player__text-btn"
        type="button"
        :disabled="!currentSegment"
        title="只播放当前这一句，播完自动暂停"
        @click="playCurrent"
      >
        播放本句
      </button>

      <span class="spacer" />

      <div class="player__speed">
        <button
          ref="speedBtnEl"
          class="player__text-btn player__text-btn--speed"
          type="button"
          @click="toggleSpeedMenu"
        >
          {{ editor.playbackRate }}x
          <Icon name="chevron-down" :size="12" />
        </button>
        <Teleport to="body">
          <ul
            v-if="speedOpen"
            ref="speedMenuEl"
            class="player__speed-menu"
            :style="{ left: `${speedMenuPos.left}px`, top: `${speedMenuPos.top}px` }"
          >
            <li v-for="speed in SPEEDS" :key="speed">
              <button
                class="player__speed-item"
                type="button"
                :class="{ 'is-active': editor.playbackRate === speed }"
                @click="setSpeed(speed)"
              >
                {{ speed }}x
              </button>
            </li>
          </ul>
        </Teleport>
      </div>
    </div>

    <p v-if="buffering" class="player__hint">正在缓冲这一段音频…</p>
    <p v-else-if="spanHasNoAudio" class="player__hint player__hint--warn">
      这一段没有音频轨（例如导入的字幕文件），无法试听。
    </p>
    <p v-if="isMerged" class="player__note">
      合并时间轴由 {{ project.supportedFiles.length }} 段音频依次拼接，试听会自动接续播放各段
      （段与段之间有 8ms 淡化，消掉拼接处的爆音）；刚切到某一段时需要先解码，可能略有延迟。
    </p>
    <p v-else-if="!audioUrl" class="player__note">
      演示数据没有真实音频，播放由模拟进度驱动；导入真实文件后将播放原声。
    </p>

    <!-- 真实音频元素。不渲染控件，播放由界面按钮驱动。
         刻意**不加 v-if**：地址一变就卸载元素，会把正在播的声音连根拔掉。 -->
    <audio
      ref="audioEl"
      class="player__audio"
      preload="auto"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMetadata"
      @ended="onAudioEnded"
      @error="onAudioError"
      @waiting="onWaiting"
      @stalled="onWaiting"
      @playing="onPlaying"
      @canplay="onPlaying"
    />
  </div>
</template>

<style scoped>
.player {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.player__controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

.player__btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  color: var(--color-text-secondary);
  transition: background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.player__btn:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.player__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.player__btn--main {
  width: 38px;
  height: 38px;
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-inverse);
}

.player__btn--main:hover:not(:disabled) {
  background: var(--color-accent-hover);
  color: var(--color-text-inverse);
}

.player__btn.is-on {
  border-color: var(--color-accent);
  background: var(--color-accent-subtle);
  color: var(--color-accent-text);
}

.player__time {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: var(--space-1);
  font-size: var(--font-size-xs);
}

.player__current {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.player__total {
  color: var(--color-text-tertiary);
}

.player__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.player__text-btn {
  height: 26px;
  padding: 0 var(--space-2);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.player__text-btn:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.player__text-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.player__speed {
  display: flex;
}

/* Teleport 到 body 后用 fixed 定位，坐标由脚本按按钮矩形算出并夹进视口。
   宽度与脚本里的 MENU_WIDTH 对应，改一处要改两处。 */
.player__speed-menu {
  position: fixed;
  z-index: var(--z-dropdown);
  width: 84px;
  padding: var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-md);
}

.player__speed-item {
  width: 100%;
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  text-align: left;
  color: var(--color-text-secondary);
}

.player__speed-item:hover {
  background: var(--color-bg-hover);
}

.player__speed-item.is-active {
  color: var(--color-accent-text);
  font-weight: var(--weight-medium);
}

.player__hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.player__hint--warn {
  color: var(--color-warning);
}

.player__note {
  font-size: 11px;
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
  padding-top: var(--space-1);
  border-top: 1px dashed var(--color-border-subtle);
}

.player__audio {
  display: none;
}
</style>
