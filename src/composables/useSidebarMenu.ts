/**
 * 侧栏的右键菜单：项目条与子项目行各一份（方案 5.2）。
 *
 * 规矩三条：
 * 1. 要选路径 / 要填名字的动作不能多选（重命名、另存为、映射、重识别…）；
 * 2. 纯批量动作可以多选（保存、关闭、删除、导出、单独保存、移到、移除），失败逐条报；
 * 3. 多选时只显示全部选中项都支持的项，不显示灰项。
 *
 * 菜单项、可用性、落地动作都收在这里，FileTree 只管「点谁、弹在哪」——
 * 与字幕条的 `useSegmentMenu` 同一个道理，两处各写一份迟早不一致。
 */
import { ref } from 'vue'
import { tidyMenu, type MenuItem, type MenuState } from '@/utils/menu'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { confirmDestructive, confirmWithOption } from '@/utils/confirm'
import { serializeSubtitle, applyLineEnding } from '@/utils/subtitle'
import type { AudioFile, SubtitleFormat } from '@/types'

export interface SidebarMenuOptions {
  /** 重命名走行内编辑：菜单只负责把请求递出去 */
  beginRename: (kind: 'draft' | 'item', id: string) => void
}

export function useSidebarMenu(options: SidebarMenuOptions) {
  const project = useProjectStore()
  const ui = useUiStore()
  const menu = ref<MenuState | null>(null)

  /** 定位一条子项目在哪个项目里 */
  function ownerOf(itemId: string): string {
    for (const d of project.drafts) {
      if (project.draftItems(d).some((f) => f.id === itemId)) return d.id
    }
    return ''
  }

  function itemOf(itemId: string): AudioFile | null {
    for (const d of project.drafts) {
      const hit = project.draftItems(d).find((f) => f.id === itemId)
      if (hit) return hit
    }
    return null
  }

  /**
   * 多选时把灰项直接去掉（方案 5.2 第 3 条：只显示全部选中项都支持的项）；
   * 单选留着灰项，让人看得出「为什么这里点不了」。
   */
  function finalize(items: MenuItem[], one: boolean): MenuItem[] {
    const picked = one ? items : items.filter((it) => !it.disabled && !it.divider)
    return tidyMenu(picked)
  }

  /* ------------------------------------------------------------ 项目条菜单 */

  function draftMenuItems(ids: string[]): MenuItem[] {
    const one = ids.length === 1
    const drafts = ids.map((id) => project.drafts.find((d) => d.id === id)).filter(Boolean)
    const hasPath = drafts.some((d) => !!(d as { path?: string | null }).path)
    return finalize(
      [
        {
          key: 'draft:rename',
          label: '重命名',
          disabled: !one,
        },
        {
          key: 'draft:save',
          label: one ? '保存' : `保存这 ${ids.length} 个`,
        },
        {
          key: 'draft:save-as',
          label: '另存为…',
          disabled: !one,
        },
        {
          key: 'draft:reveal',
          label: '在文件夹中显示',
          disabled: !one || !hasPath,
        },
        { key: 'd1', label: '', divider: true },
        {
          key: 'draft:close',
          label: one ? '关闭项目' : `关闭这 ${ids.length} 个`,
        },
        {
          key: 'draft:delete',
          label: one ? '删除项目…' : `删除这 ${ids.length} 个…`,
          danger: true,
        },
        { key: 'd2', label: '', divider: true },
        { key: 'draft:collapse-all', label: '全部折叠' },
        { key: 'draft:expand-all', label: '全部展开' },
      ],
      one,
    )
  }

  /* ---------------------------------------------------------- 子项目行菜单 */

  function itemMenuItems(ids: string[]): MenuItem[] {
    const one = ids.length === 1
    const items = ids.map(itemOf)
    const owners = new Set(ids.map(ownerOf))
    // 导出走的是导出弹窗，只认一个项目里的条目：跨项目多选时不出这一项
    const exportable = owners.size === 1
    const allSubtitle = items.every((f) => !!f?.subtitleFormat)
    const hasPath = items.some((f) => !!(f?.path || f?.subtitlePath))
    // 移到的目标：排除任何一条的原项目，剩下的都能放
    const targets = project.drafts.filter((d) => !owners.has(d.id))
    const moveChildren: MenuItem[] = targets.map((d) => ({
      key: `move:${d.id}`,
      label: d.name || '未命名项目',
      hint: `${project.draftItems(d).length} 项`,
    }))
    moveChildren.push({ key: 'move:@new', label: '新建项目' })

    return finalize(
      [
        { key: 'item:rename', label: '重命名', disabled: !one },
        {
          key: 'item:recognize',
          label: '重新识别',
          /*
           * 灰着不给理由，用户只会以为软件坏了。这里把「为什么不能点」直接写在
           * 右边：没有音频（纯字幕条目）是唯一不可逆的情况 —— 重识别会清空字幕，
           * 而它没有音频可以重新跑，等于把内容删掉。
           */
          hint: !items[0]
            ? ''
            : !one
              ? '只能一条一条来'
              : project.recognizing
                ? '正在识别'
                : !items[0].path && !items[0].demo
                  ? '没有音频'
                  : '',
          disabled: !one || !items[0] || (!items[0].path && !items[0].demo) || project.recognizing,
        },
        { key: 'item:map', label: '音频映射', disabled: !one },
        {
          key: 'item:reload',
          label: '重新读取源文件',
          disabled: !one || !allSubtitle,
        },
        { key: 'd1', label: '', divider: true },
        {
          key: 'item:export',
          label: one ? '导出这一条…' : `导出这 ${ids.length} 条…`,
          disabled: !exportable,
        },
        {
          key: 'item:save-sub',
          label: one ? '单独保存为字幕…' : `单独保存这 ${ids.length} 条…`,
        },
        {
          key: 'item:move',
          label: '移到…',
          children: moveChildren,
        },
        { key: 'd2', label: '', divider: true },
        { key: 'item:reveal', label: '在文件夹中显示', disabled: !one || !hasPath },
        {
          key: 'item:remove',
          label: one ? '从项目中移除' : `从项目中移除这 ${ids.length} 条`,
          danger: true,
        },
      ],
      one,
    )
  }

  /* ------------------------------------------------------------------ 弹出 */

  function openDraftAt(x: number, y: number, id: string, selected: string[]): void {
    const ids = selected.includes(id) ? selected : [id]
    menu.value = { x, y, items: draftMenuItems(ids), ids, anchorId: id }
  }

  function openItemAt(x: number, y: number, id: string, selected: string[]): void {
    const ids = selected.includes(id) ? selected : [id]
    menu.value = { x, y, items: itemMenuItems(ids), ids, anchorId: id }
  }

  /** 需要活动项目才能跑的动作，先切过去（切项目是静默保存的） */
  async function ensureActive(draftId: string): Promise<void> {
    if (draftId && draftId !== project.activeDraftId) await project.switchDraft(draftId)
  }

  /* ------------------------------------------------------------------ 落地 */

  async function pick(key: string, ids: string[]): Promise<void> {
    const one = ids[0] ?? ''

    if (key === 'draft:collapse-all') return project.collapseAll()
    if (key === 'draft:expand-all') return project.expandAll()

    if (key === 'draft:rename') {
      const d = project.drafts.find((x) => x.id === one)
      if (d) {
        await ensureActive(one)
        options.beginRename('draft', one)
      }
      return
    }
    if (key === 'draft:save') {
      await project.saveAllProjects(ids)
      return
    }
    if (key === 'draft:save-as') {
      await ensureActive(one)
      ui.openDialog('save-project')
      return
    }
    if (key === 'draft:reveal') {
      const d = project.drafts.find((x) => x.id === one)
      const target = d?.path
      if (target && window.xbaos) void window.xbaos.fs.reveal(target)
      return
    }
    if (key === 'draft:close') {
      // 带未保存确认：直接 closeDraft 会把没存的改动丢掉
      await project.closeDraftsSafely(ids)
      return
    }
    if (key === 'draft:delete') {
      const names = ids
        .map((id) => project.drafts.find((d) => d.id === id))
        .filter(Boolean)
        .map((d) => (d as { name?: string }).name || '未命名项目')
      const res = await confirmWithOption({
        title: '删除项目',
        message:
          ids.length === 1
            ? `「${names[0]}」的项目文件会从磁盘上删除，找不回来。`
            : `这 ${ids.length} 个项目的文件会从磁盘上删除，找不回来。`,
        detail: '勾上下面这一项就只把它从侧栏移出，磁盘上的 .xbsgp 会留着。',
        confirmLabel: '删除',
        checkboxLabel: '只从列表移除（保留磁盘文件）',
      })
      if (!res.ok) return
      // 勾了就退化成「关闭项目」：同一件事的轻量版，不该让用户再走一次菜单
      if (res.checked) for (const id of ids) project.closeDraft(id)
      else await project.deleteDrafts(ids)
      return
    }

    if (key === 'item:rename') {
      options.beginRename('item', one)
      return
    }
    if (key === 'item:recognize') {
      await ensureActive(ownerOf(one))
      void project.recognizeItem(one)
      return
    }
    if (key === 'item:map') {
      await ensureActive(ownerOf(one))
      ui.openDialog('audio-map', { fileId: one })
      return
    }
    if (key === 'item:reload') {
      await ensureActive(ownerOf(one))
      void project.reloadSubtitle(one)
      return
    }
    if (key === 'item:export') {
      await ensureActive(ownerOf(ids[0]))
      ui.openDialog('export', { onlyIds: ids })
      return
    }
    if (key === 'item:save-sub') {
      await saveSubtitles(ids)
      return
    }
    if (key.startsWith('move:')) {
      const dest = key.slice('move:'.length)
      if (dest === '@new') {
        const id = project.createDraft({ activate: false })
        project.moveItemsToDraft(ids, id)
      } else {
        project.moveItemsToDraft(ids, dest)
      }
      return
    }
    if (key === 'item:reveal') {
      const f = itemOf(one)
      const target = f?.path || f?.subtitlePath
      if (target && window.xbaos) void window.xbaos.fs.reveal(target)
      return
    }
    if (key === 'item:remove') {
      const f = itemOf(one)
      const ok = await confirmDestructive({
        title: '从项目中移除',
        message:
          ids.length === 1
            ? `「${f?.name ?? ''}」的 ${f?.segments.length ?? 0} 条字幕会一起没掉。`
            : `这 ${ids.length} 个子项目和它们的字幕会一起没掉。`,
        detail: '源文件还在磁盘上，只是不再属于这个项目。',
        confirmLabel: '移除',
      })
      if (ok) project.removeItems(ids)
      return
    }
  }

  /**
   * 「单独保存为字幕…」：一条一个保存框，格式跟扩展名走。
   * 多选就是挨个问一遍，失败一条不拦后面的（方案 5.2 第 2 条）。
   */
  async function saveSubtitles(ids: string[]): Promise<void> {
    const bridge = window.xbaos
    if (!bridge) {
      ui.notify('warning', '浏览器预览无法保存字幕', '请在桌面应用里使用')
      return
    }
    let done = 0
    for (const id of ids) {
      const f = itemOf(id)
      if (!f) continue
      const picked = await bridge.dialog.saveSubtitle({
        defaultPath: f.name.replace(/\.[^.]+$/, '') + '.srt',
      })
      if (!picked) continue
      const ext = picked.split('.').pop()?.toLowerCase() ?? ''
      const format: SubtitleFormat =
        ext === 'vtt' || ext === 'ass' || ext === 'txt' ? ext : 'srt'
      const text = applyLineEnding(serializeSubtitle(format, f.segments), 'crlf')
      try {
        await bridge.fs.writeSubtitle(picked, text, 'utf-8')
        done += 1
      } catch (err) {
        ui.notify('error', '保存失败', `${f.name}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (done > 0) ui.notify('success', `已保存 ${done} 个字幕文件`)
  }

  return { menu, openDraftAt, openItemAt, pick }
}
