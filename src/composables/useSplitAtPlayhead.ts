/**
 * 「按时间轴播放头分割字幕」这一件事的**唯一实现**。
 *
 * 为什么值得单独抽出来：它有三个入口 —— 世界快捷键（Ctrl+B）、字幕表格工具栏
 * 的「分割」按钮、以及将来可能加的时间轴右键菜单。三处各写一遍的话，
 * 「按钮亮着但点了没反应」「快捷键切两条、按钮只切一条」这类偏差几乎必然出现，
 * 而且只会在用户踩到时才暴露。这里把「切哪些」与「怎么切」放在一处，
 * 按钮的可用状态也由同一份数据推导。
 *
 * 与「按文本光标分割」的分工（`SubtitleTable.splitAtCaret`）：
 *   - 光标分割：用户指着**文本里的某个字**，时间按被切槽位的字符比例分配；
 *   - 时间点分割（本文件）：用户指着**时间轴上的一个点**，时间按刀口切开，
 *     文本整段复制到两段上并标红待确认 —— 从时间推不出对应第几个字。
 * 两者靠「有没有在编辑文本」分流，互斥、不会同时触发。
 */
import { computed } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import { useUiStore } from '@/stores/ui'
import { splitSegmentsAtTime, splittableAtTime } from '@/utils/segmentOps'
import type { SubtitleSegment } from '@/types'

export function useSplitAtPlayhead() {
  const project = useProjectStore()
  const editor = useEditorStore()
  const history = useHistoryStore()
  const ui = useUiStore()

  /**
   * 这次刀口能切到哪些条。
   *
   * 有选中就以选中为范围，没有就「谁被播放头压着切谁」—— 这正是用户要的语义：
   * 挑好了再切，或者直接对着游标切。同一垂面上叠着几条时，后者会一次切好几条，
   * 而它们本来就该一起处理（否则切完一条，剩下几条又叠上来了）。
   */
  const targets = computed<SubtitleSegment[]>(() => {
    const segments = project.viewFile?.segments ?? []
    return splittableAtTime(segments, editor.playheadSec, editor.selectedIds)
  })

  const canSplit = computed(() => targets.value.length > 0)

  /** 真正执行。返回是否切成了，调用方据此决定要不要给提示 */
  function splitAtPlayhead(): boolean {
    const file = project.viewFile
    if (!file) return false
    const hits = targets.value
    if (hits.length === 0) {
      ui.notify(
        'info',
        '播放头不在任何一条字幕里',
        editor.selectedIds.length > 0
          ? '选中的字幕没有盖住播放头，把它挪到要切开的位置上'
          : '把播放头放到要切开的位置上，或先选中要切的那几条',
      )
      return false
    }
    const result = splitSegmentsAtTime(file.segments, hits.map((s) => s.id), editor.playheadSec)
    if (!result) return false

    const label = hits.length > 1 ? `按播放头分割 ${hits.length} 条字幕` : '按播放头分割字幕'
    history.commit(file.id, file.segments, label, () => {
      file.segments = result.list
      // 选中切出来的前半段：分割之后用户多半先收拾它们，表格也会跟着滚过去
      editor.setSelection(result.created.map((s) => s.id))
    })
    return true
  }

  return { canSplit, targetCount: computed(() => targets.value.length), splitAtPlayhead }
}
