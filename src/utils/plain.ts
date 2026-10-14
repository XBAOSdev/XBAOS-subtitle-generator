/**
 * 把 Vue 响应式对象转成可以跨进程传递的纯数据。
 *
 * Electron 的 IPC 走结构化克隆（structuredClone），而 Vue 3 的 `reactive()` /
 * `ref()` 返回的是 Proxy —— 克隆 Proxy 会直接抛 `An object could not be cloned.`。
 * 这个错发生在渲染进程发消息那一刻，表现出来就是「按钮点了毫无反应」，
 * 极难从界面上看出原因。
 *
 * 特别注意：**展开运算符不够用**。`{ ...seg }` 只能解掉最外层，Vue 的代理是
 * 深度代理，读到的嵌套数组/对象（例如 `seg.issues`）依然是 Proxy，克隆照样失败。
 *
 * 走一遍 JSON 序列化是这里最省事也最可靠的做法 —— 跨进程传的都只是字符串、
 * 数字与布尔这类 JSON 原生值，不涉及 Date / Map / TypedArray / 循环引用。
 */
export function toPlain<T>(value: T): T {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 数组版本。单独开一个是为了在调用点读起来更明确：
 * `toPlainList(file.segments)` 比 `toPlain(file.segments)` 更能说明意图。
 */
export function toPlainList<T>(value: readonly T[]): T[] {
  return toPlain(value) as T[]
}
