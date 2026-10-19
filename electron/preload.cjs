/**
 * Preload 桥。
 *
 * 渲染进程开了 contextIsolation + sandbox，拿不到 Node。这里显式列出
 * 允许渲染进程调用的能力，是一条白名单 —— 新增能力必须写在这里，
 * 不允许用通用的 `ipcRenderer.invoke(任意 channel)` 兜底，否则等于把 IPC 全开放。
 *
 * 注意：本文件必须是 CommonJS（沙箱化的 preload 不支持 ESM），
 * 所以用 `.cjs` 后缀，不受 package.json 的 "type": "module" 影响。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** 把事件订阅包成「返回取消函数」的形式，组件卸载时好清理 */
function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/**
 * 关于「参数纯化」——这里**故意不做**，原因值得记一笔：
 *
 * contextBridge 在参数从主世界跨进 preload 隔离世界时就会做一次结构化克隆。
 * Vue 的响应式代理（`reactive()` / `ref()` 返回的都是 Proxy）在那一步就被拒收，
 * 抛 `An object could not be cloned.` —— **此时本文件里的任何代码都还没开始执行**，
 * 所以「在 preload 里兜底纯化」是不可能的，写了也是死代码。
 *
 * 结论：纯化是**渲染层的责任**，统一走 `src/utils/plain.ts` 的 `toPlain()`。
 * 漏了会直接抛错而不是静默失败，调用点必须 catch 并给出可见反馈。
 */

/** 版本号由主进程通过 additionalArguments 注入（渲染进程在 file:// 下读不到 package.json） */
const versionArg = process.argv.find((a) => a.startsWith('--xbaos-version='))
const injectedVersion = versionArg ? versionArg.split('=')[1] : ''

/**
 * 首屏主题。主进程在开窗前按「用户上次选择的外观」算好传进来（`light` / `dark` /
 * 空串表示不确定）。渲染进程在**首帧之前**拿它定 `data-theme`，避免
 * 「固定浅色 + 系统深色」时先闪一下深色底。
 */
const themeArg = process.argv.find((a) => a.startsWith('--xbaos-theme='))
const rawTheme = themeArg ? themeArg.split('=')[1] : ''
const injectedTheme = rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : ''

/**
 * 首屏毛玻璃。主进程在开窗前按「用户偏好 + 系统是否支持」算好传进来，
 * 渲染进程在**首帧之前**拿它决定要不要把自己的底色透明化 ——
 * 页面不透明的话，Mica 材质会被完全盖住。
 */
const glassArg = process.argv.find((a) => a.startsWith('--xbaos-glass='))
const injectedGlass = glassArg ? glassArg.split('=')[1] === '1' : false

contextBridge.exposeInMainWorld('xbaos', {
  isElectron: true,
  platform: process.platform,
  appVersion: injectedVersion,

  // ---- 应用信息与主题
  info: () => ipcRenderer.invoke('app:info'),
  onThemeChange: (cb) => subscribe('app:theme', cb),

  /**
   * 应用级行为：任务栏进度、关窗确认、首屏主题。
   *
   * 关窗走「主进程请求 → 渲染进程裁决」，因为「有没有未保存的内容」只有渲染
   * 进程知道。主进程侧还有 4 秒看门狗，渲染进程卡死时不会把窗口锁住。
   */
  app: {
    /** 任务栏进度：0–1，-1 表示清除（识别、模型下载时用） */
    setProgress: (value) => ipcRenderer.send('app:progress', value),
    /** 长任务跑完时请求提醒；窗口在前台时主进程会忽略 */
    flash: () => ipcRenderer.send('app:flash'),
    /** 收到关窗请求：算完有没有未保存内容再回话 */
    onCloseRequest: (cb) => subscribe('app:close-request', cb),
    /** 已收到请求（主进程据此撤掉看门狗） */
    ackCloseRequest: () => ipcRenderer.send('app:close-ack'),
    /** 放行：真的关掉窗口 */
    forceClose: () => ipcRenderer.send('app:force-close'),
  },

  theme: {
    /** 主进程按「上次选择的外观」预算出的首屏主题，用于首帧前定底色 */
    initial: injectedTheme,
    /** 外观设置变化时同步给主进程（下次启动的首屏底色按它算） */
    persist: (mode) => ipcRenderer.send('app:set-theme-mode', mode),
  },

  /** 标题栏毛玻璃（Mica）。设置真相源在渲染进程，这里只做同步与状态回推 */
  glass: {
    /** 主进程按「偏好 + 系统支持」预算出的首屏状态，用于首帧前透明化 */
    initial: injectedGlass,
    /** 开关变化时同步给主进程：存副本 + 即时切换窗口材质 */
    setEnabled: (enabled) => ipcRenderer.send('app:set-glass', !!enabled),
    /** 主进程回推实际生效状态（不支持的环境上开关开着也不生效） */
    onState: (cb) => subscribe('app:glass', cb),
  },

  // ---- 窗口控制
  window: {
    control: (action) => ipcRenderer.send('window:control', action),
    onStateChange: (cb) => subscribe('window:state', cb),
  },

  /**
   * 取拖放进来的文件的真实路径。
   * Electron 32 起 `File.path` 已被移除，只能用 webUtils —— 这是官方唯一途径。
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  // ---- 系统对话框
  dialog: {
    pickAudio: () => ipcRenderer.invoke('dialog:pickAudio'),
    pickSubtitle: () => ipcRenderer.invoke('dialog:pickSubtitle'),
    pickDirectory: (options) => ipcRenderer.invoke('dialog:pickDirectory', options),
    saveSubtitle: (options) => ipcRenderer.invoke('dialog:saveSubtitle', options),
    confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  },

  // ---- 文件系统（受限：只暴露这几个操作）
  fs: {
    exists: (p) => ipcRenderer.invoke('fs:exists', p),
    stat: (p) => ipcRenderer.invoke('fs:stat', p),
    readText: (p) => ipcRenderer.invoke('fs:readText', p),
    /** 编码自适应读取（BOM / UTF-8 / GBK），返回 { text, encoding } */
    readTextAuto: (p) => ipcRenderer.invoke('fs:readTextAuto', p),
    readArrayBuffer: (p) => ipcRenderer.invoke('fs:readArrayBuffer', p),
    writeText: (p, content) => ipcRenderer.invoke('fs:writeText', p, content),
    writeSubtitle: (p, content, encoding) =>
      ipcRenderer.invoke('fs:writeSubtitle', p, content, encoding),
    reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
    openPath: (p) => ipcRenderer.invoke('fs:openPath', p),
    basename: (p) => ipcRenderer.invoke('fs:basename', p),
    dirname: (p) => ipcRenderer.invoke('fs:dirname', p),
  },

  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
    /** 读取剪贴板文本：AI 校对把用户从网页版复制的结果接回来 */
    readText: () => ipcRenderer.invoke('clipboard:readText'),
  },

  // ---- AI 校对辅助窗口
  // 走「剪贴板中转」：软件本身不联网，提示词由用户手工粘贴到网页版 AI，
  // 结果再由用户复制回来。这里只负责开窗、置顶、读写剪贴板与中转数据。
  assist: {
    /** 打开辅助窗口。payload: { targets: [{ fileId, fileName, durationSec, segments }], settings } */
    open: (payload) => ipcRenderer.invoke('assist:open', payload),
    /** 辅助窗口侧：取回主窗口交过来的数据 */
    payload: () => ipcRenderer.invoke('assist:payload'),
    setAlwaysOnTop: (value) => ipcRenderer.invoke('assist:setAlwaysOnTop', value),
    isAlwaysOnTop: () => ipcRenderer.invoke('assist:isAlwaysOnTop'),
    /** 辅助窗口侧：提交校对结果，由主进程转给主窗口 */
    submit: (payload) => ipcRenderer.send('assist:submit', payload),
    /** 关闭辅助窗口（辅助窗口自己收尾、或主窗口应用完结果后调用） */
    close: () => ipcRenderer.send('assist:close'),
    /** 主窗口侧：把被别的窗口盖住的辅助窗口重新拉到最前 */
    focus: () => ipcRenderer.invoke('assist:focus'),
    /** 主窗口侧：接收辅助窗口提交的结果 */
    onResult: (cb) => subscribe('assist:result', cb),
    /** 主窗口侧：辅助窗口已关闭（主界面据此解除压暗） */
    onClosed: (cb) => subscribe('assist:closed', cb),
    /** 辅助窗口侧：窗口被重复打开时重新取一次数据 */
    onRefresh: (cb) => subscribe('assist:refresh', cb),
  },

  // ---- 录制音频窗口
  // 采集本身（getDisplayMedia / getUserMedia / Web Audio）全在渲染进程里做，
  // 这里只负责开窗、关窗裁决、以及把编好的 WAV 交给主进程写盘。
  // 系统声音之所以不用弹选择框，靠的是主进程侧的 setDisplayMediaRequestHandler。
  record: {
    /** 主窗口侧：打开录音窗口 */
    open: () => ipcRenderer.invoke('record:open'),
    /** 主窗口侧：把被别的窗口盖住的录音窗口重新拉到最前 */
    focus: () => ipcRenderer.invoke('record:focus'),
    close: () => ipcRenderer.send('record:close'),
    /** 录制中或有未保存编辑时，让用户在**原生**确认框里裁决（不用应用内浮层） */
    confirmDiscard: (options) => ipcRenderer.invoke('record:confirmDiscard', options),
    /** 录音窗口侧：收到关窗请求，算完再回话 */
    onCloseRequest: (cb) => subscribe('record:close-request', cb),
    /** 已收到请求（主进程据此撤掉看门狗） */
    ackCloseRequest: () => ipcRenderer.send('record:close-ack'),
    /** 放行：真的关掉窗口 */
    forceClose: () => ipcRenderer.send('record:force-close'),
    /** 保存 WAV。payload: { data: Uint8Array, defaultName? }，返回落盘路径或 null（取消） */
    save: (payload) => ipcRenderer.invoke('record:save', payload),
    /**
     * 录音窗口侧：把落盘路径交给主进程转发给主窗口入队。
     *
     * **不能由录音窗口自己入队**：两个窗口是两个渲染进程，Pinia store 不共享，
     * 在这里 addFiles 只会加进它自己那份空工程，窗口一关就没了。
     */
    submit: (filePath) => ipcRenderer.send('record:submit', filePath),
    /** 主窗口侧：收到录音窗口保存的文件路径 */
    onSaved: (cb) => subscribe('record:saved', cb),
    /** 主窗口侧：录音窗口已关闭（主界面据此解除压暗） */
    onClosed: (cb) => subscribe('record:closed', cb),
  },

  // ---- 模型管理
  models: {
    /** 可下载模型的目录（key / file / sizeLabel） */
    catalog: () => ipcRenderer.invoke('model:catalog'),
    download: (key) => ipcRenderer.invoke('model:download', key),
    cancelDownload: (key) => ipcRenderer.invoke('model:downloadCancel', key),
    /** 删除用户模型目录中的文件，只接受纯文件名 */
    remove: (fileName) => ipcRenderer.invoke('model:delete', fileName),
    /** 当前模型存储位置 { dir, defaultDir, custom } */
    getDir: () => ipcRenderer.invoke('model:getDir'),
    /** 设置自定义目录（会真写一个探针文件验证可写）。传空串恢复默认 */
    setDir: (dir) => ipcRenderer.invoke('model:setDir', dir),
    /** 在系统文件管理器里打开模型文件夹 */
    openDir: () => ipcRenderer.invoke('model:openDir'),
    /**
     * 这次实际会用哪个模型 `{ name, path, source } | null`。
     * 传设置里的文件名；失效时主进程会告诉你回退到了哪个 ——
     * 界面据此标「使用中」，不要拿文件名自己比。
     */
    resolve: (file) => ipcRenderer.invoke('models:resolve', file),
    /** 下载进度事件：{ key, status, received, total, percent, message? } */
    onProgress: (cb) => subscribe('model:download:progress', cb),
  },

  // ---- 更新检查
  // 只读一份 JSON 清单比版本号，**不下载、不安装、不替换文件**。
  // 联网这件事被收在主进程里：渲染进程在 file:// 沙箱下既没有网络能力，
  // 也不该有。
  update: {
    /** 读清单并比版本。永不 reject，失败信息在返回值里 */
    check: () => ipcRenderer.invoke('update:check'),
    /** 用系统默认浏览器打开外部链接（主进程只放行 https） */
    openUrl: (url) => ipcRenderer.invoke('update:openUrl', url),
  },

  // ---- 识别引擎
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    load: (opts) => ipcRenderer.invoke('engine:load', opts),
    unload: () => ipcRenderer.invoke('engine:unload'),
    transcribe: (opts) => ipcRenderer.invoke('engine:transcribe', opts),
    abort: () => ipcRenderer.invoke('engine:abort'),
    /** 流式进度与字幕段。payload: { taskId, msg }，taskId 为 null 表示全局消息（如后端回退） */
    onStream: (cb) => subscribe('engine:stream', cb),
    /** 引擎的 stderr 日志 */
    onLog: (cb) => subscribe('engine:log', cb),
    /** 引擎进程退出（异常退出时界面要提示可重试） */
    onExit: (cb) => subscribe('engine:exit', cb),
  },

  // ---- 诊断
  //
  // 用户报错时没法要求他去翻事件查看器，这里一键把现场收成文件：
  // 环境摘要、引擎状态与最近退出码、Vulkan 全局层清单、引擎日志尾部。
  diag: {
    export: () => ipcRenderer.invoke('diag:export'),
  },
})
