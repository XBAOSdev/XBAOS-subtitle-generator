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
 * ---------------------------------------------------------------------------
 * 2026-11-11 重写定位：三个「会把滑块画歪」的来源
 *
 * ① `offsetLeft` / `offsetWidth` 是**整数**。Windows 上 125% / 150% 缩放时
 *    按钮的真实边界落在半像素上（49.6px），逐个四舍五入之后，右边缘能差出
 *    1~2 个物理像素；指示块的底色与内描边是紧贴按钮边缘画的，差一点就能看出来。
 *    改用 `getBoundingClientRect()` 的浮点差值。
 *
 * ② 换算基准必须是**内边距盒**。绝对定位的 `left` 从边框以里算起，而两块 rect
 *    的差值是从边框外沿算起 —— 不减 `clientLeft` / `clientTop`，整个块就固定
 *    偏出去 1px（边框宽度）。平时不明显，一旦容器边框变粗（选中态、浅色主题）
 *    就露馅。
 *
 * ③ 只盯容器尺寸是不够的。文案从「未选择」变成「已选 12 条」并不会改变容器的
 *    盒子，但它会把容器连同指示块一起推走 —— 这没问题；真正出问题的是**按钮
 *    自己变宽**（字重从中等变半粗、标签从「双语」换成「仅译文」）而容器总宽
 *    恰好不变的时候，容器尺寸没变、指示块也就不会重新量。所以每个按钮都要
 *    单独观察，外加字体加载完成后补一次。
 */
const THUMB_CLASS = 'seg-thumb'

type Holder = HTMLElement & {
  __segThumb?: HTMLElement
  __segMo?: MutationObserver
  __segRo?: ResizeObserver
}

/**
 * 把指示块摆到选中项上。
 *
 * `animate = false` 用于首帧与字体切换：先写位置再撤掉「不动画」标记，
 * 中间强制一次 reflow，避免从 (0,0) 飞过来。
 */
function position(el: Holder, thumb: HTMLElement, animate: boolean): void {
  const active = el.querySelector<HTMLElement>(':scope > .is-active')
  if (!active) {
    thumb.style.opacity = '0'
    return
  }
  thumb.style.opacity = '1'
  if (!animate) thumb.classList.add(`${THUMB_CLASS}--jump`)

  const box = el.getBoundingClientRect()
  const rect = active.getBoundingClientRect()
  // clientLeft / clientTop 就是这里那一圈边框：rect 差值以边框外沿为 0，
  // 而绝对定位以内边距盒为 0，两者差的正是它
  const left = rect.left - box.left - el.clientLeft
  const top = rect.top - box.top - el.clientTop
  thumb.style.left = `${left}px`
  thumb.style.top = `${top}px`
  thumb.style.width = `${rect.width}px`
  thumb.style.height = `${rect.height}px`

  if (!animate) {
    void thumb.offsetWidth
    thumb.classList.remove(`${THUMB_CLASS}--jump`)
  }
}

export const segThumb: Directive<Holder> = {
  mounted(el) {
    const thumb = document.createElement('span')
    thumb.className = THUMB_CLASS
    thumb.setAttribute('aria-hidden', 'true')
    // 指示块要绝对定位于容器；容器是 static 的话补上（不影响现有布局）
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    el.prepend(thumb)

    /** 同步量一次：首帧不能等 rAF（窗口隐藏时它永远不来） */
    const measure = (animate: boolean): void => {
      position(el, thumb, animate)
    }
    el.__segThumb = thumb

    measure(false)

    /*
     * 每个子项各观察一份。
     *
     * `childList` 会跟着 v-for 的重建变，所以每次结构变动都重新对一遍表：
     * 新出现的按钮补上观察，消失的解除（不解除会一直握着一堆死节点）。
     *
     * 回调里直接量、不经 rAF：ResizeObserver 本身就是每帧批量回调一次，
     * 而指示块是绝对定位的、不参与被观察元素的尺寸计算，量完改样式不会把
     * 自己再触发一轮（那才会报 "loop completed with undelivered notifications"）。
     */
    const ro = new ResizeObserver(() => measure(true))
    const watched = new Set<Element>()
    const sync = (): void => {
      for (const node of [...watched]) {
        if (!el.contains(node)) {
          ro.unobserve(node)
          watched.delete(node)
        }
      }
      for (const node of el.children) {
        if (node === thumb || watched.has(node)) continue
        ro.observe(node)
        watched.add(node)
      }
    }
    sync()
    ro.observe(el)
    el.__segRo = ro

    const mo = new MutationObserver(() => {
      sync()
      // class 变化 = 选中项变了，要滑动过去；结构变化只是补观察，直接量即可
      measure(true)
    })
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    el.__segMo = mo

    /*
     * 字体替换会改变标签宽度。
     *
     * 内嵌的思源黑体是异步就绪的，首帧量到的宽度是按系统字体算的 —— 交换那一
     * 瞬间按钮宽度就变了，而容器的总宽未必跟着变（三档标签宽度可能刚好相抵）。
     */
    void document.fonts?.ready.then(() => measure(true))
  },
  unmounted(el) {
    el.__segMo?.disconnect()
    el.__segRo?.disconnect()
    el.__segThumb?.remove()
    el.__segMo = undefined
    el.__segRo = undefined
    el.__segThumb = undefined
  },
}
