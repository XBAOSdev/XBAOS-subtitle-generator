/**
 * 字幕条目的结构化编辑操作。
 *
 * 全部是纯函数：传入条目数组，返回新数组或在调用方的 mutate 里改。
 * 时间码的边界一律 round 到毫秒，避免浮点尾巴越算越长。
 *
 * 「文本槽位」是本文件的核心抽象：一条字幕上挂着原文（`text`）与若干语言的
 * 译文（`translations`），每一个可以独立编辑的位置就是一个槽位。结构操作
 * （分割 / 合并）必须明确「在哪一个槽位上做」，否则双语条目会切错对象。
 */

import type { GapFillOptions, SubtitleSegment } from '@/types'
import { uid } from '@/utils/id'

/**
 * 原文槽位的保留标识。
 *
 * 语言码不可能长成 `source`（都是 zh / en / ja 这类），所以拿它来指代原文是
 * 安全的 —— 这样「在哪个槽位上分割」就只需要一个字符串参数，不用再区分
 * 「是原文还是译文」两套分支。
 */
export const SOURCE_SLOT = 'source'

/**
 * 条目有没有实际文本。
 *
 * 空条目**不进 AI 提示词**（塞进去只会浪费 token 并诱导模型凭空填空），所以它也
 * **不该占一个译文序号**。这三处必须用同一个判定，否则会出静默错位：
 *   ① 拼提示词的 `usable()`；② 辅助窗口算「期望译文条数」；③ 译文按序号贴回条目。
 * 三者只要有一处把空条目算进去，后面所有译文就整体错一格 —— 读起来通顺，极难发现。
 */
export function hasText(seg: SubtitleSegment): boolean {
  return seg.text.trim() !== ''
}

/** 一条字幕上所有「有内容的槽位」：原文 + 有译文的语言 */
export function slotsOf(seg: SubtitleSegment): string[] {
  const langs = Object.keys(seg.translations ?? {})
  return [SOURCE_SLOT, ...langs]
}

/**
 * 条目数组的内容签名，用来判断「有没有改动」。
 *
 * **只含有产出意义的字段**：时间码、文本、译文、待确认标记。`issues` 刻意
 * 排除 —— 它由校验自动重算，把它算进来会让「跑一遍校验」也被当成一次改动，
 * 于是刚保存完的工程立刻又变成「有未保存的修改」。`origin` 同理（它只是
 * 「首次呈现的文本」这个基线，改了 `text` 就已经体现在里面了）。`acked`
 * （用户手动忽略告警）同样排除：它是编辑器侧的批注，不写进字幕文件，
 * 算进来只会让用户点一下「忽略」就被告知「有未保存的修改」。
 *
 * 用途有两处：① 关窗时判断有没有未保存的内容；② 和写盘那一刻的签名比对。
 * 这是**全量序列化**，只在需要时调用（关窗、写盘后），不要放进 computed ——
 * 那会让每次编辑都付一次全量字符串化的代价。
 */
export function segmentsSignature(segments: SubtitleSegment[]): string {
  return JSON.stringify(
    segments.map((s) => [
      s.id,
      s.start,
      s.end,
      s.text,
      s.translations ?? null,
      s.staleSlots ?? null,
    ]),
  )
}

/** 这批条目里实际出现过的译文语言，按首次出现的顺序 */
export function usedLangs(segments: SubtitleSegment[]): string[] {
  const out: string[] = []
  for (const s of segments) {
    for (const lang of Object.keys(s.translations ?? {})) {
      if (!out.includes(lang)) out.push(lang)
    }
  }
  return out
}

/**
 * 决定该展示哪一种语言的译文。
 *
 * 优先用设置里的工作语言；**它在当前数据里一条都找不到时退回实际存在的第一种**。
 * 最典型的场景是「撤销了一次翻译」：数据退回到上一版，而工作语言还停在新的那个
 * 语言上 —— 死守偏好会让译文行整片消失，用户看到的就成了「撤销把译文弄丢了」。
 * 退回数据里真实存在的语言，撤销才会看上去和操作前一致。
 *
 * 与 `exportPlan.ts` 的 `pickTranslationLang` 刻意不共用：那边判「有没有内容」
 * （空译文不算一种语言，免得导出对话框冒出空选项），这边判「键在不在」——
 * 编辑器里用户把一条译文整段删空时那个键仍然留着，语言必须继续算数，
 * 否则译文行会在编辑途中消失，连改回去的输入框都没了。
 */
export function pickViewLang(segments: SubtitleSegment[], preferred: string): string {
  const langs = usedLangs(segments)
  if (preferred && langs.includes(preferred)) return preferred
  return langs[0] ?? preferred
}

/** 读某个槽位的文本 */
export function slotText(seg: SubtitleSegment, slot: string): string {
  if (slot === SOURCE_SLOT) return seg.text
  return seg.translations?.[slot] ?? ''
}

/**
 * 写某个槽位的文本，返回新对象（不改原对象）。
 *
 * 写译文时若无条件新建 `translations` 会让「本来没有译文」的条目凭空多出一个
 * 空语言的键，所以只在槽位不是原文时才碰 `translations`。
 */
export function withSlotText(
  seg: SubtitleSegment,
  slot: string,
  text: string,
): SubtitleSegment {
  if (slot === SOURCE_SLOT) return { ...seg, text }
  return { ...seg, translations: { ...(seg.translations ?? {}), [slot]: text } }
}

/** 把一个槽位从待确认集合里去掉（用户改过之后调用） */
export function clearStale(seg: SubtitleSegment, slot: string): SubtitleSegment {
  if (!seg.staleSlots?.includes(slot)) return seg
  const next = seg.staleSlots.filter((s) => s !== slot)
  return { ...seg, staleSlots: next.length > 0 ? next : undefined }
}

/** 把若干槽位加进待确认集合 */
export function addStale(seg: SubtitleSegment, slots: string[]): SubtitleSegment {
  const fresh = slots.filter((s) => !(seg.staleSlots ?? []).includes(s))
  if (fresh.length === 0) return seg
  return { ...seg, staleSlots: [...(seg.staleSlots ?? []), ...fresh] }
}

/**
 * 这条字幕上除 `slot` 之外、**有内容**的槽位。空槽位不算 —— 它没有可核对的东西。
 * 合并选中的条目时也复用它（那里判的是「哪些槽位要继承待确认」）。
 */
export function otherSlotsWithText(seg: SubtitleSegment, slot: string): string[] {
  return slotsOf(seg).filter((s) => s !== slot && slotText(seg, s).trim() !== '')
}

/**
 * 改动了 `slot` 的内容之后，把这条字幕上**其余的译文槽位**标为待确认。
 *
 * 方向是单向的：只从原文指向译文。原文改了，译文自然可能不再对应；反过来改
 * 译文并不影响原文的正误 —— 而且对称标记会立刻陷入死循环：改原文标红译文、
 * 再去改译文又把原文标红，两边永远有一个红的，用户只能反复改同一句话。
 */
export function markTranslationsStale(seg: SubtitleSegment): SubtitleSegment {
  return addStale(seg, otherSlotsWithText(seg, SOURCE_SLOT))
}

/**
 * 把 `origin` 对齐到当前文本，用于**新生成的识别结果**落库之前。
 *
 * `origin` 的定义是「这一条第一次呈现给用户时的文本」（见 `types/index.ts`）。
 * 识别管线里繁转简、标点后处理、按规格折行都会改写 `text` 却不动 `origin`，
 * 于是用户刚识别完、一个字都没改，屏幕上就已经有一半条目顶着「已改动」的
 * 小圆点 —— 这个圆点本该只表示「人改过」。
 *
 * 只给识别管线用：用户手动跑「标点规范 / 重新折行」时**不能**这么做，
 * 那会把他之前的编辑痕迹一起抹掉（那些场景下圆点是对的）。
 */
export function alignOrigin(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments.map((s) => (s.text === s.origin ? s : { ...s, origin: s.text }))
}

function round(v: number): number {
  return Number(v.toFixed(3))
}

/** 单条最长时长。未启用限制时给一个宽松上限，防止插入出负数或零长条目 */
function maxDuration(gap: GapFillOptions): number {
  return gap.limitEnabled ? Math.max(0.2, gap.maxDurationSec) : 8
}

/**
 * 按「中文直接相接、西文接缝补一个空格」的规则把多段文本接起来。
 *
 * 只在两条的接缝处判断要不要补空格 —— 不能对拼接后的全文做正则替换，
 * 那会把条目内部的字母对也拆开。
 */
function joinTexts(parts: string[]): string {
  const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/
  const WORD = /[\p{L}\p{N}]/u
  let text = ''
  for (const part of parts) {
    const t = part.trim()
    if (!t) continue
    if (text) {
      const a = text[text.length - 1]
      const b = t[0]
      if (WORD.test(a) && WORD.test(b) && !CJK.test(a) && !CJK.test(b)) text += ' '
    }
    text += t
  }
  return text
}

/**
 * 计算在第 index 条之后插入新字幕的时间码。
 *
 * 规则（用户拍板的语义）：
 *   新条目默认从上一条的结束时间开始，撑满到下一条的开始时间；
 *   如果空余位置超过了填充空隙的上限，就只取上限那么长。
 *   上一条结束后就是文件末尾时同理，取到 maxDuration 为止。
 *
 * 空余位置太小（< 0.1s）时返回 null，由调用方提示用户。
 */
export function insertRangeAt(
  segments: SubtitleSegment[],
  index: number,
  gap: GapFillOptions,
): { start: number; end: number } | null {
  const current = segments[index]
  const limit = maxDuration(gap)

  if (!current) {
    // 空列表：从 0 开始
    return { start: 0, end: round(Math.min(limit, 2)) }
  }

  const start = current.end
  const nextStart = segments[index + 1]?.start ?? current.end + limit
  const room = nextStart - start

  if (room < 0.1) return null
  return { start: round(start), end: round(start + Math.min(room, limit)) }
}

/** 新建一条空字幕 */
export function makeEmptySegment(range: { start: number; end: number }): SubtitleSegment {
  return { id: uid('seg'), start: range.start, end: range.end, text: '', origin: '', issues: [] }
}

/**
 * 合并选中的字幕：按数组顺序头尾相接，文本直接拼接，
 * 时间码取首条的 start 到末条的 end —— 中间的间隙被覆盖。
 * 返回 null 表示选中项不连续或为空，不能合并。
 *
 * **每一种语言各自拼接**（原文与各语言译文互不干扰）。合并是用户明确的多选
 * 意图，拼出来的文本语义是连贯的，所以**不因为合并这个动作而标红**；只有
 * 参与合并的条目里本来就带着未确认的槽位时，才把那份「待确认」继承下来
 * —— 标红的语义是「这一段还没人确认过」，不该被一次合并洗白。
 */
export function mergeSelected(
  segments: SubtitleSegment[],
  ids: string[],
): { list: SubtitleSegment[]; merged: SubtitleSegment } | null {
  if (ids.length < 2) return null

  const indexById = new Map(segments.map((s, i) => [s.id, i]))
  const indices = ids.map((id) => indexById.get(id) ?? -1).sort((a, b) => a - b)
  if (indices.some((i) => i < 0)) return null
  for (let k = 1; k < indices.length; k += 1) {
    if (indices[k] !== indices[k - 1] + 1) return null
  }

  const picked = indices.map((i) => segments[i])
  const [first, ...rest] = picked

  const langs = new Set<string>()
  for (const s of picked) {
    for (const k of Object.keys(s.translations ?? {})) langs.add(k)
  }

  const translations: Record<string, string> = {}
  for (const lang of langs) {
    translations[lang] = joinTexts(picked.map((s) => s.translations?.[lang] ?? ''))
  }

  const stale = new Set<string>()
  for (const s of picked) {
    for (const slot of s.staleSlots ?? []) {
      // 只有真的有内容才值得标红：空槽位标红没有任何可改的东西
      if (slotText(s, slot).trim() !== '') stale.add(slot)
    }
  }

  const merged: SubtitleSegment = {
    id: uid('seg'),
    start: first.start,
    end: rest.length > 0 ? rest[rest.length - 1].end : first.end,
    text: joinTexts(picked.map((s) => s.text)),
    origin: first.origin,
    issues: [],
    avgLogprob: first.avgLogprob,
    ...(Object.keys(translations).length > 0 ? { translations } : {}),
    ...(stale.size > 0 ? { staleSlots: [...stale] } : {}),
  }

  const list = segments.filter((s) => !ids.includes(s.id))
  list.splice(indices[0], 0, merged)
  return { list, merged }
}

/**
 * 在字符偏移处把一条字幕切成两节。
 * 时间按**被切槽位**的字符比例分配；空文本按对半切。
 * 返回 null 表示偏移不合法（<=0 或 >=长度）。
 *
 * @param slot 在哪个文本槽位上切（`SOURCE_SLOT` 或语言码）。
 *
 * 双语字幕的关键约束：只有光标所在的这一侧会被真正切开，**其余槽位的内容整段
 * 复制到两段上**。为什么不去猜另一侧该从哪切？因为两种语言在同一个时间区间里
 * 的字符分布根本不成比例（中文 20 字对应英文 60 字符是常态），按比例硬切出来
 * 的断点几乎必然是错的字中间。与其猜错，不如把整段交回去让用户自己拆 ——
 * 但必须**标红**，否则用户根本不知道这里需要处理。
 */
export function splitSegment(
  segments: SubtitleSegment[],
  id: string,
  offset: number,
  slot: string = SOURCE_SLOT,
): { list: SubtitleSegment[]; a: SubtitleSegment; b: SubtitleSegment } | null {
  const index = segments.findIndex((s) => s.id === id)
  if (index < 0) return null

  const seg = segments[index]
  const cutting = slotText(seg, slot)
  const len = [...cutting].length
  if (len === 0 || offset <= 0 || offset >= len) return null

  const chars = [...cutting]
  const head = chars.slice(0, offset).join('')
  const tail = chars.slice(offset).join('')

  const span = Math.max(0.001, seg.end - seg.start)
  const ratio = offset / len
  const mid = round(seg.start + span * ratio)

  // 没被切开的槽位里，哪些需要人工确认：有内容、且不是刚被切的那一个
  const carried = slotsOf(seg).filter(
    (s) => s !== slot && slotText(seg, s).trim() !== '',
  )
  // 原有的待确认标记要接着传下去（还没人改过它），再加上这次新产生的
  const stale = [...new Set([...(seg.staleSlots ?? []), ...carried])]

  // a 沿用原条目（含全部译文槽位），只覆盖被切的那一个为前半段
  let a: SubtitleSegment = withSlotText({ ...seg, id: uid('seg'), end: mid }, slot, head)
  let b: SubtitleSegment = withSlotText({ ...seg, id: uid('seg'), start: mid, text: '', end: seg.end }, slot, tail)

  // 未被切开的槽位整段复制到两段上 —— 它们从此不再精确对应，交给用户拆分
  for (const s of carried) {
    const full = slotText(seg, s)
    a = withSlotText(a, s, full)
    b = withSlotText(b, s, full)
  }

  a = { ...a, staleSlots: stale.length > 0 ? stale : undefined }
  b = { ...b, staleSlots: stale.length > 0 ? stale : undefined }

  const list = [...segments]
  list.splice(index, 1, a, b)
  return { list, a, b }
}

/**
 * 一条字幕允许的最短时长（秒）。
 *
 * 时间轴上拖边界、刀切时间点都用它当「不能再短了」的下限。取 0.05 而不是 0：
 * 零长条目在界面上是一个点，既看不见也拖不动，等于把这条字幕做废了；
 * 0.05 秒（约 1.5 帧）肉眼刚好看得见一条细线，还能再拖开。
 */
export const MIN_SEGMENT_SEC = 0.05

/**
 * 被顺延压扁的一条字幕至少要留多久（秒）。
 *
 * 比 MIN_SEGMENT_SEC 大 —— 那 0.05 秒是「拖拽时不能再压」的下限，这里的场景不同：
 * 一条**本来有内容**的字幕被压到 0.05 秒，用户会以为它没被识别出来。
 * 0.2 秒短，但看得出来、点得到、也删得掉。
 */
const MIN_CUE_SEC = 0.2

/**
 * 把识别结果的时间轴夹成单调：后一条的起点不早于前一条的终点。
 *
 * 起因是一个真实报障：模型识别完后偶尔出现相邻两条字幕重叠，**上一条的结束时间
 * 偏长**（下一条的时间码是对的）。根因在引擎侧的 VAD 分块（`engine/src/vad.hpp`）：
 * 一段**连续说话超过 24 秒**的音频会被硬切成 24 秒的块，块与块之间**刻意留 1 秒
 * 音频重叠**，否则很容易把词切成两半。重叠区的**文本**由引擎按字符裁掉了，
 * 但**时间码是原样发出来**的 —— 于是新块的第一条会从上一块最后一条结束前 1 秒开始。
 *
 * 这里统一按「已发出的最后一条的结束」夹住起点。顺带也修掉 whisper 自己偶尔
 * 给出的、与上一条交叠的 `t0`（它的时间戳是估计值，不保证单调）。
 *
 * **只用在识别结果上，别用在导入的字幕文件上**：字幕文件里出现重叠是正常需求
 * （双行同显、多说话人并排），替用户改掉属于越权。
 */
export function enforceMonotonicCues(segments: SubtitleSegment[]): SubtitleSegment[] {
  const out: SubtitleSegment[] = []
  let lastEnd = Number.NEGATIVE_INFINITY

  for (const seg of segments) {
    if (seg.start >= lastEnd) {
      // 常态路径：原对象直接过去，不改引用，方便上游按引用比对「有没有动过」
      out.push(seg)
      lastEnd = Math.max(lastEnd, seg.end)
      continue
    }

    const start = round(lastEnd)
    const end = round(Math.max(seg.end, start + MIN_CUE_SEC))
    out.push({ ...seg, start, end })
    lastEnd = end
  }

  return out
}

/**
 * 在**时间轴上的某一点**把一条字幕切成两节。
 *
 * 与 `splitSegment`（按文本光标切）的分工：
 *   - 文本光标分割：用户指着**文本里的某个字**，时间按被切槽位的字符比例分配；
 *   - 时间点分割（本函数）：用户指着**时间轴上的某个位置**，时间按刀口切开。
 *
 * 关键差异是**文本不截断**：整段原文原样复制到两段上，两段都标红待确认。
 * 为什么不像文本分割那样按比例去切字符串？因为从「时间轴上的一个点」根本推不出
 * 「这对应文本的第几个字」—— 同一段时长里，中文与英文的字数能差一倍以上，
 * 人物口播的语速更是忽快忽慢。按时间比例硬切出来的断点，几乎必然落在词的中间。
 * 与其猜错，不如把完整文本交回给用户自己删，但**必须标红**，否则他根本不知道
 * 这里需要处理（这与双语分割「另一侧整段复制 + 标红」是同一个取舍）。
 *
 * 时间按刀口分给两段：前半 `[start, at]`，后半 `[at, end]`。两段首尾相接、
 * 不重叠，所以它们会落在同一条泳道上。
 *
 * @param atSec 刀口位置。必须落在条目内部（两侧各留 MIN_SEGMENT_SEC），
 *              否则返回 null —— 贴着边缘切出来的零长条目没有意义。
 */
export function splitSegmentAtTime(
  segments: SubtitleSegment[],
  id: string,
  atSec: number,
): { list: SubtitleSegment[]; a: SubtitleSegment; b: SubtitleSegment } | null {
  const index = segments.findIndex((s) => s.id === id)
  if (index < 0) return null

  const seg = segments[index]
  if (atSec <= seg.start + MIN_SEGMENT_SEC - 1e-9) return null
  if (atSec >= seg.end - MIN_SEGMENT_SEC + 1e-9) return null

  const at = round(atSec)

  /*
   * 所有**有内容**的文本槽位都要标红：刀口是时间上的，我们并不知道它落在
   * 每种语言的第几个字，所以原文与全部译文都需要人工过目。
   * 空槽位不标 —— 没有可改的东西，标红只是噪音。
   */
  const carried = slotsOf(seg).filter((s) => slotText(seg, s).trim() !== '')
  const stale = [...new Set([...(seg.staleSlots ?? []), ...carried])]
  const staleSlots = stale.length > 0 ? stale : undefined

  // 两段共用同一份文本与译文内容，所以 b 从 a 派生即可；但要**各自的引用**，
  // 否则之后编辑其中一段的译文会连带改到另一段（快照与撤回也会跟着错）。
  const clone = (base: SubtitleSegment): SubtitleSegment => {
    const out: SubtitleSegment = { ...base, issues: [...base.issues] }
    if (base.translations) out.translations = { ...base.translations }
    if (staleSlots) out.staleSlots = [...staleSlots]
    else delete out.staleSlots
    return out
  }

  const a: SubtitleSegment = clone({ ...seg, id: uid('seg'), end: at })
  const b: SubtitleSegment = clone({ ...seg, id: uid('seg'), start: at })

  const list = [...segments]
  list.splice(index, 1, a, b)
  return { list, a, b }
}

/** 删除给定 id 的所有条目 */
export function removeIds(segments: SubtitleSegment[], ids: string[]): SubtitleSegment[] {
  const drop = new Set(ids)
  return segments.filter((s) => !drop.has(s.id))
}

/**
 * 在时间点 `atSec` 处**能切开**哪些条。
 *
 * 刀口必须落在条目内部（两侧各留 `MIN_SEGMENT_SEC`）：贴着首尾切出来的零长条目
 * 既看不见也拖不动，等于把这条做废了。判定与 `splitSegmentAtTime` 的守卫条件
 * 是同一条，写成函数是为了让「按钮亮不亮」和「真的切得动」永远一致 ——
 * 两边各写一份正则迟早会分叉成「按钮能点但点了没反应」。
 *
 * @param ids 限定候选（通常是当前选中的那些）。传空数组表示不限，即
 *            「谁被播放头压着就切谁」—— 同一时刻叠了几条就切几条。
 */
export function splittableAtTime(
  segments: SubtitleSegment[],
  atSec: number,
  ids: string[] = [],
): SubtitleSegment[] {
  const pool = ids.length > 0 ? segments.filter((s) => ids.includes(s.id)) : segments
  return pool.filter(
    (s) => atSec > s.start + MIN_SEGMENT_SEC && atSec < s.end - MIN_SEGMENT_SEC,
  )
}

/**
 * 在同一个时间点，把一整批字幕各切一刀。
 *
 * 一次 Ctrl+B 可能同时作用于好几条（同一垂面上叠着的那些），所以必须**合成
 * 一次改动**：逐条 commit 会在撤销栈里留下好几格，用户要按好几次 Ctrl+Z 才能
 * 回到按下之前 —— 在他看来那一下就是「一步」。
 *
 * 返回 null 表示一条也没切成（调用方据此决定要不要提示）。
 */
export function splitSegmentsAtTime(
  segments: SubtitleSegment[],
  ids: string[],
  atSec: number,
): { list: SubtitleSegment[]; created: SubtitleSegment[] } | null {
  let next = segments
  const created: SubtitleSegment[] = []
  // 每切一刀都会让列表变长，所以逐条拿最新的列表去切，不能拿原始数组
  for (const id of ids) {
    const result = splitSegmentAtTime(next, id, atSec)
    if (!result) continue
    next = result.list
    created.push(result.a)
  }
  return created.length > 0 ? { list: next, created } : null
}

/**
 * 一条字幕上「跟着内容走」的字段。
 *
 * 拖动排序时要在**时间槽之间**搬的就是这些 —— 时间码留原地，所以它们必须
 * 和 `start` / `end` 分开。`issues` 也不在其中：它由校验按「这一格的时间码 +
 * 这一格的文本」重新算出来，跟着内容搬反而会瞬间过期。
 */
type SegmentContent = Pick<
  SubtitleSegment,
  'text' | 'origin' | 'translations' | 'staleSlots' | 'avgLogprob' | 'acked' | 'originFileId'
>

function contentOf(seg: SubtitleSegment): SegmentContent {
  return {
    text: seg.text,
    origin: seg.origin,
    translations: seg.translations ? { ...seg.translations } : undefined,
    staleSlots: seg.staleSlots ? [...seg.staleSlots] : undefined,
    avgLogprob: seg.avgLogprob,
    acked: seg.acked,
    originFileId: seg.originFileId,
  }
}

/** 把内容写回某个时间槽（`id` / 时间码 / `issues` 保持槽位自己的） */
function withContent(seg: SubtitleSegment, content: SegmentContent): SubtitleSegment {
  const next: SubtitleSegment = { ...seg, ...content, issues: [...seg.issues] }
  // 展开运算符会把显式的 undefined 也覆盖上去，得逐个把「本来就没有」删干净
  if (content.translations === undefined) delete next.translations
  if (content.staleSlots === undefined) delete next.staleSlots
  if (content.avgLogprob === undefined) delete next.avgLogprob
  if (content.acked === undefined) delete next.acked
  if (content.originFileId === undefined) delete next.originFileId
  return next
}

/**
 * 把第 `from` 条上的**内容**搬到第 `to` 条的位置（时间码原地不动）。
 *
 * 这是「拖动列表调整顺序」的语义：用户拖的是**内容**，不是时间轴上的位置。
 * 语言槽位（原文 + 各语言译文）与「待确认」标记一并搬走 —— 它们描述的是
 * 这一段话，不是一个时间格子；`origin` 同理（它是这段文本的基线）。
 *
 * 中间那些条目整体让位一格（标准拖放行为），所以这条搬过去之后，它落在
 * 第 `to` 个时间槽上。时间码与条目 id 都不动 —— id 留在槽位上，选中状态与
 * 撤销栈的指向才不会跟着乱跳。
 *
 * 数组顺序仍是时间顺序，因此列表看起来依旧整齐；变的是每个时间格子里的字。
 *
 * 返回 null 表示没有实际变化（原地放下或下标越界）。
 */
export function moveContentTo(
  segments: SubtitleSegment[],
  from: number,
  to: number,
): SubtitleSegment[] | null {
  if (from === to) return null
  if (from < 0 || from >= segments.length) return null
  if (to < 0 || to >= segments.length) return null

  const contents = segments.map(contentOf)
  const [moved] = contents.splice(from, 1)
  contents.splice(to, 0, moved)
  return segments.map((seg, i) => withContent(seg, contents[i]))
}

/** 修改一条字幕的文本（编辑器里的每一次确认） */
export function updateText(
  segments: SubtitleSegment[],
  id: string,
  text: string,
): SubtitleSegment[] {
  return segments.map((s) => (s.id === id ? { ...s, text } : s))
}
