import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useSettingsStore } from '@/stores/settings'
import { defaultSpeakerName, listSpeakers, nextSpeakerIndex, type SpeakerEntry } from '@/utils/speaker'

/**
 * 讲话人称呼。
 *
 * 编号（`segment.speaker`）是数据本身，称呼只是套在编号外面的名字，两者分开存：
 *  - 编号一旦确定就不重排，删掉中间一位时后面几位仍然叫原来的名字；
 *  - 称呼可以不填，不填时退回「讲话人 N」。
 *
 * **默认每个文件各一套**：分离是对每份音频各自跑出来的，A 里的 0 号与 B 里的
 * 0 号本来就不必是同一个人。合并处理时物理上只有一条拼接产物，天然还是一套。
 * 设置里打开「所有文件共用同一套称呼」后才改走共享表。
 *
 * 不落盘：称呼只活在这一次工程里，和字幕数据同理（项目本身也不持久化）。
 */
export const useSpeakerStore = defineStore('speakers', () => {
  const settings = useSettingsStore()

  /** fileId → 编号 → 称呼 */
  const byFile = ref<Record<string, Record<string, string>>>({})
  /** 跨文件共用时的那一套 */
  const shared = ref<Record<string, string>>({})
  /**
   * 手动新增、但一条字幕都还没挂上的编号。
   *
   * 不记这一笔的话，「新增讲话人」在列表里看不见任何变化 —— 列表是按
   * 条目反推的，而新编号此刻还没有条目。
   */
  const declared = ref<Record<string, number[]>>({})

  function namesOf(fileId: string): Record<string, string> {
    if (settings.speakerNamesShared) return shared.value
    return byFile.value[fileId] ?? {}
  }

  /** 某个文件里的讲话人列表（含新增未用的），按编号升序 */
  function speakersOf(fileId: string, segments: { speaker?: number }[]): SpeakerEntry[] {
    return listSpeakers(segments, namesOf(fileId), declared.value[fileId] ?? [])
  }

  function nameOf(fileId: string, index: number): string {
    return namesOf(fileId)[index]?.trim() || defaultSpeakerName(index)
  }

  function rename(fileId: string, index: number, name: string): void {
    const target = settings.speakerNamesShared ? shared.value : (byFile.value[fileId] ??= {})
    const trimmed = name.trim()
    if (trimmed) target[index] = trimmed
    else delete target[index]
  }

  /** 新增一位：编号取当前最大 + 1，并登记为「已声明」 */
  function addSpeaker(fileId: string, segments: { speaker?: number }[]): number {
    const index = nextSpeakerIndex(segments, declared.value[fileId] ?? [])
    const list = (declared.value[fileId] ??= [])
    if (!list.includes(index)) list.push(index)
    // 写一个默认称呼，列表才会立刻出现这一位
    rename(fileId, index, defaultSpeakerName(index))
    return index
  }

  /** 这一位已经不存在了（标识被清除或并入别人），把称呼与声明一并收走 */
  function forget(fileId: string, index: number): void {
    const map = settings.speakerNamesShared ? shared.value : byFile.value[fileId]
    if (map) delete map[index]
    const list = declared.value[fileId]
    if (list) {
      const at = list.indexOf(index)
      if (at >= 0) list.splice(at, 1)
    }
  }

  /** 整个文件的称呼（文件被移出队列时调用，避免张冠李戴） */
  function forgetFile(fileId: string): void {
    delete byFile.value[fileId]
    delete declared.value[fileId]
  }

  return {
    byFile,
    shared,
    declared,
    namesOf,
    speakersOf,
    nameOf,
    rename,
    addSpeaker,
    forget,
    forgetFile,
  }
})
