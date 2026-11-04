/** 菜单项。右键菜单与「更换讲话人」下拉共用一套结构 */
export interface MenuItem {
  key: string
  label: string
  icon?: string
  /** 右侧的轻提示（快捷键或计数） */
  hint?: string
  disabled?: boolean
  /** 分隔线：这一项只占位，label 等字段可留空 */
  divider?: boolean
  /** 危险动作（删除一类），文字用告警色 */
  danger?: boolean
  children?: MenuItem[]
}

/** 一次右键 / 下拉的状态：坐标 + 菜单项 + 这次作用在哪些条目上 */
export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
  ids: string[]
  anchorId: string
}

/** 过滤掉「分隔线打头 / 连续分隔线 / 收尾分隔线」这类排版毛病 */
export function tidyMenu(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const item of items) {
    if (item.divider) {
      if (out.length === 0 || out[out.length - 1].divider) continue
      out.push(item)
      continue
    }
    out.push({
      ...item,
      ...(item.children ? { children: tidyMenu(item.children) } : {}),
    })
  }
  while (out.length > 0 && out[out.length - 1].divider) out.pop()
  return out
}
