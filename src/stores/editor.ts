import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useEditorStore = defineStore('editor', () => {
  /** 选中的字幕条目 id */
  const selectedIds = ref<string[]>([])
  /** 键盘导航锚点 */
  const anchorId = ref<string | null>(null)
  /** 正在编辑的条目 id */
  const editingId = ref<string | null>(null)

  /** 播放头位置，单位秒 */
  const playheadSec = ref(0)
  const isPlaying = ref(false)
  const playbackRate = ref(1)
  const loopCurrent = ref(false)

  /**
   * 用户正在拖播放头。
   *
   * 必须是**共享**状态而不是某个组件里的局部变量：拖拽发生在时间轴组件，
   * 而 `timeupdate` 的写回发生在播放器组件。两边各拿一个标志，等于没拦——
   * 拖到一半就被音频的进度写回去，游标会来回弹。
   */
  const scrubbing = ref(false)
  const followPlayback = ref(true)

  /** 填充空隙等批量操作的预览结果：segmentId -> 变更后的时间码 */
  const pendingPreview = ref<Record<string, { start: number; end: number }>>({})

  const hasSelection = computed(() => selectedIds.value.length > 0)

  const previewCount = computed(() => Object.keys(pendingPreview.value).length)

  function select(id: string, mode: 'replace' | 'toggle' | 'range' = 'replace', allIds: string[] = []): void {
    if (mode === 'replace') {
      selectedIds.value = [id]
      anchorId.value = id
      return
    }
    if (mode === 'toggle') {
      selectedIds.value = selectedIds.value.includes(id)
        ? selectedIds.value.filter((x) => x !== id)
        : [...selectedIds.value, id]
      anchorId.value = id
      return
    }
    // range
    const anchor = anchorId.value ?? id
    const from = allIds.indexOf(anchor)
    const to = allIds.indexOf(id)
    if (from < 0 || to < 0) {
      selectedIds.value = [id]
      anchorId.value = id
      return
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    selectedIds.value = allIds.slice(lo, hi + 1)
  }

  function clearSelection(): void {
    selectedIds.value = []
    anchorId.value = null
  }

  /**
   * 一次性把选中项设成给定集合。
   *
   * 有些操作天然会产生**一组**结果（例如一次 Ctrl+B 把同一垂面上叠着的三条
   * 各切一刀），逐个 `select(..., 'toggle')` 拼出来既啰嗦又容易漏；而且
   * `toggle` 的语义是「有就去掉」，一旦那条本来就在选中集合里就会反向失效。
   */
  function setSelection(ids: string[]): void {
    selectedIds.value = [...ids]
    anchorId.value = ids[0] ?? null
  }

  function beginEdit(id: string): void {
    editingId.value = id
  }

  function endEdit(): void {
    editingId.value = null
  }

  function setPlayhead(sec: number): void {
    playheadSec.value = Math.max(0, sec)
  }

  /**
   * 显式跳转的序号。
   *
   * 播放器有两条把「音频位置」写回游标的通道（播放时逐帧推进、暂停时补最后一帧），
   * 它们会把任何外部写入覆盖掉。方向键一次只挪 0.1 秒，比「游标与音频差 0.15 秒
   * 才 seek」那个死区还小 —— 走普通通道只会被音频原样写回去，界面看着毫无反应。
   * 序号一变，播放器就无条件对齐一次，不再看阈值。
   */
  const seekSeq = ref(0)

  /**
   * 跳到指定位置。
   *
   * `pause` 为真时先停下再跳：播放中逐帧推进每一帧都会把游标写回音频位置，
   * 不先停，0.1 秒的微调在下一帧就被抹掉了。停止与跳转必须在同一次调用里完成，
   * 分成两步会留下「先被补最后一帧、再被跳走」的中间态。
   */
  function seekTo(sec: number, options: { pause?: boolean } = {}): void {
    if (options.pause && isPlaying.value) isPlaying.value = false
    seekSeq.value += 1
    playheadSec.value = Math.max(0, sec)
  }

  function togglePlay(): void {
    isPlaying.value = !isPlaying.value
  }

  /**
   * 一次性播放范围（「播放本句」用）。
   *
   * 与「循环当前句」是两回事：循环是反复听同一句；这个是**播到句尾就停**。
   * 两者互斥 —— 开一个就清掉另一个，否则会出现「播到句尾停下、又立刻跳回句首」
   * 这种谁都不想要的中间态。
   *
   * 停下来的位置刻意**留在句尾**：接着按「下一句」就能顺着往下听。
   * 想反复听同一句请用循环。
   */
  const playRange = ref<{ id: string; start: number; end: number } | null>(null)

  function playOneShot(id: string, start: number, end: number): void {
    loopCurrent.value = false
    playRange.value = { id, start, end }
  }

  function clearPlayRange(): void {
    playRange.value = null
  }

  function setPreview(preview: Record<string, { start: number; end: number }>): void {
    pendingPreview.value = preview
  }

  function clearPreview(): void {
    pendingPreview.value = {}
  }

  return {
    selectedIds,
    anchorId,
    editingId,
    playheadSec,
    isPlaying,
    playbackRate,
    loopCurrent,
    scrubbing,
    followPlayback,
    pendingPreview,
    hasSelection,
    previewCount,
    select,
    clearSelection,
    setSelection,
    beginEdit,
    endEdit,
    setPlayhead,
    seekSeq,
    seekTo,
    togglePlay,
    playRange,
    playOneShot,
    clearPlayRange,
    setPreview,
    clearPreview,
  }
})
