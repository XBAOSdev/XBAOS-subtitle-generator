/**
 * 「焦点是不是在能打字的地方」。
 *
 * 全局快捷键与容器级快捷键都必须先问这一句：只要焦点落在输入框 / 文本域 /
 * 下拉框 / 可编辑区域里，那一次按键就属于**输入本身**，全局那套语义必须让位。
 *
 * 踩过的两个具体坑：
 *  1. 时间码框里按 Delete 想删一位数字，事件冒泡到字幕表格的 keydown，
 *     整条字幕被删掉了（编辑态判定只认文本编辑框，认不出时间码输入框）。
 *  2. Ctrl+B 在文本编辑框里被「按文本光标分割」处理完后退出编辑态，
 *     同一次按键继续冒泡到 window，又被「按播放头分割」切了第二刀。
 *
 * 抽成一个共用函数，是因为这个判断散落过三处，每加一个快捷键都要重想一遍。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
