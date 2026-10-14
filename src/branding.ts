/**
 * 产品标识集中配置
 * 后续修改软件名、官网只需改这里；**版本号不在这里**，见文件末尾 resolveAppVersion 的说明
 */

export const branding = {
  /** 产品全名（窗口标题、安装包产品名、关于页） */
  productName: 'XBAOS 字幕生成器',
  /** 简称（窄侧栏、任务栏悬浮提示） */
  shortName: '字幕生成器',
  /** 开发者 */
  developer: 'XBAOS',
  /** 本软件官网（官网本身就是这个软件的展示页） */
  website: 'https://subtitle.xbaos.com.cn',
  /** 官网显示文本 */
  websiteLabel: 'subtitle.xbaos.com.cn',
  /** XBAOS 主站：放工作室其他作品 */
  mainSite: 'https://www.xbaos.com.cn',
  mainSiteLabel: 'www.xbaos.com.cn',
  /**
   * 版本清单所在站点。2026-10-14 起**就是软件官网自己**（`/data/subtitle.json`）：
   * 官网页面与软件读同一份清单，版本号只有一处真相源。
   * 安装包放不进官网（Pages 单文件上限 25 MiB，安装包 520MB），
   * 清单里的 `download.url` 指向网盘分享链接，本站不放二进制。
   */
  updateSite: 'https://subtitle.xbaos.com.cn',
  updateSiteLabel: 'subtitle.xbaos.com.cn',
  /** 版权行 */
  copyright: '© 2026 XBAOS',
  /** 安装目录片段 */
  installDirName: 'SubtitleGenerator',
  /** 数据目录 */
  dataDirName: 'XBAOS\\SubtitleGenerator',
} as const

/**
 * 应用版本。真相源只有一个：`package.json` 的 `version`。
 *
 * 这里**不写死字面量**。曾经写死过 `'0.1.0'`，于是改了 package.json 之后
 * 安装包与控制面板显示新版本、侧边栏和关于页还是旧版本，两边对不上。
 *
 * 取值顺序：
 *   1. Electron 运行时：主进程 `app.getVersion()` 经 preload 注入，反映真正在跑的那份
 *   2. 构建期常量 `__APP_VERSION__`：vite.config.ts 从 package.json 注入。
 *      浏览器预览没有 Electron，走这条
 *   3. `'0.0.0'`：脱离 vite 的裸 node 环境（单元测试直接 import 本模块时）
 */
function resolveAppVersion(): string {
  const injected = typeof window === 'undefined' ? '' : window.xbaos?.appVersion
  if (typeof injected === 'string' && injected !== '') return injected
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
}

export const appVersion = resolveAppVersion()
