<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUiStore, TASK_RECOGNIZE, FLIGHT_MS, FLIGHT_SETTLE_MS, type TaskFlight, type ViewKey } from '@/stores/ui'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { useUpdateStore } from '@/stores/update'
import { confirmDestructive } from '@/utils/confirm'

import AppTitlebar from '@/components/AppTitlebar.vue'
import AppSidebar from '@/components/AppSidebar.vue'
import AppStatusBar from '@/components/AppStatusBar.vue'
import ToastStack from '@/components/ToastStack.vue'
import DropOverlay from '@/components/DropOverlay.vue'
import Icon from '@/components/Icon.vue'

import HomeView from '@/views/HomeView.vue'
import EditorView from '@/views/EditorView.vue'
import ModelView from '@/views/ModelView.vue'
import SettingsView from '@/views/SettingsView.vue'
import AboutView from '@/views/AboutView.vue'
import AssistView from '@/views/AssistView.vue'

import type { AssistSubmitPayload } from '@/types/engine'

import UnsupportedFormatDialog from '@/components/dialogs/UnsupportedFormatDialog.vue'
import FormatHelpDialog from '@/components/dialogs/FormatHelpDialog.vue'
import GapFillDialog from '@/components/dialogs/GapFillDialog.vue'
import ExportDialog from '@/components/dialogs/ExportDialog.vue'
import UpdateDialog from '@/components/dialogs/UpdateDialog.vue'
import LegalDialog from '@/components/dialogs/LegalDialog.vue'
import RecordView from '@/views/RecordView.vue'

const ui = useUiStore()
const project = useProjectStore()
const settings = useSettingsStore()
const update = useUpdateStore()

const views = {
  home: HomeView,
  editor: EditorView,
  models: ModelView,
  settings: SettingsView,
  about: AboutView,
} as const

const viewComponent = computed(() => views[ui.currentView])

/* --------------------------------------------------------------- 全局拖放 */

const dragActive = ref(false)
let dragDepth = 0

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!hasFiles(event)) return
  dragDepth += 1
  dragActive.value = true
}

function onDragOver(event: DragEvent): void {
  if (!hasFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(): void {
  dragDepth -= 1
  if (dragDepth <= 0) {
    dragDepth = 0
    dragActive.value = false
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragDepth = 0
  dragActive.value = false
  const list = [...(event.dataTransfer?.files ?? [])]
  if (list.length > 0) project.receiveDroppedFiles(list)
}

/** 开发预览用：?demo=1 载入演示数据，?view=editor 进入指定页面，?theme=dark 切换主题 */

/** 开发预览注入了更新状态时为 true，据此跳过启动时的自动检查 */
let devUpdateInjected = false

/** 开发预览用 `?view=` 指定了页面时为 true，据此跳过启动时的模型检查与自动跳转 */
let devViewInjected = false

/**
 * 主题直达（DEV）。
 *
 * 单独拎出来是因为它**与窗口类型无关**：辅助窗口不跑 `applyDevQuery()`（它不挂主界面的
 * 拖放与更新检查），但 `?theme=` 是纯渲染开关，两个窗口都该认。少了这一步，辅助窗口
 * 只跟着系统的 `prefers-color-scheme` 走，探针里写的 `?theme=light` 就成了一句空话 ——
 * 截图看着是深色，还以为是浅色通过了。
 *
 * 它必须晚于 settings store 初始化：store 的 `watch(themeMode, applyTheme, { immediate })`
 * 会先按设置写一次 `data-theme`，这里再覆盖。
 */
function applyDevTheme(): void {
  if (!import.meta.env.DEV) return
  const theme = new URLSearchParams(window.location.search).get('theme')
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme
  }
}

function applyDevQuery(): void {
  if (!import.meta.env.DEV) return
  const params = new URLSearchParams(window.location.search)
  const view = params.get('view')
  if (params.has('demo')) project.loadDemo(view === 'editor')
  if (view && view in views) {
    ui.navigate(view as ViewKey)
    devViewInjected = true
  }

  // 主题由 applyDevTheme() 处理 —— 它要在辅助窗口里也生效，所以不放在这里

  // 弹窗直达。只为让探针能在指定窗口尺寸下量弹窗的高度与滚动，
  // 这类问题用静态截图看不出来 —— 正式版没有这个入口。
  if (params.get('dialog') === 'format-help') ui.openDialog('format-help')
  if (params.get('dialog') === 'update') ui.openDialog('update')

  // 更新状态直达。浏览器预览里既没有 Electron 桥也没有外网，
  // 探针要测左下角提示与更新弹窗只能靠它摆出现场。
  // 一旦注入了就跳过启动时的自动检查，否则会把摆好的状态覆盖掉。
  const injected = params.get('update')
  if (injected) {
    update.applyDevState(injected)
    devUpdateInjected = true
  }
}

/**
 * 启动时确认至少有一个可用的识别模型。
 *
 * 「模型不随包」之后，装完软件是没有模型的。不提醒的话用户会一路走到
 * 「开始识别」才失败 —— 那时音频都导进来了，也看不出失败的原因是模型。
 * 所以启动即检查，直接把人送到模型页。
 *
 * 只提醒一次：用户可能就是想先不下载，每次启动都拦一道会很烦。磁盘上重新
 * 出现模型时把这个标记清掉，于是「又被删空了」还会再提醒一次。
 */
const MODELS_PROMPT_KEY = 'xbaos.models.startupPrompted'

async function checkModelsOnStart(): Promise<void> {
  const api = window.xbaos
  if (!api?.info) return // 浏览器预览没有桥
  try {
    const appInfo = await api.info()
    if ((appInfo.models ?? []).length > 0) {
      localStorage.removeItem(MODELS_PROMPT_KEY)
      return
    }
    if (localStorage.getItem(MODELS_PROMPT_KEY) === '1') return

    // 这几十毫秒里用户可能自己点了别处 —— 那就别把人拽走
    if (ui.currentView !== 'home') return

    localStorage.setItem(MODELS_PROMPT_KEY, '1')
    ui.navigate('models')
    ui.notify(
      'warning',
      '还没有可用的识别模型',
      '请先下载一个模型，或把 ggml 格式的 .bin 模型文件放进模型文件夹',
    )
  } catch {
    /* 拿不到应用信息就静默跳过，不打扰用户 */
  }
}

/**
 * 辅助窗口（AI 校对）与主界面共用同一份前端产物，靠 ?window=assist 区分。
 * 它只渲染 AssistView，不挂主界面的拖放与结果回写。
 */
const isAssistWindow = new URLSearchParams(window.location.search).get('window') === 'assist'

/**
 * 录音窗口同理，靠 ?window=record 区分，只渲染 RecordView。
 *
 * 两个「附属窗口」的判断合在 `isSubWindow` 里用：主界面那一堆副作用
 * （拖放、更新检查、任务栏进度、飞行指示、关窗裁决）对它们**一个都不成立**，
 * 每加一个新窗口都去补一遍 `isXxx && return` 迟早会漏。
 */
const isRecordWindow = new URLSearchParams(window.location.search).get('window') === 'record'
const isSubWindow = isAssistWindow || isRecordWindow

let offAssistResult: (() => void) | undefined
let offAssistClosed: (() => void) | undefined
let offRecordSaved: (() => void) | undefined
let offRecordClosed: (() => void) | undefined

/**
 * 辅助窗口确认后把结果送回来，在这里执行覆盖。
 * 覆盖走 history.commit，编辑器里 Ctrl+Z 就能整体撤回。
 */
function onAssistResult(payload: AssistSubmitPayload): void {
  const results = payload.results ?? []
  const translating = payload.task === 'translate'
  let applied = 0
  for (const item of results) {
    if (translating) {
      if (project.applyTranslation(item.fileId, payload.lang ?? '', item.lines ?? [])) applied += 1
    } else if (project.applyAiReview(item.fileId, item.cues ?? [])) {
      applied += 1
    }
  }
  if (applied > 1) {
    // 历史是按文件分桶的，一次 Ctrl+Z 只回退当前正在看的那个文件。
    // 不说清楚的话，用户会觉得「撤销没生效」。
    ui.notify(
      'info',
      '撤销按文件生效',
      `这次改了 ${applied} 个文件。Ctrl+Z 只回退当前查看的那个，其余文件需切换过去分别撤销`,
    )
  }
  if (applied === 0) {
    ui.notify(
      'error',
      translating ? '译文没能写回' : 'AI 校对结果没能写回',
      // 翻译最常见的失败原因就是条数对不上 —— 直接说出来，别让用户猜
      translating
        ? '译文条数与字幕条数必须完全一致；目标字幕也可能已被清空或替换'
        : '目标字幕可能已被清空或替换，请重新打开校对窗口',
    )
  }
  // 不论成败都关掉辅助窗口：失败了再留着它也做不了什么
  window.xbaos?.assist?.close()
}

/** 辅助窗口关掉了 → 解除主界面的压暗 */
function onAssistClosed(): void {
  ui.setAssistActive(false)
}

/* -------------------------------------------------------------- 录音窗口 */

/**
 * 录音窗口保存好了音频，把路径递过来入队。
 *
 * **不能在录音窗口里直接入队**：那是另一个渲染进程，Pinia 各有一份实例，
 * 它那边的 `addFiles` 只会加进一份空工程，窗口一关就没了 ——
 * 用户会看到「保存成功」而队列里什么都没有。
 */
async function onRecordSaved(filePath: string): Promise<void> {
  const added = await project.addFilesFromPaths([filePath])
  if (added <= 0) return
  // 录完就是要立刻看它、标它、识别它 —— 落到导入页
  ui.navigate('home')
  ui.notify('info', '录音已加入队列', '确认无误后就可以开始识别')
}

/** 录音窗口关掉了 → 解除主界面的压暗 */
function onRecordClosed(): void {
  ui.setRecordActive(false)
}

/** 把被别的窗口盖住的录音窗口重新拉到最前 */
function bringRecorderToFront(): void {
  void window.xbaos?.record?.focus()
}

/** 把被别的窗口盖住的辅助窗口重新拉到最前 */
function bringAssistToFront(): void {
  void window.xbaos?.assist?.focus()
}

/* ------------------------------------------------- 开始识别 → 进度条飞行 */

/**
 * 「开始识别」按钮收成一个小圆点、沿着一条弧线飞到界面最底部那条进度条上。
 *
 * 这不是装饰：进度条在状态栏中栏，只有 120×3px，第一次用的人点完按钮根本不知道
 * 去哪儿看进度。让圆点**从按钮出发落到进度条上**，等于用位置说了一句「进度在下面」。
 * 所以它是全项目唯一一处 460ms（`--dur-slow`）的动画 —— 其余动画都在 120/180ms 两档。
 *
 * 三个组件各有分工：起点在 HomeView 页脚（`beginTaskFlight`），终点在 AppStatusBar
 * （`.statusbar__progress-track`），动画本体挂在这里的 Teleport 上。
 */
const flightRef = ref<HTMLElement | null>(null)
/** 自增序号：上一次飞行还没收完又来了新的一次时，旧的那条要立刻退场 */
let flightSeq = 0

/**
 * 「先快后极缓」的缓动求值器，语义与 CSS 的 `cubic-bezier(x1, y1, x2, y2)` 相同。
 *
 * 计算方式就是 CSS 那份定义：解出参数 t 使 Bx(t) = x，再取 By(t)。
 * 这里用牛顿迭代，6 次足够收敛到亚像素精度。
 */
function cubicBezierEase(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const at = (t: number) => ((ax * t + bx) * t + cx) * t
  const slope = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  const value = (t: number) => ((ay * t + by) * t + cy) * t
  return (x: number) => {
    let t = x
    for (let i = 0; i < 6; i += 1) {
      const d = slope(t)
      if (Math.abs(d) < 1e-6) break
      t -= (at(t) - x) / d
    }
    return value(Math.min(1, Math.max(0, t)))
  }
}

/**
 * 落点坐标（视口坐标）。
 *
 * **每次调用都重新量**：状态栏中栏会随「进度文案变长」「百分比从 9% 变成 100%」
 * 左右移动，实测这一下能把进度条推走 150px 以上。缓存起飞时量到的那个位置，
 * 圆点就会落在进度条旁边。（飞行途中改窗口大小同理。）
 */
function flightTarget(): { x: number; y: number } {
  const track = document.querySelector('.statusbar__progress-track')
  const fallback =
    document.querySelector('.statusbar__center') ?? document.querySelector('.statusbar')
  const el = track ?? fallback
  if (el) {
    const rect = el.getBoundingClientRect()
    // 落在进度条左端（进度是从左往右长的），其余情况落在元素水平中心
    return {
      x: track ? rect.left + 1 : rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }
  }
  return { x: window.innerWidth / 2, y: window.innerHeight - 16 }
}

/** 圆点飞行途中的弧线抬升高度（px）。直线位移在这么短的距离里显得「啪」地一下 */
const FLIGHT_ARC = 18
/** 飞到终点时圆点缩到原来的多少 */
const FLIGHT_SCALE_TO = 0.34

async function runTaskFlight(flight: TaskFlight): Promise<void> {
  const seq = ++flightSeq
  await nextTick()
  const el = flightRef.value
  if (!el) {
    ui.endTaskFlight()
    return
  }

  const sx = flight.from.x + flight.from.width / 2
  const sy = flight.from.y + flight.from.height / 2
  const ease = cubicBezierEase(0.32, 0.72, 0, 1)
  const startedAt = performance.now()

  // 先把圆点同步摆到按钮上。
  // **这一步必须在注册 rAF 之前做**：元素是 `v-if` 新建的，它的静态位置在视口
  // 左上角 (0,0)，而左上角正是侧栏/标题栏所在的位置 —— 只要有一帧没摆正，
  // 眼睛就会看到「屏幕左上角闪了一下」。（探针里那个逐帧采样器就是靠
  // 首个采样 x=0 把它逮出来的。）
  el.style.transform = `translate3d(${sx}px, ${sy}px, 0) scale(1)`

  /*
   * 轨迹自己算，不用 `offset-path`。两个理由：
   *
   * 1. **落点要每帧跟着进度条走**（见 flightTarget 的注释）。`offset-path` 是一条
   *    出发时就定死的路径，中途挪目标得整条重建。
   * 2. **`offset-path` 的位移会被元素自身的 transform 乘掉**：把 `scale` 和它放在
   *    同一个元素上时，落点 = `scale × 路径点` —— 收小到 0.34 就等于朝左上角缩，
   *    实测本该落在 (671, 826) 的进度条上、结果落在 (142, 176)。
   *    自己算的话，位移和缩放都在一条 `transform` 里，怎么组合都是我说了算。
   */
  await new Promise<void>((resolve) => {
    const step = (): void => {
      if (seq !== flightSeq) {
        resolve()
        return
      }
      const t = Math.min(1, (performance.now() - startedAt) / FLIGHT_MS)
      const p = ease(t)
      const target = flightTarget()
      const x = sx + (target.x - sx) * p
      // 上凸的弧线：正弦包络在中段最高，两端恰好为零 —— 所以起点与终点都是准的
      const y = sy + (target.y - sy) * p - Math.sin(Math.PI * p) * FLIGHT_ARC
      const s = 1 + (FLIGHT_SCALE_TO - 1) * p
      el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`
      if (t >= 1) resolve()
      else requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  if (seq !== flightSeq) return

  // 收尾「吸入」：短促一拍，把圆点收进进度条里。位置再量一次，别停在旧坐标上
  const end = flightTarget()
  const settle = el.animate(
    [
      {
        transform: `translate3d(${end.x}px, ${end.y}px, 0) scale(${FLIGHT_SCALE_TO})`,
        opacity: '1',
      },
      { transform: `translate3d(${end.x}px, ${end.y}px, 0) scale(0.12)`, opacity: '0' },
    ],
    { duration: FLIGHT_SETTLE_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
  )
  try {
    await settle.finished
  } catch {
    /* 被取消（切页 / 又点了一次）：不算错误 */
  }
  if (seq !== flightSeq) return
  ui.endTaskFlight()
}

watch(
  () => ui.taskFlight,
  (flight) => {
    if (isSubWindow || !flight) return
    void runTaskFlight(flight)
  },
  { flush: 'post' },
)

/* ------------------------------------------------------------ 关窗与进度 */

/**
 * 主进程要关窗，先在这里裁决「有没有会丢的东西」。
 *
 * 数据全在渲染进程（工程只存在于内存，没有落盘），所以判断必须在这边做。
 * 主进程那边有 4 秒看门狗兜底；这里第一件事就是回执把它撤掉 —— 原生确认框
 * 可能要让用户想上一会儿，看门狗不能按「确认框还没点」来计时。
 */
async function onCloseRequest(): Promise<void> {
  const bridge = window.xbaos?.app
  if (!bridge) return
  bridge.ackCloseRequest()

  const { count, recognizing, names } = project.unsavedSummary()
  // 一份没动过、也没在识别 —— 直接放行，不打扰
  if (count === 0) {
    bridge.forceClose()
    return
  }

  const head =
    recognizing > 0
      ? `有 ${recognizing} 个文件还没识别完`
      : count === 1
        ? '有 1 个文件的内容尚未保存'
        : `有 ${count} 个文件的内容尚未保存`
  const shown = names.slice(0, 5).join('、')
  const more = names.length > 5 ? ` 等 ${names.length} 个文件` : ''

  const ok = await confirmDestructive({
    title: '还有未保存的内容',
    message: `${head}，关闭后不会保留。`,
    detail: `涉及：${shown}${more}。\n可以先「导出字幕」保存下来，或者留在软件里继续处理。`,
    confirmLabel: '仍要关闭',
  })
  if (ok) bridge.forceClose()
}

/**
 * 识别进度喂进任务栈。
 *
 * 只负责「识别自己那一份」：栈里可能还有别的长任务（模型下载），谁该显示、
 * 什么时候清，由 ui store 按「后开始的优先」统一裁决 —— 这里不碰任务栏。
 */
watch(
  () => [project.recognizing, project.progress] as const,
  ([recognizing, percent], [wasRecognizing]) => {
    if (isSubWindow) return
    if (recognizing) {
      // 用 hasTask 而不是「栈顶是不是我」：栈顶可能已经是后开始的下载
      if (!ui.hasTask(TASK_RECOGNIZE)) ui.beginTask(TASK_RECOGNIZE, '正在识别')
      ui.updateTask(TASK_RECOGNIZE, percent)
      return
    }
    // 刚跑完（之前确实在跑，而不是本来就没跑）
    if (wasRecognizing) {
      ui.endTask(TASK_RECOGNIZE)
      // 识别要跑几分钟，结束时人往往已经切走了 —— 闪一下任务栏把人叫回来
      ui.flashTaskBar()
    }
  },
)

/**
 * 任务栈 → 任务栏进度条。
 *
 * 与上面那个 watch 分开是刻意的：上面管「谁在跑、跑到哪」，这里只管「任务栏
 * 怎么画」。合在一起的话，将来每加一个长任务都得爬进识别那段代码里插一行。
 */
watch(
  () => ui.taskProgress,
  (task) => {
    if (isSubWindow) return
    const api = window.xbaos?.app
    if (!api?.setProgress) return
    // Electron 约定：0–1 显示进度，负数清除
    api.setProgress(task ? Math.min(1, Math.max(0, task.percent / 100)) : -1)
  },
)

let offCloseRequest: (() => void) | undefined

onMounted(() => {
  // 先套主题：附属窗口（辅助 / 录音）在这一行之后就返回了，它们同样要认 `?theme=`
  applyDevTheme()
  if (isSubWindow) return

  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  applyDevQuery()

  // 模型是识别的前提，缺了必须当面说清楚。?view= 注入时不抢导航（探针要用）
  if (!devViewInjected) void checkModelsOnStart()

  // 「模型存储位置」存在 localStorage 里，主进程重启后不记得 —— 启动时同步一次，
  // 否则改过目录之后第一次下载还会落到旧位置
  const modelsApi = window.xbaos?.models
  if (modelsApi?.setDir) void modelsApi.setDir(settings.modelsDir).catch(() => {})

  // 启动时静默检查更新。这是软件除「下载模型」外唯一会联网的地方，
  // 可以在关于页关掉。不 await：它慢一点、失败也不该拖住界面。
  if (settings.checkUpdateOnStart && !devUpdateInjected) void update.check()

  offAssistResult = window.xbaos?.assist?.onResult(onAssistResult)
  offAssistClosed = window.xbaos?.assist?.onClosed(onAssistClosed)
  offRecordSaved = window.xbaos?.record?.onSaved((filePath) => void onRecordSaved(filePath))
  offRecordClosed = window.xbaos?.record?.onClosed(onRecordClosed)
  offCloseRequest = window.xbaos?.app?.onCloseRequest(() => void onCloseRequest())
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  offAssistResult?.()
  offAssistClosed?.()
  offRecordSaved?.()
  offRecordClosed?.()
  offCloseRequest?.()
})
</script>

<template>
  <!-- 附属窗口（辅助 / 录音）只渲染它自己的界面，主界面（标题栏 / 侧栏 / 状态栏）一律不挂 -->
  <RecordView v-if="isRecordWindow" />
  <AssistView v-else-if="isAssistWindow" />

  <div v-else class="app">
    <AppTitlebar />

    <div class="app__body">
      <AppSidebar />

      <main class="app__main">
        <!-- 页面切换过渡。**只做进场、不做出场**（见 global.css 里 viewfade 的注释）：
             入场缺席时两个视图会同时在 DOM 里待 180ms，「时间轴上有几条字幕」这类
             查询会数到两倍。mode="out-in" + 出场无过渡，等于「旧的立刻走、新的淡入」。 -->
        <Transition name="viewfade" mode="out-in">
          <KeepAlive>
            <component :is="viewComponent" />
          </KeepAlive>
        </Transition>
      </main>
    </div>

    <AppStatusBar />

    <DropOverlay :active="dragActive" />

    <UnsupportedFormatDialog v-if="ui.dialog === 'unsupported-format'" />
    <FormatHelpDialog v-if="ui.dialog === 'format-help'" />
    <GapFillDialog v-if="ui.dialog === 'gap-fill'" />
    <ExportDialog v-if="ui.dialog === 'export'" />
    <UpdateDialog v-if="ui.dialog === 'update'" />
    <LegalDialog v-if="ui.dialog === 'legal'" />

    <!-- 辅助窗口存在期间压暗主界面。
         一是拦住「流程没走完又回主界面点一次入口」（会把辅助窗口的数据整个重置），
         二是给用户一个明确的指示：现在该在另一个窗口里操作，点这里可以把它叫到前面。 -->
    <div v-if="ui.assistActive" class="assistlock">
      <div class="assistlock__card" role="alertdialog" aria-modal="true">
        <Icon name="info" :size="18" class="assistlock__icon" />
        <p class="assistlock__title">AI 窗口正在使用中</p>
        <p class="assistlock__text">
          请先在 AI 窗口中按步骤完成操作。该窗口关闭后，本界面会自动恢复。
        </p>
        <button class="btn btn--primary" type="button" @click="bringAssistToFront">
          回到 AI 窗口
        </button>
      </div>
    </div>

    <!-- 录音窗口存在期间压暗主界面，语义与 AI 窗口那把锁完全一致
         （防重复开窗 + 明确指示「去另一个窗口操作」），所以复用同一套样式 -->
    <div v-if="ui.recordActive" class="assistlock">
      <div class="assistlock__card" role="alertdialog" aria-modal="true">
        <Icon name="mic" :size="18" class="assistlock__icon" />
        <p class="assistlock__title">录音窗口正在使用中</p>
        <p class="assistlock__text">
          请在录音窗口完成录制与剪辑。窗口关闭后，本界面会自动恢复。
        </p>
        <button class="btn btn--primary" type="button" @click="bringRecorderToFront">
          回到录音窗口
        </button>
      </div>
    </div>

    <ToastStack />

    <!-- 飞行圆点。Teleport 到 body：它要跨过状态栏、越过 KeepAlive 的视图层，
         留在 .app 里会被别的层叠上下文夹住。 -->
    <Teleport to="body">
      <div v-if="ui.taskFlight" ref="flightRef" class="flight" aria-hidden="true">
        <span class="flight__dot" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-base);
}

.app__body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.app__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-base);
}

/* ---- 辅助窗口存在期间的遮罩 ---- */
.assistlock {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--space-6);
  background: color-mix(in srgb, var(--color-bg-base) 76%, transparent);
}

.assistlock__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: 380px;
  padding: var(--space-6);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
  box-shadow: var(--shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.18));
  text-align: center;
}

.assistlock__icon {
  color: var(--color-text-tertiary);
}

.assistlock__title {
  font-size: var(--font-size-md);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

.assistlock__text {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: var(--line-base);
}

/* ---- 「开始识别」飞向进度条的圆点 ---- */

/* 外层只管「在哪」：offset-path 的位移作用在它身上。
   32px 的方框、margin 拉回一半，于是方框中心就是 offset-anchor（50% 50%），
   落在路径点上时圆点正好压住目标。 */
.flight {
  position: fixed;
  left: 0;
  top: 0;
  width: 32px;
  height: 32px;
  margin: -16px 0 0 -16px;
  pointer-events: none;
  z-index: 60;
}

/* 内层只管「多大、多透」。**缩放必须挂在这里**：挂在 .flight 上的话，
   自身 transform 会乘到 offset 位移上，圆点会朝着左上角缩过去。 */
.flight__dot {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  box-shadow: var(--shadow-sm);
}
</style>
