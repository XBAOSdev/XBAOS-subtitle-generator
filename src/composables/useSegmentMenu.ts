/**
 * 字幕条的右键菜单与「更换讲话人」下拉。
 *
 * 表格行与时间轴上的字幕条是同一批数据的两种画法，菜单必须一模一样 ——
 * 两处各写一份，迟早会出现「表格里能合并、时间轴上合并是灰的」这种
 * 说不清原因的差异。所以菜单项、可用性判断、落地动作都放在这里，
 * 两个组件只负责决定「用哪几个条目」和「菜单弹在哪个坐标」。
 */
import { computed, ref } from 'vue'
import type { SubtitleSegment } from '@/types'
import { mergeSelected, removeIds } from '@/utils/segmentOps'
import { setSpeakerFor } from '@/utils/speaker'
import { tidyMenu, type MenuItem, type MenuState } from '@/utils/menu'
import { useProjectStore } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { useUiStore } from '@/stores/ui'
import { useSpeakerStore } from '@/stores/speakers'
import { useSplitAtPlayhead } from '@/composables/useSplitAtPlayhead'

export interface SegmentMenuOptions {
  /**
   * 进入文本编辑。表格里能直接把光标放进输入框；时间轴上没有输入框，
   * 不传这一项菜单里就不出现「编辑文本」—— 宁可少一项，也不要点了没反应。
   */
  beginEdit?: (seg: SubtitleSegment) => void
}

export function useSegmentMenu(options: SegmentMenuOptions = {}) {
  const project = useProjectStore()
  const editor = useEditorStore()
  const history = useHistoryStore()
  const ui = useUiStore()
  const speakers = useSpeakerStore()
  const { canSplit: canSplitAtPlayhead, splitAtPlayhead } = useSplitAtPlayhead()

  const menu = ref<MenuState | null>(null)

  const segments = computed(() => project.viewFile?.segments ?? [])
  const selectedSet = computed(() => new Set(editor.selectedIds))
  const speakerList = computed(() =>
    speakers.speakersOf(project.viewFileId ?? '', segments.value),
  )

  /**
   * 这次操作作用在哪些条目上。
   *
   * 右键的那一条**在选区里**时按整片选区算，否则只算它自己 —— 这样
   * 「先框选一片、再右键其中一条」是批量的，而右键选区外的一条不会误伤
   * 已经选好的那批。
   */
  function targetIds(seg: SubtitleSegment): string[] {
    return selectedSet.value.has(seg.id) ? [...editor.selectedIds] : [seg.id]
  }

  function targetSegments(ids: string[]): SubtitleSegment[] {
    const wanted = new Set(ids)
    return segments.value.filter((s) => wanted.has(s.id))
  }

  function applySpeaker(ids: string[], index: number | undefined): void {
    const file = project.viewFile
    if (!file || ids.length === 0) return
    const result = setSpeakerFor(file.segments, ids, index)
    if (result.changed === 0) return
    const name = index === undefined ? '' : speakers.nameOf(file.id, index)
    history.commit(
      file.id,
      file.segments,
      index === undefined ? '清除讲话人标识' : '更改讲话人',
      () => {
        file.segments = result.segments
      },
    )
    ui.notify(
      'success',
      index === undefined ? '已清除讲话人标识' : `已改为「${name}」`,
      `${result.changed} 条字幕`,
    )
  }

  /** 讲话人选项：已经是同一个人的灰掉（点了也不会有任何变化） */
  function speakerItems(ids: string[]): MenuItem[] {
    const targets = targetSegments(ids)
    const items: MenuItem[] = speakerList.value.map((entry) => ({
      key: `speaker:${entry.index}`,
      label: entry.name,
      hint: entry.count > 0 ? `${entry.count} 条` : '未使用',
      disabled: targets.length > 0 && targets.every((s) => s.speaker === entry.index),
    }))
    if (items.length === 0) {
      items.push({ key: 'speaker:empty', label: '还没有讲话人', disabled: true })
    }
    items.push({ key: 'd-spk', label: '', divider: true })
    items.push({
      key: 'speaker:none',
      label: '清除标识',
      disabled: targets.every((s) => typeof s.speaker !== 'number'),
    })
    return items
  }

  function openAt(x: number, y: number, seg: SubtitleSegment): void {
    // 右键没点到选区里时先把这一条选上：菜单里的「已选 N 条」必须与实际情况一致
    if (!selectedSet.value.has(seg.id)) {
      editor.select(seg.id, 'replace', segments.value.map((s) => s.id))
    }
    const ids = targetIds(seg)
    menu.value = { x, y, items: buildItems(ids), ids, anchorId: seg.id }
  }

  /** 点讲话人那一格：只出换人这一组，别把整份菜单摊出来 */
  function openSpeakerAt(x: number, y: number, seg: SubtitleSegment): void {
    if (!selectedSet.value.has(seg.id)) {
      editor.select(seg.id, 'replace', segments.value.map((s) => s.id))
    }
    const ids = targetIds(seg)
    menu.value = { x, y, items: speakerItems(ids), ids, anchorId: seg.id }
  }

  function buildItems(ids: string[]): MenuItem[] {
    const targets = targetSegments(ids)
    const multi = ids.length > 1
    const hasAudio = (project.viewFile?.durationSec ?? 0) > 0
    const canMerge = multi && mergeSelected(segments.value, ids) !== null
    const canAck = targets.some(
      (s) => s.issues.length > 0 || (s.staleSlots?.length ?? 0) > 0,
    )
    const allAcked = targets.length > 0 && targets.every((s) => s.acked)

    return tidyMenu([
      {
        key: 'play',
        label: multi ? `播放选中的 ${ids.length} 条` : '播放本句',
        icon: 'play',
        disabled: !hasAudio,
      },
      // 多选时仍然列出来但灰着：直接不列会让人以为「这菜单里没有编辑」，
      // 灰着才说得清「多条不能一起进同一条文本」
      ...(options.beginEdit
        ? [{ key: 'edit', label: '编辑文本', icon: 'type', disabled: multi }]
        : []),
      { key: 'copy', label: multi ? '复制选中文本' : '复制文本', icon: 'copy' },
      { key: 'd1', label: '', divider: true },
      { key: 'merge', label: '合并选中', icon: 'layers', hint: 'Ctrl+M', disabled: !canMerge },
      {
        key: 'split',
        label: '在播放头分割',
        icon: 'scissors',
        hint: 'Ctrl+B',
        disabled: !canSplitAtPlayhead.value,
      },
      {
        key: 'speaker',
        label: '更改讲话人',
        icon: 'user',
        disabled: speakerList.value.length === 0,
        children: speakerItems(ids),
      },
      { key: 'd2', label: '', divider: true },
      {
        key: 'ack',
        label: allAcked ? '恢复告警' : '忽略告警',
        icon: allAcked ? 'eye' : 'eye-off',
        disabled: !canAck,
      },
      {
        key: 'delete',
        label: multi ? `删除选中的 ${ids.length} 条` : '删除',
        icon: 'trash',
        danger: true,
      },
    ])
  }

  function onPick(key: string): void {
    const state = menu.value
    const file = project.viewFile
    if (!state || !file) return

    if (key.startsWith('speaker:')) {
      const raw = key.slice('speaker:'.length)
      applySpeaker(state.ids, raw === 'none' ? undefined : Number(raw))
      return
    }

    const targets = targetSegments(state.ids)

    switch (key) {
      case 'play': {
        if (targets.length === 0) return
        const start = Math.min(...targets.map((s) => s.start))
        const end = Math.max(...targets.map((s) => s.end))
        editor.setPlayhead(start)
        editor.playOneShot(targets[0].id, start, end)
        break
      }
      case 'edit': {
        const seg = targets[0]
        if (seg) options.beginEdit?.(seg)
        break
      }
      case 'copy': {
        const text = targets.map((s) => s.text).filter(Boolean).join('\n')
        if (!text) {
          ui.notify('info', '选中的字幕没有文本')
          return
        }
        // 走主进程的剪贴板：file:// 下 navigator.clipboard 不是安全上下文，会直接拒绝
        const bridge = window.xbaos
        const done = bridge?.clipboard?.write
          ? bridge.clipboard.write(text)
          : navigator.clipboard.writeText(text)
        void done
          .then(() => ui.notify('success', '已复制字幕文本', `${targets.length} 条`))
          .catch(() => ui.notify('warning', '复制失败', '系统拒绝了剪贴板访问'))
        break
      }
      case 'merge': {
        const result = mergeSelected(file.segments, state.ids)
        if (!result) return
        history.commit(file.id, file.segments, '合并字幕', () => {
          file.segments = result.list
          editor.select(result.merged.id, 'replace', result.list.map((s) => s.id))
        })
        break
      }
      case 'split':
        splitAtPlayhead()
        break
      case 'ack': {
        const next = !targets.every((s) => s.acked)
        history.commitIfChanged(
          file.id,
          file.segments,
          next ? '忽略告警' : '恢复告警',
          () => {
            for (const seg of file.segments) {
              if (!state.ids.includes(seg.id)) continue
              if (next) seg.acked = true
              else delete seg.acked
            }
          },
        )
        break
      }
      case 'delete': {
        history.commit(file.id, file.segments, '删除字幕', () => {
          file.segments = removeIds(file.segments, state.ids)
          editor.clearSelection()
        })
        break
      }
    }
  }

  function close(): void {
    menu.value = null
  }

  return {
    menu,
    segments,
    speakerList,
    openAt,
    openSpeakerAt,
    onPick,
    close,
  }
}
