/// <reference types="vite/client" />

/**
 * 构建期注入的版本号，值取自 package.json 的 `version`（见 vite.config.ts 的 define）。
 * 浏览器预览（`npm run dev:ui`）没有 Electron 注入的 `xbaos.appVersion`，靠它兜底。
 */
declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.woff2' {
  const src: string
  export default src
}
