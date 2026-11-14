import { onMounted, onUnmounted } from 'vue'

/**
 * 标题栏交给系统之后要做的一件事：把符号色报上去。
 *
 * Windows 上三个窗口按钮由系统绘制（Window Controls Overlay），界面因此
 * ① 不再自绘那三个按钮，② 主题一变就得把 `symbolColor` 报给主进程 ——
 * 系统按钮不认识我们的 CSS 变量。三个窗口（主窗口、AI 窗口、录制窗口）都要做，
 * 各写一遍必漏，收在这里。
 *
 * 只报符号色：按钮区的底色恒为全透明，页面底色与毛玻璃材质自己透上来 ——
 * 这是保留了材质观感的唯一做法（改成不透明同色时，毛玻璃下按钮区会是一块实心色块）。
 *
 * 读 `data-theme` 与 `class` 的变化而不是在各个切换入口补调用：主题的切换路径
 * 不止一条（按钮循环、设置页、跟随系统时系统改外观），毛玻璃也走 class，
 * 盯属性最不容易漏。
 */
export function useNativeChrome(): { nativeChrome: boolean } {
  const nativeChrome = !!window.xbaos?.window?.nativeChrome
  let observer: MutationObserver | undefined

  function sync(): void {
    if (!nativeChrome) return
    const api = window.xbaos?.window
    if (!api?.setOverlay) return
    const symbolColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-text-primary')
      .trim()
    api.setOverlay({ symbolColor: symbolColor || '#1f1f1f' })
  }

  onMounted(() => {
    observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    })
    sync()
  })

  onUnmounted(() => observer?.disconnect())

  return { nativeChrome }
}
