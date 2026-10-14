/**
 * 会覆盖已有内容之前的确认。
 *
 * 走系统原生对话框而不是自绘浮层：这类提醒必须**模态且抢焦点**。用户的注意力
 * 此刻往往在别的窗口（AI 助手的网页）上，应用内的浮层会被整个盖住，等于没提醒。
 *
 * 浏览器预览没有桥，退回 `window.confirm` —— 只在开发预览里走到，逻辑仍然完整。
 */
export interface DestructiveConfirm {
  /** 标题，一句话说清「会发生什么」 */
  title: string
  /** 主文案：后果 */
  message: string
  /** 补充说明：怎么撤回、有没有别的出路 */
  detail?: string
  /** 确认按钮的文字。用动词而不是「确定」，让人看清自己点的是什么 */
  confirmLabel: string
}

export async function confirmDestructive(options: DestructiveConfirm): Promise<boolean> {
  const bridge = window.xbaos
  if (bridge?.dialog?.confirm) {
    const index = await bridge.dialog.confirm({
      type: 'warning',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [options.confirmLabel, '取消'],
      // 默认落在「取消」上：这是一个会丢内容的岔路口，不该顺手回车就过
      defaultId: 1,
      cancelId: 1,
    })
    return index === 0
  }

  const text = [options.message, options.detail].filter(Boolean).join('\n\n')
  return window.confirm(text)
}

export interface BlockedNotice {
  /** 标题，一句话说清「为什么不行」 */
  title: string
  /** 主文案：被拒绝的是什么操作 */
  message: string
  /** 补充说明：怎么才能做成 */
  detail?: string
}

/**
 * 告知用户「这个操作不被允许」，并且这次操作已经被放弃。
 *
 * 与 `confirmDestructive` 的区别：那个是**岔路口**（继续 / 取消，默认落在取消），
 * 这个是**死路**（只有一个「知道了」）。分开写是为了不把「你确定吗」的语义
 * 混进「这样不行」里 —— 前者给选择，后者不给。
 *
 * 同样走系统原生对话框：拒绝理由必须真的被看到，应用内浮层会被用户正在看
 * 的别的窗口整个盖住。
 */
export async function noticeBlocked(options: BlockedNotice): Promise<void> {
  const bridge = window.xbaos
  if (bridge?.dialog?.confirm) {
    await bridge.dialog.confirm({
      type: 'warning',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: ['知道了'],
      defaultId: 0,
      cancelId: 0,
    })
    return
  }

  const text = [options.message, options.detail].filter(Boolean).join('\n\n')
  window.alert(text)
}
