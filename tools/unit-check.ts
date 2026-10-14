/**
 * 后处理与编辑操作的语义自检。
 * 运行方式：esbuild bundle 后 node 执行（见 npm run unit）。
 */
import { applyPunctuation, toSimplified } from '../src/utils/punctuation'
import {
  MIN_SEGMENT_SEC,
  SOURCE_SLOT,
  addStale,
  clearStale,
  enforceMonotonicCues,
  insertRangeAt,
  markTranslationsStale,
  mergeSelected,
  moveContentTo,
  otherSlotsWithText,
  pickViewLang,
  removeIds,
  slotText,
  splitSegment,
  splitSegmentAtTime,
  splitSegmentsAtTime,
  splittableAtTime,
  usedLangs,
  withSlotText,
} from '../src/utils/segmentOps'
import {
  MAX_LANES,
  assignLanes,
  exceedsLaneLimit,
  exceedsLaneLimitByShift,
  laneNeighbours,
  overflowLaneIds,
} from '../src/utils/timelineLayout'
import { countIssues, visibleIssues, widthUnits } from '../src/utils/validate'
import { applyLineWrap } from '../src/utils/lineWrap'
import { srtTime, serializeSrt, serializeAss, composeForExport, bundleLangTag, sourceLangTag } from '../src/utils/subtitle'
import { planExport, pickTranslationLang, translationLangsOf, type PlanSource } from '../src/utils/exportPlan'
import { parseSubtitle } from '../src/utils/subtitleParse'
import { buildPrompt, pickPresentTerms, promptCharCost, splitTerms } from '../src/utils/prompt'
import { LEXICONS } from '../src/data/lexicons'
import {
  containmentSimilarity,
  diceSimilarity,
  mergeRuns,
  normalizeForCompare,
  repetitionPenalty,
  runText,
  scoreRun,
  type RecognitionRun,
} from '../src/utils/transcriptMerge'
import { depthPreset } from '../src/utils/reasoningDepth'
import { applyRescue, planRescueRanges, LOW_CONF_LOGPROB } from '../src/utils/lowConfRescue'
import { VAD_PRESETS, vadPreset, filterVadPresets } from '../src/data/vadPresets'
import {
  buildReviewPrompt,
  buildTranslatePrompt,
  estimatePromptTokens,
  PROMPT_CHAR_WARN,
  type ReviewPromptOptions,
} from '../src/utils/llmPrompt'
import {
  applyTranslation,
  cuesToSegments,
  parseModelOutput,
  parseTranslation,
  splitByFileMarks,
  stripNoise,
  summarizeReview,
} from '../src/utils/llmResult'
import { toPlain, toPlainList } from '../src/utils/plain'
import { buildMergedTimeline, type MergeSourceFile } from '../src/utils/mergeTimeline'
import { parseReplaceDict, applyReplaceRules } from '../src/utils/dictReplace'
import {
  allowedExternalUrl,
  checkForUpdate,
  compareVersions,
  isValidVersion,
  parseManifest,
  pickReleaseNotes,
} from '../electron/update.js'
import { readFileSync } from 'node:fs'
import type { PunctuationOptions, SubtitleSegment } from '../src/types'

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ok  ${name}`)
  } else {
    fail += 1
    console.error(`FAIL  ${name}  ${detail}`)
  }
}

function seg(start: number, end: number, text: string): SubtitleSegment {
  return { id: `s${start}_${end}`, start, end, text, origin: text, issues: [] }
}

/* ---- 繁转简 ---- */
check('繁转简：改變 -> 改变', toSimplified('人工智能正在改變我們的生活方式') === '人工智能正在改变我们的生活方式')
check('繁转简：无繁体时原样返回', toSimplified('简体原样') === '简体原样')
check('繁转简：西文不受影响', toSimplified('Hello, world! 3.5') === 'Hello, world! 3.5')

/* ---- 标点后处理 ---- */
const OPT: PunctuationOptions = { zh: 'strip-split', en: 'keep' }

{
  const r = applyPunctuation([seg(0, 2, '今天我们聊一聊，开放式耳机。')], OPT)
  check('中文 strip-split：切成两条', r.segments.length === 2, JSON.stringify(r.segments.map((s) => s.text)))
  check('切分后无停顿标点', r.segments.every((s) => !/[，。]/.test(s.text)))
  check('切分条数统计', r.splitCount === 1)
  check('时间边界衔接', r.segments[0].end === r.segments[1].start)
  check('时间覆盖原区间', r.segments[0].start === 0 && r.segments[1].end === 2)
}

{
  const r = applyPunctuation([seg(0, 2, '价格是3.5元，一共1,000件。')], OPT)
  check('小数点与千分位保留', r.segments.some((s) => s.text.includes('3.5')) && r.segments.some((s) => s.text.includes('1,000')), JSON.stringify(r.segments.map((s) => s.text)))
}

{
  const r = applyPunctuation([seg(0, 2, '他说"你好"之后离开了。')], OPT)
  check('引号不被删除', r.segments.some((s) => s.text.includes('"')), JSON.stringify(r.segments.map((s) => s.text)))
}

{
  const en = [seg(0, 2, 'Hello, world. This is great!')]
  const r = applyPunctuation(en, OPT)
  check('西文默认保留', r.segments[0].text === 'Hello, world. This is great!')
}

{
  const r = applyPunctuation([seg(0, 2, '人工智能正在改變我們的生活方式。')], OPT)
  check('繁体先转简再切分', r.segments[0].text === '人工智能正在改变我们的生活方式', JSON.stringify(r.segments.map((s) => s.text)))
}

{
  // 全部是标点的条目：不生成空条目
  const r = applyPunctuation([seg(0, 2, '。。。')], OPT)
  check('纯标点条目原样保留', r.segments.length === 1 && r.segments[0].text === '。。。')
}

/* ---- 合并 ---- */
{
  const list = [seg(0, 1, 'ab'), seg(1.5, 2.5, 'cd'), seg(3, 4, 'ef')]
  const r = mergeSelected(list, [list[0].id, list[1].id])
  check('合并：连续两条', r !== null && r.list.length === 2)
  check('合并：文本相接', r?.merged.text === 'ab cd', JSON.stringify(r?.merged.text))
  check('合并：间隙被覆盖', r?.merged.start === 0 && r?.merged.end === 2.5)
  const gap = mergeSelected(list, [list[0].id, list[2].id])
  check('合并：不连续拒绝', gap === null)
}

/* ---- 分割 ---- */
{
  const list = [seg(0, 4, 'abcd')]
  const r = splitSegment(list, list[0].id, 1)
  check('分割：一分为二', r !== null && r.list.length === 2)
  check('分割：按字数比例', r?.a.end === 1 && r?.b.start === 1, `${r?.a.end}/${r?.b.start}`)
  check('分割：文本对半', r?.a.text === 'a' && r?.b.text === 'bcd')
  check('分割：边界外拒绝', splitSegment(list, list[0].id, 0) === null)
  check('分割：边界外拒绝2', splitSegment(list, list[0].id, 4) === null)
}

/* ---- 按时间点分割（时间轴上的一刀） ---- */
{
  const bi = (text: string, translations: Record<string, string>): SubtitleSegment => ({
    ...seg(0, 4, text),
    translations: { ...translations },
  })

  // 时间按刀口切开，文本整段复制到两段上
  {
    const list = [bi('今天天气不错', { en: 'Nice weather today' })]
    const r = splitSegmentAtTime(list, list[0].id, 1.5)
    check('按时间分割：两段', r !== null && r.list.length === 2)
    check(
      '按时间分割：时间按刀口切，两段首尾相接不重叠',
      r?.a.end === 1.5 && r?.b.start === 1.5 && r?.a.start === 0 && r?.b.end === 4,
      `${r?.a.start}-${r?.a.end} / ${r?.b.start}-${r?.b.end}`,
    )
    check(
      '按时间分割：文本不截断，两段都是完整原文（不按时间比例猜断点）',
      r?.a.text === '今天天气不错' && r?.b.text === '今天天气不错',
      `${r?.a.text} / ${r?.b.text}`,
    )
    check(
      '按时间分割：译文同样整段复制',
      r?.a.translations?.en === 'Nice weather today' &&
        r?.b.translations?.en === 'Nice weather today',
    )
    check(
      '按时间分割：原文标红待确认',
      (r?.a.staleSlots ?? []).includes(SOURCE_SLOT) &&
        (r?.b.staleSlots ?? []).includes(SOURCE_SLOT),
      JSON.stringify([r?.a.staleSlots, r?.b.staleSlots]),
    )
    check(
      '按时间分割：译文也标红',
      (r?.a.staleSlots ?? []).includes('en') && (r?.b.staleSlots ?? []).includes('en'),
    )
    // 两段必须各拿一份引用：共享的话改一段的译文会连带改到另一段
    check(
      '按时间分割：两段的译文是各自独立的引用',
      r !== null && r.a.translations !== r.b.translations,
    )
    check(
      '按时间分割：两段的 staleSlots 也是各自的数组',
      r !== null && r.a.staleSlots !== r.b.staleSlots,
    )
    check(
      '按时间分割：修改一段的译文不影响另一段',
      (() => {
        if (!r) return false
        r.a.translations!.en = 'CHANGED'
        return r.b.translations?.en === 'Nice weather today'
      })(),
    )
  }

  // 位置校验：贴边的一刀切不出有意义的条目
  {
    const list = [seg(10, 12, 'abcd')]
    check(
      '按时间分割：贴着起点拒绝',
      splitSegmentAtTime(list, list[0].id, 10) === null &&
        splitSegmentAtTime(list, list[0].id, 10 + MIN_SEGMENT_SEC / 2) === null,
    )
    check(
      '按时间分割：贴着终点拒绝',
      splitSegmentAtTime(list, list[0].id, 12) === null &&
        splitSegmentAtTime(list, list[0].id, 12 - MIN_SEGMENT_SEC / 2) === null,
    )
    check('按时间分割：id 不存在时返回 null', splitSegmentAtTime(list, 'nope', 11) === null)
    check('按时间分割：换行的 id 不会误伤别人', list.length === 1 && list[0].text === 'abcd')
  }

  // 没有内容就没有可确认的东西，不该莫名其妙标红
  {
    const list = [seg(0, 4, '')]
    const r = splitSegmentAtTime(list, list[0].id, 2)
    check(
      '按时间分割：空文本不标红（标了也没有可改的东西）',
      r !== null && !r.a.staleSlots && !r.b.staleSlots,
      JSON.stringify([r?.a.staleSlots, r?.b.staleSlots]),
    )
  }
}

/* ---- 泳道布局（时间轴多轨） ---- */
{
  const make = (id: string, start: number, end: number): SubtitleSegment => ({
    ...seg(start, end, id),
    id,
  })

  // 互不重叠 → 全都待在第 0 条泳道上
  {
    const list = [make('a', 0, 1), make('b', 1, 2), make('c', 2, 3)]
    const l = assignLanes(list)
    check(
      '泳道：首尾相接算不重叠，共用一条泳道',
      l.laneCount === 1 && [...l.laneOf.values()].every((v) => v === 0),
      JSON.stringify([...l.laneOf]),
    )
  }

  // 重叠 → 自动分层
  {
    const list = [make('a', 0, 3), make('b', 1, 4), make('c', 2, 5)]
    const l = assignLanes(list)
    check('泳道：三条全重叠 → 三层', l.laneCount === 3, String(l.laneCount))
    check(
      '泳道：同一泳道上不许有时间重叠',
      l.laneOf.get('a') === 0 && l.laneOf.get('b') === 1 && l.laneOf.get('c') === 2,
      JSON.stringify([...l.laneOf]),
    )
  }

  // 让位复用：b 与 a 重叠占 1，c 与 a 不重叠 → 回到 0
  {
    const list = [make('a', 0, 2), make('b', 1, 3), make('c', 2.5, 4)]
    const l = assignLanes(list)
    check(
      '泳道：前面的泳道让开了就复用（不无脑往下堆）',
      l.laneOf.get('c') === 0 && l.laneCount === 2,
      JSON.stringify([...l.laneOf]),
    )
  }

  // 输入顺序不影响结果：这是「键盘改时间码后自动重排」不会抖的前提
  {
    const list = [make('a', 0, 3), make('b', 1, 4), make('c', 2, 5)]
    const shuffled = [list[2], list[0], list[1]]
    const l1 = assignLanes(list)
    const l2 = assignLanes(shuffled)
    check(
      '泳道：结果与输入顺序无关',
      l1.laneCount === l2.laneCount &&
        [...l1.laneOf].every(([id, lane]) => l2.laneOf.get(id) === lane),
    )
  }

  // 空输入不该崩，也不该占用泳道
  check('泳道：空数组返回 0 层', assignLanes([]).laneCount === 0)

  // 邻居查询：拖边界时的夹取对象
  {
    const list = [make('a', 0, 2), make('b', 1, 3), make('c', 2.5, 4)]
    const l = assignLanes(list)
    const nb = laneNeighbours(list, l.laneOf, 'c', l.laneOf.get('c') ?? 0)
    check(
      '泳道邻居：只认同一条泳道上的，隔层的邻居不算',
      nb.prev?.id === 'a' && nb.next === null,
      JSON.stringify([nb.prev?.id, nb.next?.id]),
    )
    const nbFirst = laneNeighbours(list, l.laneOf, 'a', 0)
    check('泳道邻居：第一条没有左邻', nbFirst.prev === null && nbFirst.next?.id === 'c')
  }

  /* ---- 同时重叠的条数上限（5 条） ---- */

  check('泳道上限：常量就是 5', MAX_LANES === 5, String(MAX_LANES))

  // 5 条恰好铺满，不算超
  {
    const list = [0, 1, 2, 3, 4].map((n) => make(`s${n}`, 0, 4))
    check(
      '泳道上限：5 条同时重叠不算超限',
      assignLanes(list).laneCount === 5 && overflowLaneIds(list).size === 0,
      String(assignLanes(list).laneCount),
    )
  }

  // 第 6 条才算超，而且**只有它**该被标出来（前 5 条是正常的）
  {
    const list = [0, 1, 2, 3, 4, 5].map((n) => make(`s${n}`, 0, 4))
    const over = overflowLaneIds(list)
    check(
      '泳道上限：第 6 条同时重叠时只标出超出的那一条',
      assignLanes(list).laneCount === 6 && over.size === 1 && over.has('s5'),
      JSON.stringify([...over]),
    )
  }

  // 试算：改一条的时间码会不会把总量推到第 6 层
  {
    const list = [0, 1, 2, 3, 4].map((n) => make(`s${n}`, 0, 4))
    list.push(make('extra', 20, 22))
    check(
      '泳道上限试算：把外面的条挪进来会超限',
      exceedsLaneLimit(list, { id: 'extra', start: 1, end: 3 }) === true,
    )
    check(
      '泳道上限试算：挪到没人的地方不超限',
      exceedsLaneLimit(list, { id: 'extra', start: 25, end: 27 }) === false,
    )
    check(
      '泳道上限试算：整条平移到空处不超限（按位移那一路）',
      exceedsLaneLimitByShift(list, 'extra', 3) === false &&
        exceedsLaneLimitByShift(list, 'extra', -17) === true,
    )
    // 补丁只给一侧时，另一侧必须保持原值：end 若掉成 0，`1..0` 就是个非法区间，
    // 试算会得出「没超限」这个假结论
    check(
      '泳道上限试算：只给起点时终点保持原值（1..22 压住全部 5 条）',
      exceedsLaneLimit(list, { id: 'extra', start: 1 }) === true,
    )
  }

  /*
   * 「只把终点拉长」要真的能压到别人，就得把额外的条放在 5 条叠着的**前面**——
   * 放在后面（`20..22` 对面 `0..4`）无论终点怎么拉长都够不着它们，那样的用例
   * 只是在测「没压到别人 = 不超限」，和 `end: 19` 那条重复。
   */
  {
    const list = [0, 1, 2, 3, 4].map((n) => make(`s${n}`, 20, 24))
    list.push(make('extra', 15, 17))
    check(
      '泳道上限试算：只给终点、拉长到压住别人也会算出超限',
      exceedsLaneLimit(list, { id: 'extra', end: 21 }) === true,
    )
    check(
      '泳道上限试算：只给终点、没压到别人就不算超限',
      exceedsLaneLimit(list, { id: 'extra', end: 19 }) === false,
    )
  }
}

/* ---- 按时间槽搬运内容（拖动排序） ---- */
{
  const withTr = (id: string, start: number, end: number, text: string, tr: string): SubtitleSegment => ({
    ...seg(start, end, text),
    id,
    translations: { en: tr },
    staleSlots: ['en'],
  })

  const list = [
    withTr('s1', 0, 2, '第一句', 'one'),
    withTr('s2', 2, 4, '第二句', 'two'),
    withTr('s3', 4, 6, '第三句', 'three'),
  ]

  const moved = moveContentTo(list, 0, 2)
  check(
    '拖动排序：内容搬到目标序号，中间的整体让位一格',
    moved !== null &&
      moved.map((s) => s.text).join(',') === '第二句,第三句,第一句' &&
      moved.map((s) => s.translations?.en).join(',') === 'two,three,one',
    JSON.stringify(moved?.map((s) => s.text)),
  )
  check(
    '拖动排序：时间码原地不动（搬的是内容，不是位置）',
    moved !== null &&
      moved.map((s) => `${s.start}-${s.end}`).join(',') === '0-2,2-4,4-6',
    JSON.stringify(moved?.map((s) => [s.start, s.end])),
  )
  check(
    '拖动排序：条目 id 留在时间槽上（选中与历史指向不会乱跳）',
    moved !== null && moved.map((s) => s.id).join(',') === 's1,s2,s3',
  )
  check(
    '拖动排序：「待确认」标记跟着内容走',
    moved !== null && moved[2].staleSlots?.join() === 'en' && moved[0].staleSlots?.join() === 'en',
  )
  check(
    '拖动排序：新的译文对象是独立的（不会两行共享同一份引用）',
    moved !== null && moved[2].translations !== list[0].translations,
  )
  check('拖动排序：原地放下返回 null（不白占一格历史）', moveContentTo(list, 1, 1) === null)
  check('拖动排序：下标越界返回 null', moveContentTo(list, 0, 9) === null)

  // 前后互换：只动两条，中间没有别人时结果就是交换
  const swapped = moveContentTo(list, 0, 1)
  check(
    '拖动排序：相邻两条互换内容',
    swapped !== null && swapped.map((s) => s.text).join(',') === '第二句,第一句,第三句',
    JSON.stringify(swapped?.map((s) => s.text)),
  )
}

/* ---- 按播放头批量分割 ---- */
{
  /*
   * 注意 `seg()` 只收 (start, end, text)，**id 是由时间码推出来的**（`s0_6`）。
   * 想给条目起名必须显式覆盖 id —— 早先这里写成 `seg(0, 6, '上一条', 'a')`，
   * 第 4 个参数被静默忽略，于是 stack 里三条的 id 变成 `s0_6 / s0_6 / s8_12`：
   * 「两条叠着的」其实是两条**同名**条目，而 `splitSegmentsAtTime(stack, ['a','b'])`
   * 因为 `a`/`b` 根本不存在而返回 null —— 断言全挂。探针数据永远是真实形状，
   * 这类「参数传了但没生效」只能靠断言本身把 id 读出来比对。
   */
  const withId = (id: string, start: number, end: number, text: string): SubtitleSegment => ({
    ...seg(start, end, text),
    id,
  })
  const stack = [
    withId('a', 0, 6, '上一条'),
    withId('b', 0, 6, '下一条'),
    withId('c', 8, 12, '远处的一条'),
  ]

  // 播放头压着两条叠着的：两条都该被选中为刀口对象
  {
    const hits = splittableAtTime(stack, 3)
    check(
      '时间点分割：叠着的两条都算命中（无选中时「谁被压着就切谁」）',
      hits.length === 2 && hits.map((s) => s.id).join() === 'a,b',
      JSON.stringify(hits.map((s) => s.id)),
    )
  }

  // 有选中时以选中为范围：远处那条被选中也能切
  {
    const hits = splittableAtTime(stack, 3, ['c'])
    check('时间点分割：指定选中范围时不越界到别的条', hits.length === 0, String(hits.length))
    const hits2 = splittableAtTime(stack, 10, ['c'])
    check('时间点分割：选中范围内命中就算数', hits2.length === 1 && hits2[0].id === 'c')
  }

  // 贴着首尾不算命中（否则会切出零长条目）
  {
    check('时间点分割：压在起点上不算命中', splittableAtTime(stack, 0).length === 0)
    check('时间点分割：压在终点上不算命中', splittableAtTime(stack, 6).length === 0)
    check('时间点分割：贴着边界一点点也不算命中', splittableAtTime(stack, 0.01).length === 0)
  }

  // 批量切：一次切两条要合成一个结果，不能只留最后一条
  {
    const result = splitSegmentsAtTime(stack, ['a', 'b'], 3)
    check(
      '时间点分割：一次切多条时全部落盘（不是只留最后一条）',
      result !== null && result.list.length === 5 && result.created.length === 2,
      JSON.stringify([result?.list.length, result?.created.length]),
    )
    check(
      '时间点分割：批量切出的两段文本都是整段复制并标红',
      result !== null &&
        result.created.every((s) => s.text === '上一条' || s.text === '下一条') &&
        result.created.every((s) => (s.staleSlots ?? []).includes('source')),
    )
  }

  check(
    '时间点分割：一条都切不成时返回 null（调用方据此给提示）',
    splitSegmentsAtTime(stack, ['c'], 3) === null,
  )
}

/* ---- 忽略告警：只抑制展示与计数，不动数据 ---- */
{
  const flagged: SubtitleSegment = {
    ...seg(0, 4, '有问题的字幕'),
    issues: [
      { level: 'error', code: 'OVERLAP', message: '与上一条的时间码重叠' },
      { level: 'warning', code: 'TOO_LONG', message: '单条时长过长' },
    ],
  }
  const acked: SubtitleSegment = { ...flagged, acked: true }

  check(
    '忽略告警：未忽略时原样展示',
    visibleIssues(flagged).length === 2,
    String(visibleIssues(flagged).length),
  )
  check('忽略告警：忽略后展示层拿不到任何问题', visibleIssues(acked).length === 0)
  check(
    '忽略告警：**数据层的 issues 不动**（取消忽略后还能回来）',
    acked.issues.length === 2,
    String(acked.issues.length),
  )

  const counts = countIssues([flagged, acked, { ...seg(10, 12, '干净的', 'c'), issues: [] }])
  check(
    '忽略告警：不计入错误 / 警告条数',
    counts.errors === 1 && counts.warnings === 0,
    JSON.stringify(counts),
  )
  /*
   * `countIssues` 的口径是**每条只算一次**：有 error 就算进 errors，否则才算 warnings。
   * 上面那条 `counts.warnings === 0` 正是这么来的 —— `flagged` 同时带着 error 与
   * warning，它只进 errors。所以要验「忽略也会屏蔽 warning」，对照物不能是 `flagged`
   * （它本来就进不了 warnings），必须用一个**只有 warning** 的条目。
   */
  const warnOnly: SubtitleSegment = {
    ...seg(0, 4, '只有一条警告的字幕'),
    issues: [{ level: 'warning', code: 'TOO_LONG', message: '单条时长过长' }],
  }
  check(
    '忽略告警：整条忽略时连警告也不计（不是只屏蔽 error）',
    countIssues([warnOnly]).warnings === 1 &&
      countIssues([{ ...warnOnly, acked: true }]).warnings === 0,
    JSON.stringify([countIssues([warnOnly]), countIssues([{ ...warnOnly, acked: true }])]),
  )
}

/* ---- 分割 / 合并：多语言槽位 ---- */
{
  const bi = (text: string, translations: Record<string, string>): SubtitleSegment => ({
    ...seg(0, 4, text),
    translations: { ...translations },
  })

  // 光标在原文上：原文被切开，译文两段都拿完整内容并标红
  {
    const list = [bi('abcd', { en: 'ABCD' })]
    const r = splitSegment(list, list[0].id, 2)
    check('分割原文：原文按光标切开', r?.a.text === 'ab' && r?.b.text === 'cd')
    check(
      '分割原文：译文两段都是完整内容（不去猜另一侧的断点）',
      r?.a.translations?.en === 'ABCD' && r?.b.translations?.en === 'ABCD',
      `${r?.a.translations?.en} / ${r?.b.translations?.en}`,
    )
    check(
      '分割原文：译文标红待确认',
      r?.a.staleSlots?.includes('en') === true && r?.b.staleSlots?.includes('en') === true,
      JSON.stringify(r?.a.staleSlots),
    )
    check('分割原文：原文自己不标红（它被正确切开了）', r?.a.staleSlots?.includes(SOURCE_SLOT) !== true)
    check('分割原文：时间码按原文字符比例', r?.a.end === 2 && r?.b.start === 2, `${r?.a.end}/${r?.b.start}`)
  }

  // 光标在译文上：译文被切开，原文两段都拿完整内容并标红
  {
    const list = [bi('你好世界', { en: 'Hello world' })]
    const r = splitSegment(list, list[0].id, 5, 'en')
    check(
      '分割译文：译文按光标切开',
      r?.a.translations?.en === 'Hello' && r?.b.translations?.en === ' world',
      `${JSON.stringify(r?.a.translations?.en)} / ${JSON.stringify(r?.b.translations?.en)}`,
    )
    check(
      '分割译文：原文两段都是完整内容并被标红',
      r?.a.text === '你好世界' &&
        r?.b.text === '你好世界' &&
        r?.a.staleSlots?.includes(SOURCE_SLOT) === true &&
        r?.b.staleSlots?.includes(SOURCE_SLOT) === true,
      `${r?.a.text} / ${r?.b.text} / ${JSON.stringify(r?.a.staleSlots)}`,
    )
    check('分割译文：被切的那一侧自己不标红', r?.a.staleSlots?.includes('en') !== true)
    check(
      '分割译文：时间码按译文字符比例（5/11）',
      r?.a.end === Number((4 * (5 / 11)).toFixed(3)),
      String(r?.a.end),
    )
  }

  // 空槽位没有可改的东西，不该标红
  {
    const list = [bi('abcd', { en: '' })]
    const r = splitSegment(list, list[0].id, 2)
    check('分割：空的槽位不标红', r?.a.staleSlots === undefined, JSON.stringify(r?.a.staleSlots))
  }

  // 合并：各语言分别拼接，合并本身不产生标红
  {
    const list = [
      { ...seg(0, 1, '你好'), translations: { en: 'Hello' } },
      { ...seg(1.2, 2, '世界'), translations: { en: 'world' } },
    ]
    const r = mergeSelected(list, [list[0].id, list[1].id])
    check('合并：原文相接', r?.merged.text === '你好世界', String(r?.merged.text))
    check('合并：译文各自相接（中文直接相接，不跟着原文乱补空格）', r?.merged.translations?.en === 'Hello world', String(r?.merged.translations?.en))
    check('合并：不因为合并而标红', r?.merged.staleSlots === undefined, JSON.stringify(r?.merged.staleSlots))
  }

  // 但原本就没人确认过的槽位，不该被一次合并洗白
  {
    const list = [
      { ...seg(0, 1, '你好'), translations: { en: 'Hello' }, staleSlots: ['en'] },
      { ...seg(1.2, 2, '世界'), translations: { en: 'world' }, staleSlots: ['en'] },
    ]
    const r = mergeSelected(list, [list[0].id, list[1].id])
    check(
      '合并：原有的待确认标记会继承下来',
      r?.merged.staleSlots?.includes('en') === true,
      JSON.stringify(r?.merged.staleSlots),
    )
  }

  // 改过之后标红才消失
  {
    const s: SubtitleSegment = { ...seg(0, 1, 'a'), translations: { en: 'A' }, staleSlots: ['en', SOURCE_SLOT] }
    check('改过之后只清掉该槽位', clearStale(s, 'en').staleSlots?.join(',') === SOURCE_SLOT)
    check(
      '清掉最后一个后字段整体移除（不留下空数组）',
      clearStale({ ...s, staleSlots: ['en'] }, 'en').staleSlots === undefined,
    )
    check('本来就没标红的槽位原对象返回', clearStale(s, 'ja') === s)
  }

  // 槽位读写
  {
    const s: SubtitleSegment = { ...seg(0, 1, 'a'), translations: { en: 'A', ja: '' } }
    check('slotText：读原文', slotText(s, SOURCE_SLOT) === 'a')
    check('slotText：读译文', slotText(s, 'en') === 'A')
    check('slotText：读不存在的语言给空串', slotText(s, 'ko') === '')
    check(
      'withSlotText：写原文不碰译文',
      withSlotText(s, SOURCE_SLOT, 'b').text === 'b' && withSlotText(s, SOURCE_SLOT, 'b').translations?.en === 'A',
    )
    check(
      'withSlotText：写译文不碰原文',
      withSlotText(s, 'en', 'B').text === 'a' && withSlotText(s, 'en', 'B').translations?.en === 'B',
    )
  }

  // 合并产物上分割出的条目，两段都要继续带来源标记
  {
    const src: SubtitleSegment = { ...seg(0, 2, 'abcd'), originFileId: 'f1' }
    const r = splitSegment([src], src.id, 2)
    check('分割出的两段都带来源标记（否则重新拼接时会被当成孤儿）', r?.a.originFileId === 'f1' && r?.b.originFileId === 'f1')
  }
}

/* ---- 插入 ---- */
{
  const gap = { thresholdSec: 2, keepGapSec: 0, limitEnabled: true, maxDurationSec: 2 }
  const list = [seg(0, 1, 'a'), seg(4, 5, 'b')]
  const r1 = insertRangeAt(list, 0, gap)
  check('插入：空位充足取上限 2 秒', r1?.start === 1 && r1?.end === 3, JSON.stringify(r1))
  const list2 = [seg(0, 1, 'a'), seg(1.05, 5, 'b')]
  const r2 = insertRangeAt(list2, 0, gap)
  check('插入：空位不足拒绝', r2 === null, JSON.stringify(r2))
  const list3 = [seg(0, 1, 'a'), seg(1.2, 5, 'b')]
  const r2b = insertRangeAt(list3, 0, gap)
  check('插入：0.2 秒空位允许插入', r2b?.start === 1 && r2b?.end === 1.2, JSON.stringify(r2b))
  const gapOff = { thresholdSec: 2, keepGapSec: 0, limitEnabled: false, maxDurationSec: 2 }
  const r3 = insertRangeAt(list, 0, gapOff)
  check('插入：关闭限制时空位 3 秒全取', r3?.end === 4, JSON.stringify(r3))
}

/* ---- 删除 ---- */
{
  const list = [seg(0, 1, 'a'), seg(1, 2, 'b'), seg(2, 3, 'c')]
  check('删除：按 id 移除', removeIds(list, [list[0].id, list[2].id]).length === 1)
}

/* ---- SRT 序列化 ---- */
{
  check('SRT 时间码', srtTime(3661.5) === '01:01:01,500')
  const srt = serializeSrt([seg(0.5, 2, '你好'), seg(3, 4.2, '世界')])
  check('SRT 序列化', srt.startsWith('1\n00:00:00,500 --> 00:00:02,000\n你好\n\n2\n'), JSON.stringify(srt.slice(0, 60)))
}

/* ---- 字幕解析 ---- */
{
  // SRT：逗号毫秒 + 序号行 + CRLF
  const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\n你好世界\r\n\r\n2\r\n00:00:03.000 --> 00:00:04,000\r\n第二行A\r\n第二行B\r\n'
  const r = parseSubtitle(srt, 'srt')
  check('SRT 解析：条数', r.format === 'srt' && r.segments.length === 2, JSON.stringify(r.segments))
  check('SRT 解析：逗号毫秒', r.segments[0].start === 1 && r.segments[0].end === 2.5, JSON.stringify(r.segments[0]))
  check('SRT 解析：点号毫秒也接受', r.segments[1].start === 3)
  check('SRT 解析：多行文本', r.segments[1].text === '第二行A\n第二行B', JSON.stringify(r.segments[1].text))
}

{
  // VTT：WEBVTT 头 + cue 设置 + NOTE 块
  const vtt = 'WEBVTT\n\nNOTE 这是注释\n\n00:00:01.000 --> 00:00:02.000 position:50%\n带设置的条目\n\nwrong line\n\n00:00:03.000 --> 00:00:04.000\n正常条目\n'
  const r = parseSubtitle(vtt, 'vtt')
  check('VTT 解析：跳过头与注释', r.format === 'vtt' && r.segments.length === 2, JSON.stringify(r.segments))
  check('VTT 解析：cue 设置不混入文本', r.segments[0].text === '带设置的条目', JSON.stringify(r.segments[0].text))
}

{
  // ASS：Format 行定字段序、文本含逗号、覆盖标签与 \N
  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Outline, Alignment, MarginV, Encoding',
    'Style: Default,Microsoft YaHei,60,&H00FFFFFF,0,2,2,48,1',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,带{\i1}样式{\i0}的\\N文本，还有逗号',
  ].join('\n')
  const r = parseSubtitle(ass, 'ass')
  check('ASS 解析：条数', r.format === 'ass' && r.segments.length === 1, JSON.stringify(r.segments))
  check('ASS 解析：时间', r.segments[0]?.start === 1 && r.segments[0]?.end === 2.5, JSON.stringify(r.segments[0]))
  check(
    'ASS 解析：剥标签还原换行且保留逗号',
    r.segments[0]?.text === '带样式的\n文本，还有逗号',
    JSON.stringify(r.segments[0]?.text),
  )
}

{
  // 序列化 → 解析的往返一致
  const origin = [seg(0.5, 2, '第一句'), seg(2.5, 4, '第二句, 带标点')]
  const back = parseSubtitle(serializeSrt(origin), 'srt')
  check('SRT 往返：条数一致', back.segments.length === 2)
  check('SRT 往返：文本一致', back.segments.every((s, i) => s.text === origin[i].text))
  check('SRT 往返：时间一致', back.segments.every((s, i) => s.start === origin[i].start && s.end === origin[i].end))
}

{
  // 坏数据容错：无时间码的行被忽略，时间乱序时重排
  const messy = '随便一行\n00:00:05,000 --> 00:00:06,000\n后句\n\n垃圾\n\n00:00:01,000 --> 00:00:02,000\n前句\n'
  const r = parseSubtitle(messy, 'srt')
  check('容错：坏行忽略且按时间排序', r.segments.length === 2 && r.segments[0].text === '前句', JSON.stringify(r.segments))
}

/* ---- 提示词构建（内置词库） ---- */
{
  const r = buildPrompt({ terms: '小包, XBAOS\n小包', lexiconIds: [] })
  check('热词去重并注入', r.usedTerms.join(',') === '小包,XBAOS' || r.usedTerms.join(',') === '小包、XBAOS', JSON.stringify(r.usedTerms))
  check('热词按顿号拼接', r.prompt.includes('小包'), r.prompt)

  const withLex = buildPrompt({ terms: '', lexiconIds: ['tech'] })
  check('词库风格句注入', withLex.prompt.includes('数码产品评测'), withLex.prompt.slice(0, 40))
  check('词库核心词注入', withLex.prompt.includes('处理器') && withLex.prompt.includes('刷新率'))
  check('单库时核心词不被截断', !withLex.truncated && withLex.droppedCore.length === 0)
  check('预算不足时先舍弃扩展词', withLex.dropped.length > 0 && withLex.usedTerms.includes('处理器'), `dropped=${withLex.dropped.length}`)

  const all = buildPrompt({ terms: '', lexiconIds: LEXICONS.map((l) => l.id) })
  check('五库全选触发核心词截断', all.truncated && all.droppedCore.length > 0, `chars=${all.chars} droppedCore=${all.droppedCore.length}`)
  check('截断后不超预算', all.chars <= 110, `chars=${all.chars}`)

  // 同一个词在提示词里只应出现一次（去重）
  const dup = buildPrompt({ terms: '处理器', lexiconIds: ['tech'] })
  const occurrences = dup.prompt.split('处理器').length - 1
  check('热词与词库重复时只注入一次', occurrences === 1, `出现 ${occurrences} 次`)

  check('汉字计费为 1', promptCharCost('显卡') === 2)
  check('标点不收费', promptCharCost('、，。') === 0)
  check('热词拆分支持中英文分隔', splitTerms('a,b、c\nd').length === 4, JSON.stringify(splitTerms('a,b、c\nd')))
}

/* ---- 两遍策略：词条精选 ---- */
{
  const text = '今天我们聊聊显万和处理器，还有续航表现。'
  const picked = pickPresentTerms(text, ['tech'])
  check('精确命中被挑出', picked.includes('处理器') && picked.includes('续航'), JSON.stringify(picked))
  check('一字之差也能捞回', picked.includes('显卡'), JSON.stringify(picked))
  check('未出现的词不入选', !picked.includes('水冷'), JSON.stringify(picked))
  check('无关双字词不被误捞', pickPresentTerms('今天天气不错，心情很好', ['tech']).length === 0, JSON.stringify(pickPresentTerms('今天天气不错，心情很好', ['tech'])))
  check('空文本返回空', pickPresentTerms('', ['tech']).length === 0)
}

/* ---- 多遍整合 ---- */
{
  check('重复退化：正常文本为 0', repetitionPenalty('今天我们来聊聊字幕生成器的准确率优化方案') === 0)
  const looped = repetitionPenalty('好的好的好的好的好的好的好的好的好的好的')
  check('重复退化：循环文本被识别', looped > 0.5, String(looped))

  const run = (text: string, avgLogprob: number, noSpeech = 0): RecognitionRun => ({
    temperature: 0,
    segments: [seg(0, 2, text)],
    stats: { avgLogprob, noSpeechRatio: noSpeech, count: 1 },
  })

  const good = run('今天我们来聊聊显卡和处理器', -0.1)
  const bad = run('今天我们来聊聊显卡和处理器', -1.2)
  check('打分：高置信度更高分', scoreRun(good) > scoreRun(bad), `${scoreRun(good)} vs ${scoreRun(bad)}`)
  check('打分：无语音占比扣分', scoreRun(run('测试', -0.1, 0.5)) < scoreRun(run('测试', -0.1, 0)))

  check('相似度：自比为 1', diceSimilarity('abc', 'abc') === 1)
  check('相似度：完全不同为 0', diceSimilarity('abcd', '甲乙丙丁') === 0)
  const near = diceSimilarity('今天我们来聊聊显卡', '今天我们来聊聊处理器')
  check('相似度：部分相同在 0~1 之间', near > 0 && near < 1, String(near))

  /* ---- 文案纠偏的吻合度（覆盖率）----
   *
   * 用户实测回归：他粘贴的是**整期视频的旁白稿**（730 字），识别结果只是其中
   * 一段（百来字）。内容明明包含在文案里，界面却报「相似度约 30%，差异过大」，
   * 直接拒绝交给 AI。根因就是拿对称 Dice 去比长度差一个量级的两段文本。
   */
  const longScript =
    '大家好欢迎回到这一期的节目今天我们要聊的是开放式耳机这类产品这两年增长得非常快' +
    '我手上这三款都是今年的新品价格从四百多一直到一千出头先说结论最贵的那个不一定最好' +
    '我们先从佩戴说起开放式耳机最大的优势就是不堵耳道长时间戴着不会有明显的胀痛感' +
    '但代价是低频的量感会明显少一些这是物理结构决定的不是调音能解决的第二点是漏音控制' +
    '在安静的办公室里音量开到六成半米之外基本听不清具体内容三款里面有两款做到了这个水平'
  const shortSubtitle = '开放式耳机最大的优势就是不堵耳道长时间戴着不会有明显的胀痛感'
  const diceScore = diceSimilarity(shortSubtitle, longScript)
  const coverScore = containmentSimilarity(shortSubtitle, longScript)
  check('覆盖率：长稿包住短字幕时给高分', coverScore > 0.95, String(coverScore))
  check(
    '覆盖率：同输入下对称 Dice 被长度差压死（就是那个 bug）',
    diceScore < 0.5 && coverScore > diceScore + 0.4,
    `dice=${diceScore.toFixed(2)} cover=${coverScore.toFixed(2)}`,
  )
  check(
    '覆盖率：子集方向（只贴了其中一段）同样给高分',
    containmentSimilarity(longScript, shortSubtitle) > 0.95,
    String(containmentSimilarity(longScript, shortSubtitle)),
  )

  // 标点、繁简、大小写、空白都不该影响判定（识别结果走的是去标点管道，稿子带标点）
  const scriptZh = '那么以上就是本期视频的全部内容也欢迎各位在评论区补充我是小包我们下期再见'
  const scriptTrad =
    '那麼以上就是本期視頻的全部內容，也歡迎各位在評論區補充。我是小包，我們下期再見！'
  check(
    '归一化：标点与繁体不扣分',
    containmentSimilarity(scriptZh, scriptTrad) > 0.95,
    String(containmentSimilarity(scriptZh, scriptTrad)),
  )
  check(
    '归一化：去空白并统一小写',
    normalizeForCompare('Hello World!') === 'helloworld',
    normalizeForCompare('Hello World!'),
  )

  // 反例：内容无关时必须仍然很低，否则这个门槛就白设了
  const unrelatedScore = containmentSimilarity(
    '今天我们来聊聊显卡的性能表现',
    '本期节目我们前往云南拍摄野生动物纪录片',
  )
  check('覆盖率：无关内容仍然很低', unrelatedScore < 0.3, String(unrelatedScore))
  // 只有一两个词的极短输入才退回对称判据，否则覆盖率本身就是噪声
  check(
    '覆盖率：极短文本不虚高',
    containmentSimilarity('好的', '好的好的好的') < 1,
    String(containmentSimilarity('好的', '好的好的好的')),
  )
  // 十几字的短句仍要按覆盖率算（demo 场景就是这种长度）。
  // 曾经把「不足 20 个 bigram 就退回 Dice」写死，结果真吻合的短句反被低估成 0.67。
  check(
    '覆盖率：十几字的短句不被长度差压低',
    containmentSimilarity(
      '大家好欢迎来到本期节目今天我们聊一聊显卡这个东西',
      '今天我们聊一聊显卡这个东西',
    ) > 0.95,
    String(
      containmentSimilarity(
        '大家好欢迎来到本期节目今天我们聊一聊显卡这个东西',
        '今天我们聊一聊显卡这个东西',
      ),
    ),
  )

  const single = mergeRuns([good])
  check('单遍直接采用', single.method === 'single' && runText(single.best) === '今天我们来聊聊显卡和处理器')

  // 两遍相近 + 一遍跑飞：MBR 应选中多数派
  const a = run('今天我们来聊聊显卡和处理器', -0.2)
  const b = run('今天我们来聊聊显卡和处理器性能', -0.2)
  const c = run('好的好的好的好的好的好的好的好的好的好的', -0.2)
  const merged = mergeRuns([a, b, c])
  check('退化候选被剔除', runText(merged.best).includes('显卡'), runText(merged.best))
  check('整合方式为共识挑选', merged.method === 'mbr', merged.method)
  check('整合理由非空', merged.reason.length > 0)

  // 全部退化：走兜底并给出提示
  const allBad = mergeRuns([
    run('算了算了算了算了算了算了算了算了算了算了', -0.2),
    run('好吧好吧好吧好吧好吧好吧好吧好吧好吧好吧', -0.3),
  ])
  check('全退化走兜底分支', allBad.method === 'fallback', allBad.method)
  check('兜底理由提示复核', allBad.reason.includes('复核'), allBad.reason)
}

/* ---- 推理深度档位 ---- */
{
  check('标准档 1 遍', depthPreset('standard').passes === 1)
  check('增强档 3 遍', depthPreset('enhanced').passes === 3)
  const deep = depthPreset('deep')
  check('深度档 5 遍且温度阶梯齐全', deep.passes === 5 && deep.temperatures.length === 5)
  check('深度档温度递增', deep.temperatures.every((t, i) => i === 0 || t > deep.temperatures[i - 1]))
  check('深度档开启两遍策略', deep.twoPass)
  check('未知档位回落标准', depthPreset('???').id === 'standard')
}

/* ---- 低置信度复核 ---- */
{
  const confSeg = (start: number, end: number, text: string, logprob: number): SubtitleSegment => ({
    ...seg(start, end, text),
    avgLogprob: logprob,
  })

  // 反例先行：阈值之上的段绝不能被圈进复核区间，否则复核就变成全篇重跑
  check(
    '高置信段不触发复核',
    planRescueRanges([confSeg(0, 4, '大家应该都能听清', -0.2)], 10).length === 0,
  )
  check('阈值本身为负且接近 -0.45', LOW_CONF_LOGPROB < 0 && LOW_CONF_LOGPROB > -0.6)

  const ranges = planRescueRanges(
    [confSeg(10, 14, '这段不太可信', -0.6), confSeg(14.2, 18, '这段也不可信', -0.5), confSeg(30, 32, '还行', -0.55)],
    60,
  )
  check('低置信段圈出复核区间', ranges.length === 2, JSON.stringify(ranges))
  check('区间前后留了余量', Math.abs(ranges[0].start - 9.7) < 1e-9, JSON.stringify(ranges[0]))
  check('相邻低置信段并成一个区间', ranges[0].end - ranges[0].start > 8, JSON.stringify(ranges[0]))
  check('过短的低置信碎片被丢弃', planRescueRanges([confSeg(0, 0.5, '嗯', -0.9)], 10).length === 0)
  // 60s 的低置信区间必须切开：引擎单窗 30s，复核区间不能超过它的上限
  const longRanges = planRescueRanges([confSeg(0, 60, '很长', -0.6)], 61)
  check('超长区间被切开', longRanges.length === 3, JSON.stringify(longRanges))

  // 替换裁决：新结果置信度更高才换，否则保留原文
  const original = [confSeg(10, 14, '识别错了的字', -0.6), confSeg(20, 24, '没问题', -0.1)]
  const range0 = [{ start: 9.7, end: 14.3 }]
  const better = applyRescue(original, [confSeg(10, 14, '识别正确的字', -0.2)], range0)
  check('复核结果更好才替换', better.replaced === 1, JSON.stringify(better))
  check(
    '替换后保留未涉及的段落',
    better.segments.some((s) => s.text === '没问题'),
  )
  check('替换后按时间有序', better.segments.every((s, i) => i === 0 || s.start >= better.segments[i - 1].start))

  const worse = applyRescue(original, [confSeg(10, 14, '反而更差了', -0.8)], range0)
  check('复核结果更差时保留原文', worse.replaced === 0 && worse.segments.some((s) => s.text === '识别错了的字'))
  // 复核没覆盖到区间时不能有任何动作
  const miss = applyRescue(original, [confSeg(40, 44, '别处的结果', -0.1)], range0)
  check('复核区间无新结果时不动原文', miss.replaced === 0)
}

/* ---- VAD 场景预设 ---- */
{
  check('内置场景数量充足', VAD_PRESETS.length >= 10, String(VAD_PRESETS.length))
  const ids = new Set(VAD_PRESETS.map((p) => p.id))
  check('场景 id 无重复', ids.size === VAD_PRESETS.length)
  // 每个场景的参数必须完整独立 —— 不允许「继承默认、只覆盖两三个字段」的写法，
  // 否则将来单独微调某个场景时会牵连其他场景
  check(
    '每个场景 8 项参数全部显式给出',
    VAD_PRESETS.every((p) =>
      [
        p.options.minSpeechSec,
        p.options.minSilenceSec,
        p.options.longSilenceSec,
        p.options.noisePercentile,
        p.options.startFactor,
        p.options.stopFactor,
        p.options.targetSec,
        p.options.overlapSec,
      ].every((v) => typeof v === 'number' && Number.isFinite(v)),
    ),
  )
  check('每个场景判停不高于起判（滞回有意义）', VAD_PRESETS.every((p) => (p.options.stopFactor ?? 0) <= (p.options.startFactor ?? 0)))
  check('每个场景单块目标不超引擎上限', VAD_PRESETS.every((p) => (p.options.targetSec ?? 0) <= 28 && (p.options.targetSec ?? 0) >= 8))
  check('未知场景回退通用', vadPreset('nope').id === 'general')
  check('关键字过滤命中', filterVadPresets('讲座').some((p) => p.id === 'lecture'))
  check('关键字过滤可空', filterVadPresets('  ').length === VAD_PRESETS.length)
}

/* ---- 折行与超长拆分（lineWrap） ---- */
{
  const SPEC = { maxCharsPerLine: 16, maxCharsPerLineEn: 42, maxLinesPerSegment: 1 }

  // 反例先行：旧实现的 bug 是「装不下就丢字」，这条断言必须真抓住那个行为
  const long = seg(0, 10, '你用浏览器的无痕浏览防控网站真的没人知道吗') // 21 字
  const one = applyLineWrap([long], SPEC)
  const total = one.segments.map((s) => s.text.replace(/\n/g, '')).join('')
  check('拆分后文字一个不丢', total === long.text, total)
  check('超长条被拆成多条', one.segments.length === 2, String(one.segments.length))
  check('每条都不超单行上限', one.segments.every((s) => widthUnits(s.text) <= 32))
  check('拆分条时间首尾相接', Math.abs(one.segments[0].end - one.segments[1].start) < 1e-9)
  check('拆分条时间不越界', one.segments[0].start === 0 && one.segments[1].end === 10)
  check('拆分条按宽度分时长', one.segments[0].end - one.segments[0].start > one.segments[1].end - one.segments[1].start)
  check('原条目文本不被就地改动', long.text.includes('没人知道吗'))

  // 装得下 → 折行；再次运行 → 幂等，不能越折越碎
  const wrapCase = seg(0, 6, '很多人觉得打开这个模式就等于在互联网上穿上了隐身衣')
  const again = applyLineWrap(applyLineWrap([wrapCase], SPEC).segments, SPEC)
  check('二次折行幂等', again.rewrapped === 0 && again.splitCount === 0, JSON.stringify(again))

  // 标点断点：标点落在容量内时，贴着标点断而不是硬切
  const punct = applyLineWrap(
    [seg(0, 8, '今天我们聊聊无痕浏览，很多人其实都用过它')],
    { ...SPEC, maxCharsPerLine: 12 },
  )
  check(
    '优先在标点后断行',
    punct.segments.some((s) => /[，。]$/.test(s.text.replace(/\n/g, ''))),
    JSON.stringify(punct.segments.map((s) => s.text)),
  )

  // 英文按词断，不从单词中间切
  const en = applyLineWrap(
    [seg(0, 8, 'private browsing mode keeps your history hidden from other users')],
    { maxCharsPerLine: 16, maxCharsPerLineEn: 20, maxLinesPerSegment: 1 },
  )
  check(
    '英文单词不被切断',
    en.segments.every((s) => s.text.split(/\s+/).every((w) => w.length <= 20)),
    JSON.stringify(en.segments.map((s) => s.text)),
  )

  // 短条与空条原样通过，引用不变
  const short = seg(0, 2, '大家好')
  const empty = seg(2, 4, '')
  const untouched = applyLineWrap([short, empty], SPEC)
  check('短条与空条不动', untouched.segments[0] === short && untouched.segments[1] === empty)

  // 译文标红：原文被折行的条目，其译文必须带待确认标记
  const withTr = { ...seg(0, 8, '这条字幕被折行了所以译文需要确认'), translations: { en: 'translated text' } }
  const flagged = applyLineWrap([withTr], { ...SPEC, maxCharsPerLine: 6 })
  check('折行后译文标红待确认', (flagged.segments[0].staleSlots ?? []).includes('en'), JSON.stringify(flagged.segments[0]))
}

/* ---- 实验功能隐藏守门（源码扫描） ---- */
{
  const readSource = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const home = readSource('src/views/HomeView.vue')
  check('场景切分开关已从 UI 隐藏', !home.includes('settings.vadSceneEnabled'))
  check('束搜索开关已从 UI 隐藏', !home.includes('settings.beamSearch'))
  check('低置信复核开关已从 UI 隐藏', !home.includes('settings.lowConfRescue'))
  check('手动束宽输入已从 UI 隐藏', !home.includes('settings.beamSize'))
  const settingsSrc = readSource('src/stores/settings.ts')
  check('load() 强制复位实验功能', settingsSrc.includes('merged.vadSceneEnabled = false'))
  check('实验功能默认关闭', settingsSrc.includes('beamSearch: false'))
}

/* ---- 标题栏毛玻璃守门（源码扫描） ---- */
{
  const readSource = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const mainJs = readSource('electron/main.js')
  // 不支持的环境必须提前判掉：Mica 选项在 Win10 上要么抛错要么没效果
  check('主进程按 Win11 22H2 (build 22621) 判支持', mainJs.includes('22621'))
  check('Mica 开启时窗口底色全透明', mainJs.includes("'#00000000'"))
  check('主题与毛玻璃共用副本文件且先读后并', mainJs.includes('writeThemeState'))
  const css = readSource('src/styles/global.css')
  check('玻璃透明化规则挂在 html.glass 上', css.includes('html.glass .app'))
  check('标题栏半透明规则存在', css.includes('html.glass .titlebar'))
  const settingsSrc = readSource('src/stores/settings.ts')
  check('毛玻璃默认开启', settingsSrc.includes('glassEnabled: true'))
  const preload = readSource('electron/preload.cjs')
  check('首屏玻璃状态经启动参数注入', preload.includes('--xbaos-glass='))
  // 材质选型：Mica 的底是壁纸色调且整体偏不透明，深色下看不出透；Acrylic 模糊真实背景
  check(
    '材质常量是 Acrylic',
    mainJs.includes("const GLASS_MATERIAL = 'acrylic'") && mainJs.includes('backgroundMaterial: GLASS_MATERIAL'),
  )
  const lightCss = readSource('src/styles/theme-light.css')
  const darkCss = readSource('src/styles/theme-dark.css')
  check(
    '浅色标题栏用主界面底色（用 surface 会拉出色带）',
    lightCss.includes('--glass-titlebar-bg: color-mix(in srgb, var(--color-bg-base)'),
  )
  check(
    '深浅两套标题栏遮罩同一底色系（色调才统一）',
    darkCss.includes('--glass-titlebar-bg: color-mix(in srgb, var(--color-bg-base) 62%, transparent)'),
  )
  // 深色主题有「媒体查询 + 显式选择器」两块，改一处必漏另一处
  check(
    '深色两处块都定义了毛玻璃令牌',
    darkCss.split('--glass-titlebar-bg').length - 1 === 2,
    `出现 ${darkCss.split('--glass-titlebar-bg').length - 1} 次`,
  )
  check(
    '壳层令牌也是两份（标题栏 + 下方界面）',
    lightCss.includes('--glass-shell-bg') && darkCss.split('--glass-shell-bg').length - 1 === 2,
  )
  // 两级拆分的理由：材质只看「头顶所有层透过率相乘」，页脚条压在内容遮罩之上就只剩 1%
  check(
    '壳层分两级（外壳 + 内容区）',
    lightCss.includes('--glass-region-bg') &&
      css.includes('background: var(--glass-shell-bg') &&
      css.includes('background: var(--glass-region-bg'),
  )
  check(
    '页脚条自己不再铺底（否则材质透不出来）',
    /html\.glass \.view__foot,\s*\nhtml\.glass \.editor__foot \{\s*background: transparent;/.test(css),
  )
  // 两层半透明相叠 = 透过率相乘 ≈ 0.6%，材质等于白做 —— 外壳这一层必须不铺底
  check(
    '应用外壳不铺底（避免两层半透明相叠）',
    /html\.glass \.app \{\s*background: transparent;/.test(css),
  )
  check('标题栏文字提档 + 光晕', css.includes('--glass-text-halo') && css.includes('html.glass .titlebar__name'))
  check(
    '三个窗口共用毛玻璃选项',
    mainJs.split('const glass = glassWindowOptions(headless)').length - 1 === 3,
    `出现 ${mainJs.split('const glass = glassWindowOptions(headless)').length - 1} 次`,
  )
}

/* ---- AI 校对：提示词构建 ---- */
{
  const BASE: ReviewPromptOptions = {
    language: 'zh',
    autoDetectLanguage: false,
    punctuation: { zh: 'strip-split', en: 'keep' },
    maxCharsPerLine: 16,
    maxCharsPerLineEn: 42,
    maxLinesPerSegment: 2,
    maxSegmentDuration: 7,
  }
  const segs = [seg(0, 2.5, '大家好欢迎来到本期节目'), seg(2.5, 6, '今天我们聊一聊显卡')]
  const built = buildReviewPrompt({
    targets: [{ fileName: 'a.wav', durationSec: 6, segments: segs }],
    options: BASE,
  })
  check('提示词包含字幕正文', built.prompt.includes('今天我们聊一聊显卡'))
  check('提示词带上片长（最后一条的结束时间）', built.prompt.includes('00:00:06,000'))
  check('统计条数正确', built.segmentCount === 2, String(built.segmentCount))
  check('文件数正确', built.fileCount === 1, String(built.fileCount))
  check('短字幕不触发超长警告', built.overLimit === false)

  const many = Array.from({ length: 400 }, (_, i) =>
    seg(i, i + 1, `这是第 ${i} 条用来撑长度的字幕内容`),
  )
  const big = buildReviewPrompt({
    targets: [{ fileName: 'big.wav', durationSec: 400, segments: many }],
    options: BASE,
  })
  check('长字幕触发超长警告', big.overLimit === true, String(big.charCount))
  check('阈值常量在合理区间', PROMPT_CHAR_WARN > 4000 && PROMPT_CHAR_WARN < 40000)

  const blank = buildReviewPrompt({
    targets: [{ fileName: 'b.wav', durationSec: 1, segments: [seg(0, 1, '   ')] }],
    options: BASE,
  })
  check('全空白字幕条数为 0', blank.segmentCount === 0)
  check('token 估算可用', estimatePromptTokens(1600) === 1000)
}

/* ---- AI 校对：提示词随本地设置动态变化 ---- */
{
  const oneSeg = [seg(0, 2.5, '大家好欢迎来到本期节目')]
  const build = (options: Partial<ReviewPromptOptions>) =>
    buildReviewPrompt({
      targets: [{ fileName: 'a.wav', durationSec: 6, segments: oneSeg }],
      options: {
        language: 'zh',
        autoDetectLanguage: false,
        punctuation: { zh: 'strip-split', en: 'keep' },
        maxCharsPerLine: 16,
        maxCharsPerLineEn: 42,
        maxLinesPerSegment: 2,
        maxSegmentDuration: 7,
        ...options,
      },
    })

  // 用户报过的 bug：设置明确「中文去标点」，提示词却要 AI「补齐标点」
  const strip = build({}).prompt
  check('去标点设置下不再要求补标点', !strip.includes('补齐或修正标点符号'))
  check('去标点设置下明确禁止加标点', strip.includes('不要给字幕添加任何标点符号'))
  check('strip-split 要求按停顿拆成两条', strip.includes('应当拆成两条'))

  const keep = build({ punctuation: { zh: 'keep', en: 'keep' } }).prompt
  check('保留标点设置下才要求补标点', keep.includes('补齐或修正标点符号'))
  check('保留标点设置下不出现禁止加标点', !keep.includes('不要给字幕添加任何标点符号'))

  const spec = build({ maxCharsPerLine: 12, maxCharsPerLineEn: 30, maxLinesPerSegment: 3 }).prompt
  check('字幕规格写入中文单行上限', spec.includes('每一行不超过 12 字'))
  check('字幕规格写入单条上限', spec.includes('单条不超过 36 字'))
  check('字幕规格写入英文上限', spec.includes('每一行不超过 30 个字符'))
  check('字幕规格写入时长上限', spec.includes('单条持续时间不超过 7 秒'))
  check('合并必须有上限约束', spec.includes('宁可不合并'))

  check('时长上限为 0 时不写入规格', !build({ maxSegmentDuration: 0 }).prompt.includes('单条持续时间不超过'))
  check('英文识别时角色为多语言字幕编辑', build({ language: 'en' }).prompt.includes('多语言字幕编辑'))
  check('中文识别时角色为中文字幕编辑', build({}).prompt.includes('中文字幕编辑'))

  check('无热词时不出现专有名词段', !build({}).prompt.includes('【专有名词参照】'))
  const withTerms = build({ terms: ['XBAOS', '显卡'] }).prompt
  check('有热词时出现专有名词段', withTerms.includes('【专有名词参照】'))
  check('专有名词写进提示词', withTerms.includes('XBAOS'))
}

/* ---- AI 校对：多文件分段 ---- */
{
  const options: ReviewPromptOptions = {
    language: 'zh',
    autoDetectLanguage: false,
    punctuation: { zh: 'strip-split', en: 'keep' },
    maxCharsPerLine: 16,
    maxCharsPerLineEn: 42,
    maxLinesPerSegment: 2,
    maxSegmentDuration: 7,
  }
  const multi = buildReviewPrompt({
    targets: [
      { fileName: 'a.wav', durationSec: 6, segments: [seg(0, 2, '第一段的第一句')] },
      { fileName: 'b.wav', durationSec: 4, segments: [seg(0, 2, '第二段的第一句')] },
    ],
    options,
  })
  check('多文件带出文件数', multi.fileCount === 2, String(multi.fileCount))
  check(
    '多文件写入文件分隔行',
    multi.prompt.includes('【文件 1/2】a.wav') && multi.prompt.includes('【文件 2/2】b.wav'),
  )
  check('多文件要求原样保留分隔行', multi.prompt.includes('一个都不能少'))
  check('多文件要求不跨文件累计时间', multi.prompt.includes('不要跨文件累计'))
  check('多文件不写全片时长', !multi.prompt.includes('全片总时长不要超过'))
  check('多文件统计条数合计', multi.segmentCount === 2, String(multi.segmentCount))

  const single = buildReviewPrompt({
    targets: [{ fileName: 'a.wav', durationSec: 6, segments: [seg(0, 2, '只有一段')] }],
    options,
  })
  check('单文件不出现分隔行', !single.prompt.includes('【文件 1/1】'))
  check('单文件写全片时长', single.prompt.includes('全片总时长不要超过'))
}

/* ---- AI 校对：文案纠偏段落 ---- */
{
  const options: ReviewPromptOptions = {
    language: 'zh',
    autoDetectLanguage: false,
    punctuation: { zh: 'strip-split', en: 'keep' },
    maxCharsPerLine: 16,
    maxCharsPerLineEn: 42,
    maxLinesPerSegment: 2,
    maxSegmentDuration: 7,
  }
  const targets = [{ fileName: 'a.wav', durationSec: 6, segments: [seg(0, 2, '今天聊显卡')] }]
  const withScript = buildReviewPrompt({
    targets,
    options: { ...options, script: '今天我们聊一聊显卡这个东西' },
  })
  check('有文案时出现文案段', withScript.prompt.includes('【原文案参考】'))
  check('文案正文写进提示词', withScript.prompt.includes('今天我们聊一聊显卡这个东西'))
  check('文案锚点句在提示词里', withScript.prompt.includes('文稿用来纠正「写错的字」'))
  check(
    '文案禁止补入没说过的内容',
    withScript.prompt.includes('不要把文稿里有、但朗读中没有的内容补进字幕'),
  )

  check('无文案时不出现文案段', !buildReviewPrompt({ targets, options }).prompt.includes('【原文案参考】'))
  check(
    '空白文案也不出现文案段',
    !buildReviewPrompt({ targets, options: { ...options, script: '   \n  ' } }).prompt.includes(
      '【原文案参考】',
    ),
  )
}

/* ---- AI 校对：多文件输出的切块 ---- */
{
  const RAW = [
    '【文件 1/2】a.wav',
    '1',
    '00:00:00,000 --> 00:00:02,000',
    '第一段',
    '',
    '【文件 2/2】b.wav',
    '1',
    '00:00:00,000 --> 00:00:03,000',
    '第二段',
  ].join('\n')
  const split = splitByFileMarks(RAW)
  check('多文件输出切出两块', split.blocks.length === 2, String(split.blocks.length))
  check('切块保留文件名', split.blocks[0]?.name === 'a.wav' && split.blocks[1]?.name === 'b.wav')
  check(
    '切块正文归属正确',
    split.blocks[0].text.includes('第一段') && !split.blocks[0].text.includes('第二段'),
  )
  check(
    '各块可独立解析',
    parseModelOutput(split.blocks[0].text, 2).cues.length === 1 &&
      parseModelOutput(split.blocks[1].text, 3).cues.length === 1,
  )
  check(
    '全角斜杠的分隔行也识别',
    splitByFileMarks('【文件 1／2】x.wav\n1\n00:00:00,000 --> 00:00:01,000\n内容').blocks.length === 1,
  )
  const noMark = splitByFileMarks('1\n00:00:00,000 --> 00:00:01,000\n内容')
  check('没有分隔行时不产生块', noMark.blocks.length === 0 && noMark.hasMarks === false)
  check('分隔行齐全时 leading 是空的', split.leading.trim() === '', JSON.stringify(split.leading))
  const lead = splitByFileMarks(['开场白一句', '【文件 2/3】b.wav', '1', '有内容'].join('\n'))
  check(
    '首个分隔行之前的内容落在 leading 里（供上层补回被吞掉的第一个文件）',
    lead.blocks.length === 1 && lead.leading.includes('开场白一句'),
    JSON.stringify({ n: lead.blocks.length, leading: lead.leading }),
  )
}

/* ---- AI 校对：模型输出解析 ---- */
{
  const SRT_OK = [
    '1',
    '00:00:00,000 --> 00:00:02,500',
    '大家好，欢迎来到本期节目',
    '',
    '2',
    '00:00:02,500 --> 00:00:06,000',
    '今天我们聊一聊显卡',
  ].join('\n')

  const ok = parseModelOutput(SRT_OK, 10)
  check('标准 SRT 解析出 2 条', ok.cues.length === 2 && !ok.error, String(ok.error))
  check('时间码换算正确', ok.cues[0].start === 0 && ok.cues[1].end === 6)
  check('无校验警告', ok.warnings.length === 0, ok.warnings.join('；'))

  // 提示词要求了不用围栏、不加寒暄，但模型经常不听话，解析必须自己扛住
  const messy = ['好的，以下是校对后的字幕：', '', '```srt', SRT_OK, '```', '', '希望对你有帮助！'].join('\n')
  const parsedMessy = parseModelOutput(messy, 10)
  check('剥离围栏与寒暄后仍解析出 2 条', parsedMessy.cues.length === 2, String(parsedMessy.cues.length))
  check('正文没被寒暄污染', parsedMessy.cues[0].text === '大家好，欢迎来到本期节目', parsedMessy.cues[0].text)

  const tight = [
    '00:00:00,000 --> 00:00:02,500',
    '第一条',
    '00:00:02,500 --> 00:00:06,000',
    '第二条',
  ].join('\n')
  check('缺序号且条间不空行也能解析', parseModelOutput(tight, 10).cues.length === 2)

  const vttLike = [
    '1',
    '00:00:00.000 --> 00:00:02.500',
    '甲',
    '',
    '2',
    '00:00:02.500 --> 00:00:06.000',
    '乙',
  ].join('\n')
  check('点号毫秒（VTT 风格）也能解析', parseModelOutput(vttLike, 10).cues.length === 2)

  check('stripNoise 剥掉围栏', stripNoise('```srt\nA\n```').trim() === 'A')
  check('空剪贴板报错', parseModelOutput('   ', 10).error !== null)
  check('无关闲聊报错', parseModelOutput('你好，请问有什么可以帮你的吗？', 10).error !== null)

  const overlap = [
    '1',
    '00:00:00,000 --> 00:00:05,000',
    '甲',
    '',
    '2',
    '00:00:03,000 --> 00:00:08,000',
    '乙',
  ].join('\n')
  check(
    '时间码重叠给出警告',
    parseModelOutput(overlap, 20).warnings.some((w) => w.includes('重叠')),
    parseModelOutput(overlap, 20).warnings.join('；'),
  )

  const reversed = ['1', '00:00:05,000 --> 00:00:02,000', '甲'].join('\n')
  check(
    '结束早于开始给出警告',
    parseModelOutput(reversed, 20).warnings.some((w) => w.includes('结束时间')),
  )

  const tooLong = ['1', '00:00:00,000 --> 00:00:50,000', '甲'].join('\n')
  check(
    '超出原片长给出警告',
    parseModelOutput(tooLong, 10).warnings.some((w) => w.includes('多出')),
    parseModelOutput(tooLong, 10).warnings.join('；'),
  )
}

/* ---- AI 校对：写回转换与概览 ---- */
{
  const prev = [seg(0, 2, '原来的第一句'), seg(2, 4, '原来的第二句')]
  const cues = [
    { start: 0, end: 2, text: '改过的第一句' },
    { start: 2, end: 4, text: '原来的第二句' },
  ]

  const next = cuesToSegments(cues, prev)
  check('时间码原样带入', next[0].start === 0 && next[1].end === 4)
  check('id 优先复用原文（保住选中态）', next[0].id === prev[0].id && next[1].id === prev[1].id)
  check('origin 与 text 一致', next[0].origin === next[0].text)
  check('旧的校验问题被清空', next[0].issues.length === 0)

  const more = cuesToSegments([...cues, { start: 4, end: 6, text: '新增的一句' }], prev)
  check(
    '多出的条目获得新 id',
    more.length === 3 && more[2].id !== prev[0].id && more[2].id !== prev[1].id,
  )

  const sum = summarizeReview(cues, prev)
  check('概览记录条数', sum.before === 2 && sum.after === 2)
  check('概览统计变化条数', sum.changed === 1, String(sum.changed))
  check('概览只列变化项', sum.previews.length === 1 && sum.previews[0].index === 1)

  const del = summarizeReview([cues[0]], prev)
  check('条数减少也被记录', del.before === 2 && del.after === 1)
  check('被删除的条目出现在预览里', del.previews.some((p) => p.after === ''))
}

/* ---- 跨进程纯化（toPlain）----
 *
 * 背景：Electron 的 IPC 走结构化克隆，V8 对任何 JSProxy 一律拒收并抛
 * `An object could not be cloned.`。Pinia store 里的数据、`ref` 里的数组
 * 全都是 Vue 的深度代理，所以「把 store 数据直接扔给 IPC」这条路径曾经
 * 让 AI 校对窗口完全打不开。这里用 structuredClone 直接复现与验证。
 */
{
  /**
   * 造一个深度代理，模拟 Vue 的 reactive / ref。
   *
   * 基本类型必须原样返回 —— 给字符串/数字套 Proxy 会直接抛
   * `Cannot create proxy with a non-object as target`，那样「基准用例」
   * 会因为抛错而被误判成「克隆失败」。
   */
  const deepProxy = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value
    const target = value as Record<string, unknown>
    for (const key of Object.keys(target)) target[key] = deepProxy(target[key])
    return new Proxy(target, {})
  }

  // 先证明「坑」是真的：原生代理确实不能过结构化克隆
  let rawCloneFailed = false
  try {
    structuredClone(deepProxy({ id: 's1', issues: [] }))
  } catch {
    rawCloneFailed = true
  }
  check('深度代理直接结构化克隆会失败（这就是打不开窗口的根因）', rawCloneFailed)

  const reactiveSegment = deepProxy({
    id: 's1',
    start: 0,
    end: 2,
    text: '你好',
    origin: '你好',
    issues: [{ level: 'warn', message: '太短' }],
  })

  // 纯化后必须能被克隆 —— 这正是修复的关键
  let plainCloneFailed = false
  let cloned: Record<string, unknown> | null = null
  try {
    cloned = structuredClone(toPlain(reactiveSegment)) as Record<string, unknown>
  } catch {
    plainCloneFailed = true
  }
  check('toPlain 之后可以安全跨进程克隆', !plainCloneFailed)
  check(
    '嵌套数组也一并解掉（浅展开做不到）',
    Array.isArray((cloned as { issues?: unknown[] })?.issues) &&
      (cloned as { issues: unknown[] }).issues.length === 1,
  )
  check('纯化保留全部字段', cloned?.id === 's1' && cloned?.text === '你好' && cloned?.end === 2)

  // 必须是深拷贝：改副本不能影响原数据，否则编辑器会被静默改脏
  ;(cloned as { text: string }).text = '被改过了'
  check('纯化是深拷贝，不会反向改脏原数据', (reactiveSegment as { text: string }).text === '你好')

  // 列表版本
  const list = toPlainList([deepProxy({ id: 'a' }), deepProxy({ id: 'b' })])
  let listOk = true
  try {
    structuredClone(list)
  } catch {
    listOk = false
  }
  check('toPlainList 处理代理数组', listOk && list.length === 2 && list[1].id === 'b')

  // 边界：null / undefined 原样返回，不能抛
  check('null 原样返回', toPlain(null) === null)
  check('undefined 原样返回', toPlain(undefined) === undefined)
}

/* ---- 架构不变量：跨进程传参必须在渲染层纯化 ----
 *
 * 这是没法用「跑一次」来兜住的规则：只有真实点按钮才会走到，而且失败的
 * 表现只是「点了没反应」。所以直接扫源码，把这条约定钉死。
 */
{
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

  const editorSrc = readSource('src/views/EditorView.vue')
  check(
    'EditorView：assist.open 的实参经过 toPlain 纯化',
    /assist\.open\(\{[\s\S]{0,400}?toPlain\(/.test(editorSrc),
    'assist.open({ ... segments: toPlain(file.segments) ... })',
  )

  const assistSrc = readSource('src/views/AssistView.vue')
  check(
    'AssistView：assist.submit 的实参经过 toPlain 纯化',
    /\bsubmit\(\{[\s\S]{0,300}?toPlain\(/.test(assistSrc),
    'submit({ fileId, cues: toPlain(outcome.value.cues) })',
  )
}

/* ---- 架构不变量：AI 辅助窗口的窗口行为与覆盖预警 ----
 *
 * 这一组全是「改一个数字、删一行就悄悄退化」的类型，而且退化之后功能照样能用：
 * 窗口被钉在最前挡住别的窗口、关窗后主界面留在后台找不回来、确认框默认按钮落在
 * 「清空译文」上顺手回车就过 —— 都要等真实用户撞上才暴露。所以扫源码钉死。
 */
{
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

  const mainSrc = readSource('electron/main.js')
  check(
    '辅助窗口不默认置顶（置顶按钮保留，但不预设开启）',
    !/alwaysOnTop:\s*true/.test(mainSrc),
    'electron/main.js 里又出现了 alwaysOnTop: true',
  )
  check(
    '辅助窗口关闭后一次性拉起主界面',
    /assistWindow\.on\(\s*['"]closed['"][\s\S]{0,400}?raiseMainWindow\(\)/.test(mainSrc),
    "assistWindow.on('closed') 里应调用 raiseMainWindow()",
  )
  check(
    '拉起主界面不动置顶状态（只 restore / show / focus）',
    /function raiseMainWindow[\s\S]{0,300}?focus\(\)/.test(mainSrc) &&
      !/function raiseMainWindow[\s\S]{0,300}?setAlwaysOnTop/.test(mainSrc),
    'raiseMainWindow 应是 restore/show/focus，不得顺手 setAlwaysOnTop',
  )
  check(
    '辅助窗口关闭时通知渲染层解锁（否则主界面永久压暗）',
    /send\(\s*['"]assist:closed['"]/.test(mainSrc),
    "assistWindow.on('closed') 里应 send('assist:closed', true)",
  )

  const assistView = readSource('src/views/AssistView.vue')
  check(
    '辅助窗口的「置顶」按钮初始态为关闭',
    /const onTop = ref\(false\)/.test(assistView),
    'onTop 初始值应为 false（挂载后由 isAlwaysOnTop() 校正）',
  )

  const confirmSrc = readSource('src/utils/confirm.ts')
  check(
    '覆盖预警走系统原生对话框（应用内浮层会被别的窗口整个盖住）',
    /dialog\.confirm\(/.test(confirmSrc),
    '应调用 bridge.dialog.confirm',
  )
  check(
    '覆盖预警的默认按钮是「取消」（不顺手回车就过）',
    /defaultId:\s*1/.test(confirmSrc) && /cancelId:\s*1/.test(confirmSrc),
    'defaultId / cancelId 都应指向第 1 个按钮（取消）',
  )

  const editorSrc2 = readSource('src/views/EditorView.vue')
  check(
    '两个 AI 入口都在开窗前先问后果',
    (editorSrc2.match(/confirmDestructive\(/g) ?? []).length >= 2,
    'AI 校对与 AI 翻译各需要一处 confirmDestructive',
  )
  check(
    '开窗成功后把主界面锁上',
    (editorSrc2.match(/ui\.setAssistActive\(true\)/g) ?? []).length >= 2,
    '两个 openAi* 的成功路径末尾都应调用 ui.setAssistActive(true)',
  )
}

/* ---- 架构不变量：关窗保护、任务栏进度、长列表渲染 ----
 *
 * 这一组同样是「删一行、换个写法就悄悄退化，退化之后功能照样跑」的类型：
 * 关窗不再问一句（用户一小时的校对白做）、进度条不更新（最小化后彻底失联）、
 * 行内退回全表线性查找（长音频每帧上千万次比较）。都要等真实用户撞上才暴露。
 */
{
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

  const mainSrc = readSource('electron/main.js')
  check(
    '主窗口拦截 close 并交给渲染进程裁决',
    /mainWindow\.on\(\s*['"]close['"][\s\S]{0,400}?app:close-request/.test(mainSrc),
    "mainWindow.on('close') 里应发 app:close-request",
  )
  check(
    '关窗有看门狗兜底（渲染进程卡死时窗口仍关得掉）',
    /closeWatchdog\s*=\s*setTimeout\(/.test(mainSrc),
    '应有 setTimeout 看门狗，否则渲染进程无响应时只能杀进程',
  )
  check(
    '窗口尺寸按屏幕工作区动态算，不再写死',
    /screen\.getPrimaryDisplay\(\)/.test(mainSrc) && !/width:\s*1360,/.test(mainSrc),
    '应使用 screen.getPrimaryDisplay().workAreaSize 推导尺寸',
  )
  check(
    '首屏底色按用户设置的外观算（不是系统主题）',
    /resolvedStartupTheme/.test(mainSrc) &&
      // 毛玻璃开启时底色必须是全透明（材质要透出来），否则回退按主题算
      /backgroundColor: glass\.active \? '#00000000' : startupTheme/.test(mainSrc),
    '固定浅色 + 深色系统时不该先闪一块黑',
  )
  check(
    '识别进度推到任务栏',
    /setProgressBar\(/.test(mainSrc),
    "应调用 mainWindow.setProgressBar()",
  )
  check(
    '任务完成提醒先看窗口在不在前台（在前台就不闪）',
    /ipcMain\.on\(\s*['"]app:flash['"][\s\S]{0,400}?isFocused\(\)[\s\S]{0,160}?flashFrame\(true\)/.test(
      mainSrc,
    ),
    '用户就坐在窗口前面时闪烁纯属噪音，只有被盖住或最小化才需要提醒',
  )
  check(
    '窗口获得焦点时自动停闪',
    /mainWindow\.on\(\s*['"]focus['"][\s\S]{0,220}?flashFrame\(false\)/.test(mainSrc),
    'Windows 上 flashFrame(true) 会一直闪到窗口获得焦点，不主动停会闪得人心烦',
  )

  const appSrc = readSource('src/App.vue')
  check(
    '关窗请求先回执再算未保存内容（撤掉看门狗）',
    /ackCloseRequest\(\)/.test(appSrc),
    '确认框可能等用户很久，看门狗不能按它计时',
  )
  check(
    '关窗确认走原生对话框且默认落在取消上',
    /confirmDestructive\(/.test(appSrc) && /仍要关闭/.test(appSrc),
    '尚未保存的岔路口不该顺手回车就过',
  )
  check(
    '任务栏进度由任务栈统一驱动（没有任务时置 -1 清除）',
    /ui\.taskProgress/.test(appSrc) && /api\.setProgress\(task \?/.test(appSrc),
    '应 watch(ui.taskProgress) 推 app.setProgress —— 别再退回「只认识别」',
  )
  check(
    '识别用 hasTask 判断「是不是已经在跑」，而不是看栈顶',
    /ui\.hasTask\(TASK_RECOGNIZE\)/.test(appSrc),
    '拿栈顶当判据的话：识别在模型下载之后开始时，每次进度更新都会把下载挤下去',
  )
  check(
    '识别结束才提醒（区分「本来在跑」与「本来就没跑」）',
    /wasRecognizing[\s\S]{0,200}?ui\.flashTaskBar\(\)/.test(appSrc),
    '不判旧值的话启动瞬间就会闪一下任务栏',
  )

  const subSrc = readSource('src/components/SubtitleTable.vue')
  /*
   * 判据取的是**函数签名 + 函数体**，不是全文里有没有 `isEdited(seg.id)` 这个串 ——
   * 注释里正好写着这行反例（说明为什么要改），全文匹配会被自己的注释打成假失败。
   */
  const isEditedDef = /function isEdited\([^)]*\)[^}]*}/.exec(subSrc)?.[0] ?? ''
  const worstDef = /function worstLevel\([^)]*\)[^}]*}/.exec(subSrc)?.[0] ?? ''
  check(
    '行内派生标记直接吃条目对象（否则每行一次全表扫描）',
    isEditedDef.includes('seg: SubtitleSegment') &&
      worstDef.includes('seg: SubtitleSegment') &&
      !isEditedDef.includes('segments.value.find') &&
      !worstDef.includes('segments.value.find'),
    `isEdited: ${isEditedDef.slice(0, 60)} / worstLevel: ${worstDef.slice(0, 60)}`,
  )
  check(
    '选中判定用 Set（全选时每行一次 includes 会退化成 O(n²)）',
    /selectedSet\.has\(/.test(subSrc),
    '应使用 selectedSet 而不是 editor.selectedIds.includes',
  )

  const historySrc = readSource('src/stores/history.ts')
  check(
    '无变化的提交会完整回退（含重做栈）',
    /bucket\.future = futureBackup/.test(historySrc),
    '只回滚 past 会把重做栈顺手清掉：撤销后再跑一次空操作，重做就没了',
  )

  const preloadSrc = readSource('electron/preload.cjs')
  check(
    'preload 暴露关窗的三个动作（缺一个窗口就要白等看门狗）',
    /onCloseRequest:/.test(preloadSrc) &&
      /ackCloseRequest:/.test(preloadSrc) &&
      /forceClose:/.test(preloadSrc),
    'onCloseRequest / ackCloseRequest / forceClose 缺一不可',
  )
  check(
    'preload 暴露首屏主题与偏好同步',
    /initial: injectedTheme/.test(preloadSrc) && /persist:/.test(preloadSrc),
    'theme.initial 用于首帧定色，theme.persist 用于下次启动',
  )
  check(
    'preload 暴露任务完成提醒',
    /flash:\s*\(\)\s*=>\s*ipcRenderer\.send\('app:flash'\)/.test(preloadSrc),
    '少了 app.flash，渲染进程就没法把「跑完了」告诉主进程',
  )

  const uiSrc = readSource('src/stores/ui.ts')
  check(
    '长任务进度按归属者入栈（后开始的优先显示）',
    /const taskStack = ref<string\[\]>\(\[\]\)/.test(uiSrc) && /taskByOwner/.test(uiSrc),
    '只留一个槽位的话，先结束的任务会把还在跑的另一个的进度一起抹掉',
  )
  check(
    '结束任务只弹掉自己那一份（别人的进度不受牵连）',
    /function endTask\(owner: string\): void \{[\s\S]{0,240}?taskStack\.value\.filter\(\(o\) => o !== owner\)/.test(
      uiSrc,
    ),
    'endTask 必须按归属者过滤，不能整条清空',
  )
  check(
    'hasTask 提供「是否已在跑」的查询',
    /function hasTask\(owner: string\): boolean/.test(uiSrc),
    '上报方要区分「开始」与「更新」，不能拿栈顶当判据',
  )

  const downloadsSrc = readSource('src/stores/downloads.ts')
  check(
    '模型下载进度也上任务栏，并在完成时提醒',
    /updateTask\(TASK_MODEL_DOWNLOAD/.test(downloadsSrc) &&
      /flashTaskBar\(\)/.test(downloadsSrc),
    '几百 MB 下载几分钟，切走后任务栏是唯一信息来源',
  )

  const modelViewSrc = readSource('src/views/ModelView.vue')
  check(
    '模型下载状态来自 store，而不是页面自己订阅',
    /useDownloadsStore\(\)/.test(modelViewSrc) && !/models\.onProgress\(/.test(modelViewSrc),
    '页面组件订阅的话，用户切走一卸载，进度就再也收不到了（主进程还在跑）',
  )

  /* ---- 模型探测与「文件名无关性」（2026-10-14）
   *
   * 「模型不随包」之后，模型是用户自己在文件系统里摆的，文件名不可控：
   * 浏览器重复下载会变成 `ggml-small(1).bin`，也有人习惯改名成
   * `whisper-small.bin`。这一组守四件事 —— 界面不许拿文件名自己判
   * 「使用中」、回退不许死盯默认档、报错不许写死文件名、自放的模型必须可见。
   */
  const mainModelsSrc = readSource('electron/main.js')
  const appModelsSrc = readSource('src/App.vue')
  const preloadModelsSrc = readSource('electron/preload.cjs')

  check(
    '「使用中」由主进程判定，界面不拿文件名自己比',
    /resolvedModel\.value !== '' && resolvedModel\.value === modelFileOf\(item\.key\)/.test(modelViewSrc) &&
      !/return activeModelFile\.value === modelFileOf\(item\.key\)/.test(modelViewSrc),
    '只比名字的话，文件被手动删掉后界面会一直挂着「使用中」的空壳',
  )
  check(
    '主进程提供 models:resolve 只读查询通道',
    /ipcMain\.handle\('models:resolve'/.test(mainModelsSrc) &&
      /resolve: \(file\) => ipcRenderer\.invoke\('models:resolve', file\)/.test(preloadModelsSrc),
    '判定规则只能存一份，放主进程',
  )
  check(
    '回退按「任一已装模型」，不死盯默认档',
    /const fallback = pickInstalledModel\(\)/.test(mainModelsSrc) &&
      /function pickInstalledModel\(\)/.test(mainModelsSrc),
    '只回退 DEFAULT_MODEL 的话，只装了 base 的用户会被判「找不到模型」',
  )
  check(
    '识别失败的报错指向模型管理页，不写死文件名',
    /没有可用的识别模型/.test(mainModelsSrc) && !/找不到模型文件（\$\{DEFAULT_MODEL\}）/.test(mainModelsSrc),
  )
  check(
    '文件名不在内置目录里的模型也要列出来',
    /const extraModels = computed/.test(modelViewSrc) && /v-for="m in extraModels"/.test(modelViewSrc),
    '识别用得上、界面看不到的话，用户既不知道它生效了，也删不掉',
  )
  check(
    '启动时检查有没有可用模型并跳转',
    /function checkModelsOnStart/.test(appModelsSrc) &&
      /if \(!devViewInjected\) void checkModelsOnStart\(\)/.test(appModelsSrc),
    '不检查的话用户会一路点到「开始识别」才失败',
  )
}

/* ---- 架构不变量：时间轴（泳道 / 缩放 / 拖拽边界） ----
 *
 * 这一块专守「最容易静默变坏」的几条。尤其是 Ctrl+滚轮：Chromium 默认把
 * 带 ctrlKey 的 wheel 当**整页缩放**，而触控板双指捏合在 Chromium 里就是
 * 这个事件 —— 不拦的话用户一次捏合会把整个界面连同时间轴一起放大，
 * 而且缩放比例会被记住，下次打开还是怪的，得按 Ctrl+0 才回去。
 */
{
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

  const tlSrc = readSource('src/components/TimelineTrack.vue')
  const mainSrc = readSource('src/main.ts')
  const editorViewSrc = readSource('src/views/EditorView.vue')
  const typesSrc = readSource('src/types/index.ts')
  const subSrc = readSource('src/components/SubtitleTable.vue')

  check(
    '时间轴自己拦掉 Ctrl+滚轮的默认行为',
    /function onWheel\(event: WheelEvent\)[\s\S]{0,160}?event\.preventDefault\(\)/.test(tlSrc),
    '不 preventDefault 的话，一次捏合会同时缩放时间轴和整个界面',
  )
  check(
    '时间轴的滚轮监听显式声明 non-passive',
    /addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(tlSrc),
    'passive 的监听里 preventDefault 无效，等于没拦；元素级默认虽然也非 passive，但别依赖这个默认值',
  )
  check(
    '全局也拦掉 Ctrl+滚轮的整页缩放',
    /window\.addEventListener\(\s*'wheel'[\s\S]{0,220}?ctrlKey[\s\S]{0,120}?preventDefault[\s\S]{0,80}?capture: true/.test(
      mainSrc,
    ),
    '时间轴以外误触 Ctrl+滚轮同样会缩放界面，且被记住 —— 必须 window 捕获阶段拦',
  )

  check(
    'Ctrl+B 在编辑态让位给输入框',
    editorViewSrc.indexOf('if (editor.editingId) return') >= 0 &&
      editorViewSrc.indexOf("key === 'b' || key === 'B'") >
        editorViewSrc.indexOf('if (editor.editingId) return'),
    '编辑态的 Ctrl+B 归 SubtitleTable 的输入框（按文本光标切），两处若同时响应会把一条字幕切两次',
  )
  // 只让位还不够：splitAtCaret 会先退出编辑态，冒泡到 window 时 editingId 已经空了，
  // 光靠 editingId 守卫拦不住 —— 输入框必须 stopPropagation，全局那边再用 isTypingTarget 兜底。
  // 取整个函数体：用 `[\s\S]{0,300}` 这种长度上限会被函数里的长注释顶出去，
  // 改成一直吃到下一个行首的 `}`（函数体内没有顶格的右括号）。
  const editorKeydown =
    /function onEditorKeydown\(event: KeyboardEvent\): void \{[\s\S]*?\n\}/.exec(subSrc)?.[0] ?? ''
  check(
    '编辑态的 Ctrl+B 掐断冒泡（否则同一次按键被两套逻辑各切一刀）',
    editorKeydown.includes('stopPropagation()') && editorKeydown.includes('splitAtCaret()'),
    'splitAtCaret 退出编辑态后，这次按键会继续冒泡到 window 再按播放头切一刀',
  )
  check(
    '全局 Ctrl+B 兜底拦住来自输入框的事件',
    (() => {
      const at = editorViewSrc.indexOf("key === 'b' || key === 'B'")
      const seg = at >= 0 ? editorViewSrc.slice(at, at + 800) : ''
      return /isTypingTarget\(event\.target\)/.test(seg) && /splitAtPlayhead\(\)/.test(seg)
    })(),
    '第二道防线：万一 stopPropagation 被去掉，这里也要认得出事件来自文本框',
  )
  check(
    '分割按「是否在编辑文本」分流到同一个判据',
    /const splitTarget = computed/.test(subSrc) && /:disabled="!splitTarget"/.test(subSrc),
    '按钮与世界快捷键必须走同一处判断，否则会出现「按钮做 A、快捷键做 B」',
  )

  // 拖拽落盘那一步必须过 history.commit。这里按「函数体范围」判而不是全文搜：
  // 全文搜的话，注释里写着 history.commit 也能骗过断言（这轮已经栽过一次）。
  const dragUpAt = tlSrc.indexOf('function onDragUp')
  const dragUpEnd = tlSrc.indexOf('function onStagePointerDown', dragUpAt)
  const dragUpBody =
    dragUpAt >= 0 && dragUpEnd > dragUpAt ? tlSrc.slice(dragUpAt, dragUpEnd) : ''
  check(
    '拖拽字幕（边界与整条）都要进撤销栈',
    /history\.commit\(/.test(dragUpBody) &&
      /'调整字幕起点'/.test(dragUpBody) &&
      /'调整字幕终点'/.test(dragUpBody) &&
      /'移动字幕'/.test(dragUpBody),
    '拖完撤不回来是最容易漏的一条：按钮有反应、数据也真变了，就是回不去',
  )
  check(
    '拖拽只在松手时落盘（拖动过程走本地预览）',
    /dragPreview/.test(dragUpBody) && !/file\.segments\s*=\s*[\s\S]{0,80}?onDragMove/.test(tlSrc),
    '每帧都写数据的话，2000 条的重排会被拖成幻灯片，历史栈也会被塞满',
  )
  check(
    '拖拽时被同泳道邻居夹住（同轨不重叠）',
    /laneNeighbours\(/.test(tlSrc) && /MIN_SEGMENT_SEC/.test(tlSrc),
    '同一条泳道上不许重叠，且两侧各留 MIN_SEGMENT_SEC，否则能拖出零长条目',
  )

  /*
   * 拖整条是挂在字幕条自己身上的，而拖边界挂在两侧热区上。
   * preventDefault 只能给后者：对挂在元素本体上的 pointerdown 调它，会连带把
   * 兼容的 click 一起掐掉 —— 「点一下选中」直接失效，而且现象是「点了没反应」，
   * 排查方向很容易跑偏到选择逻辑上去。
   */
  check(
    '拖整条不做 preventDefault（否则点选会被一起掐掉）',
    /if \(edge !== 'move'\) event\.preventDefault\(\)/.test(tlSrc),
    'preventDefault 会连带掐掉 click，字幕条就点不中了',
  )

  /* ---- 拖整条的可动范围：被同泳道前后邻居夹出来 ---- */
  {
    const beganAt = tlSrc.indexOf("const minDelta = prev ? prev.end - seg.start : -seg.start")
    const endAt = tlSrc.indexOf('function startDrag', beganAt)
    const began = beganAt >= 0 ? tlSrc.slice(beganAt, endAt > beganAt ? endAt : beganAt + 600) : ''
    check(
      '拖整条时用「位移范围」而不是绝对时间夹取',
      /const minDelta/.test(began) && /const maxDelta/.test(began),
      '整条平移是相对量，用绝对时间夹会把起点终点算成同一个值，条就动不了',
    )
    const moveAt = tlSrc.indexOf("if (state.edge === 'move')")
    const moveBody = moveAt >= 0 ? tlSrc.slice(moveAt, moveAt + 500) : ''
    check(
      '拖整条时超出范围要夹住（不是无穷平移）',
      /Math\.max\(lo, Math\.min\(/.test(moveBody),
      '不夹的话整条会被拖到音频外面，时间码变成负数或超出总时长',
    )
  }

  /* ---- 手抖不算拖动：Ctrl+单击必须还能多选 ---- */
  check(
    '横向位移小于阈值不算拖动（保住 Ctrl+单击多选）',
    /DRAG_THRESHOLD/.test(tlSrc) &&
      /Math\.abs\(dx\) < DRAG_THRESHOLD\) return/.test(tlSrc),
    '没有阈值的话，一次 Ctrl+单击会被判成拖拽并吃掉 click，表现是多选点了没反应',
  )

  /* ---- 点击字幕条不挪播放头 ---- */
  check(
    '点击字幕条不再挪动播放头（游标只由点空白处决定）',
    !/editor\.setPlayhead\(seg\.start\)/.test(tlSrc),
    '点一条就把游标带走，就没法一边听一边挑条目',
  )
  check(
    '点轨道空白处仍然会移动播放头',
    /editor\.setPlayhead\(t\)/.test(tlSrc),
    '空白处点击是唯一的定位入口，丢了就没法把游标放到位',
  )

  const segIface = /export interface SubtitleSegment \{[\s\S]*?\n\}/.exec(typesSrc)?.[0] ?? ''
  check(
    '泳道是纯派生数据，条目类型里不存 lane',
    segIface.length > 0 && !/\blane\b/.test(segIface) && /assignLanes\(/.test(tlSrc),
    '存进数据就要维护「键盘改了时间码之后 lane 对不对」，派生则永远自洽',
  )

  // 判 CSS 规则一律用 `\{[^}]*` 锁在**这一个选择器的块内**。
  // 用 `[\s\S]{0,300}?` 会一路跨到后面别的选择器上去：反例验证时明明把
  // `.tl-clip` 的过渡改成了 left，断言却因为匹配到下一个块的 `transition` 而照样通过。
  check(
    '字幕条位置变化有过渡（换泳道时平滑滑过去）',
    /\.tl-clip \{[^}]*transition: top /.test(tlSrc),
    '只给 top 过渡：left / width 若是也带缓动，拖边界和缩放会追着鼠标慢慢爬',
  )
  check(
    '字幕条上的文字放不下时用省略号',
    /\.tl-clip__text \{[^}]*text-overflow: ellipsis/.test(tlSrc),
    '窄条也要能认出来是哪一条，而不是整条都是光秃秃的色块',
  )

  check(
    '旧的波形组件已移除（不留两套实现）',
    (() => {
      try {
        readSource('src/components/WaveformCanvas.vue')
        return false
      } catch {
        return true
      }
    })(),
    '已经被 TimelineTrack 取代，留着会让人以为有两套波形实现',
  )

  /* ---- 泳道上限：数字只有一个真相源，且改数据前必须先试算 ---- */

  const layoutSrc = readSource('src/utils/timelineLayout.ts')
  check(
    '泳道上限只在 timelineLayout 里定义一处',
    /export const MAX_LANES = 5/.test(layoutSrc) && !/const MAX_LANES = 5/.test(tlSrc),
    '界面能画几层与允许多少条重叠必须是同一个数字，两处各写一份迟早对不上',
  )
  /*
   * 这条必须**只扫 `setTimecode` 的函数体**。
   *
   * 先前是拿两个 `indexOf` 在整个文件里比先后，而 `SubtitleTable.vue` 里
   * `commitIfChanged(` 第一次出现在 `toggleAck`（忽略告警）—— 位置比
   * `setTimecode` 里的 `exceedsLaneLimit(` 更靠前，于是断言恒为假。
   * 取「函数签名 + 函数体」切片再比，才是这条守门真正想表达的东西。
   */
  const setTcAt = subSrc.indexOf('function setTimecode(')
  const setTc = setTcAt >= 0 ? subSrc.slice(setTcAt, subSrc.indexOf('\n}', setTcAt) + 2) : ''
  check(
    '时间码改动前先试算泳道数，超限就弹窗并放弃改动',
    setTc.includes('exceedsLaneLimit(') &&
      setTc.includes('noticeBlocked(') &&
      setTc.indexOf('exceedsLaneLimit(') < setTc.indexOf('commitIfChanged('),
    '先试算再落盘：否则数据已经改了，用户还得自己撤回',
  )
  check(
    '拖动落盘前也试算泳道数',
    /exceedsLaneLimit\(/.test(tlSrc) && /noticeBlocked\(/.test(tlSrc),
    '纵向逃逸之后整条可以落到任何位置，这一步同样能把总量推到第 6 层',
  )
  check(
    '超限的字幕条在时间轴上有专门的警示配色',
    /\.tl-clip\.is-overflow \{[^}]*border-style: dashed/.test(tlSrc) &&
      /\.tl-clip\.is-overflow \{[^}]*--color-clip-overflow/.test(tlSrc),
    '没有区别的话，几条叠在一层就是一团看不清的色块，用户只会以为界面坏了',
  )

  /* ---- 输入焦点优先：全局快捷键不许抢输入框的按键 ---- */

  const typingSrc = readSource('src/utils/typing.ts')
  check(
    '「焦点在输入框里」抽成共用判断',
    /export function isTypingTarget/.test(typingSrc) &&
      /tag === 'INPUT'/.test(typingSrc) &&
      /tag === 'TEXTAREA'/.test(typingSrc),
    '判断散在三处的话，每加一个快捷键都要重想一遍，必然漏',
  )
  {
    const subKeydown =
      /function onKeydown\(event: KeyboardEvent\): void \{[\s\S]*?\n\}/.exec(subSrc)?.[0] ?? ''
    check(
      '字幕表格的快捷键在输入框里让位（时间码框内按 Delete 不再删掉整条）',
      subKeydown.length > 0 &&
        subKeydown.includes('isTypingTarget(event.target)') &&
        subKeydown.includes("key === 'Delete'"),
      '时间码是 <input> 但不走 editingId，少了这道判断，删一位数字会把整条字幕删掉',
    )
  }

  /* ---- Ctrl+B：多条一起切，但只占一格历史 ---- */

  const splitUseSrc = readSource('src/composables/useSplitAtPlayhead.ts')
  check(
    '按播放头分割只有一份实现（按钮与快捷键共用）',
    /export function useSplitAtPlayhead/.test(splitUseSrc) &&
      /splitSegmentsAtTime\(/.test(splitUseSrc) &&
      /useSplitAtPlayhead\(\)/.test(subSrc) &&
      /useSplitAtPlayhead\(\)/.test(editorViewSrc),
    '各写一遍必然分叉成「按钮切一条、快捷键切三条」',
  )
  check(
    '一次 Ctrl+B 切多条只提交一次历史',
    (splitUseSrc.match(/history\.commit\(/g) ?? []).length === 1,
    '逐条提交会在撤销栈里留好几格，用户要按好几次 Ctrl+Z 才回到按下之前',
  )
  check(
    '没有选中时按播放头切、有选中时只切选中的那几条',
    /ids\.length > 0 \? segments\.filter\(\(s\) => ids\.includes\(s\.id\)\) : segments/.test(
      readSource('src/utils/segmentOps.ts'),
    ),
    '这是用户拍板的语义：挑好了就切挑的，没挑就对游标切',
  )

  /* ---- 拖动排序：搬内容，不搬时间码 ---- */

  const segOpsSrc = readSource('src/utils/segmentOps.ts')
  check(
    '拖动排序搬的是内容，id 与时间码留在槽位上',
    /export function moveContentTo/.test(segOpsSrc) &&
      /contents\.splice\(from, 1\)/.test(segOpsSrc) &&
      /withContent\(seg, contents\[i\]\)/.test(segOpsSrc),
    '时间码跟着内容走会把整条时间轴搅乱，而用户想要的只是「这段话排到前面」',
  )
  check(
    '拖动排序进撤销栈',
    /'调整字幕顺序'/.test(subSrc) && /moveContentTo\(/.test(subSrc),
    '改了数据却不入历史，用户按 Ctrl+Z 会跳过它撤到更早的操作',
  )

  /* ---- 忽略告警：只抑制展示与计数 ---- */

  {
    const sigFn = /export function segmentsSignature[\s\S]*?\n\}/.exec(segOpsSrc)?.[0] ?? ''
    check(
      '忽略告警不进「未保存」签名',
      sigFn.length > 0 && !/acked/.test(sigFn),
      '它是编辑器侧的批注、不写进字幕文件；进了签名就会「点一下忽略就冒出未保存」',
    )
    const validateSrc = readSource('src/utils/validate.ts')
    check(
      '忽略只抑制展示与计数，不删数据',
      /export function visibleIssues/.test(validateSrc) &&
        /if \(seg\.acked\) continue/.test(validateSrc),
      '真正的删除应该是「取消忽略之后还能回来」，所以 issues 必须原样留着',
    )
    check(
      '校验结果面板与底栏都按「可见问题」算',
      /visibleIssues\(item\.seg\)/.test(editorViewSrc) && /hasHighlight/.test(subSrc),
      '只改一处的话，列表里还在、行首红条没了，看起来像半坏',
    )
  }

  /* ---- 底部告警分层：一个报当前文件，一个报全工程 ---- */

  const statusBarSrc = readSource('src/components/AppStatusBar.vue')
  check(
    '底部状态栏报全工程、编辑器底栏报当前文件（两个口径）',
    /project\.errorCount/.test(statusBarSrc) &&
      /countIssues\(activeFile\.value/.test(editorViewSrc) &&
      !/project\.errorCount/.test(editorViewSrc),
    '两处都读同一个数就会被当成重复渲染；分层之后多文件时才看得出区别',
  )

  /* ---- 文本选中策略 ---- */

  const globalSrc = readSource('src/styles/global.css')
  check(
    '界面文案默认不可选中',
    /html,\s*body,\s*#app \{\s*user-select: none;/.test(globalSrc),
    'Electron 的界面本质是浏览器，不关掉的话随便一划就蓝一片，还会误触发拖文字',
  )
  check(
    '输入控件放行选中（否则输入框里连自己的内容都选不中）',
    /input,\s*textarea,\s*select,\s*\[contenteditable='true'\] \{\s*user-select: text;/.test(globalSrc),
    'user-select: none 会被继承到输入框里，双击选词、Ctrl+A 全部失效',
  )
  check(
    '字幕正文与时间码仍然可复制',
    /\.row__text \{[^}]*user-select: text/.test(subSrc) &&
      /\.timecode__display \{[^}]*user-select: text/.test(
        readSource('src/components/TimecodeInput.vue'),
      ),
    '这两样是用户真的会拷出去的东西；时间轴上的字幕条文字则不必放行',
  )
}

/* ---- 版本号只能有一个真相源（package.json） ----
 *
 * `branding.ts` 里曾经写死 `export const appVersion = '0.1.0'`。后果很隐蔽：
 * 改了 package.json 之后，安装包文件名、控制面板的 DisplayVersion、`app.getVersion()`
 * 都变成新版本，界面侧边栏和关于页却还是旧版本 —— 只有肉眼比对才看得出来。
 * 这条直接扫源码，把「不得再写死」钉死。
 */
{
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

  const brandingSrc = readSource('src/branding.ts')
  const pkgVersion = (JSON.parse(readSource('package.json')) as { version: string }).version

  check(
    'branding.ts 不再写死版本号字面量',
    !/appVersion\s*=\s*['"]/.test(brandingSrc),
    '又出现了 appVersion = "x.y.z"',
  )
  check(
    'branding.ts 同时接运行时注入与构建常量',
    /\bxbaos\?\.appVersion\b/.test(brandingSrc) && /__APP_VERSION__/.test(brandingSrc),
    '应同时读 window.xbaos?.appVersion 与 __APP_VERSION__',
  )
  check(
    'package.json 版本号是三段语义化版本（更新检查要靠 semver 比较）',
    /^\d+\.\d+\.\d+$/.test(pkgVersion),
    pkgVersion,
  )
}

/* ---- 更新检查 ----
 *
 * 这段逻辑在主进程里跑，探针很难覆盖全部分支（真要测「服务器返回 503」就得架个
 * 会返 503 的服务器）。所以真正的把关放在这：`electron/update.js` 是纯逻辑，
 * 网络实现靠注入，这里用一个假 fetch 把所有分支走一遍。
 */
{
  const manifest = {
    schema: 1,
    id: 'subtitle-generator',
    name: 'XBAOS 字幕生成器',
    latest: '0.2.0',
    updated: '2026-11-01',
    homepage: 'https://subtitle.xbaos.com.cn',
    download: { label: '第三方网盘下载', url: 'https://example.com/dl' },
    notes: { highlight: '本次重点提升识别速度。', upgradeHint: '覆盖安装即可。' },
    releases: [
      { version: '0.2.0', date: '2026-11-01', title: '性能更新', items: ['快了一截', '修了几个问题'] },
      { version: '0.1.0', date: '2026-10-08', title: '首个版本', items: ['上线'] },
    ],
  }

  const fakeFetch = (payload: unknown, status = 200) => {
    const calls: { url: string; init: unknown }[] = []
    const impl = async (url: string, init?: unknown) => {
      calls.push({ url, init })
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (typeof payload === 'string') throw new SyntaxError('Unexpected token < in JSON')
          return payload
        },
      }
    }
    return { impl, calls }
  }

  // ---- 版本比较
  check('版本比较：相等', compareVersions('0.1.0', '0.1.0') === 0)
  check('版本比较：段数不同补零后相等', compareVersions('1.2', '1.2.0') === 0)
  check('版本比较：按数字而不是字典序', compareVersions('0.10.0', '0.9.9') === 1, '0.10 > 0.9')
  check('版本比较：低位更大', compareVersions('1.0.1', '1.1.0') === -1)
  check('版本号合法性：拒绝 v 前缀与后缀', !isValidVersion('v1.0.0') && !isValidVersion('1.0.0-beta'))
  check('版本号合法性：接受两段到四段', isValidVersion('1.0') && isValidVersion('1.2.3.4'))
  check('版本号合法性：拒绝非字符串', !isValidVersion(123 as unknown as string))

  // ---- 清单校验
  check('清单校验：正常清单通过', parseManifest(manifest, 'subtitle-generator').ok)
  check('清单校验：缺 latest 被拒', !parseManifest({ id: 'x' }, 'x').ok)
  check('清单校验：latest 写法不合法被拒', !parseManifest({ latest: 'v1.0' }, '').ok)
  check(
    '清单校验：id 对不上被拒（防止拿别的软件的版本号提示更新）',
    !parseManifest({ latest: '1.0.0', id: 'tank-game' }, 'subtitle-generator').ok,
  )
  check(
    '清单校验：没有 id 字段时放行',
    parseManifest({ latest: '1.0.0' }, 'subtitle-generator').ok,
  )
  check('清单校验：数组不是清单', !parseManifest([], 'x').ok)
  check(
    '更新条目：取 latest 对应的那一条',
    pickReleaseNotes(manifest).items.length === 2 && pickReleaseNotes(manifest).title === '性能更新',
  )
  check(
    '更新条目：latest 没有对应发布记录时返回空数组',
    pickReleaseNotes({ latest: '9.9.9', releases: manifest.releases }).items.length === 0,
  )

  // ---- 外链白名单
  check('外链：自家域名放行', allowedExternalUrl('https://subtitle.xbaos.com.cn/') !== '')
  check('外链：子域放行', allowedExternalUrl('https://update.xbaos.com.cn/data/x.json') !== '')
  check('外链：裸域放行', allowedExternalUrl('https://xbaos.com.cn/') !== '')
  check('外链：非自家域名拒绝', allowedExternalUrl('https://example.com/') === '')
  check('外链：http 拒绝', allowedExternalUrl('http://subtitle.xbaos.com.cn/') === '')
  check('外链：file 协议拒绝', allowedExternalUrl('file:///C:/Windows/System32/calc.exe') === '')
  check('外链：冒充域名拒绝', allowedExternalUrl('https://xbaos.com.cn.evil.com/') === '')
  check('外链：空值与非法值拒绝', allowedExternalUrl('') === '' && allowedExternalUrl(null as unknown as string) === '')

  // ---- 清单落点：由软件官网自己承担（2026-10-14 从 update.xbaos.com.cn 迁来）
  {
    const src = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    const updateSrc = src('electron/update.js')
    // 只认赋值那一行 —— 文件里其他地方（注释）提到旧域名不算数
    const manifestLine = updateSrc.split('\n').find((line) => line.includes('MANIFEST_URL =')) ?? ''
    check(
      '版本清单指向软件官网（不再是 update 子域）',
      manifestLine.includes("'https://subtitle.xbaos.com.cn/data/subtitle.json'"),
      manifestLine || '没找到 MANIFEST_URL 赋值行',
    )
    check(
      '清单地址与 branding 同步改了（改域名时两处一起改）',
      !manifestLine.includes('update.xbaos.com.cn') &&
        !src('src/branding.ts').includes('update.xbaos.com.cn'),
    )
  }

  // ---- 检查更新的各个分支
  const at = async (payload: unknown, current: string, status = 200) => {
    const { impl, calls } = fakeFetch(payload, status)
    const result = await checkForUpdate({
      currentVersion: current,
      url: 'https://subtitle.xbaos.com.cn/data/subtitle.json',
      expectedId: 'subtitle-generator',
      fetchImpl: impl,
      now: () => 1700000000000,
    })
    return { result, calls }
  }

  const up = await at(manifest, '0.1.0')
  check('检查更新：版本落后 → state=update', up.result.state === 'update', JSON.stringify(up.result))
  check('检查更新：带上升级条目', (up.result.notes ?? []).length === 2, String(up.result.notes))
  check('检查更新：带上概括与升级说明', !!up.result.highlight && !!up.result.upgradeHint)
  check('检查更新：带上官网与下载入口', up.result.homepage === manifest.homepage)
  check(
    '检查更新：URL 加反缓存参数（CDN 缓存会把新版本号压住）',
    up.calls[0].url.includes('_=1700000000000'),
    up.calls[0].url,
  )

  const same = await at(manifest, '0.2.0')
  check('检查更新：版本相同 → state=latest', same.result.state === 'latest')
  check('检查更新：版本一致时不带升级条目', (same.result.notes ?? []).length === 0)

  const ahead = await at(manifest, '0.3.0')
  check('检查更新：本机版本更新（装了内测版）也按 latest 处理', ahead.result.state === 'latest')

  const notFound = await at({ message: 'Not Found' }, '0.1.0', 404)
  check('检查更新：HTTP 404 → error 且带上三位状态码', notFound.result.state === 'error' && notFound.result.code === 404, JSON.stringify(notFound.result))
  check('检查更新：HTTP 错误归类为 http', notFound.result.reason === 'http')

  const serverError = await at({}, '0.1.0', 503)
  check('检查更新：HTTP 503 原样透出状态码', serverError.result.code === 503, String(serverError.result.code))

  const notJson = await at('<html>运营商劫持页</html>', '0.1.0')
  check('检查更新：返回 200 但内容不是 JSON → format', notJson.result.state === 'error' && notJson.result.reason === 'format')

  const wrongId = await at({ ...manifest, id: 'other-app' }, '0.1.0')
  check('检查更新：清单属于别的软件 → format', wrongId.result.state === 'error' && wrongId.result.reason === 'format')

  const offline = await checkForUpdate({
    currentVersion: '0.1.0',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND update.xbaos.com.cn')
    },
  })
  check('检查更新：连不上 → error/network 且没有状态码', offline.state === 'error' && offline.reason === 'network' && offline.code === null, JSON.stringify(offline))

  // 模拟 AbortController 中断：fetch 抛错且 signal 处于 aborted
  const timedOut = await checkForUpdate({
    currentVersion: '0.1.0',
    timeoutMs: 1,
    fetchImpl: (() =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('The operation was aborted')), 5)
      })) as unknown as typeof fetch,
  })
  check('检查更新：超时 → error/timeout', timedOut.state === 'error' && timedOut.reason === 'timeout', JSON.stringify(timedOut))

  const noFetch = await checkForUpdate({ currentVersion: '0.1.0' })
  check('检查更新：没有注入 fetch 实现时不崩，返回可读失败', noFetch.state === 'error' && !!noFetch.message)

  const badLocal = await checkForUpdate({ currentVersion: 'dev', fetchImpl: fakeFetch(manifest).impl })
  check('检查更新：本机版本号不合法时明确报错', badLocal.state === 'error', JSON.stringify(badLocal))
}

/* ------------------------------------------------- 合并时间轴的增量拼接 */

{
  const mk = (id: string, dur: number, texts: string[]): MergeSourceFile => ({
    id,
    durationSec: dur,
    segments: texts.map((t, i) => ({
      id: `${id}-${i}`,
      start: i * 2,
      end: i * 2 + 1.5,
      text: t,
      origin: t,
      issues: [],
    })),
  })

  const A = mk('A', 100, ['甲一', '甲二'])
  const B = mk('B', 100, ['乙一'])

  const first = buildMergedTimeline([A, B], null)
  check('合并拼接：首次把各文件的条目按顺序拼成一条', first.segments.length === 3)
  check(
    '合并拼接：第二段音频的条目按第一段的时长顺延',
    first.segments[2].start === 100 && first.offsets.B === 100,
    JSON.stringify(first.segments.map((s) => s.start)),
  )
  check(
    '合并拼接：产物上的条目带来源标记（重新拼接时靠它归位）',
    first.segments.every((s) => s.originFileId === 'A' || s.originFileId === 'B'),
  )

  // ★ 用户报的严重问题：改过内容后往队列追加音频，修改必须还在
  const edited = first.segments.map((s) =>
    s.originFileId === 'A' ? { ...s, text: `改过-${s.text}` } : s,
  )
  const C = mk('C', 50, ['丙一'])
  const carried = buildMergedTimeline([A, B, C], {
    segments: edited,
    offsets: first.offsets,
  })
  check(
    '追加文件：上一轮的编辑原样保留（不再被源文件覆盖）',
    carried.segments.filter((s) => s.text.startsWith('改过-')).length === 2,
    JSON.stringify(carried.segments.map((s) => s.text)),
  )
  check(
    '追加文件：新文件的条目补进时间轴末尾',
    carried.segments.some((s) => s.text === '丙一') && carried.offsets.C === 200,
    JSON.stringify(carried.offsets),
  )

  // 在前面插入一个文件：后面的条目要按新的偏移整体平移
  const D = mk('D', 30, ['丁一'])
  const inserted = buildMergedTimeline([D, A, B], {
    segments: carried.segments,
    offsets: carried.offsets,
  })
  const aFirst = inserted.segments.find((s) => s.originFileId === 'A')
  check(
    '插入文件：后面的条目按新偏移整体平移',
    aFirst?.start === 30 && inserted.offsets.A === 30,
    `A 首条 start=${aFirst?.start}`,
  )
  check(
    '插入文件：平移不影响已保留的编辑',
    inserted.segments.filter((s) => s.text.startsWith('改过-')).length === 2,
  )
  check(
    '插入文件：不在队列里的文件（C）的条目随之消失',
    inserted.segments.every((s) => s.originFileId !== 'C'),
    JSON.stringify(inserted.segments.map((s) => s.originFileId)),
  )

  const removed = buildMergedTimeline([A, B], {
    segments: inserted.segments,
    offsets: inserted.offsets,
  })
  check(
    '移除文件：该文件的条目随之消失',
    removed.segments.every((s) => s.originFileId !== 'D'),
    JSON.stringify(removed.segments.map((s) => s.originFileId)),
  )
  check(
    '移除文件：后面的条目前移到新的偏移',
    removed.segments.find((s) => s.originFileId === 'A')?.start === 0,
    `A 首条 start=${removed.segments.find((s) => s.originFileId === 'A')?.start}`,
  )

  // 还没识别出内容的文件不能登记偏移，否则它识别完成后会被当成「已参与」而保留成空白
  const blank = mk('E', 20, [])
  const withBlank = buildMergedTimeline([A, blank], { segments: [], offsets: {} })
  check(
    '未识别（无内容）的文件不登记偏移',
    withBlank.offsets.E === undefined,
    JSON.stringify(withBlank.offsets),
  )

  // 用户在合并视图里手动新增的条目（无来源标记）
  const manual = {
    id: 'manual-1',
    start: 105,
    end: 106,
    text: '手动加的',
    origin: '手动加的',
    issues: [],
  }
  const withManual = buildMergedTimeline([A, B], {
    segments: [...first.segments, manual],
    offsets: first.offsets,
  })
  check(
    '手动新增的条目（无来源标记）在重拼后仍然保留',
    withManual.segments.some((s) => s.id === 'manual-1'),
    JSON.stringify(withManual.segments.map((s) => s.text)),
  )

  // 在合并视图里把某个文件的条目删光 → 不能被重新生成回来
  const cleared = buildMergedTimeline([A, B], {
    segments: first.segments.filter((s) => s.originFileId !== 'B'),
    offsets: first.offsets,
  })
  check(
    '在合并视图里删光某文件的条目后，重拼不再把它生成回来',
    cleared.segments.every((s) => s.originFileId !== 'B'),
    JSON.stringify(cleared.segments.map((s) => s.originFileId)),
  )
}

/* ---------------------------------------------- 翻译：提示词与 1:1 校验 */
{
  // ---- 提示词：只发文字，不发时间码 ----
  const r = buildTranslatePrompt({
    targets: [
      { fileName: 'a.wav', durationSec: 30, segments: [seg(0, 2, '你好'), seg(2, 4, '世界')] },
    ],
    targetLang: '英语',
  })
  const body = r.prompt.split('【待翻译的字幕】')[1] ?? ''
  check('翻译提示词：写明目标语言', r.prompt.includes('英语'))
  check('翻译提示词：正文按序号排列', body.includes('1. 你好') && body.includes('2. 世界'), body)
  check('翻译提示词：正文里一个时间码都没有', !/\d{2}:\d{2}:\d{2},\d{3}/.test(body), body)
  check('翻译提示词：强调条数一致', r.prompt.includes('条数必须与输入完全一致'))
  check('翻译提示词：明确要求不要输出时间码', r.prompt.includes('不要输出时间码'))
  check('翻译提示词：条数与文件数统计正确', r.segmentCount === 2 && r.fileCount === 1)

  const wrapped = buildTranslatePrompt({
    targets: [{ fileName: 'a.wav', durationSec: 30, segments: [seg(0, 2, '上句\n下句')] }],
    targetLang: '英语',
  })
  check(
    '翻译提示词：条目内的换行被压成单行（否则「一条一行」就不成立了）',
    wrapped.prompt.includes('1. 上句 下句'),
  )

  const multi = buildTranslatePrompt({
    targets: [
      { fileName: 'a.wav', durationSec: 30, segments: [seg(0, 2, '甲')] },
      { fileName: 'b.wav', durationSec: 30, segments: [seg(0, 2, '乙')] },
    ],
    targetLang: '日语',
  })
  check(
    '翻译提示词：多文件带【文件 k/N】分隔行',
    multi.prompt.includes('【文件 1/2】a.wav') && multi.prompt.includes('【文件 2/2】b.wav'),
  )
  check('翻译提示词：多文件要求原样保留分隔行', multi.prompt.includes('原样保留'))
  check(
    '翻译提示词：格式示例里也摆出【文件 1/N】（模型很爱把开头那个当标题吞掉）',
    multi.prompt.includes('【文件 1/2】xxx.mp3') && multi.prompt.includes('输出的第一行就是'),
    multi.prompt,
  )
  check('翻译提示词：空目标语言时兜底成英语', buildTranslatePrompt({ targets: [], targetLang: '  ' }).prompt.includes('英语'))
}

{
  // ---- 解析：正常 ----
  const ok = parseTranslation('1. Hello\n2. World', [2])
  check('翻译解析：正常通过', ok.ok && ok.blocks[0].lines.join('|') === 'Hello|World', JSON.stringify(ok.blocks[0]?.lines))

  // ---- 1:1 是硬红线：多了少了都整份拒绝 ----
  const fewer = parseTranslation('1. Hello', [2])
  check('翻译解析：少一条 → 整份拒绝（不部分回写）', fewer.ok === false && fewer.blocks.length === 0)
  check(
    '翻译解析：失败信息说清「识别到 N 条 / 需要 M 条」',
    /识别到 1 条译文，需要 2 条/.test(fewer.message ?? ''),
    fewer.message,
  )
  check('翻译解析：多一条也拒绝', parseTranslation('1. a\n2. b\n3. c', [2]).ok === false)

  // ---- 容忍模型的常见变体 ----
  const noisy = parseTranslation('好的，以下是译文：\n```\n1、你好\n2、世界\n```\n希望对你有帮助', [2])
  check('翻译解析：容忍代码块与开场白', noisy.ok && noisy.blocks[0].lines[0] === '你好', JSON.stringify(noisy.blocks[0]?.lines))

  const wrappedLine = parseTranslation('1. Hello\nworld\n2. Bye', [2])
  check(
    '翻译解析：某条被写成两行时接回上一条',
    wrappedLine.ok && wrappedLine.blocks[0].lines[0] === 'Hello world',
    JSON.stringify(wrappedLine.blocks[0]?.lines),
  )

  const unnumbered = parseTranslation('Hello\nWorld', [2])
  check('翻译解析：整份没写序号时按行顺序取', unnumbered.ok && unnumbered.blocks[0].lines.join('|') === 'Hello|World')

  const blank = parseTranslation('1. \n2. World', [2])
  check('翻译解析：空译文本身也算一条（不吞掉序号）', blank.ok && blank.blocks[0].lines[0] === '', JSON.stringify(blank.blocks[0]?.lines))

  // ---- 多文件 ----
  const twoFiles = parseTranslation('【文件 1/2】a.wav\n1. A1\n2. A2\n\n【文件 2/2】b.wav\n1. B1', [2, 1])
  check(
    '翻译解析：多文件各自核条数',
    twoFiles.ok && twoFiles.blocks.length === 2 && twoFiles.blocks[1].lines.length === 1,
    JSON.stringify(twoFiles.blocks.map((b) => b.lines.length)),
  )
  const shortMulti = parseTranslation('1. A1\n2. A2', [2, 1])
  check(
    '翻译解析：多文件只复制回一部分 → 按总条数拒绝',
    shortMulti.ok === false && /识别到 2 条译文，需要 3 条/.test(shortMulti.message ?? ''),
    shortMulti.message,
  )
  check(
    '翻译解析：总数对得上但文件间错位 → 指出是哪个文件（分隔行齐全时才判得出来）',
    /第 1 个文件（a\.wav）识别到 1 条译文，需要 2 条/.test(
      parseTranslation('【文件 1/2】a.wav\n1. A1\n【文件 2/2】b.wav\n1. B1\n2. B2', [2, 1]).message ?? '',
    ),
    parseTranslation('【文件 1/2】a.wav\n1. A1\n【文件 2/2】b.wav\n1. B1\n2. B2', [2, 1]).message,
  )

  // ---- P0 回归（用户实测）：模型把输出开头的【文件 1/N】当"标题"吞掉 ----
  // 形状照抄内置测试数据：28 + 15 + 3 = 46 条，AI 回来的开头少了【文件 1/3】，
  // 第一个文件的 28 条译文就全落在第一个分隔行前面。
  // 老实现按分隔行分组 → 只切出 2 块 → 整份拒绝（「识别到 2 个文件块，应当是 3 个」）。
  const f1 = Array.from({ length: 28 }, (_, i) => `${i + 1}. a${i + 1}`)
  const f2 = Array.from({ length: 15 }, (_, i) => `${i + 1}. b${i + 1}`)
  const f3 = Array.from({ length: 3 }, (_, i) => `${i + 1}. c${i + 1}`)
  const dropFirst = [
    ...f1,
    '【文件 2/3】录音棚闲聊 第7期.mp3',
    ...f2,
    '【文件 3/3】片头开场白.mp3',
    ...f3,
  ].join('\n')
  const rec = parseTranslation(dropFirst, [28, 15, 3])
  check(
    '翻译解析：吞掉第一个分隔行也要能取回（改成按已知条数分组）',
    rec.ok && rec.blocks.map((b) => b.lines.length).join('|') === '28|15|3',
    `${rec.message ?? ''} ${JSON.stringify(rec.blocks.map((b) => b.lines.length))}`,
  )
  check(
    '翻译解析：补回后每块边界正确（没有串到隔壁文件）',
    rec.blocks[0]?.lines[27] === 'a28' &&
      rec.blocks[1]?.lines[0] === 'b1' &&
      rec.blocks[2]?.lines[2] === 'c3',
    JSON.stringify([rec.blocks[0]?.lines[27], rec.blocks[1]?.lines[0], rec.blocks[2]?.lines[2]]),
  )
  const greeted = parseTranslation(
    ['好的，以下是译文：', '', ...f1, '【文件 2/3】b.mp3', ...f2, '【文件 3/3】c.mp3', ...f3].join('\n'),
    [28, 15, 3],
  )
  check(
    '翻译解析：开头有寒暄 + 吞掉第一个分隔行，仍能取回（寒暄不算一条译文）',
    greeted.ok && greeted.blocks.map((b) => b.lines.length).join('|') === '28|15|3',
    `${greeted.message ?? ''} ${JSON.stringify(greeted.blocks.map((b) => b.lines.length))}`,
  )
  const noMarksAtAll = parseTranslation([...f1, ...f2, ...f3].join('\n'), [28, 15, 3])
  check(
    '翻译解析：分隔行全丢也兜得住（总条数对就按已知条数切）',
    noMarksAtAll.ok && noMarksAtAll.blocks.map((b) => b.lines.length).join('|') === '28|15|3',
    `${noMarksAtAll.message ?? ''} ${JSON.stringify(noMarksAtAll.blocks.map((b) => b.lines.length))}`,
  )
  const honestShort = parseTranslation(
    [...f1.slice(0, 27), '【文件 2/3】b.mp3', ...f2, '【文件 3/3】c.mp3', ...f3].join('\n'),
    [28, 15, 3],
  )
  check(
    '翻译解析：真少一条仍然整份拒绝（宽容不等于放水）',
    honestShort.ok === false && /识别到 45 条译文，需要 46 条/.test(honestShort.message ?? ''),
    honestShort.message,
  )

  // 真实译文的行首比夹具花哨：句子里带冒号、逗号、撇号、千位分隔符。
  // 序号判定不能被它们带跑偏（真取回时第 5、6 条就是长这样）。
  const realish = parseTranslation(
    [
      '1. Hello everyone, welcome back to the show.',
      '5. Prices range from just over 400 to a little over 1,000.',
      "6. Let's start with the conclusion: the most expensive one isn't necessarily the best.",
      '【文件 2/2】b.wav',
      '1. Okay, so just chat today.',
    ].join('\n'),
    [3, 1],
  )
  check(
    '翻译解析：译文里的冒号/逗号/撇号不影响序号识别',
    realish.ok &&
      realish.blocks.map((b) => b.lines.length).join('|') === '3|1' &&
      realish.blocks[0]?.lines[2] ===
        "Let's start with the conclusion: the most expensive one isn't necessarily the best.",
    `${realish.message ?? ''} ${JSON.stringify(realish.blocks[0]?.lines)}`,
  )
}

{
  // ---- 写回：只动译文，时间码与原文一个字都不许动 ----
  const before: SubtitleSegment[] = [
    { ...seg(0, 1, '你好'), translations: { en: 'old' }, staleSlots: ['en'] },
    { ...seg(1, 2, '世界') },
  ]
  const after = applyTranslation(before, 'en', ['Hello', 'World'])
  check('翻译写回：按序号贴译文', after[0].translations?.en === 'Hello' && after[1].translations?.en === 'World')
  check('翻译写回：原文一个字都不动', after[0].text === '你好' && after[1].text === '世界')
  check('翻译写回：时间码一个字都不动', after[0].start === 0 && after[1].end === 2)
  check('翻译写回：清掉该语言的待确认标红', after[0].staleSlots === undefined, JSON.stringify(after[0].staleSlots))

  const mixed: SubtitleSegment[] = [
    { ...seg(0, 1, 'a'), translations: { en: 'x' }, staleSlots: [SOURCE_SLOT, 'en'] },
  ]
  check(
    '翻译写回：不碰别的槽位的标红',
    applyTranslation(mixed, 'en', ['y'])[0].staleSlots?.join(',') === SOURCE_SLOT,
    JSON.stringify(applyTranslation(mixed, 'en', ['y'])[0].staleSlots),
  )

  // 空条目没进提示词，也就不该占译文序号 —— 不跳的话从它之后全部错一格
  const withBlank: SubtitleSegment[] = [seg(0, 1, '你好'), seg(1, 2, ''), seg(2, 3, '世界')]
  const placed = applyTranslation(withBlank, 'en', ['Hello', 'World'])
  check(
    '翻译写回：空条目不占译文序号（跳不过去后面就整体错一格）',
    placed[0].translations?.en === 'Hello' &&
      placed[1].translations === undefined &&
      placed[2].translations?.en === 'World',
    JSON.stringify(placed.map((s) => s.translations ?? null)),
  )
}

/* ---------------------------------------------- 导出：语言维度与文件命名 */

{
  const a = { ...seg(0, 2, '你好'), translations: { en: 'Hello' } }
  const b = { ...seg(2, 4, '世界'), translations: { en: 'World' } }

  const src = composeForExport([a, b])
  check('导出组合：仅原文', src.lines.length === 2 && src.lines[0].text === '你好', JSON.stringify(src))
  check('导出组合：仅原文不报缺译文', src.missing === 0, String(src.missing))

  // 双语是同一个字幕块里的两行 —— 拆成两个 cue 会被播放器当成连续两句话
  const both = composeForExport([a, b], { lang: 'both', translationLang: 'en' })
  check('导出组合：双语是块内两行', both.lines[0].text === '你好\nHello', JSON.stringify(both.lines[0]))
  check('导出组合：双语仍是两条字幕（不是四条）', both.lines.length === 2, String(both.lines.length))

  const rev = composeForExport([a, b], { lang: 'both', translationLang: 'en', sourceFirst: false })
  check('导出组合：行序可换成译文在上', rev.lines[0].text === 'Hello\n你好', JSON.stringify(rev.lines[0]))

  const only = composeForExport([a, b], { lang: 'translation', translationLang: 'en' })
  check('导出组合：仅译文', only.lines[0].text === 'Hello' && only.lines.length === 2, JSON.stringify(only.lines))

  // 缺译文：退回原文，而不是把整条丢掉 —— 丢掉会在那个时间点留一段空白
  const half = [a, { ...seg(4, 6, '这句还没有译文') }]
  const hb = composeForExport(half, { lang: 'both', translationLang: 'en' })
  check('导出组合：双语里缺译文只出原文一行', hb.lines[1].text === '这句还没有译文', JSON.stringify(hb.lines[1]))
  check('导出组合：缺译文如实报数', hb.missing === 1, String(hb.missing))
  const ht = composeForExport(half, { lang: 'translation', translationLang: 'en' })
  check('仅译文时缺译文用原文顶上', ht.lines[1].text === '这句还没有译文' && ht.missing === 1)
  check('仅译文时缺译文不会整条消失', ht.lines.length === 2, String(ht.lines.length))

  const none = composeForExport([a, b], { lang: 'both' })
  check('没有目标语言时双语退化为纯原文', none.lines[0].text === '你好' && none.missing === 0, JSON.stringify(none))
  const emptyTr = composeForExport([{ ...seg(0, 2, '你好'), translations: { en: '   ' } }], { lang: 'translation', translationLang: 'en' })
  check('译文只有空白字符时按「没有译文」处理', emptyTr.lines[0].text === '你好' && emptyTr.missing === 1)

  check('语言后缀：识别语言直接用作后缀', sourceLangTag('zh', false) === 'zh')
  check(
    '语言后缀：自动检测时用 und（不编造一个语言出来）',
    sourceLangTag('auto', false) === 'und' && sourceLangTag('zh', true) === 'und',
  )
  check('语言后缀：双语连写', bundleLangTag('both', 'zh', 'en') === 'zh-en', bundleLangTag('both', 'zh', 'en'))
  check(
    '语言后缀：仅原文/仅译文各取对应的一边',
    bundleLangTag('source', 'zh', 'en') === 'zh' && bundleLangTag('translation', 'zh', 'en') === 'en',
  )

  const srtSrc = serializeSrt([a, b])
  check('SRT：只有原文时两条 cue', srtSrc.split('-->').length === 3, String(srtSrc.split('-->').length))
  const srtBoth = serializeSrt([a, b], { lang: 'both', translationLang: 'en' })
  check('SRT：双语写在同一个块里', srtBoth.includes('你好\nHello'), JSON.stringify(srtBoth))
  check('SRT：双语条数不变（还是两条 cue）', srtBoth.split('-->').length === 3, String(srtBoth.split('-->').length))
  const ass = serializeAss([a, b], { lang: 'both', translationLang: 'en' })
  check('ASS：双语走 \\N 换行（ASS 里没有「块内换行」这回事）', ass.includes('你好\\NHello'), JSON.stringify(ass.slice(-160)))
  check('ASS：双语只产生一条 Dialogue', ass.split('Dialogue:').length === 3, String(ass.split('Dialogue:').length))
}

{
  const withTr: PlanSource = {
    id: 'f1',
    name: '第一段.mp4',
    dir: 'D:\\a',
    baseName: '第一段',
    outputDir: 'D:\\a',
    segments: [{ ...seg(0, 2, '你好'), translations: { en: 'Hello' } }],
  }
  const noTr: PlanSource = { ...withTr, id: 'f2', name: '第二段.mp4', baseName: '第二段', segments: [seg(0, 2, '没有译文')] }

  const base = {
    sourceFirst: true,
    sourceLanguage: 'zh',
    autoDetectLanguage: false,
    preferredLang: 'en',
    template: '{原名}',
    ext: 'srt',
    date: '20261009',
  } as const

  const names = (list: { outputName: string }[]) => list.map((e) => e.outputName).join(' | ')

  const p1 = planExport([withTr], { ...base, langMode: 'source' })
  check('导出规划：仅原文 → 一个不加后缀的文件', p1.length === 1 && p1[0].outputName === '第一段.srt', names(p1))
  check('导出规划：仅原文的 bundle 是 source', p1[0].bundle === 'source' && p1[0].lang === '')

  const p2 = planExport([withTr], { ...base, langMode: 'both' })
  check('导出规划：双语 → 语言后缀自动追加', p2.length === 1 && p2[0].outputName === '第一段.zh-en.srt', names(p2))
  check('导出规划：双语 bundle 带上语言码', p2[0].bundle === 'both' && p2[0].lang === 'en')

  const p3 = planExport([withTr], { ...base, langMode: 'translation' })
  check('导出规划：仅译文 → 只挂译文语言', p3.length === 1 && p3[0].outputName === '第一段.en.srt', names(p3))

  const p4 = planExport([withTr], { ...base, langMode: 'separate' })
  check('导出规划：分别导出 → 两个文件', p4.length === 2, names(p4))
  check(
    '导出规划：分别导出按行业惯例命名（播放器能自动挂轨）',
    p4[0].outputName === '第一段.zh.srt' && p4[1].outputName === '第一段.en.srt',
    names(p4),
  )
  check('导出规划：只有第一个文件带「第一行」标记（目录输入框画一处）', p4[0].firstOfSource === true && p4[1].firstOfSource === false)

  const p5 = planExport([withTr], { ...base, template: '{原名}.{语言}', langMode: 'separate' })
  check('导出规划：模板里自己写了 {语言} 就不再额外追加', names(p5) === '第一段.zh.srt | 第一段.en.srt', names(p5))
  const p6 = planExport([withTr], { ...base, template: '{原名}-{序号}-{日期}', langMode: 'translation' })
  check('导出规划：模板变量照常替换', p6[0].outputName === '第一段-01-20261009.en.srt', names(p6))

  const p7 = planExport([withTr], { ...base, autoDetectLanguage: true, langMode: 'both' })
  check('导出规划：自动检测语言时后缀为 und-en', p7[0].outputName === '第一段.und-en.srt', names(p7))

  // 一条译文都没有：所有模式都退化成干净的纯原文，不该出现空文件或怪后缀
  for (const mode of ['source', 'both', 'translation', 'separate'] as const) {
    const list = planExport([noTr], { ...base, langMode: mode })
    check(
      `导出规划：没有译文时「${mode}」退化为一个纯原文文件`,
      list.length === 1 && list[0].outputName === '第二段.srt',
      names(list),
    )
  }

  const p8 = planExport([{ ...withTr, segments: [{ ...seg(0, 2, '你好'), translations: { en: 'Hello' } }, seg(2, 4, '缺译文')] }], { ...base, langMode: 'both' })
  check('导出规划：缺译文条数透到清单里（界面据此提示）', p8[0].missing === 1, String(p8[0].missing))
  check('导出规划：清单条数是真实写出的条数', p8[0].lineCount === 2, String(p8[0].lineCount))

  const p9 = planExport([{ ...withTr, segments: [] }], { ...base, langMode: 'both' })
  check('导出规划：一个字都写不出来的来源不进清单（否则会导出 0 字节文件）', p9.length === 0, names(p9))

  const twoFiles = planExport([withTr, noTr], { ...base, langMode: 'source' })
  check('导出规划：多来源各一行', twoFiles.length === 2 && twoFiles[1].outputName === '第二段.srt', names(twoFiles))

  check(
    '译文语言：优先用工作语言',
    pickTranslationLang([{ ...seg(0, 1, 'x'), translations: { en: 'a', ja: 'あ' } }], 'ja') === 'ja',
  )
  check(
    '译文语言：工作语言不在这个文件里时退回它自己的第一种',
    pickTranslationLang([{ ...seg(0, 1, 'x'), translations: { ja: 'あ' } }], 'en') === 'ja',
  )
  check('译文语言：一条译文都没有时返回空串', pickTranslationLang([seg(0, 1, 'x')], 'en') === '')
  check(
    '译文语言列表：值为空的键不算一种语言',
    translationLangsOf([{ ...seg(0, 1, 'x'), translations: { en: 'a', ja: '  ' } }]).join(',') === 'en',
  )
}

/* ---- 原文改动后译文转「待确认」+ 展示语言的兜底选取 ----
 *
 * 用户拍板的语义：原文被改动（手工编辑或批量工具），这条上各语言的译文就不再
 * 与它对应了 —— 必须标红待确认，否则「译文还在、内容却对不上」这件事在界面上
 * 完全看不出来。反向不成立（改译文不动原文），否则两边会互相标红形成死循环。
 */
{
  const withTr = (text: string, tr: Record<string, string>) => ({
    ...seg(0, 2, text),
    translations: tr,
  })

  const s1 = withTr('你好', { en: 'Hello', ja: 'こんにちは' })
  check(
    '译文脱钩：列出除原文外有内容的槽位',
    otherSlotsWithText(s1, SOURCE_SLOT).join(',') === 'en,ja',
    otherSlotsWithText(s1, SOURCE_SLOT).join(','),
  )
  check(
    '译文脱钩：原文槽位自己不在列表里',
    !otherSlotsWithText(s1, SOURCE_SLOT).includes(SOURCE_SLOT),
  )
  check(
    '译文脱钩：空译文的语言不算（没有可核对的东西）',
    otherSlotsWithText(withTr('你好', { en: 'Hello', ja: '   ' }), SOURCE_SLOT).join(',') === 'en',
  )
  check(
    '译文脱钩：没有译文的条目不受影响（原样返回）',
    markTranslationsStale(seg(0, 2, '你好')).staleSlots === undefined,
  )
  check(
    '译文脱钩：改原文后各语言译文都进待确认',
    markTranslationsStale(s1).staleSlots?.join(',') === 'en,ja',
    JSON.stringify(markTranslationsStale(s1).staleSlots),
  )
  check(
    '译文脱钩：已有的待确认标记不会被顶掉',
    markTranslationsStale({ ...s1, staleSlots: ['en'] }).staleSlots?.join(',') === 'en,ja',
    JSON.stringify(markTranslationsStale({ ...s1, staleSlots: ['en'] }).staleSlots),
  )
  check(
    '译文脱钩：已是待确认的槽位不重复加入',
    markTranslationsStale({ ...s1, staleSlots: ['en', 'ja'] }).staleSlots?.join(',') === 'en,ja',
  )

  check('待确认：addStale 无新增时原样返回', addStale(s1, []) === s1)
  check(
    '待确认：addStale 只补没在集合里的',
    addStale({ ...s1, staleSlots: ['en'] }, ['en', 'ja']).staleSlots?.join(',') === 'en,ja',
  )

  /* ---- 展示语言的兜底 ---- */

  check('usedLangs：按首次出现的顺序收集', usedLangs([withTr('a', { ja: 'x' }), withTr('b', { en: 'y' })]).join(',') === 'ja,en')
  check('usedLangs：值为空的键也算（编辑器要留着那一行让人改回去）', usedLangs([withTr('a', { en: '' })]).join(',') === 'en')
  check('展示语言：偏好语言在数据里就用它', pickViewLang([withTr('a', { en: 'x', ja: 'y' })], 'ja') === 'ja')
  check(
    '展示语言：撤销后偏好语言没了 → 退回数据里实际存在的那个',
    pickViewLang([withTr('a', { en: 'x' })], 'ja') === 'en',
    pickViewLang([withTr('a', { en: 'x' })], 'ja'),
  )
  check('展示语言：一条译文都没有时保持偏好原样', pickViewLang([seg(0, 2, '你好')], 'en') === 'en')
  check(
    '展示语言：清空一条译文只留下空值时，那个语言仍然算数（否则行会中途消失）',
    pickViewLang([withTr('a', { en: '' })], 'en') === 'en',
  )
}

/* --------------------------------------------------- 自定义替换词表 */

{
  const rules = parseReplaceDict(
    [
      '# 注释行会被忽略',
      '帐号=账号',
      '视屏 => 视频',
      '',
      '空的=',
      '=只有右边',
      '帐号=后出现的重复条目不覆盖',
    ].join('\n'),
  )
  check('替换词表：忽略空行与注释行', rules.length === 2, JSON.stringify(rules))
  check(
    '替换词表：= 与 => 都能作分隔符',
    rules[0]?.from === '帐号' && rules[1]?.from === '视屏',
    JSON.stringify(rules),
  )
  check(
    '替换词表：只有一边的条目被跳过（空的一端会误伤全文）',
    rules.every((r) => r.from !== '空的' && r.to !== '只有右边'),
  )
  check(
    '替换词表：同一错词只保留第一次出现的那条',
    rules.filter((r) => r.from === '帐号').length === 1 &&
      rules.find((r) => r.from === '帐号')?.to === '账号',
    JSON.stringify(rules.find((r) => r.from === '帐号')),
  )
  check(
    '替换词表：按规则批量替换',
    applyReplaceRules('我的帐号登不上，视屏也打不开', rules) === '我的账号登不上，视频也打不开',
    applyReplaceRules('我的帐号登不上，视屏也打不开', rules),
  )
  check('替换词表：空表原样返回', applyReplaceRules('原文', []) === '原文')
  check('替换词表：没有命中时原样返回', applyReplaceRules('无关内容', rules) === '无关内容')
  check('替换词表：undefined 输入不崩', parseReplaceDict(undefined).length === 0)
}

/* ------------------------------------------ 识别结果的时间轴夹成单调（去重叠） */

{
  const mk = (start: number, end: number, text = 'x'): SubtitleSegment => ({
    ...seg(start, end, text),
    id: `m${start}_${end}`,
  })

  // 真实形状：连续说话 > 24 秒 → VAD 硬切，块间留 1 秒音频重叠。
  // 上一块最后一条到 12.0 结束，下一块第一条从 11.0 开始（文本重叠部分已被引擎裁掉）
  const raw = [mk(0, 5.5), mk(5.5, 12), mk(11, 15.5)]
  const fixed = enforceMonotonicCues(raw)
  check(
    '识别结果：与前一条重叠的起点被顺延到前一条的结束',
    fixed[2].start === 12 && fixed[2].end === 15.5,
    JSON.stringify(fixed.map((s) => [s.start, s.end])),
  )
  check(
    '识别结果：不重叠的条目原样通过（连对象引用都不换）',
    fixed[0] === raw[0] && fixed[1] === raw[1],
  )
  check(
    '识别结果：夹完之后整条时间轴单调不减',
    fixed.every((s, i) => i === 0 || s.start >= fixed[i - 1].end),
    JSON.stringify(fixed.map((s) => [s.start, s.end])),
  )

  // 整条都落在重叠区里：必须给一个看得见的最短时长，不能产出 0 秒字幕
  const swallowed = enforceMonotonicCues([mk(0, 5), mk(4.6, 4.9)])
  check(
    '识别结果：整条落进重叠区时给最短时长（不产出 0 秒字幕）',
    swallowed[1].start === 5 && swallowed[1].end > 5 && swallowed[1].end - swallowed[1].start >= 0.2,
    JSON.stringify([swallowed[1].start, swallowed[1].end]),
  )

  // 只有「被夹过」的条目才吃最短时长 —— 本来就短的正常条目不许被拉长
  const short = enforceMonotonicCues([mk(0, 0.08)])
  check(
    '识别结果：本来就很短但不重叠的条目不被拉长',
    short[0].end === 0.08,
    String(short[0].end),
  )

  // 串行重叠：三条依次咬合，顺延要一路传下去
  const chain = enforceMonotonicCues([mk(0, 3), mk(2.5, 4), mk(3.5, 6)])
  check(
    '识别结果：连续咬合的重叠会一路顺延下去',
    chain[1].start === 3 && chain[2].start === 4 && chain[2].end === 6,
    JSON.stringify(chain.map((s) => [s.start, s.end])),
  )

  // 浮点尾巴：顺延后的时间码同样要 round 到毫秒
  const floaty = enforceMonotonicCues([mk(0, 1.0000001), mk(0.9999, 2)])
  check(
    '识别结果：顺延后的时间码取整到毫秒',
    String(floaty[1].start).length <= 6,
    String(floaty[1].start),
  )
}

/* ------------------------------------------------ 安装器品牌位图与协议落地 */

{
  const readText = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const readBin = (rel: string): Uint8Array => readFileSync(new URL(`../${rel}`, import.meta.url))

  /**
   * 位图尺寸错是一件**看不见**的事：NSIS 不会报错，只会把图拉伸糊掉，
   * 而且要装一遍才看得到。所以在这里按规范卡死：24 位、不压缩、尺寸精确。
   */
  const bmpInfo = (rel: string) => {
    const b = readBin(rel)
    return {
      magic: String.fromCharCode(b[0], b[1]),
      fileSize: b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24),
      actual: b.length,
      headerSize: b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24),
      width: b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24),
      height: b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24),
      planes: b[26] | (b[27] << 8),
      bpp: b[28] | (b[29] << 8),
      compression: b[30] | (b[31] << 8) | (b[32] << 16) | (b[33] << 24),
    }
  }

  for (const [rel, w, h] of [
    ['build/installerSidebar.bmp', 164, 314],
    ['build/uninstallerSidebar.bmp', 164, 314],
    ['build/installerHeader.bmp', 150, 57],
  ] as const) {
    const i = bmpInfo(rel)
    check(
      `${rel} 是尺寸正确的 24 位未压缩 BMP`,
      i.magic === 'BM' &&
        i.headerSize === 40 &&
        i.planes === 1 &&
        i.bpp === 24 &&
        i.compression === 0 &&
        i.width === w &&
        i.height > 0 &&
        i.height === h &&
        i.fileSize === i.actual,
      JSON.stringify(i),
    )
  }

  /**
   * 配置里指到的位图必须真的在。
   * 这几个文件名是在 `electron-builder.yml` 里手写的，改名时最容易只改一处 ——
   * 而 builder 找不到就静默退回 NSIS 自带的图，界面上看不出是「我们的图没生效」。
   */
  const yml = readText('electron-builder.yml')
  for (const name of [
    'build/installerSidebar.bmp',
    'build/uninstallerSidebar.bmp',
    'build/installerHeader.bmp',
  ]) {
    check(`electron-builder.yml 指向的 ${name} 确实存在`, yml.includes(name), '配置里没写这一行')
  }

  // 协议正文：两份都要带官网（主体唯一性靠它锚定），且都不许出现编造的邮箱
  const legal = readText('src/legal/index.ts')
  check('协议正文里带了官网域名（主体唯一性靠它锚定）', legal.includes('www.xbaos.com.cn'))
  check(
    '协议正文里没有编造的联系邮箱',
    !/support@|@xbaos\.com\.cn/.test(legal),
    legal.match(/[\w.]+@[\w.]+/)?.[0] ?? '',
  )
  check(
    '协议正文写明了「未来版本可能新增联网功能」这层口子',
    legal.includes('未来版本中增加需要联网的功能'),
    '没有这句，将来加联网功能就成了单方面变更',
  )

  // 「关于」页的隐私说明曾经漏掉「检查更新」这处联网，这里守住不许回退
  const about = readText('src/views/AboutView.vue')
  check(
    '关于页的隐私说明列出了两处联网（检查更新 + 下载模型）',
    about.includes('检查更新') && about.includes('下载可选模型'),
    '缺一处就会退回到「只有在下载模型时才联网」那种不准确的表述',
  )
  check(
    '关于页不含「只有在下载模型时才联网」这种漏项表述',
    !about.includes('只有在下载可选的大模型时才会联网'),
  )
  check(
    '关于页有用户协议与隐私政策两个可查看入口',
    about.includes("'terms'") && about.includes("'privacy'") && about.includes("openDialog('legal'"),
  )
  check(
    '协议正文能选中复制（全局 user-select:none 不能漏进来）',
    readText('src/components/dialogs/LegalDialog.vue').includes('user-select: text'),
  )
}

/* ------------------------------------------------ 录制音频窗口的接线守门 */

{
  const readText = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const main = readText('electron/main.js')
  const preload = readText('electron/preload.cjs')
  const record = readText('src/views/RecordView.vue')
  const dropzone = readText('src/components/DropZone.vue')
  const app = readText('src/App.vue')

  // ---- 主进程：三件渲染进程做不到的事
  for (const channel of ['record:open', 'record:focus', 'record:save', 'record:submit', 'record:confirmDiscard']) {
    check(`主进程注册了 ${channel}`, main.includes(`'${channel}'`), '缺这个 IPC 录音窗口就是空壳')
  }
  check(
    '桌面音频走 setDisplayMediaRequestHandler + desktopCapturer（不弹选择器）',
    main.includes('setDisplayMediaRequestHandler') && main.includes('desktopCapturer'),
    '缺了就会在每次录制时弹系统的共享选择框',
  )

  // ---- preload：桥必须把这几件都露出来
  for (const api of ['open', 'focus', 'save', 'submit', 'onSaved', 'onClosed', 'confirmDiscard', 'onCloseRequest']) {
    check(`preload 暴露了 record.${api}`, new RegExp(`record:\\s*{[\\s\\S]*?${api}`).test(preload), '渲染进程拿不到')
  }

  // ---- 录音窗口自身：只出 WAV、保存走转发、退出有裁决
  check('录音保存只输出 WAV（自研编码器，零新依赖）', record.includes("from '@/utils/wav'") && readText('src/utils/wav.ts').includes('RIFF'))
  check(
    '录音窗口保存走 submit 转发而不是自己入队',
    record.includes('.submit(') && !record.includes('addFilesFromPaths'),
    '两个渲染进程的 Pinia 不共享：自己 addFiles 只会加进窗口那份空工程，关窗即丢',
  )
  check('录制中 / 有未保存编辑时退出要过原生裁决', record.includes('confirmDiscard'))
  check(
    '关窗确认覆盖「录完了但还没编辑」的态',
    record.includes('recording.value === null'),
    '只在录制中/剪辑过才确认的话，没剪过的录音会被静默丢掉',
  )
  check(
    '设备记忆记 label 不记 deviceId',
    record.includes("d.label === micLabel.value") || record.includes('micLabel'),
    'deviceId 跨会话不稳定，存它等于没记',
  )

  // ---- 主界面：入口 + 锁
  check('导入页有「录制音频」入口', dropzone.includes('录制音频') && dropzone.includes('openRecorder'))
  check(
    '点入口直接开窗（先置锁再 open），不再弹「接下来会打开窗口」那种无意义确认',
    !dropzone.includes('dialog.confirm') &&
      dropzone.indexOf('setRecordActive(true)') >= 0 &&
      dropzone.indexOf('setRecordActive(true)') < dropzone.indexOf('record.open()'),
    '点「录制音频」的意图已经够明确，多一步确认是纯噪音',
  )
  check(
    '录音窗口存在期间主界面有锁遮罩，关窗后解除',
    app.includes('ui.recordActive') && app.includes('onRecordClosed'),
    '没有锁就会重蹈 AI 窗口改造前的「流程没走完又点一次入口」',
  )
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)