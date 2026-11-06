import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  defaultSpeakerName,
  isUserSpeakerName,
  listSpeakers,
  nextSpeakerIndex,
  planSpeakerMapping,
  type GlobalSpeaker,
  type SpeakerEntry,
} from '@/utils/speaker'

/** 参与对应关系推断的文件（只要 id 与带编号的条目） */
export interface SpeakerMappingFile {
  id: string
  segments: { speaker?: number }[]
}

/**
 * 讲话人称呼与跨文件对应关系。
 *
 * 三层东西，分开存：
 *  - **编号**（`segment.speaker`）是数据本身，一旦确定就不重排；
 *  - **称呼**是可以改的名字；
 *  - **对应关系**是「这个文件的这一号，在全局算哪一位」。
 *
 * 「所有文件共用同一套称呼」以前是把称呼表整个换成一张共享表，于是
 * 勾上的一瞬间，当前文件已经改好的名字被共享表盖掉；而共享表以裸编号
 * 为键，A 文件的 0 号与 B 文件的 0 号被强行绑成同一个人 —— 可 0 号本来就
 * 只是「这个文件里的第一个人」，两个文件各拍各的，编号相同纯属巧合。
 *
 * 现在改成三层：每个文件的称呼表（`byFile`）**永远保留**，跨文件只多存
 * 一层「局部编号 → 全局编号」的对应（`mapping`）与一张全局称呼表
 * （`globals`）。勾上共用时按需现推，推完让人确认；取消共用时什么都不动，
 * 原来改好的名字还在原地。
 *
 * 不随设置落盘（那是软件偏好）；随**项目**落盘 —— 称呼与对应关系是这份
 * 工程的一部分，换台电脑打开必须一模一样。
 */
export const useSpeakerStore = defineStore('speakers', () => {
  /**
   * 本项目内是否共用一套称呼。
   *
   * **项目级属性**（不是全局设置）：每个项目各记各的，切换项目时开关跟着变。
   * 放在这里而不是 `settings` 里，是因为它描述的是"这一份工程怎么看待称呼"，
   * 而设置描述的才是"这个软件怎么工作"。初值由建项目时的批量模式决定
   * （合并 → 共用，分开 → 各自称呼），之后与模式无关。
   */
  const shared = ref(false)
  /** fileId → 编号 → 称呼（**每个文件各自一套**，永远保留） */
  const byFile = ref<Record<string, Record<string, string>>>({})
  /**
   * 全局讲话人：跨文件的「同一个人」。
   *
   * 下标即全局编号。`name` 是用户定的统一称呼，空串表示「用兜底称呼」；
   * `fallback` 是建这一位时它在源文件里的默认称呼（「讲话人 1」之类），
   * 免得改完称呼再清空时变成一个空白格。
   */
  const globals = ref<GlobalSpeaker[]>([])
  /** fileId → 局部编号 → 全局编号 */
  const mapping = ref<Record<string, Record<string, number>>>({})
  /**
   * 手动新增、但一条字幕都还没挂上的编号。
   *
   * 不记这一笔的话，「新增讲话人」在列表里看不见任何变化 —— 列表是按
   * 条目反推的，而新编号此刻还没有条目。
   */
  const declared = ref<Record<string, number[]>>({})
  /**
   * 对应关系是否已经建过。
   *
   * 建过之后就不能随便推倒重来 —— 用户在表里调过的关系不能被悄悄改回去。
   * 只有「还没建过」时才按名字推断一次。
   */
  const mappingBuilt = ref(false)
  /**
   * 用户是否已经确认过对应关系。
   *
   * 没确认之前每次开启共用都会**重新推断**一遍：用户可能在这期间改过名字，
   * 新的名字才是新的证据。确认过之后就不再乱推，只在表格里手动调。
   */
  const mappingConfirmed = ref(false)
  /**
   * 这次打开对应关系表，是不是因为用户勾了「共用一套称呼」。
   *
   * 勾选时勾选框会先弹回去（等确认），确认后才由弹窗把共用打开。
   * 但从侧栏「调整对应关系」按钮进来时**不能顺手把开关打开** —— 用户可能只是
   * 想看看，独立处理下确认一次就被强行共用，等于又回到「自己勾上的勾选框」。
   */
  const pendingShareConfirm = ref(false)

  /* ------------------------------------------------------------ 全局编号 */

  /** 全局编号的称呼（空则用兜底） */
  function globalName(index: number): string {
    const g = globals.value[index]
    if (!g) return ''
    return g.name.trim() || g.fallback
  }

  /** 新开一位全局讲话人 */
  function createGlobal(name: string, fallback: string): number {
    globals.value.push({ name: name.trim(), fallback })
    return globals.value.length - 1
  }

  /** 改全局称呼 */
  function setGlobalName(index: number, name: string): void {
    const g = globals.value[index]
    if (!g) return
    g.name = name.trim()
    /*
     * **不往各文件的称呼表里写。**
     *
     * 各文件那份（`byFile`）是「这个文件自己的称呼」，共用模式只是把它盖上一层
     * 统一的叫法。写回去的话，取消勾选就再也回不到各自原来的称呼了 ——
     * 而「取消共用 = 各文件回归原来的称呼」正是这个开关该有的语义。
     */
  }

  /** 某位全局讲话人现在挂在哪些（文件，局部编号）上 */
  function membersOf(global: number): { fileId: string; local: number }[] {
    const out: { fileId: string; local: number }[] = []
    for (const [fileId, map] of Object.entries(mapping.value)) {
      for (const [local, g] of Object.entries(map)) {
        if (g === global) out.push({ fileId, local: Number(local) })
      }
    }
    return out
  }

  /** 表里要显示的全局编号：只有还挂着人的才算一行 */
  function usedGlobals(): number[] {
    return globals.value
      .map((_, index) => index)
      .filter((index) => membersOf(index).length > 0)
  }

  /* ------------------------------------------------------------ 映射 */

  /** 某个文件的局部编号对应到哪一位全局 */
  function globalOf(fileId: string, local: number): number | undefined {
    return mapping.value[fileId]?.[String(local)]
  }

  /** 把某个文件的局部编号指到某一位全局上 */
  function setGlobalOf(fileId: string, local: number, global: number): void {
    const map = (mapping.value[fileId] ??= {})
    map[String(local)] = global
  }

  /**
   * 局部编号 → 全局编号 的对应关系（给表格用）。
   *
   * 反查一次比每次渲染都去扫整张表快，也省得表格里到处写反查代码。
   */
  function localOf(fileId: string, global: number): number | undefined {
    const map = mapping.value[fileId]
    if (!map) return undefined
    for (const [local, g] of Object.entries(map)) {
      if (g === global) return Number(local)
    }
    return undefined
  }

  /**
   * 按「同名即同一人」重新推断一遍对应关系。
   *
   * 只有**用户自己起的名字**算证据；系统给的「讲话人 N」在每个文件里
   * 都叫这个数，拿它当依据等于把两个陌生人绑成一个人。
   */
  function rebuildMapping(files: SpeakerMappingFile[]): void {
    const inputs = files.map((file) => {
      const indexes = [
        ...new Set(
          file.segments
            .filter((seg) => typeof seg.speaker === 'number')
            .map((seg) => seg.speaker as number),
        ),
      ].sort((a, b) => a - b)
      return { id: file.id, indexes, names: byFile.value[file.id] ?? {} }
    })
    const plan = planSpeakerMapping(inputs)
    globals.value = plan.globals
    mapping.value = plan.mapping
    mappingBuilt.value = true
  }

  /**
   * 补齐映射：新出现的讲话人（又识别了一遍、或者新导入了文件）挂到新的全局位上。
   *
   * 已有对应关系的**不动** —— 用户在表格里调过的关系不能被悄悄改回去。
   */
  function ensureMapping(files: SpeakerMappingFile[]): void {
    for (const file of files) {
      const indexes = [
        ...new Set(
          file.segments
            .filter((seg) => typeof seg.speaker === 'number')
            .map((seg) => seg.speaker as number),
        ),
      ].sort((a, b) => a - b)

      /*
       * 先清掉已经不存在的编号。
       *
       * 这个文件里某位讲话人可能刚被删掉（或者重新识别后编号变了），它那一条
       * 对应关系如果留着，表里就会挂着一个**语料里已经没有人**的标签 ——
       * 看着像删除没生效，其实是旧映射没人收拾。这里顺手自愈一次。
       */
      const map = mapping.value[file.id]
      if (map) {
        const alive = new Set(indexes.map(String))
        for (const key of Object.keys(map)) {
          if (!alive.has(key)) delete map[key]
        }
      }

      if (indexes.length === 0) continue
      const target = (mapping.value[file.id] ??= {})
      for (const index of indexes) {
        if (target[String(index)] !== undefined) continue
        // 有用户起的名字就并进同名的那一位，没有就单独开一位
        const local = byFile.value[file.id]?.[String(index)]
        const name = isUserSpeakerName(index, local) ? local!.trim() : ''
        const found = name
          ? globals.value.findIndex((g) => g.name.trim() === name)
          : -1
        target[String(index)] =
          found >= 0 ? found : createGlobal(name, defaultSpeakerName(index))
      }
    }
    mappingBuilt.value = true
  }

  /**
   * 拖动一个讲话人到某一行。
   *
   * 行的意思：表里从上往下数的第几行。落在已有行 = 归入那一行；
   * 落在末尾的空行 = 单独开一位（相当于新建一个对应关系）。
   *
   * 目标行在同一个文件里已经有别人时**对调**，而不是挤掉一个 —— 挤掉的话
   * 那位讲话人就凭空消失了，用户想撤回都找不到地方。
   */
  function moveToRow(fileId: string, local: number, row: number): void {
    const used = usedGlobals()
    let target: number
    if (row < used.length) {
      target = used[row]
    } else {
      target = createGlobal('', defaultSpeakerName(local))
    }
    const source = globalOf(fileId, local)
    if (source === target) return
    // 同一文件里目标行已经有人 → 跟源位对调
    const displaced = localOf(fileId, target)
    if (displaced !== undefined && displaced !== local) {
      if (source === undefined) {
        // 被挤走的那位另开一位：不能凭空消失，用户连撤回都找不到地方
        setGlobalOf(fileId, displaced, createGlobal('', defaultSpeakerName(displaced)))
      } else {
        setGlobalOf(fileId, displaced, source)
      }
    }
    setGlobalOf(fileId, local, target)
  }

  /* ------------------------------------------------------------ 称呼 */

  function namesOf(fileId: string): Record<string, string> {
    const own = byFile.value[fileId] ?? {}
    if (!shared.value) return own
    /*
     * 共用模式下以统一称呼为准，但**没进对应关系的人仍用他自己的称呼**。
     *
     * 少了这个兜底，只要有一处对应没建起来（刚识别完、面板还没挂载、
     * 新导入的文件），侧栏就会整片退回「讲话人 N」—— 看起来像名字被吃了。
     */
    const out: Record<string, string> = { ...own }
    const map = mapping.value[fileId]
    if (!map) return out
    for (const [local, g] of Object.entries(map)) {
      const name = globalName(g)
      if (name) out[local] = name
    }
    return out
  }

  /** 某个文件里的讲话人列表（含新增未用的），按编号升序 */
  function speakersOf(fileId: string, segments: { speaker?: number }[]): SpeakerEntry[] {
    return listSpeakers(segments, namesOf(fileId), declared.value[fileId] ?? [])
  }

  function nameOf(fileId: string, index: number): string {
    return namesOf(fileId)[index]?.trim() || defaultSpeakerName(index)
  }

  /**
   * 改称呼。
   *
   * 共用模式下改的是**全局**那一位的称呼 —— 否则改一个文件的名字却只在这个
   * 文件生效，界面上显示的却是统一的称呼，两边对不上。
   */
  function rename(fileId: string, index: number, name: string): void {
    if (shared.value) {
      const g = globalOf(fileId, index)
      if (g !== undefined) {
        setGlobalName(g, name)
        return
      }
      // 还没进对应关系的人：仍按本文件的称呼记，别让这次改名凭空消失。
      // 记下来的名字同时也是这张表将来「同名即同一人」的证据。
    }
    const target = (byFile.value[fileId] ??= {})
    const trimmed = name.trim()
    if (trimmed) target[index] = trimmed
    else delete target[index]
  }

  /** 新增一位：编号取当前最大 + 1，并登记为「已声明」 */
  function addSpeaker(fileId: string, segments: { speaker?: number }[]): number {
    const index = nextSpeakerIndex(segments, declared.value[fileId] ?? [])
    const list = (declared.value[fileId] ??= [])
    if (!list.includes(index)) list.push(index)
    if (shared.value) {
      // 共用模式下新增的是**新的一位**，不能去改别人的称呼
      const g = createGlobal('', defaultSpeakerName(index))
      setGlobalOf(fileId, index, g)
    } else {
      // 写一个默认称呼，列表才会立刻出现这一位
      rename(fileId, index, defaultSpeakerName(index))
    }
    return index
  }

  /** 这一位已经不存在了（标识被清除或并入别人），把称呼与声明一并收走 */
  function forget(fileId: string, index: number): void {
    // 每个文件的称呼表都要清：共用模式下旧代码只清共享表，
    // 结果删掉一位讲话人，别人的名字也跟着没了
    const own = byFile.value[fileId]
    if (own) delete own[index]
    /*
     * 对应关系**无条件**删。
     *
     * 以前只在共用模式（`speakerNamesShared`）下删 —— 独立处理时删掉一位讲话人，
     * `mapping` 里那条还留着，之后打开共用或对应关系表，这位在字幕里早就没有
     * 任何一条了，表里却还挂着一个标签。
     */
    const map = mapping.value[fileId]
    if (map) delete map[String(index)]
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
    delete mapping.value[fileId]
  }

  /** 整份工程换掉（打开项目）时复位所有的表与开关 */
  function resetAll(): void {
    shared.value = false
    byFile.value = {}
    globals.value = []
    mapping.value = {}
    declared.value = {}
    mappingBuilt.value = false
    mappingConfirmed.value = false
    pendingShareConfirm.value = false
  }

  return {
    shared,
    byFile,
    globals,
    mapping,
    declared,
    mappingBuilt,
    mappingConfirmed,
    pendingShareConfirm,
    globalName,
    createGlobal,
    setGlobalName,
    membersOf,
    usedGlobals,
    globalOf,
    setGlobalOf,
    localOf,
    rebuildMapping,
    ensureMapping,
    moveToRow,
    namesOf,
    speakersOf,
    nameOf,
    rename,
    addSpeaker,
    forget,
    forgetFile,
    resetAll,
  }
})
