import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { uid } from '@/utils/id'

export type ViewKey = 'home' | 'editor' | 'models' | 'settings' | 'about'

export type ToastType = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: string
  type: ToastType
  title: string
  message?: string
}

/** 全局弹窗标识 */
export type DialogKey =
  | 'unsupported-format'
  | 'export'
  | 'gap-fill'
  | 'find-replace'
  | 'format-help'
  | 'shortcuts'
  | 'update'
  /** 跨文件讲话人对应关系表 */
  | 'speaker-map'
  /** 保存项目（.xbsgp）：自己实现是为了能实时校验同目录重名 */
  | 'save-project'
  /** 用户协议 / 隐私政策。看哪一份由 `dialogPayload.doc` 决定（`'terms' | 'privacy'`） */
  | 'legal'
  | null

/** 一个正在跑的长任务的进度快照（会同步到任务栏） */
export interface TaskProgress {
  /** 归属者标识：识别 = `recognize`，模型下载 = `model-download` */
  owner: string
  /** 0–100 */
  percent: number
  label: string
}

/** 长任务归属者的固定标识。写死在这里，避免各处手拼字符串写错 */
export const TASK_RECOGNIZE = 'recognize'
export const TASK_MODEL_DOWNLOAD = 'model-download'

/**
 * 「开始识别」按钮飞向底部进度条的飞行时长（毫秒）。
 *
 * 取 `--dur-slow` 那一档（460ms）。它是**唯一**一处跨元素的空间指引动画：
 * 进度条在界面最底部、只有 3px 高，第一次用的人根本不知道点完按钮要去哪看。
 * 这条动画的作用就是把「进度条在下面」这句话用位置讲出来，不是装饰。
 *
 * 落地后的收尾短促一拍单独定义，见 FLIGHT_SETTLE_MS。
 */
export const FLIGHT_MS = 460
/** 圆点落到进度条上之后「吸入」的收尾时长 */
export const FLIGHT_SETTLE_MS = 120

/**
 * 一次「开始识别 → 进度条」的飞行指示。
 *
 * 为什么必须放 store：起点在 HomeView 页脚的按钮、终点在 AppStatusBar 的中栏、
 * 动画本体挂在 App.vue 的 Teleport 上 —— 三处各拿一个局部变量根本串不起来；
 * 而且用户可能在这 460ms 里切页，局部变量会随着组件卸载一起消失。
 */
export interface TaskFlight {
  /** 按钮的视口矩形，飞行起点取它的中心 */
  from: { x: number; y: number; width: number; height: number }
  /** 触发时刻（`Date.now()`），用于边界兜底与探针断言 */
  at: number
}

export const useUiStore = defineStore('ui', () => {
  const currentView = ref<ViewKey>('home')
  const sidebarCollapsed = ref(false)
  const toasts = ref<ToastItem[]>([])
  const dialog = ref<DialogKey>(null)
  /** 弹窗附加上下文，例如不支持格式的文件名列表 */
  const dialogPayload = ref<Record<string, unknown>>({})
  /**
   * 跳转到设置页时希望滚动到的锚点（目标元素的 id）。
   *
   * 模型管理页的「模型存储位置」入口靠它把用户直接送到设置页对应章节；
   * 设置页是 KeepAlive 缓存的，切回来不会重新挂载，所以只能用一个状态来触发滚动。
   */
  const settingsAnchor = ref<string | null>(null)
  /**
   * 设置页当前所在的分组（左侧二级菜单）。
   *
   * 只存内存不写盘：会话内来回切页要停在上次那一组（调完字幕规格去看效果、
   * 再回来不用重新点），但重开软件回到第一组更符合预期 —— 用户往往是从
   * 头到尾扫一遍，而不是接着上次的位置。
   *
   * 放 store 而不是组件本地，是因为深链（模型页 → 模型存储位置）需要在
   * 激活之前就指定分组，组件那时还没渲染。
   */
  const settingsGroup = ref<string>('appearance')
  /**
   * AI 辅助窗口是否开着。
   *
   * 它存在期间主界面会被压暗并拦截交互 —— 「复制提示词 → 去网页 AI → 贴回来」
   * 是一条必须走完的流程，中途回主界面点别的按钮只会让两边状态对不上
   * （最典型的就是再点一次入口，把辅助窗口的数据整个重置掉）。
   */
  const assistActive = ref(false)
  /**
   * 录音窗口是否开着。语义与 `assistActive` 完全一致（压暗 + 拦交互 + 关窗解锁），
   * 只是文案不同。分开两个标志而不是共用一个：两个窗口可能先后打开，
   * 共用一个的话先关的那个会把后开的锁一起解掉。
   */
  const recordActive = ref(false)
  /**
   * 「AI 校对」引导气泡这一次运行里被关掉了。
   *
   * 只存内存、不写盘：气泡上的「×」语义是「这次别挡我」，用户下次打开软件
   * 仍然该看到一次提示（那是它的价值）；而「不再提示」是写进设置里的永久决定。
   * 两者必须分开存，否则「×」就变成了永久关闭 —— 那等于把两个按钮做成一个。
   */
  const aiTipClosed = ref(false)
  /** 「开始识别」按钮飞向进度条的一次性指示；null = 没有在飞 */
  const taskFlight = ref<TaskFlight | null>(null)

  /**
   * 长任务进度。做成「栈」而不是单一变量。
   *
   * 起因：模型下载几百 MB 要跑几分钟，用户完全可能中途切去识别 —— 两个长任务
   * 会同时存在。若只留一个槽位，先结束的那个随手清一次，就把还在跑的另一个的
   * 进度一起抹掉了，界面上表现为「进度条突然没了，但事情还在跑」，比一直没有
   * 进度条更让人不安。
   *
   * 规则：**后开始的压栈顶**（最新发生的任务最相关），结束时弹掉并自动回退到
   * 下面那个还没结束的任务；只有栈空了才真正清除任务栏进度。
   */
  const taskStack = ref<string[]>([])
  const taskByOwner = reactive<Record<string, { percent: number; label: string }>>({})

  const taskProgress = computed<TaskProgress | null>(() => {
    const owner = taskStack.value[taskStack.value.length - 1]
    if (!owner) return null
    const task = taskByOwner[owner]
    return task ? { owner, percent: task.percent, label: task.label } : null
  })

  function beginTask(owner: string, label: string): void {
    taskByOwner[owner] = { percent: 0, label }
    taskStack.value = [...taskStack.value.filter((o) => o !== owner), owner]
  }

  /**
   * 这个任务是否已经在跑。
   *
   * 上报方靠它区分「开始」与「更新」—— 不能拿「栈顶是不是我」来判断：
   * 栈顶可能已经是后开始的另一个任务，那时重新 begin 会把人家挤下去。
   */
  function hasTask(owner: string): boolean {
    return taskByOwner[owner] !== undefined
  }

  function updateTask(owner: string, percent: number, label?: string): void {
    const task = taskByOwner[owner]
    if (!task) return
    task.percent = Math.min(100, Math.max(0, percent))
    if (label) task.label = label
  }

  function endTask(owner: string): void {
    if (!taskByOwner[owner]) return
    delete taskByOwner[owner]
    taskStack.value = taskStack.value.filter((o) => o !== owner)
  }

  /**
   * 长任务跑完，提醒用户回来看一眼。
   *
   * 真正闪不闪由主进程定：窗口就在用户眼前时闪烁纯属噪音（用户已经看到了），
   * 只有窗口被盖住或最小化时才闪 —— 那正是「最小化后完全失联」的另一半：
   * 不只要看得到进度，还得知道已经好了。
   */
  function flashTaskBar(): void {
    try {
      window.xbaos?.app?.flash?.()
    } catch {
      /* 浏览器预览没有桥 */
    }
  }

  function navigate(view: ViewKey, anchor?: string): void {
    currentView.value = view
    settingsAnchor.value = anchor ?? null
  }

  function openDialog(key: Exclude<DialogKey, null>, payload: Record<string, unknown> = {}): void {
    dialogPayload.value = payload
    dialog.value = key
  }

  function closeDialog(): void {
    dialog.value = null
    dialogPayload.value = {}
  }

  function setAssistActive(value: boolean): void {
    assistActive.value = value
  }

  function setRecordActive(value: boolean): void {
    recordActive.value = value
  }

  /**
   * 点亮一次飞行指示。`rect` 是「开始识别」按钮的视口矩形。
   *
   * 调用点（HomeView.start）在按钮自己的 click 处理里，能直接拿到
   * `event.currentTarget.getBoundingClientRect()` —— 比起事后 querySelector 找按钮，
   * 这样在按钮结构变化时不会悄悄指错元素。
   */
  function beginTaskFlight(rect: { x: number; y: number; width: number; height: number }): void {
    taskFlight.value = { from: { ...rect }, at: Date.now() }
  }

  /** 飞行收尾（含吸入动画）之后调用，让进度行淡入 */
  function endTaskFlight(): void {
    taskFlight.value = null
  }

  function notify(type: ToastType, title: string, message?: string): string {
    const id = uid('toast')
    toasts.value.push({ id, type, title, message })
    window.setTimeout(() => dismissToast(id), type === 'error' ? 7000 : 4200)
    return id
  }

  function dismissToast(id: string): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return {
    currentView,
    sidebarCollapsed,
    toasts,
    dialog,
    dialogPayload,
    settingsAnchor,
    settingsGroup,
    assistActive,
    recordActive,
    aiTipClosed,
    taskFlight,
    taskProgress,
    navigate,
    openDialog,
    closeDialog,
    setAssistActive,
    setRecordActive,
    beginTaskFlight,
    endTaskFlight,
    beginTask,
    updateTask,
    endTask,
    hasTask,
    flashTaskBar,
    notify,
    dismissToast,
  }
})
