import { createApp } from 'vue'
import { createPinia } from 'pinia'

import './styles/tokens.css'
import './styles/theme-light.css'
import './styles/theme-dark.css'
import './styles/global.css'

import App from './App.vue'
import { segThumb } from './directives/segThumb'

/**
 * 首帧之前先把主题定下来。
 *
 * `index.html` 里那句 inline 样式只是兜底（写死深色 + 一条 prefers-color-scheme
 * 媒体查询），它没法知道用户在设置里固定了哪种外观。当用户「固定浅色」而系统是
 * 深色时，光靠它就会先铺一层深色再被 Vue 改成浅色 —— 一次可见的闪烁。
 *
 * 主进程在开窗前算好真实主题并从启动参数带进来，这里在挂载前无条件应用。
 * 之后 `settings` store 初始化时还会再应用一次（那时 auto 模式要交回媒体查询），
 * 两次结果一致，不会互相打架。
 */
const initialTheme = window.xbaos?.theme?.initial
if (initialTheme === 'light' || initialTheme === 'dark') {
  document.documentElement.dataset.theme = initialTheme
}

/**
 * 首帧之前把毛玻璃状态定下来（与上面主题同一个套路）。
 *
 * Mica 是窗口背后的系统材质，页面任何一层铺了不透明底色都会把它盖住 ——
 * 所以必须在挂载前就给 html 挂上 `glass` 类，让 global.css 里的透明化规则
 * 生效。主进程把「用户偏好 + 系统是否支持」合成好的结果从启动参数带进来，
 * 不支持的环境（Win10 / 浏览器预览）这里就是 false，界面保持纯色。
 */
if (window.xbaos?.glass?.initial === true) {
  document.documentElement.classList.add('glass')
}

/**
 * 全局关掉「Ctrl + 滚轮缩放整个界面」。
 *
 * Chromium 默认把 Ctrl+wheel 当页面缩放，而这个软件的界面里 Ctrl+滚轮是
 * **缩放时间轴**（触控板双指捏合在 Chromium 里就是带 ctrlKey 的 wheel）。
 * 不拦的话，用户在时间轴上的一次捏合会同时做两件事：时间轴放大、整个界面
 * 也放大 —— 而且界面缩放会被记下来，下次打开还是怪比例，得按 Ctrl+0 才回去。
 *
 * 必须在 window 的**捕获阶段**拦：元素级的处理器（时间轴自己那个）要在捕获
 * 之后才轮到，而这里只 preventDefault、不 stopPropagation，所以时间轴照常
 * 收到事件并做缩放。
 *
 * 顺带一提，这样也就没有「缩放界面」这个功能了 —— 桌面应用里它本来也只会
 * 被误触。窗口大小由主进程按屏幕算，不需要用户自己缩放。
 */
window.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault()
  },
  { passive: false, capture: true },
)

const app = createApp(App)
// 分段控件的滑动指示块：设置页 / 导入页 / 字幕表 / 录音窗口共用一套
app.directive('seg-thumb', segThumb)
app.use(createPinia()).mount('#app')
