import { onMounted, onUnmounted } from 'vue'

/**
 * 标题栏交给系统之后要做的两件事。
 *
 * Windows 上三个窗口按钮由系统绘制（Window Controls Overlay），界面因此
 * ① 不再自绘那三个按钮，② 主题一变就得把符号色报给主进程 —— 系统按钮
 * 不认识我们的 CSS 变量。三个窗口（主窗口、AI 窗口、录制窗口）都要做，
 * 各写一遍必漏，收在这里。
 *
 * 读 `data-theme` 的属性变化而不是在各个切换入口补调用：主题的切换路径
 * 不止一条（按钮循环、设置页、跟随系统时系统改外观），盯属性最不容易漏。
 */
export function useNativeChrome(): { nativeChrome: boolean } {
  const nativeChrome = !!window.xbaos?.window?.nativeChrome
  let observer: MutationObserver | undefined

  function sync(): void {
    if (!nativeChrome) return
    const api = window.xbaos?.window
    if (!api?.setOverlay) return
    const color = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-text-primary')
      .trim()
    if (color) api.setOverlay({ symbolColor: color })
  }

  onMounted(() => {
    observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    sync()
  })

  onUnmounted(() => observer?.disconnect())

  return { nativeChrome }
}
