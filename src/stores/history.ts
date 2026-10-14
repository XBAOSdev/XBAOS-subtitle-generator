import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SubtitleSegment } from '@/types'

/**
 * 编辑历史（撤回 / 重做）。
 *
 * 快照式：每次操作前把整个条目数组克隆一份入栈。字幕文件通常几十到
 * 几百条，快照成本可以忽略，换来的是实现简单、任何操作都能覆盖
 * —— 不用为每种操作手写反向函数，也不会出现「撤销到一半状态对不上」。
 *
 * 按文件分桶：在文件 A 上做的编辑不会把文件 B 的历史冲掉。
 * 上限 15 步，超过后丢掉最老的 —— 用户明确要求的值。
 */

const MAX_STEPS = 15

interface HistoryBucket {
  /** 过去的快照，栈顶是「上一步」 */
  past: SubtitleSegment[][]
  /** 未来的快照，栈顶是「下一步」（撤销后被压进来） */
  future: SubtitleSegment[][]
  /** 最新一步的可读描述，用于状态栏提示 */
  lastLabel: string
}

export const useHistoryStore = defineStore('history', () => {
  const buckets = ref(new Map<string, HistoryBucket>())

  /** 变更计数，仅用于驱动 canUndo / canRedo 的响应性 */
  const version = ref(0)

  function bucketOf(fileId: string): HistoryBucket {
    let bucket = buckets.value.get(fileId)
    if (!bucket) {
      bucket = { past: [], future: [], lastLabel: '' }
      buckets.value.set(fileId, bucket)
    }
    return bucket
  }

  /**
   * 快照用的逐条克隆。
   *
   * ⚠️ 必须把 `translations` / `staleSlots` 也拷一层 —— 它们是引用类型，只做
   * `{ ...s }` 会让快照与现状共享同一份数据。后果非常隐蔽：编辑译文之后
   * `JSON.stringify(before) === JSON.stringify(now)` 会成立（两边是同一个对象），
   * 于是历史认为「什么都没改」，译文改动**根本撤不回来**。
   */
  function cloneOne(s: SubtitleSegment): SubtitleSegment {
    return {
      ...s,
      issues: [...s.issues],
      ...(s.translations ? { translations: { ...s.translations } } : {}),
      ...(s.staleSlots ? { staleSlots: [...s.staleSlots] } : {}),
    }
  }

  function cloneAll(segments: SubtitleSegment[]): SubtitleSegment[] {
    return segments.map(cloneOne)
  }

  /**
   * 记录一次操作：先把当前状态压入过去栈，再执行 mutate。
   * 所有会改动字幕条目的地方都必须走这个入口，撤回才完整。
   */
  function commit(fileId: string, segments: SubtitleSegment[], label: string, mutate: () => void): void {
    const bucket = bucketOf(fileId)
    bucket.past.push(cloneAll(segments))
    if (bucket.past.length > MAX_STEPS) bucket.past.shift()
    bucket.future = []
    bucket.lastLabel = label
    mutate()
    version.value += 1
  }

  /** 当前状态与最近一次快照之间是否有差异。没有就不算一步，避免空占历史 */
  function commitIfChanged(
    fileId: string,
    segments: SubtitleSegment[],
    label: string,
    mutate: () => void,
  ): boolean {
    const before = JSON.stringify(segments)
    const bucket = bucketOf(fileId)
    /*
     * 先把这一次「假提交」会破坏掉的东西**全部**留底。
     *
     * `commit()` 会无条件清空 future（这是对的：一旦真的产生了新改动，旧的
     * 重做分支就失效了）。但「其实什么都没改」的时候不能这么干 ——
     * 用户先 Ctrl+Z、再跑一次本来就没东西可改的批量工具（标点规范 / 词表替换
     * 常常是空操作），重做栈就会被顺手清空，**原来能重做的内容永久丢失**。
     *
     * 所以 past / future / lastLabel 三样都要还原：past 要还原是因为超过
     * MAX_STEPS 时压栈会把最老的一步挤掉，只 pop 回来会让栈凭空少一格。
     */
    const dropped = bucket.past.length >= MAX_STEPS ? bucket.past[0] : null
    const futureBackup = bucket.future
    const labelBackup = bucket.lastLabel

    commit(fileId, segments, label, mutate)

    if (JSON.stringify(segments) === before) {
      bucket.past.pop()
      if (dropped) bucket.past.unshift(dropped)
      bucket.future = futureBackup
      bucket.lastLabel = labelBackup
      version.value += 1
      return false
    }
    return true
  }

  /**
   * 适合「改动已经发生」的场景（textarea 的 v-model 直接改了文本）：
   * 调用方在改动前把快照存下来，确认改动后把快照推入过去栈。
   * 内部自行判断快照与现状是否真的有差异。
   */
  function pushSnapshot(
    fileId: string,
    segments: SubtitleSegment[],
    before: SubtitleSegment[],
    label: string,
  ): boolean {
    if (JSON.stringify(before) === JSON.stringify(segments)) return false
    const bucket = bucketOf(fileId)
    bucket.past.push(cloneAll(before))
    if (bucket.past.length > MAX_STEPS) bucket.past.shift()
    bucket.future = []
    bucket.lastLabel = label
    version.value += 1
    return true
  }

  function undo(fileId: string, segments: SubtitleSegment[]): SubtitleSegment[] | null {
    const bucket = buckets.value.get(fileId)
    if (!bucket || bucket.past.length === 0) return null
    const previous = bucket.past.pop()!
    bucket.future.push(cloneAll(segments))
    version.value += 1
    return previous
  }

  function redo(fileId: string, segments: SubtitleSegment[]): SubtitleSegment[] | null {
    const bucket = buckets.value.get(fileId)
    if (!bucket || bucket.future.length === 0) return null
    const next = bucket.future.pop()!
    bucket.past.push(cloneAll(segments))
    version.value += 1
    return next
  }

  /** 切换文件或重新识别时清掉该文件的历史，避免撤回到别的来源的数据 */
  function clear(fileId: string): void {
    if (buckets.value.delete(fileId)) version.value += 1
  }

  const canUndo = computed(() => {
    void version.value
    for (const bucket of buckets.value.values()) {
      if (bucket.past.length > 0) return true
    }
    return false
  })

  const canRedo = computed(() => {
    void version.value
    for (const bucket of buckets.value.values()) {
      if (bucket.future.length > 0) return true
    }
    return false
  })

  function canUndoFile(fileId: string | null): boolean {
    void version.value
    if (!fileId) return false
    return (buckets.value.get(fileId)?.past.length ?? 0) > 0
  }

  function canRedoFile(fileId: string | null): boolean {
    void version.value
    if (!fileId) return false
    return (buckets.value.get(fileId)?.future.length ?? 0) > 0
  }

  return {
    commit,
    commitIfChanged,
    pushSnapshot,
    undo,
    redo,
    clear,
    canUndo,
    canRedo,
    canUndoFile,
    canRedoFile,
  }
})
