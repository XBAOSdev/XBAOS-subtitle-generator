import type { XbaosBridge } from './engine'

declare global {
  interface Window {
    /**
     * Electron 主进程通过 preload 注入的接口。
     * 用浏览器直接预览（`npm run dev:ui`）时为 undefined，
     * 因此所有调用点都必须先判断存在性 —— 这也是前端能脱离
     * Electron 独立预览的前提。
     */
    xbaos?: XbaosBridge
  }
}

export {}
