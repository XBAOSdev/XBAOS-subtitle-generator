import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

// 版本号**唯一的真相源**就是 package.json。构建期把它注入成编译常量 __APP_VERSION__，
// 供「浏览器预览」场景兜底（那时没有 Electron，读不到 preload 注入的 xbaos.appVersion）。
// 打包后的 exe 里优先用 app.getVersion()，两条路最终都指回 package.json。
const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

// 端口允许用环境变量覆盖，给「5173 被别的进程占着」留一条退路。
// 必须在这里读，而不是只在启动器里读 —— 真正的监听端口由这份配置决定，
// 启动器改的只是「去哪个地址等」，两边不一致就会变成：
// 启动器以为要等 5198，Vite 却埋头去抢 5173，报错信息完全对不上。
const DEV_PORT = Number(process.env.XBAOS_DEV_PORT || 5173)

export default defineConfig({
  plugins: [vue()],
  // 版本号编译期常量，构建与开发服务器都注入，见文件顶部说明
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  // Electron 以 file:// 加载打包产物，必须用相对路径
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 显式绑 IPv4。默认的 'localhost' 在 Node 18+ 上可能被解析成 IPv6 的 ::1，
    // 于是只监听 ::1 —— 而 Electron 主进程和两个探针都写死了 127.0.0.1，
    // 连过去就是 ERR_CONNECTION_REFUSED，日志里却只说 "ready"。
    host: '127.0.0.1',
    port: DEV_PORT,
    // 端口被占就直接失败。启动器、探针、Electron 都按同一个端口号对接，
    // 静默换到 5174 只会让它们连到别的东西上，查起来更绕。
    strictPort: true,
    open: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 目标就是 Electron 内置的 Chromium，可以放心用现代特性
    target: 'chrome126',
    assetsInlineLimit: 8192,
  },
})
