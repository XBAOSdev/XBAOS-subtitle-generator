import type { Directive } from 'vue'

/**
 * 分段控件的「滑动指示块」。
 *
 * 用法：`<div class="seg" v-seg-thumb><button :class="{'is-active': ...}">…</button></div>`
 *
 * 为什么做成指令而不是组件：这软件里分段控件有四种长相（设置页 40px 高、
 * 导入页 28px、字幕表 20px、录音窗口 30px），共享的是「选中标记会滑动」
 * 这一件事，不是尺寸与文案。指令不动模板结构，只在容器里塞一个绝对定位的
 * 指示块，把「选中格的底色 + 内描边 + 投影」从按钮身上挪到它身上 ——
 * 切换时指示块滑过去，按钮自己只变文字颜色与字重。
 *
 * 指示块的样式在 `global.css`（指令创建的元素没有 scoped data 属性，
 * 组件内的 scoped 样式罩不到它）。
 *
 * 监听用的是 MutationObserver 而不是 props 回调：指令拿不到组件的状态，
 * class 变化本身就是「状态变了」的信号，对任何组件都成立。
 */

const THUMB_CLASS = 'seg-thumb'

function position(el: HTMLElement, thumb: HTMLElement, animate: boolean): void {
  const active = el.querySelector<HTMLElement>(':scope > .is-active')
  if (!active) {
    thumb.style.opacity = '0'
    return
  }
  thumb.style.opacity = '1'
  if (!animate) thumb.classList.add(`${THUMB_CLASS}--jump`)
  thumb.style.left = `${active.offsetLeft}px`
  thumb.style.top = `${active.offsetTop}px`
  thumb.style.width = `${active.offsetWidth}px`
  thumb.style.height = `${active.offsetHeight}px`
  if (!animate) {
    // 先写入位置再撤掉「不动画」标记：中间这一帧强制 reflow，
    // 保证首帧定位不平滑滑动（页面刚打开时滑块从 (0,0) 飞过来很滑稽）
    void thumb.offsetWidth
    thumb.classList.remove(`${THUMB_CLASS}--jump`)
  }
}

type Holder = HTMLElement & {
  __segThumb?: HTMLElement
  __segMo?: MutationObserver
  __segRo?: ResizeObserver
  __segUpdate?: () => void
}

export const segThumb: Directive<HTMLElement> = {
  mounted(el: Holder) {
    const thumb = document.createElement('span')
    thumb.className = THUMB_CLASS
    thumb.setAttribute('aria-hidden', 'true')
    // 指示块要绝对定位于容器；容器是 static 的话补上（不影响现有布局）
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    el.prepend(thumb)

    const update = () => position(el, thumb, true)
    el.__segThumb = thumb
    el.__segUpdate = update

    // 挂载后先无动画摆到位：此时字体还没加载完的话宽度可能略偏，
    // ResizeObserver 会在容器尺寸变化时再校一次
    requestAnimationFrame(() => position(el, thumb, false))

    const mo = new MutationObserver(() => update())
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    const ro = new ResizeObserver(() => update())
    ro.observe(el)
    el.__segMo = mo
    el.__segRo = ro
  },
  unmounted(el: Holder) {
    el.__segMo?.disconnect()
    el.__segRo?.disconnect()
    el.__segThumb?.remove()
    el.__segMo = undefined
    el.__segRo = undefined
    el.__segThumb = undefined
    el.__segUpdate = undefined
  },
}
