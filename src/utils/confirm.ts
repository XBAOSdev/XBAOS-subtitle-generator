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

export interface CheckboxConfirm extends DestructiveConfirm {
  /** 勾选项文案，例如「只从列表移除（保留磁盘上的 .xbsgp）」 */
  checkboxLabel: string
  /** 默认是否勾上 */
  checkboxChecked?: boolean
}

/**
 * 带勾选项的确认。
 *
 * 用在「同一个按钮有两种后果，其中一种更轻」的地方 —— 例如删项目时可以改成
 * 只把它从列表里移出。**勾选项不改主文案**：主按钮仍描述它默认会做的事，
 * 勾上之后由调用方按 `checked` 走另一条路。
 */
export async function confirmWithOption(
  options: CheckboxConfirm,
): Promise<{ ok: boolean; checked: boolean }> {
  const bridge = window.xbaos
  if (bridge?.dialog?.confirmOption) {
    const res = await bridge.dialog.confirmOption({
      type: 'warning',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [options.confirmLabel, '取消'],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: options.checkboxLabel,
      checkboxChecked: options.checkboxChecked === true,
    })
    return { ok: res.index === 0, checked: res.checked }
  }

  // 浏览器预览没有原生勾选框：先问做不做，再问是不是只移出列表（仅预览路径）
  const text = [options.message, options.detail].filter(Boolean).join('\n\n')
  if (!window.confirm(text)) return { ok: false, checked: false }
  return { ok: true, checked: window.confirm(`${options.checkboxLabel}？` + '\n（取消 = 按默认方式处理）') }
}

/**
 * 关闭项目前的三选：保存并关闭 / 不保存关闭 / 取消。
 *
 * 走系统原生对话框，理由同上 —— 会丢内容的岔路口必须真的被看到，
 * 且必须**模态**：用户正切在别的窗口时，应用内浮层等于没提醒。
 * 按钮顺序从左到右，「不保存关闭」夹在中间，Esc / 关窗都落在「取消」上。
 */
export type ProjectCloseChoice = 'save' | 'discard' | 'cancel'

export async function confirmProjectClose(message: string): Promise<ProjectCloseChoice> {
  const bridge = window.xbaos
  if (bridge?.dialog?.confirm) {
    const index = await bridge.dialog.confirm({
      type: 'warning',
      title: '项目有未保存的改动',
      message,
      detail: '选择「不保存关闭」后，这些改动将无法找回。',
      buttons: ['保存并关闭', '不保存关闭', '取消'],
      // 默认落在「保存并关闭」：它不丢内容，顺手回车也是安全的
      defaultId: 0,
      cancelId: 2,
    })
    return index === 0 ? 'save' : index === 1 ? 'discard' : 'cancel'
  }

  // 浏览器预览没有原生三按钮：先问保存，再问要不要不保存关（仅预览路径）
  const text = `${message}\n\n确定 = 保存并关闭`
  if (window.confirm(text)) return 'save'
  return window.confirm('不保存关闭？\n（取消 = 放弃关闭，项目留在列表里）') ? 'discard' : 'cancel'
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
