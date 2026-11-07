/**
 * 后处理与编辑操作的语义自检。
 * 运行方式：esbuild bundle 后 node 执行（见 npm run unit）。
 */
import { applyPunctuation, toSimplified } from '../src/utils/punctuation'
import {
  MIN_SEGMENT_SEC,
  SOURCE_SLOT,
  addStale,
  alignOrigin,
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
import { applyLineWrap, breakIntoLines } from '../src/utils/lineWrap'
import { applyTermFix, collectFixTerms, createTermFixer } from '../src/utils/termFix'
import {
  assignSpeakers,
  clearSpeaker,
  defaultSpeakerName,
  isUserSpeakerName,
  listSpeakers,
  mergeSpeakerInto,
  nextSpeakerIndex,
  pickSampleRange,
  planSpeakerMapping,
  setSpeakerFor,
  speakerLabel,
  speakerName,
} from '../src/utils/speaker'
import { buildWrapWords } from '../src/utils/wrapWords'
import {
  defaultProjectName,
  isProjectPath,
  projectFileName,
  samePath,
  sanitizeFileName,
} from '../src/utils/projectName'
import { buildProjectDoc, fromProjectText, toProjectText } from '../src/utils/xbsgp'
import { COMMON_WORDS, COMMON_WORD_GROUPS } from '../src/data/commonWords'
import {
  SETTINGS_ENTRIES,
  SETTINGS_GROUPS,
  groupOfDomId,
  searchSettings,
} from '../src/data/settingsMap'
import { srtTime, serializeSrt, serializeVtt, serializeAss, composeForExport, bundleLangTag, sourceLangTag } from '../src/utils/subtitle'
import { planExport, pickTranslationLang, translationLangsOf, type PlanSource } from '../src/utils/exportPlan'
import { parseSubtitle } from '../src/utils/subtitleParse'
import { buildPrompt, pickPresentTerms, promptCharCost, splitTerms } from '../src/utils/prompt'
import { decodeTextAuto, encodeSubtitle } from '../electron/encoding.js'
import { LEXICONS } from '../src/data/lexicons'
import {
  containmentSimilarity,
  containmentSimilarityPrepared,
  diceSimilarity,
  mergeRuns,
  normalizeForCompare,
  prepareText,
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
  mergeCuesIntoSelection,
  parseModelOutput,
  parseTranslation,
  splitByFileMarks,
  stripNoise,
  summarizeReview,
} from '../src/utils/llmResult'
import { toPlain, toPlainList } from '../src/utils/plain'
import {
  SCRIPT_STRENGTH_OPTIONS,
  normalizeStrength,
  strengthOption,
} from '../src/data/scriptStrength'
import { parseReplaceDict, applyReplaceRules } from '../src/utils/dictReplace'
import {
  allowedExternalUrl,
  checkForUpdate,
  compareVersions,
  isValidVersion,
  parseManifest,
  pickReleaseNotes,
} from '../electron/update.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import {
  mkdtemp,
  readFile as readFileAsync,
  readdir as readdirAsync,
  rm as rmAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameProjectFile, writeProjectFile } from '../electron/project-file.js'
import { fileURLToPath } from 'node:url'
import { parse as parseSfc } from 'vue/compiler-sfc'
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

  /*
   * 预处理版必须与「每次重算」逐位等价 —— 它只是把同样的活提前做了一次。
   * 等价性靠这张表兜：空串、单字、繁简、大小写、超集/子集两个方向都过一遍。
   */
  const eqPairs: [string, string][] = [
    [shortSubtitle, longScript],
    [longScript, shortSubtitle],
    [scriptZh, scriptTrad],
    ['', 'abc'],
    ['abc', ''],
    ['', ''],
    ['好', '好的'],
    ['AbC', 'abc'],
  ]
  check(
    '预处理版与重算版逐对等价',
    eqPairs.every(([x, y]) => containmentSimilarity(x, y) === containmentSimilarityPrepared(x, prepareText(y))),
    eqPairs
      .map(([x, y]) => `${containmentSimilarity(x, y).toFixed(4)}/${containmentSimilarityPrepared(x, prepareText(y)).toFixed(4)}`)
      .join(' '),
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
  // 时长必须跟着宽度走。不再断言「第一条更长」：零头被匀走之后可能反过来
  const expectedSpan = (s: (typeof one.segments)[number]): number =>
    (10 * widthUnits(s.text)) / one.segments.reduce((sum, x) => sum + widthUnits(x.text), 0)
  check(
    '拆分条按宽度分时长',
    one.segments.every((s) => Math.abs(s.end - s.start - expectedSpan(s)) < 0.005),
    JSON.stringify(one.segments.map((s) => [s.text, s.end - s.start])),
  )
  check('原条目文本不被就地改动', long.text.includes('没人知道吗'))

  /*
   * 硬切零头：比容量只多一个字时，旧实现切成 [16 字][1 字]，后者按宽度只能
   * 分到 1/34 的时长 —— 观众看到的就是「一条 0.17 秒的单字字幕」。
   */
  const tailCase = seg(0, 3, '二经制并不适合我们日常的计算和交流') // 17 字
  const tail = applyLineWrap([tailCase], SPEC)
  check(
    '多出一个字也不产生单字条',
    tail.segments.length === 2 && tail.segments.every((s) => widthUnits(s.text) >= 16),
    JSON.stringify(tail.segments.map((s) => [s.text, widthUnits(s.text)])),
  )
  check(
    '零头条不再拿到零点几秒',
    tail.segments.every((s) => s.end - s.start >= 1.2),
    JSON.stringify(tail.segments.map((s) => Number((s.end - s.start).toFixed(3)))),
  )
  check(
    '两行宽度接近',
    Math.abs(widthUnits(tail.segments[0].text) - widthUnits(tail.segments[1].text)) <= 4,
    JSON.stringify(tail.segments.map((s) => widthUnits(s.text))),
  )

  // 英文断行落在词与词之间的空格上，不能把两个词粘成一个
  const enTail = applyLineWrap(
    [seg(0, 8, 'the quick brown fox jumps over the lazy dog and x')],
    { maxCharsPerLine: 8, maxCharsPerLineEn: 20, maxLinesPerSegment: 1 },
  )
  const enWords = enTail.segments.map((s) => s.text).join(' ').split(/\s+/)
  check(
    '英文断行不粘连',
    'the quick brown fox jumps over the lazy dog and x'.split(' ').every((w) => enWords.includes(w)),
    JSON.stringify(enTail.segments.map((s) => s.text)),
  )
  check(
    '英文断行不超宽',
    enTail.segments.every((s) => s.text.length <= 20),
    JSON.stringify(enTail.segments.map((s) => s.text.length)),
  )

  // 断行不能把前一行末尾的标点搬到下一行开头：「览，很多人」比短尾行更刺眼
  const punctTail = applyLineWrap([seg(0, 4, '我们今天聊聊无痕浏览，很多人其实都')], SPEC)
  check(
    '标点没被搬到行首或行中',
    punctTail.segments.every((s) => !/[。！？；，、：…]/.test(s.text.slice(0, -1))),
    JSON.stringify(punctTail.segments.map((s) => s.text)),
  )

  // 已含换行的条目按段处理：手调过的排版必须稳定，连点两次也不能变
  const manual = seg(0, 4, '第一行内容\n第二行内容')
  const manualKept = applyLineWrap([manual], { ...SPEC, maxLinesPerSegment: 2 })
  check(
    '手动换行不被重排',
    manualKept.segments.length === 1 && manualKept.segments[0] === manual,
    JSON.stringify(manualKept.segments.map((s) => s.text)),
  )

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

  /* ---- 断句词表：切点必须落在词边界 ---- */
  /*
   * 中文没有词间空格，纯按宽度切必然切进词里 —— 用户截图里的
   * 「二进制并不适合我 / 们日常的计算和交流」就是这么来的。
   * 词表只改切点位置，不增删任何文字。
   */
  const words = buildWrapWords([], '')

  /*
   * 门槛从 800 提到 3000（2026-11-03 扩库：972 → 3180）。
   * 这个数字是**下限而不是目标**：词表漏一个词就少一处保护，切点只能靠宽度项
   * 竞争，而宽度项的量级比词内惩罚小两个数量级 —— 漏词等于放任切错。
   * 如果哪天有人为了「精简」删掉大量词，这里必须先失败。
   */
  check('常用词库条数够用', COMMON_WORDS.length >= 3000, String(COMMON_WORDS.length))
  check(
    '常用词库全是 2–6 字的含中文词',
    COMMON_WORDS.every((w) => {
      const len = Array.from(w).length
      return len >= 2 && len <= 6 && /[\u3400-\u9fff]/.test(w)
    }),
  )

  // 对照：不传词表时「不 / 把」被切开；传入词表后挪到「为什么」之后
  const hard = seg(0, 6, '那微软为什么不把错误的标准改过来呢')
  const plain = applyLineWrap([hard], SPEC)
  const smart = applyLineWrap([hard], { ...SPEC, wrapWords: words })
  check(
    '无词表时按宽度均分（对照基线）',
    plain.segments.map((s) => s.text).join('|') === '那微软为什么不把错|误的标准改过来呢',
    plain.segments.map((s) => s.text).join('|'),
  )
  check(
    '词表把切点拉回词边界',
    smart.segments.map((s) => s.text).join('|') === '那微软为什么|不把错误的标准改过来呢',
    smart.segments.map((s) => s.text).join('|'),
  )
  check('词表不增删任何一个字', smart.segments.map((s) => s.text).join('') === hard.text)
  check('词表不改变条数', smart.segments.length === plain.segments.length)

  // 常见搭配同样不能被横切
  const equalCase = '很多人觉得打开这个模式就等于在互联网上穿上了隐身衣'
  check(
    '「等于」不被切开',
    breakIntoLines(equalCase, 32, words).join('|') === '很多人觉得打开这个模式|就等于在互联网上穿上了隐身衣',
    breakIntoLines(equalCase, 32, words).join('|'),
  )
  const stdCase = '但问题就在于这套标准真的被全面执行了吗'
  check(
    '「标准」不被切开',
    breakIntoLines(stdCase, 32, words).join('|') === '但问题就在于这套标准|真的被全面执行了吗',
    breakIntoLines(stdCase, 32, words).join('|'),
  )

  // 禁则：行首不能是后缀助词（「我们」被劈成「我 / 们」的直接特征）
  const noStart = breakIntoLines('很多人觉得无痕浏览的模式其实没那么安全', 26, words)
  check(
    '行首不出现后缀助词',
    noStart.every((line) => !/^[们的了着过吗呢吧啊嘛]/.test(line)),
    JSON.stringify(noStart),
  )

  // 词表不能成为「造出超短行」的借口
  const noFrag = applyLineWrap([seg(0, 4, '这样看来国际标准其实已经非常明确了')], {
    ...SPEC,
    wrapWords: words,
  })
  check(
    '词表不让尾行变得过短',
    noFrag.segments.every((s) => widthUnits(s.text) >= 12),
    JSON.stringify(noFrag.segments.map((s) => [s.text, widthUnits(s.text)])),
  )

  /*
   * 断句质量回归集（2026-11-03 新增）。
   *
   * 判据刻意写成「切点是否落在词边界」而**不是**「断成什么字符串」 —— 后者只要
   * 动一下宽度权重或禁则阈值就全红，维护成本高且说不清到底哪里坏了；前者只关心
   * 用户看得见的事：有没有把一个词劈成两行。
   *
   * 这 15 句在 972 词时错切约 1/4，扩库后为 0。句子是在词库定稿之后另写的，
   * 不存在「把答案喂进词表」的自证；词库若被误删，这里会立刻失败。
   */
  const BOUNDARY_CASES: Array<[string, string[]]> = [
    ['打开任务管理器就能看到每个进程占用了多少内存', ['打开', '任务', '管理器', '就', '能', '看到', '每个', '进程', '占用', '了', '多少', '内存']],
    ['如果我们把参数调得太大模型就会开始出现过拟合的现象', ['如果', '我们', '把', '参数', '调', '得', '太', '大', '模型', '就', '会', '开始', '出现', '过拟合', '的', '现象']],
    ['他把这个问题翻来覆去想了很久最后决定先放一放', ['他', '把', '这个', '问题', '翻来覆去', '想', '了', '很久', '最后', '决定', '先', '放一放']],
    ['相比之下第二种方案的可扩展性明显更好一些', ['相比之下', '第二种', '方案', '的', '可扩展性', '明显', '更好', '一些']],
    ['归根结底这是取舍问题没有绝对正确的答案', ['归根结底', '这', '是', '取舍', '问题', '没有', '绝对', '正确', '的', '答案']],
    ['这个按钮的作用是把你选中的内容一次性全部删除', ['这个', '按钮', '的', '作用', '是', '把', '你', '选中', '的', '内容', '一次性', '全部', '删除']],
    ['从结果上看这次改版确实把加载速度提升了不少', ['从', '结果', '上', '看', '这次', '改版', '确实', '把', '加载', '速度', '提升', '了', '不少']],
    ['我们把整个过程拆成三个步骤依次完成第一个是准备阶段', ['我们', '把', '整个', '过程', '拆成', '三个', '步骤', '依次', '完成', '第一个', '是', '准备', '阶段']],
    ['从长期来看这种做法的维护成本会越来越高最后难以承受', ['从', '长期', '来看', '这种', '做法', '的', '维护', '成本', '会', '越来越', '高', '最后', '难以', '承受']],
    ['需要注意的是这个方法在数据量特别大的时候会明显变慢', ['需要', '注意', '的', '是', '这个', '方法', '在', '数据', '量', '特别', '大', '的', '时候', '会', '明显', '变慢']],
    ['这句话的意思是说前面的结论只在特定条件下才成立', ['这', '句话', '的', '意思', '是', '说', '前面', '的', '结论', '只', '在', '特定', '条件', '下', '才', '成立']],
    ['这类问题的处理思路其实大同小异掌握了套路就能触类旁通', ['这类', '问题', '的', '处理', '思路', '其实', '大同小异', '掌握', '了', '套路', '就', '能', '触类旁通']],
    ['严格来讲这两种说法都有道理只是适用的范围不太一样', ['严格', '来讲', '这', '两种', '说法', '都', '有', '道理', '只是', '适用', '的', '范围', '不太', '一样']],
    ['我们在测试中发现大部分崩溃都发生在内存不足的情况下', ['我们', '在', '测试', '中', '发现', '大部分', '崩溃', '都', '发生', '在', '内存', '不足', '的', '情况', '下']],
    ['所以到底选哪一种取决于你的使用场景和预算不要盲目跟风', ['所以', '到底', '选', '哪', '一种', '取决于', '你', '的', '使用', '场景', '和', '预算', '不要', '盲目', '跟风']],
  ]
  const cutInside: string[] = []
  for (const [text, ws] of BOUNDARY_CASES) {
    const lines = breakIntoLines(text, 32, words)
    const border = new Set<number>()
    let at = 0
    for (const w of ws) {
      border.add(at)
      at += Array.from(w).length
    }
    border.add(at)
    let pos = 0
    for (let i = 0; i < lines.length - 1; i += 1) {
      pos += Array.from(lines[i]).length
      if (!border.has(pos)) cutInside.push(`${text.slice(Math.max(0, pos - 2), pos + 2)}@${pos}`)
    }
  }
  check(
    '断句切点全部落在词边界（回归集 15 句）',
    cutInside.length === 0,
    cutInside.join(' , ') || '全部命中词边界',
  )

  /* ---- 词表合成规则 ---- */
  check('勾选词库纳入其专属断句词', buildWrapWords(['tech'], '').includes('这一代'))
  check('未勾选词库不纳入', !buildWrapWords([], '').includes('这一代'))
  check('手填术语进入词表', buildWrapWords([], '分布式账本，区块链').includes('分布式账本'))
  check(
    '手填的单字与纯英文被过滤',
    !buildWrapWords([], '的').includes('的') && !buildWrapWords([], 'abc').includes('abc'),
  )
}

/* ---- 识别结果基线对齐（alignOrigin） ---- */
{
  const SPEC = { maxCharsPerLine: 16, maxCharsPerLineEn: 42, maxLinesPerSegment: 1 }

  // 干净条目必须原样通过：返回新对象会让整张表无谓重渲染
  const short = seg(0, 2, '大家好')
  const clean = alignOrigin([short])
  check('对齐基线：干净条目引用不变', clean[0] === short)

  // 繁转简改写 text 却不动 origin —— 这就是「刚识别完就有小圆点」的来源
  const traditional = { ...seg(0, 3, '我用瀏覽器看網站'), origin: '我用瀏覽器看網站' }
  const converted = applyPunctuation([traditional], { zh: 'keep', en: 'keep' }).segments
  check('繁转简会让 text 偏离 origin', converted[0].text !== converted[0].origin, JSON.stringify(converted[0]))
  check('对齐后繁转简条目变干净', alignOrigin(converted)[0].text === alignOrigin(converted)[0].origin)

  // 折行同理：derived 条目保留了折行前的 origin
  const wrapped = applyLineWrap([seg(0, 10, '很多人觉得打开这个模式就等于在互联网上穿上了隐身衣')], SPEC).segments
  check('折行会让 text 偏离 origin', wrapped.some((s) => s.text !== s.origin))
  const aligned = alignOrigin(wrapped)
  check('对齐基线：折行条目全部变干净', aligned.every((s) => s.text === s.origin))
  check(
    '对齐基线：只改 origin 不动 text',
    aligned.map((s) => s.text).join('|') === wrapped.map((s) => s.text).join('|'),
  )

  // 守门：识别管线必须真的在落库前调用它，手动工具则不许（会抹掉已有的编辑痕迹）
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  check('识别结果落库前对齐基线', readSource('src/stores/project.ts').includes('alignOrigin(wrapped.segments)'))
  check('手动工具不重设基线', !readSource('src/components/ToolPanel.vue').includes('alignOrigin'))
}

/* ---- 字幕文件编码探测（electron/encoding.js） ---- */
{
  const text = '1\n00:00:00,000 --> 00:00:02,000\n你用浏览器的无痕浏览\n'

  const utf8 = decodeTextAuto(new Uint8Array(Buffer.from(text, 'utf8')))
  check('编码探测：UTF-8 原样读回', utf8.text === text && utf8.encoding === 'utf-8', utf8.encoding)

  const bom = decodeTextAuto(encodeSubtitle(text, 'utf-8-bom'))
  check('编码探测：UTF-8 BOM 被剥掉', bom.text === text && bom.encoding === 'utf-8-bom')

  const gbk = decodeTextAuto(encodeSubtitle(text, 'gbk'))
  check('编码探测：GBK 往返一致', gbk.text === text && gbk.encoding === 'gbk', gbk.encoding)

  const withBom16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  const r16 = decodeTextAuto(new Uint8Array(withBom16))
  check('编码探测：UTF-16LE 带 BOM', r16.text === text && r16.encoding === 'utf-8-bom')

  // 无 BOM 的 UTF-16：按 UTF-8 读会出现 U+FFFD，按 GBK 读是满屏乱码 —— 必须先认出来
  const latin = '1\r\n00:00:00,000 --> 00:00:02,000\r\nHello there\r\n'
  const noBom = decodeTextAuto(new Uint8Array(Buffer.from(latin, 'utf16le')))
  check('编码探测：无 BOM 的 UTF-16LE 读得回来', noBom.text === latin && noBom.encoding === 'utf-8-bom', JSON.stringify(noBom.text.slice(0, 12)))

  // 反例：普通 UTF-8 不能被误判成 UTF-16（误判的后果比漏判更糟，整份文件全乱）
  check('编码探测：普通 UTF-8 不误判为 UTF-16', decodeTextAuto(new Uint8Array(Buffer.from(text, 'utf8'))).encoding === 'utf-8')

  // GBK 里没有的字用问号占位，不能抛错、更不能整份写失败
  check('GBK 写回：生僻字降级为问号', new TextDecoder('gbk').decode(encodeSubtitle('\u{20000}', 'gbk')) === '?')
}

/* ---- 分段校对：只覆盖所选范围（mergeCuesIntoSelection） ---- */
{
  const base: SubtitleSegment[] = [
    { id: 'a', start: 0, end: 2, text: '第一条原文', origin: '第一条原文', issues: [] },
    { id: 'b', start: 2, end: 4, text: '第二条原文', origin: '第二条原文', issues: [] },
    { id: 'c', start: 4, end: 6, text: '第三条原文', origin: '第三条原文', issues: [] },
    { id: 'd', start: 6, end: 8, text: '第四条原文', origin: '第四条原文', issues: [] },
    { id: 'e', start: 8, end: 10, text: '第五条原文', origin: '第五条原文', issues: [] },
  ]

  // 只校对中间三条：首尾两条必须一条不动（连对象引用都不换）
  const mid = mergeCuesIntoSelection(
    base,
    [
      { start: 2, end: 4, text: '第二条改写' },
      { start: 4, end: 6, text: '第三条改写' },
      { start: 6, end: 8, text: '第四条改写' },
    ],
    ['b', 'c', 'd'],
  )
  check('分段校对：条数不变', mid.length === 5, String(mid.length))
  check(
    '分段校对：范围外条目原样保留',
    mid[0] === base[0] && mid[4] === base[4],
    `${mid[0].text} / ${mid[4].text}`,
  )
  check(
    '分段校对：范围内条目被替换',
    mid[1].text === '第二条改写' && mid[3].text === '第四条改写',
    mid.map((s) => s.text).join('|'),
  )
  check('分段校对：结果仍按时间排序', mid.every((s, i) => i === 0 || s.start >= mid[i - 1].start))
  // id 是撤销栈、选中态、结果回填共同的记账单位，条数没变时不能整份换新
  check('分段校对：条数不变时沿用原 id', mid[1].id === 'b' && mid[3].id === 'd', mid.map((s) => s.id).join(','))

  // 段内合并：AI 把三条并成两条，总条数应少一条，且不能把第四条挤掉
  const merged = mergeCuesIntoSelection(
    base,
    [
      { start: 2, end: 5, text: '第二三条合并' },
      { start: 5, end: 8, text: '第四条改写' },
    ],
    ['b', 'c', 'd'],
  )
  check('分段校对：段内合并后条数正确', merged.length === 4, String(merged.length))
  check(
    '分段校对：合并后仍保留范围外的首尾条',
    merged[0].text === '第一条原文' && merged[merged.length - 1].text === '第五条原文',
    merged.map((s) => s.text).join('|'),
  )

  /*
   * 范围外的时间码不许被挪。
   *
   * 旧实现是把整份列表交给 `enforceMonotonicCues` 一把梭：只要新的结尾压到范围外那条
   * 头上，被推后的是**那条老条目**，而界面上写的是「其余 N 条保持不变」。
   * 这里让 AI 把第四条写到 9.5 秒（第五条从 8 秒起），正确做法是截短新条目。
   */
  const overrun = mergeCuesIntoSelection(
    base,
    [
      { start: 2, end: 4, text: '第二条改写' },
      { start: 4, end: 6, text: '第三条改写' },
      { start: 6, end: 9.5, text: '第四条改写' },
    ],
    ['b', 'c', 'd'],
  )
  check(
    '分段校对：压到范围外时只截短新条目',
    overrun[4] === base[4] && overrun[3].end === 8 && overrun[3].end > overrun[3].start,
    `第五条 ${overrun[4].start}~${overrun[4].end} / 新条目 ${overrun[3].start}~${overrun[3].end}`,
  )

  // 反例对照：不传 ids 就是「整份重建」，条数少就会被截断 —— 这正是用户踩到的坑
  const wholesale = cuesToSegments([{ start: 2, end: 4, text: '只有一条' }], base)
  check('整份重建：结果少时会把文件截断（旧语义，仅全量时可用）', wholesale.length === 1)

  // 译文：按 id 只写这一段，其他条目的译文（含别的语言）必须留着
  const withTr: SubtitleSegment[] = [
    { id: 'a', start: 0, end: 2, text: '一', origin: '一', issues: [], translations: { en: 'one' } },
    { id: 'b', start: 2, end: 4, text: '二', origin: '二', issues: [], translations: { en: 'two', ja: '二' } },
    { id: 'c', start: 4, end: 6, text: '三', origin: '三', issues: [], translations: { en: 'three' } },
  ]
  const partial = applyTranslation(withTr, 'en', ['TWO'], ['b'])
  check('分段翻译：只改这一段', partial[1].translations?.en === 'TWO', JSON.stringify(partial[1].translations))
  check(
    '分段翻译：其他条目的译文原样',
    partial[0].translations?.en === 'one' && partial[2].translations?.en === 'three',
  )
  check('分段翻译：其他语言不受影响', partial[1].translations?.ja === '二', JSON.stringify(partial[1].translations))
  check(
    '分段翻译：未命中的 id 一个都不写',
    applyTranslation(withTr, 'en', ['X'], ['nope']).every((s, i) => s.translations?.en === withTr[i].translations?.en),
  )
}

/* ---- 断句词表与提示词必须完全隔离（源码扫描） ---- */
/*
 * 断句词表是「用户没说出口的偏好」：想让它保护断句，但绝不希望它影响转录。
 * 一旦哪天有人图省事在 `prompt.ts` 里引用词表，领域词库的 core 预算就会被
 * 悄悄撑大、转录结果跟着变 —— 这种回归在界面上看不出来，只能靠扫描钉死。
 */
{
  const readSource = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const promptSrc = readSource('src/utils/prompt.ts')
  check('提示词构造不引用断句词表', !/wrapWords|COMMON_WORDS|commonWords/.test(promptSrc))
  // 断行只吃调用方传进来的词表，不自己去读词库（否则「重新断行」和识别后处理会走两套口径）
  const lineWrapSrc = readSource('src/utils/lineWrap.ts')
  check('断行不直接读领域词库', !/from '@\/data\/lexicons'/.test(lineWrapSrc))
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
  // 不支持的环境必须提前判掉：材质选项在 Win10 上要么抛错要么没效果
  check('主进程按 Win11 22H2 (build 22621) 判支持', mainJs.includes('22621'))
  check('毛玻璃开启时窗口底色全透明', mainJs.includes("'#00000000'"))
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
  /*
   * 2026-11-01：玻璃从「四套语义 + 分组栏漏网」统一成三档（框架条 / 导航面板 / 内容画布）。
   * 三档共用**同一个底色**，只差透出量 —— 掺 surface 就会回到「左白右灰」的色带问题。
   * 这一组守的是：令牌齐全、两处深色块都改、三档单调（越靠边缘越透）、区域归位不漏。
   */
  const glassTiers = ['--glass-chrome-bg', '--glass-nav-bg', '--glass-shell-bg', '--glass-region-bg']
  check(
    '浅色三档玻璃令牌齐全，且都用主界面底色调',
    glassTiers.every((t) =>
      lightCss.includes(`${t}: color-mix(in srgb, var(--color-bg-base)`),
    ),
    glassTiers.filter((t) => !lightCss.includes(`${t}:`)).join(','),
  )
  check(
    '玻璃遮罩一律不掺 surface（掺了就出现色带）',
    !/--glass-(chrome|nav|shell|region)-bg:[^;]*--color-bg-surface/.test(lightCss) &&
      !/--glass-(chrome|nav|shell|region)-bg:[^;]*--color-bg-surface/.test(darkCss),
  )
  // 深色主题有「媒体查询 + 显式选择器」两块，改一处必漏另一处
  check(
    '深色两处块都定义了四档玻璃令牌',
    glassTiers.every((t) => darkCss.split(`${t}:`).length - 1 === 2),
    glassTiers.map((t) => `${t}=${darkCss.split(`${t}:`).length - 1}`).join(' '),
  )
  const veilPct = (css: string, token: string): number => {
    const hit = new RegExp(`${token}: color-mix\\(in srgb, var\\(--color-bg-base\\) (\\d+)%`).exec(css)
    return hit ? Number(hit[1]) : NaN
  }
  const tierOf = (css: string) => ({
    chrome: veilPct(css, '--glass-chrome-bg'),
    nav: veilPct(css, '--glass-nav-bg'),
    shell: veilPct(css, '--glass-shell-bg'),
    region: veilPct(css, '--glass-region-bg'),
  })
  for (const [name, css] of [
    ['浅色', lightCss],
    ['深色', darkCss],
  ] as const) {
    const t = tierOf(css)
    // 外壳与框架条同值：页脚条不铺底、直接吃外壳，数值不同就会和状态条差一档
    check(`${name}：外壳遮罩与框架条同值（页脚条才对得上状态条）`, t.shell === t.chrome, `${t.shell} vs ${t.chrome}`)
    check(`${name}：框架条比导航面板更透`, t.chrome < t.nav, `chrome=${t.chrome} nav=${t.nav}`)
    // 内容画布是外壳 × 内层相乘，合成后必须比导航面板更实，否则正文压不住材质
    const canvas = 1 - (1 - t.shell / 100) * (1 - t.region / 100)
    check(
      `${name}：内容画布合成后比导航面板更实`,
      canvas > t.nav / 100,
      `canvas=${(canvas * 100).toFixed(1)}% nav=${t.nav}%`,
    )
  }
  check(
    '深色每一档都比浅色更透（材质本就暗，遮罩一厚就没效果）',
    (() => {
      const l = tierOf(lightCss)
      const d = tierOf(darkCss)
      return d.chrome < l.chrome && d.nav < l.nav && d.region <= l.region
    })(),
  )
  // 区域归位：漏一个就一直实心夹在中间，界面看着像拼贴
  check(
    '导航面板三处归到同一档（侧栏 / 分组栏 / 文件树 / 编辑器侧栏）',
    ['\\.sidebar', '\\.setnav', '\\.filetree', '\\.editor__side'].every((s) =>
      new RegExp(`html\\.glass ${s}`).test(css),
    ),
  )
  check(
    '状态条与标题栏同一档（框架条）',
    /html\.glass \.statusbar \{\s*background: var\(--glass-chrome-bg/.test(css),
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

  /*
   * 原文案参考强度。
   *
   * 这一维最容易退化成「界面上有四个档、提示词里却是同一段话」——
   * 那种情况下用户调了没反应，还以为是 AI 不听话。所以逐档比对措辞。
   */
  const byStrength = [0, 1, 2, 3].map(
    (s) =>
      buildReviewPrompt({
        targets,
        options: { ...options, script: '今天我们聊一聊显卡这个东西', scriptStrength: s as 0 | 1 | 2 | 3 },
      }).prompt,
  )
  check(
    '文案强度四档都能生成文案段',
    byStrength.every((p) => p.includes('【原文案参考】')),
  )
  check(
    '文案强度四档措辞互不相同（调档必须真的改变提示词）',
    new Set(byStrength).size === 4,
    `${new Set(byStrength).size} 种`,
  )
  check('严格档：文稿说了算', byStrength[0].includes('一律以文稿为准'))
  check('严格档的一句话原则是「还原文稿」', byStrength[0].includes('字幕要还原文稿'))
  check('宽松档：只借专有名词写法', byStrength[3].includes('专有名词的写法'))
  check(
    '宽松档明确不许用文稿替换别的用词',
    byStrength[3].includes('不要用文稿替换识别结果的任何用词'),
  )
  check(
    '每一档都守住「不按文稿重排条目」',
    byStrength.every((p) => p.includes('不要按文稿重排或合并条目')),
    byStrength.findIndex((p) => !p.includes('不要按文稿重排或合并条目')) + '',
  )
  check(
    '严格档仍不许按文稿重排时间码',
    byStrength[0].includes('不要按文稿的字数重新分配时间码'),
  )
  /*
   * 默认档从源码里读，不 import store：store 模块会连带引入 pinia 与 vue，
   * 而这里是纯 Node 环境。用一条源码扫描守住「默认必须是中间那一档」足够。
   */
  const settingsSrc = readFileSync(
    new URL('../src/stores/settings.ts', import.meta.url),
    'utf8',
  )
  check('默认档是平衡（2）', /^\s*aiScriptStrength: 2,$/m.test(settingsSrc), '在 DEFAULT_SETTINGS 里')
  check(
    '「重新打开开关」会复位「不再提示」',
    /watch\(aiReviewTipEnabled[\s\S]{0,120}?aiReviewTipDismissed\.value = false/.test(settingsSrc),
    '否则打开开关也看不到气泡',
  )
  check('档位越界值被夹回合法范围', normalizeStrength(-3) === 0 && normalizeStrength(99) === 3)
  check('档位 NaN 落回平衡档', normalizeStrength(Number.NaN) === 2)
  check(
    '每一档都有给用户看的解释文字',
    SCRIPT_STRENGTH_OPTIONS.every((o) => o.label.length <= 3 && o.hint.length > 8),
  )
  check(
    '档位下标与数组顺序一致（滑块靠它取档，错位就会「选严格实际是宽松」）',
    SCRIPT_STRENGTH_OPTIONS.every((o, i) => o.value === i) &&
      strengthOption(3).label === '宽松',
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
  // 只警告不改是不够的：这条会被原样写进字幕，导出后播放器根本不显示
  const reversedFixed = parseModelOutput(reversed, 20)
  check(
    '倒流时间码被补齐为有效时长',
    reversedFixed.cues[0].end > reversedFixed.cues[0].start &&
      reversedFixed.cues[0].start === 5 &&
      reversedFixed.cues[0].end === 5.8,
    `${reversedFixed.cues[0].start}~${reversedFixed.cues[0].end}`,
  )

  const tooLong = ['1', '00:00:00,000 --> 00:00:50,000', '甲'].join('\n')
  check(
    '超出原片长给出警告',
    parseModelOutput(tooLong, 10).warnings.some((w) => w.includes('多出')),
    parseModelOutput(tooLong, 10).warnings.join('；'),
  )
  check('超出片长的结尾被夹到片尾', parseModelOutput(tooLong, 10).cues[0].end === 10)
  // 片长未知（0）时不能瞎夹，否则会把整份时间码压成 0
  check('片长未知时不夹取', parseModelOutput(tooLong, 0).cues[0].end === 50)
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

/*
 * 概览不再截断。
 *
 * 早期默认只留前 12 处（`previewLimit = 12`），本意是给个样本；
 * 实际用下来是反效果：界面写着「30 处有变化」，用户却只能翻到 12 条，
 * 剩下 18 条被改成了什么样完全无法确认 —— 而确认覆盖这个动作恰恰要求能逐条看。
 */
{
  const many = Array.from({ length: 20 }, (_, i) => ({
    start: i,
    end: i + 0.9,
    text: `改过的第 ${i + 1} 句`,
  }))
  const manyPrev = Array.from({ length: 20 }, (_, i) => ({
    ...seg(i, i + 0.9, `原来的第 ${i + 1} 句`),
  }))
  const all = summarizeReview(many, manyPrev)
  check(
    '概览列出全部变化（不再截断到 12 条）',
    all.previews.length === 20 && all.changed === 20,
    `${all.previews.length} / ${all.changed}`,
  )
  const capped = summarizeReview(many, manyPrev, 3)
  check('显式传入上限时仍然截断（参数保留可用）', capped.previews.length === 3)
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

/* ---- 交互不变量：「处理范围」区块不能跟着选择一起消失 ----
 *
 * 区块的显示条件曾经挂在「当前选中了什么」上，于是点一次「全部取消」，文件清单
 * 连同勾选框一起消失，用户再也选不回来（只能关窗重开）。这类退化不报错、不抛异常，
 * 只是把操作入口本身收走了 —— 跑一遍点击流程也未必发现，所以扫源码钉死。
 */
{
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const assistSrc = readSource('src/views/AssistView.vue')

  check(
    '「处理范围」区块的显示条件看「有没有文件可选」，不看「选没选中」',
    /const pickEditable = computed\(\(\) => targets\.value\.some/.test(assistSrc) &&
      !/const pickEditable = computed\(\(\) => selectedTargets/.test(assistSrc),
    'pickEditable 应基于 targets.value —— 基于 selectedTargets 会让「全部取消」把整块弄没',
  )
  check(
    '逐条勾选会带着文件级勾选一起走（不留「勾着却 0 条」的行）',
    /function syncFileSelection/.test(assistSrc) &&
      /function toggleCue[\s\S]{0,240}?syncFileSelection\(t\)/.test(assistSrc) &&
      /function setAllCues[\s\S]{0,240}?syncFileSelection\(t\)/.test(assistSrc),
    'toggleCue / setAllCues 都应调用 syncFileSelection(t)',
  )
  check(
    '「全选」把范围复位成全部条目，不是只把文件 id 塞回去',
    /function toggleSelectAll[\s\S]{0,240}?resetPicks\(\)/.test(assistSrc),
    'toggleSelectAll 选中全部时应先 resetPicks()',
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
    /dialog\?\.confirm/.test(appSrc) && /defaultId: 0/.test(appSrc) && /cancelId: 0/.test(appSrc),
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
  const modelsSrc = readSource('electron/models.js')
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
  const scanModelsSrc = readSource('electron/models.js')
  const catalogSrc = readSource('electron/model-catalog.js')
  const appModelsSrc = readSource('src/App.vue')
  const preloadModelsSrc = readSource('electron/preload.cjs')
  const engineClientSrc = readSource('electron/engine-client.js')
  const downloaderSrc = readSource('electron/model-download.js')

  /*
   * 这一组守的是「静默出错」：不报错、不崩溃，只是悄悄用错东西，
   * 用户过几天才发现结果不对，而那时早已没有现场。
   */
  check(
    '换模型后必须重新加载，不能只看 modelLoaded 这个布尔',
    /client\.loadedModel !== entry\.path/.test(mainModelsSrc) &&
      /this\.loadedModel = model/.test(engineClientSrc),
    '同一架构内换模型不重启进程，只看布尔会用旧模型跑完、界面却显示新模型的名字',
  )
  check(
    '自定义模型目录要落盘，重启后仍然生效',
    /function readCustomModelsDir/.test(mainModelsSrc) &&
      /writeCustomModelsDir\(value\)/.test(mainModelsSrc) &&
      /customModelsDir = readCustomModelsDir\(\)/.test(mainModelsSrc),
    '只存内存的话，换过目录的用户一重启就回落到默认目录，界面显示「没有模型」',
  )
  check(
    '取消下载不能被当成失败',
    /if \(job\.canceled\) \{\s*this\.finish\(job, 'canceled'\)/.test(downloaderSrc),
    '取消时 fetchOne 返回 false，会走到「所有下载源都失败了」那条分支',
  )

  check(
    '「使用中」由主进程判定，界面不拿文件名自己比',
    /const activeEntry = computed\(\(\) => model\.entry\)/.test(modelViewSrc) &&
      /activeEntry\.value\?\.id === id/.test(modelViewSrc) &&
      !/settings\.modelFile === item\.id/.test(modelViewSrc),
    '只比名字的话，文件被手动删掉后界面会一直挂着「使用中」的空壳',
  )
  /*
   * 漏导入一个常量 = 运行时 ReferenceError，而且症状不像错误。
   *
   * 真实发生过：main.js 从 model-catalog.js 只导入了 ARCH_WHISPER，app:info 里
   * 却在遍历 ARCH_SHERPA —— 整个 IPC 抛错，模型页的内置清单连同下载入口一起
   * 消失，界面上只剩「正在读取」。语法检查看不出（名字合法），类型检查不覆盖
   * .js，只能靠这条扫描守住。
   */
  const mainImported = new Set(
    // [^}]* 而不是 [\s\S]*?：后者会从文件里第一个 `import {`（electron 那行）
    // 一路吃到 model-catalog 的 `}`，把中间的 import 全当成一份名单
    [...mainModelsSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/model-catalog\.js'/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()))
      .filter(Boolean),
  )
  const mainArchUsed = [...new Set([...mainModelsSrc.matchAll(/\bARCH_[A-Z_]+\b/g)].map((m) => m[0]))]
  const mainArchMissing = mainArchUsed.filter((name) => !mainImported.has(name))
  check(
    '主进程用到的架构常量都从 model-catalog 导入了',
    mainArchMissing.length === 0,
    `未导入：${mainArchMissing.join('、')}`,
  )
  check(
    '主进程提供 models:resolve 与 models:active 两条查询通道',
    /ipcMain\.handle\('models:resolve'/.test(mainModelsSrc) &&
      /ipcMain\.handle\('models:active'/.test(mainModelsSrc) &&
      /resolve: \(file\) => ipcRenderer\.invoke\('models:resolve', file\)/.test(preloadModelsSrc) &&
      /active: \(id\) => ipcRenderer\.invoke\('models:active', id\)/.test(preloadModelsSrc),
    '判定规则只能存一份，放主进程',
  )
  check(
    '回退按「任一已装模型」，不死盯默认档',
    /export function resolveModel\(requested, ctx\)/.test(scanModelsSrc) &&
      /export function pickModel\(ctx\)/.test(scanModelsSrc),
    '只回退默认档的话，只装了 base 的用户会被判「找不到模型」',
  )
  check(
    '识别失败的报错指向模型管理页，不写死文件名',
    /没有可用的识别模型/.test(mainModelsSrc) && !/找不到模型文件（\$\{DEFAULT_MODEL\}）/.test(mainModelsSrc),
  )
  check(
    '不在内置目录里的模型也要列出来',
    /const ownModels = computed/.test(modelViewSrc) && /v-for="m in ownModels"/.test(modelViewSrc),
    '识别用得上、界面看不到的话，用户既不知道它生效了，也删不掉',
  )
  /*
   * 只信主进程的 `catalogKey` 不够：主进程没重启、下发的是旧结构时，
   * 内置模型会全部落进「自己的模型」，和上方卡片重复一遍（用户复现过）。
   * 渲染层必须拿当前清单的 id 再核一次。
   */
  check(
    '「自己的模型」按清单 id 再过滤一遍',
    /const catalogIds = computed/.test(modelViewSrc) &&
      /!m\.catalogKey && !catalogIds\.value\.has\(m\.id\)/.test(modelViewSrc),
    '两重条件缺一不可，否则旧数据会让官方模型重复显示',
  )
  /*
   * 内置条目不许在「自己的模型」里再列一遍。
   *
   * 真实踩过（2026-11-04）：`catalogKeyOf` 拿逻辑短名（`small`）去比磁盘标识
   * （`ggml-small.bin`），永远匹配不上，于是用户装了三个模型就看到六行 ——
   * 上面三张卡片，下面三个「自己的模型」，全是同一批文件。
   */
  check(
    '内置条目不会在「自己的模型」里重复出现',
    /function catalogKeyOf\(id\)[\s\S]{0,200}findCatalogByDiskId\(id\)/.test(modelsSrc) &&
      /export function findCatalogByDiskId/.test(catalogSrc),
    '按 key 比文件名永远落空，必须按磁盘标识 id 比对',
  )
  /*
   * 下载源与责任边界必须在界面上说清楚（2026-11-04 明确要求）。
   * 这不是「多写一段介绍」：模型来自第三方站点，出问题时要让用户知道
   * 该找谁，以及软件做到哪一步为止（校验、拒收），没做到哪一步（站点可用性）。
   */
  check(
    '模型页公示下载源与回退顺序',
    /ModelScope/.test(modelViewSrc) &&
      /hf-mirror/.test(modelViewSrc) &&
      /huggingface\.co/.test(modelViewSrc),
    '用户要知道模型是从哪下的、下不动时软件会不会换源',
  )
  check(
    'SenseVoice 是唯一的推荐位',
    /item\.key === 'sensevoice-small'[\s\S]{0,100}推荐/.test(modelViewSrc) &&
      (modelViewSrc.match(/tag--rec/g) ?? []).length <= 2,
    '推荐只能给一个模型，而且必须是中文效果最好的那个',
  )
  check(
    '模型页写明第三方源的责任边界',
    /不对第三方站点负责/.test(modelViewSrc) && /SHA-256/.test(modelViewSrc),
    '第三方的可用性必须与软件本身切开，但一句话说完就够，不铺陈',
  )
  /*
   * 「不对可用性负责」只切开了服务，没切开内容本身（2026-11-04 明确要求）。
   * 必须白纸黑字写出：模型文件不是本软件的一部分、权利归原权利人、
   * 软件只是下载与校验，不重新分发。否则用户会以为模型跟着软件的许可走。
   */
  check(
    '模型页明确第三方内容与本软件的切割',
    /不属于本软件/.test(modelViewSrc) && /权利与许可归各自发布者/.test(modelViewSrc),
    '只写「不负责可用性」不够，必须点明模型不是软件的一部分',
  )
  /*
   * 用户明确要求：UI 不写又长又复杂的提示（2026-11-04 晚）。
   * 底部只留来源、校验、责任切割三件事，各一句，不加饰线。
   * 这条守的是「别哪天又好心补回一段解释」。
   */
  check(
    '模型页底部说明保持精简',
    (modelViewSrc.match(/class="source__text"/g) ?? []).length <= 2 &&
      !/source__cut|source__warn/.test(modelViewSrc),
    '说明超过两句就该删，宁可少说也别让人读一屏免责声明',
  )
  check(
    '底部说明不使用文本框左侧饰线',
    !/border-left[^;]*;[\s\S]{0,80}\.source/.test(modelViewSrc) &&
      !/\.source__cut\s*\{[^}]*border-left/.test(modelViewSrc),
    '左侧竖线属于装饰性提示，与「少写提示」是同一类问题',
  )
  check(
    'README 与模型页同一套下载源与切割口径',
    /ModelScope → hf-mirror → huggingface\.co/.test(readSource('README.md')) &&
      /不属于本软件的一部分/.test(readSource('README.md')),
    '对外文档漏了这段，用户只会在出错时才发现责任边界没写清楚',
  )
  /*
   * 「下载了但没启用」这一组。
   *
   * 真实发生过：用户下了 1.6GB 的 Belle 中文微调，之后一直在用 244M 的 small，
   * 因为界面上「下完了」和「在用了」长得几乎一样 —— 卡片上只是多出一个
   * 「切换使用」按钮，没人会去点。这类问题不报错、不抛异常，只能扫源码守住。
   */
  const preferBlock = catalogSrc.match(/export const FALLBACK_ORDER = \[[\s\S]*?\]/)
  const belleAt = preferBlock ? preferBlock[0].indexOf("'belle'") : -1
  const smallAt = preferBlock ? preferBlock[0].indexOf("'small'") : -1
  check(
    '兜底挑选按能力排：SenseVoice 在首位，中文微调排在 small 之前',
    /export const FALLBACK_ORDER = \[\s*'sensevoice-small'/.test(catalogSrc) &&
      belleAt >= 0 &&
      smallAt >= 0 &&
      belleAt < smallAt,
    '顺序错了的话，装了 Belle 的用户在「没选过模型」时还是会被塞回 small',
  )
  check(
    '内置清单里 SenseVoice 排在最前',
    /export const MODEL_CATALOG = \[\s*\{[\s\S]{0,200}?key: 'sensevoice-small'/.test(catalogSrc),
    '默认推荐必须是清单第一项，否则模型页第一眼看到的还是旧的 whisper 档位',
  )
  check(
    '两套引擎都要打进安装包',
    /to: engine\/xbaos-engine\.exe/.test(readSource('electron-builder.yml')) &&
      /to: engine\/xbaos-engine-asr\.exe/.test(readSource('electron-builder.yml')),
    '少打一个的话，安装后换到另一种架构就没有引擎可用',
  )
  /*
   * ---- 下载完整性（2026-11-04）
   *
   * 清单里每个文件都必须带真实 sha256。Hugging Face 的 LFS 对象 id 与 ModelScope 的
   * `Sha256` 字段就是文件自身的 sha256，逐一核对过是同一个值 —— 也就是说「拿不到哈希」
   * 从来不是事实，只是没去取。少了哈希就只能靠「魔数 + 体积」放行，
   * 一次 CDN 的错误页（403 HTML）或截断包都会当成模型装进去，直到识别时才炸。
   */
  const sizedEntries = (catalogSrc.match(/^\s+size: \d+,$/gm) ?? []).length
  const hashedEntries = (catalogSrc.match(/^\s+sha256: '[0-9a-f]{64}',$/gm) ?? []).length
  check(
    '清单里每个下载文件都带真实 sha256',
    sizedEntries > 0 && sizedEntries === hashedEntries,
    `size 条目 ${sizedEntries} 个，sha256 ${hashedEntries} 个 —— 新增文件必须一并给出哈希`,
  )
  /*
   * ---- 下载源顺序（2026-11-04）
   *
   * urls 的顺序就是尝试顺序。huggingface.co 在国内通常拿不动，放在第一位等于
   * 「先卡几十秒再换源」；ModelScope 与 hf-mirror 才是能跑满带宽的那条路。
   */
  const firstUrls = [...catalogSrc.matchAll(/urls: \[\s*\n\s*'([^']+)'/g)].map((m) => m[1])
  check(
    '每个文件的首选下载源都不是 huggingface.co 直连',
    firstUrls.length === sizedEntries && firstUrls.every((u) => !/^https:\/\/huggingface\.co\//.test(u)),
    `首选源：${firstUrls.join(' / ')}`,
  )
  check(
    'SenseVoice 的首选源是国内的 ModelScope',
    (firstUrls.find((u) => u.includes('SenseVoiceSmallOnnx')) ?? '').includes('modelscope.cn'),
    '默认推荐的模型必须能从国内平台直接下载',
  )
  /*
   * ---- 「固定单遍」口径一致（2026-11-04）
   *
   * SenseVoice 是贪心 CTC，多跑几遍结果一样，所以 store 里把 passes 压成 1、
   * 界面也写了「固定单遍识别」。可「约 ×3 耗时」那个标签仍按设置里的档位算 ——
   * 同一块区域里三句话互相矛盾，用户只会得出「这软件在瞎说」的结论。
   */
  const homeSrc = readSource('src/views/HomeView.vue')
  check(
    '不支持多遍解码的模型按单遍显示耗时',
    /model\.caps\.decode \? preset : \{ \.\.\.preset, timeFactor: 1 \}/.test(homeSrc) &&
      /const depth = model\.caps\.decode \? settings\.reasoningDepth : 'standard'/.test(homeSrc),
    '说明写「固定单遍」、store 传 1，标签却按三档算耗时，三处对不上',
  )
  check(
    '「已下载但未启用」要在卡片上看得见',
    /class="tag tag--idle">未启用</.test(modelViewSrc),
    '只靠「切换使用」按钮区分的话，下完就等于「装好了」，没人会点',
  )
  /*
   * 反向守门：顶部那条劝导提示条是删掉的，别再「好心」加回来。
   *
   * 它最初用来解决「下了 1.6GB 却没启用」，但用户看过之后觉得放在顶部太吵，
   * 要求去掉 —— 「未启用」标签已经足够表达同一件事。删掉的东西要有断言守着，
   * 否则下次改版很容易又冒出来。
   */
  check(
    '模型页不再出现顶部劝导提示条',
    !/notice--action/.test(modelViewSrc) && !/const betterIdle/.test(modelViewSrc),
    '这条提示条是用户明确要求删掉的',
  )
  check(
    '启动时检查有没有可用模型并跳转',
    /function checkModelsOnStart/.test(appModelsSrc) &&
      /if \(!devViewInjected\) void checkModelsOnStart\(\)/.test(appModelsSrc),
    '不检查的话用户会一路点到「开始识别」才失败',
  )

  /* ---- 「模型不随包」文案守门（2026-10-14）
   *
   * 「装完就有模型可用」这个前提当初散落在**多处**：界面弹窗、设置页提示、
   * 安装器许可页、对外 README。改分发形态时只改一处必漏，上一轮就漏了两处
   * 用户可见的（设置页文案 + build/license.txt），是用户自己截图指出来的。
   *
   * 这组守的是「已失效的断言句」而不是「随包」这个词 —— 注释里说明
   * bundled 来源不可删之类仍然是对的，不该连坐。
   */
  const STALE_MODEL_CLAIMS = ['随包内置', '随包分发的模型', '随包默认', '随包附带', '装完即用']
  const modelCopySurfaces = [
    'src/views/SettingsView.vue',
    'src/views/ModelView.vue',
    'src/views/AboutView.vue',
    'src/App.vue',
    'src/legal/index.ts',
    'src/stores/settings.ts',
    'electron/paths.js',
    'electron/main.js',
    'build/license.txt',
    'NOTICE',
    'README.md',
  ]
  for (const rel of modelCopySurfaces) {
    const hits = STALE_MODEL_CLAIMS.filter((claim) => readSource(rel).includes(claim))
    check(
      `「${rel}」没有残留「随包 / 装完即用」的旧说法`,
      hits.length === 0,
      `命中：${hits.join(' / ')}`,
    )
  }
  check(
    '安装器许可页不再主张模型权利',
    !readSource('build/license.txt').includes('模型文件等全部组成部分') &&
      readSource('build/license.txt').includes('不属于本软件的权利范围'),
    '模型许可由各自权利人确定、著作权属原作者，我方不能主张',
  )

  /* 许可证**不能写死**（2026-10-17 修）。
   *
   * 四张模型卡曾经共用一段模板、统一渲染「MIT」—— 单看每张卡都对，实际是一条
   * 错误的法律信息：whisper 官方权重确实是 MIT，但 Belle-whisper-large-v3-turbo-zh
   * 是 BELLE-2 组织的中文微调版，Hugging Face 上标的是 Apache-2.0。
   * 有人照着界面上的「MIT」去做二次分发，就会漏掉 Apache-2.0 的署名与变更声明义务。
   *
   * 守两道：① 模板里必须是 `{{ item.license }}` 而不是字面量；
   *        ② 对外文本不能只说「MIT」一种许可。 */
  check(
    '模型卡的许可证按模型取字段，没有写死一个值',
    readSource('src/views/ModelView.vue').includes('{{ item.license }}') &&
      !/<dt>许可证<\/dt>[\s\S]{0,120}?<dd[^>]*>MIT<\/dd>/.test(
        readSource('src/views/ModelView.vue'),
      ),
    '四张卡的许可不同（Whisper 官方 MIT / BELLE 中文微调 Apache-2.0），写死会对外发布错误的许可信息',
  )
  check(
    '模型许可的对外表述区分了 MIT 与 Apache-2.0',
    readSource('src/legal/index.ts').includes('Apache License 2.0') &&
      readSource('build/license.txt').includes('Apache License 2.0') &&
      readSource('NOTICE').includes('Apache License 2.0') &&
      readSource('licenses/THIRD-PARTY.md').includes('Apache License 2.0'),
    '用户协议、安装器许可页、NOTICE、第三方清单四处都要写明「多数 MIT、部分中文微调版 Apache-2.0」',
  )

  /* ---- 演示数据必须自报 demo 标记（2026-10-17 修）
   *
   * `AudioPlayer.vue` 的 `loadAt()` 靠 `viewFile.demo` 区分两种「没有 blobUrl」：
   * 演示数据（正常，播放交给定时器）与导入的字幕文件（真没音频轨，提示无法试听）。
   * 这个字段曾经只在 `types/index.ts` 里**声明**过、全库没有一处赋值 ——
   * 判据恒为 undefined，于是 `?demo=1` 里一点播放就被当成无音频段落：
   * 播放头不动、还弹「这一段没有音频轨（例如导入的字幕文件），无法试听」。
   *
   * probe 的 `demo-playback` 场景跑的是同一条链（真实点击 + 读时间码），
   * 这里再加一道**静态**守门：它不需要 dev server，跑 unit 就能拦住
   * 「字段又没人赋值」这类回归。
   */
  check(
    '演示数据自报 demo 标记',
    readSource('src/stores/project.ts').includes('file.demo = true') &&
      readSource('src/mock/mockData.ts').includes('demo: true'),
    'loadDemo 与 makeAudioFile 造出来的条目都要带 demo: true，否则播放器会当成无音频段落',
  )

  /* ---- 媒体表必须有显式版本号，且组件侧真的去读它（2026-10-17 修）
   *
   * 用户报「导入自己的音频：识别正常，但波形空白 + 播放无声 + 提示没有音轨」。
   * 根因不在读字节、Blob、解码、播放任何一环（这些探针全都验过是好的），
   * 而是 **`media` 这张 Map 的内容变动没被 Vue 感知**：
   * `loadMedia()` 把 `blobUrl`/`peaks` 写进条目后，
   *   ① `AudioPlayer` 的 `singleUrl` computed 永远停在第一次算出的 `null`
   *      → 判「没有音轨」、`<audio>` 从不设 src，所以**没声音**；
   *   ② 时间轴读`peaksOf()` 也拿不到新值，且没有任何东西被触发重绘 → **波形空白**。
   * 对Map 做一次同值`set` 立刻就好 —— 说明读得到、就是没人被通知。
   *
   * 反例验过：把下面两处`mediaVersion` 接线拆掉，探针 `media-ui-flow` 立刻
   * 6条FAIL，提示语原样变回「这一段没有音频轨（例如导入的字幕文件），无法试听」。
   */
  const projectSrc = readSource('src/stores/project.ts')
  const playerSrc = readSource('src/components/AudioPlayer.vue')
  const trackSrc = readSource('src/components/TimelineTrack.vue')
  check(
    '媒体表有显式版本号，且写入口都会touch',
    projectSrc.includes('const mediaVersion = ref(0)') &&
      projectSrc.includes('function touchMedia()') &&
      // 新建条目、blob 就绪、peaks 到位、移除、清空—— 每一处内容变动都要 touch
      (projectSrc.match(/touchMedia\(\)/g) ?? []).length >= 5,
    'media 是 ref(new Map)，内容变动不会被 Vue 当成响应式变更；必须靠 mediaVersion 显式广播',
  )
  check(
    '播放器读媒体表时会建立依赖（不能只靠 Map 查找）',
    playerSrc.includes('void project.mediaVersion'),
    'singleUrl / partAudioUrl 必须读 mediaVersion，否则地址永远缓存首次算出的 null',
  )
  check(
    '时间轴重绘波形会听媒体表版本号',
    /watch\(\(\) => \[project\.mediaVersion/.test(trackSrc),
    'peaks 是异步写进去的，只靠 peaksOf() 的返回值当依赖，peaks 到位那刻没人被通知重绘',
  )

  /* ---- 「联网面」文案守门（2026-10-16）
   *
   * 软件**不是**完全离线：检查更新默认开启，下载模型要访问模型仓库；AI 校对与 AI 翻译
   * 还要把内容交给用户自选的第三方在线服务。可「全程离线」「软件本身不联网」这类
   * 绝对句一度散落在 README、官网首屏、官网 AI 展示块、THIRD-PARTY 的取舍理由里 ——
   * 全是会被现实打脸的承诺，本轮由用户自己指出来。
   *
   * 禁的是**绝对句**，不是「离线」这个词：
   * 「关掉自动检查、模型就位之后可以完全离线使用」是有条件的事实陈述，仍然允许。
   */
  const ABSOLUTE_OFFLINE_CLAIMS = [
    '全程离线',
    '全程不联网',
    '不需要联网',
    '零网络请求',
    '软件本身不联网',
    '本软件不联网',
    '不依赖任何在线服务',
    // THIRD-PARTY 里那句「与应用『全过程本地完成、不上传音频』的承诺冲突」就是这一句：
    // 它把「不上传」说成了覆盖整个软件的原则承诺，而软件确实会联网
    '全过程本地完成',
  ]
  const networkCopySurfaces = [
    'README.md',
    'src/views/HomeView.vue',
    'src/views/EditorView.vue',
    'src/views/AssistView.vue',
    'src/views/AboutView.vue',
    'src/components/dialogs/FormatHelpDialog.vue',
    'licenses/THIRD-PARTY.md',
    'build/license.txt',
    'NOTICE',
  ]
  for (const rel of networkCopySurfaces) {
    const hits = ABSOLUTE_OFFLINE_CLAIMS.filter((claim) => readSource(rel).includes(claim))
    check(
      `「${rel}」没有「全程离线 / 软件不联网」这类绝对句`,
      hits.length === 0,
      `命中：${hits.join(' / ')}`,
    )
  }
  const readmeCopy = readSource('README.md')
  check(
    'README 如实写明会联网的两处，并点出检查更新默认开启',
    readmeCopy.includes('检查更新') && readmeCopy.includes('下载模型') && readmeCopy.includes('默认开启'),
    '只写「不上传」不够：检查更新默认开启、下载模型会访问仓库，都得说清楚',
  )
  check(
    'README 说明 AI 功能的内容会离开本机',
    readmeCopy.includes('第三方在线 AI 服务') && readmeCopy.includes('离开本机'),
    '只讲「剪贴板中转」会让读者以为内容从没出过本机',
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
      /visibleIssues\(item\.seg\)/.test(editorViewSrc) && /visibleIssues\(seg\)/.test(subSrc),
      '只改一处的话，列表里还在、行首红条没了，看起来像半坏',
    )
  }

  /* ---- 底部告警分层：一个报当前文件，一个报全工程 ---- */

  const statusBarSrc = readSource('src/components/AppStatusBar.vue')
  check(
    '底部状态栏报全工程、编辑器底栏报当前文件（两个口径）',
    /project\.allErrors/.test(statusBarSrc) &&
      /countIssues\(activeFile\.value/.test(editorViewSrc) &&
      !/project\.allErrors/.test(editorViewSrc),
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
    'package.json 版本号是合法语义化版本（更新检查要靠 semver 比较）',
    // 允许预发布后缀：测试版就是 1.0.0-beta，得能如实写在这里。
    // 判定复用 update.js 的规则，避免「守门认为合法、运行时认为非法」两套标准。
    isValidVersion(pkgVersion),
    pkgVersion,
  )
  check(
    '测试版带预发布标识时仍然能通过更新比较',
    compareVersions(pkgVersion, pkgVersion) === 0 && isValidVersion(pkgVersion),
    `当前 package.json 版本：${pkgVersion}`,
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
  check('版本号合法性：拒绝 v 前缀与构建元数据', !isValidVersion('v1.0.0') && !isValidVersion('1.0.0+build'))
  check('版本号合法性：接受两段到四段', isValidVersion('1.0') && isValidVersion('1.2.3.4'))
  check('版本号合法性：拒绝非字符串', !isValidVersion(123 as unknown as string))
  check(
    '版本号合法性：接受预发布标识（测试版要能如实写进 package.json）',
    isValidVersion('1.0.0-beta') && isValidVersion('1.0.0-beta.2') && isValidVersion('1.0.0-rc.1'),
    '不接受的话 app.getVersion() 一读回来就会被判非法，更新检查直接坏掉',
  )
  check('版本号合法性：拒绝空预发布标识', !isValidVersion('1.0.0-') && !isValidVersion('1.0.0-.'))

  // ---- 预发布标识的比较（semver 规则）
  check('预发布小于同版本正式版', compareVersions('1.0.0-beta', '1.0.0') === -1)
  check('正式版大于同版本预发布', compareVersions('1.0.0', '1.0.0-beta') === 1)
  check(
    '预发布之间按字母序',
    compareVersions('1.0.0-alpha', '1.0.0-beta') === -1 &&
      compareVersions('1.0.0-beta', '1.0.0-rc') === -1,
  )
  check('预发布里数字段小于字母段', compareVersions('1.0.0-1', '1.0.0-alpha') === -1)
  check('预发布段数少的更小', compareVersions('1.0.0-beta', '1.0.0-beta.1') === -1)
  check('预发布的数字段按数值比而不是字典序', compareVersions('1.0.0-beta.2', '1.0.0-beta.10') === -1)
  check('预发布标识相同则相等', compareVersions('1.0.0-beta', '1.0.0-beta') === 0)
  check('数字段的优先级高于预发布标识', compareVersions('1.0.1-beta', '1.0.0') === 1, '1.0.1 > 1.0.0')

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
    /*
     * 更新弹窗的按钮必须用清单里的 `download.url`，不能退化成「打开官网首页」——
     * 官网靠那个地址上的 `?download=1` 判断要不要自动拉起下载弹窗，
     * 一旦改回无参的 `openTarget()`，参数就静默失效、用户落在首页找不到按钮。
     */
    const dialogSrc = src('src/components/dialogs/UpdateDialog.vue')
    check(
      '更新弹窗的下载按钮走清单里的 download.url',
      /update\.openTarget\(target\)/.test(dialogSrc) &&
        /const target = update\.downloadUrl \|\| update\.targetUrl/.test(dialogSrc),
      '退化成 openTarget() 的话，官网的 ?download=1 参数永远传不出去',
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

/*
 * 「合并时间轴的增量拼接」那一组断言（8 条）随 `mergeTimeline.ts` 一起删除了。
 *
 * 它们测的是「重新拼接时哪些条目该保留、哪些该重建」—— 那套逻辑存在的唯一理由
 * 是合并视图**物化**了一份数据，而用户的编辑只存在于那份产物上。P0 把视图改成了
 * 派生的拼接（`concatSegments()`），拼接不再产生数据，也就不存在「重拼把修改冲掉」。
 * 顺带，原用户报过的那个问题（往队列追加音频后，之前的修改原封不动地回来了）
 * 从根上不会发生了：源文件里的字幕就是用户改过的那一份。
 */

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

  /*
   * 「每条都首字母大写 + 每条结尾加句点」是用户实测报上来的问题：
   * 一句话被识别切成三条，译出来成了三个残句。根因是输入是「一条一行」的
   * 编号列表，模型按「每行一个完整句子」处理。所以提示词必须显式说明这件事。
   */
  check(
    '翻译提示词：明确断句位置必须与原文一致',
    r.prompt.includes('断句位置必须与原文一致'),
  )
  check(
    '翻译提示词：点明相邻条目常属同一句话',
    r.prompt.includes('相邻的好几条往往属于同一句话'),
  )
  check(
    '翻译提示词：明令不要把每条都翻成独立句子',
    r.prompt.includes('不要把每一条都翻成一个独立的完整句子'),
  )
  check(
    '翻译提示词：把序号后的句点说清是分隔符（这是「每条都加句号」的直接诱因）',
    r.prompt.includes('序号分隔符'),
    '旧写法「序号、英文句点、一个空格、译文」会被读成句末标点',
  )
  check(
    '翻译提示词：示例里有句中断条（逗号结尾 + 下一条小写开头）',
    r.prompt.includes('3. Many of you would say 1024 MB,') &&
      r.prompt.includes('4. but if we open the calculator on the computer,'),
  )

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

  /*
   * 许可清单的斑马纹必须按「行」算。
   *
   * 两列网格是行优先填充，`nth-child(odd)` 命中的永远是**左列** —— 左列整片有底色、
   * 右列整片裸着，看起来不像同一张表（用户截图指出过）。写成每四项取前两项才对。
   * 这条守的是那种「不报错、只是变丑」的回退，肉眼看半天看不出来。
   */
  check(
    '许可清单的斑马纹按行（4n+1 / 4n+2）而不是按项交替',
    /\.licenses__row:nth-child\(4n \+ 1\)/.test(about) &&
      /\.licenses__row:nth-child\(4n \+ 2\)/.test(about) &&
      !/\.licenses__row:nth-child\(odd\)/.test(about),
    'nth-child(odd) 只会命中左列',
  )
}

/* ------------------------------------------------ 全局样式与组件本地样式重名 */

/**
 * 全局类名不许与组件本地类名重名。
 *
 * 为什么值得单独守一条：scoped 只保证「组件自己声明过的属性」不被全局覆盖，
 * 组件没声明的属性照样从全局漏进来。给导入页加了个带边框的 `.pane` 之后，
 * AI 辅助窗口里那个同名但无边框的 `.pane` 立刻被框住 —— 标题顶在边框上，
 * 整页看不出是哪来的，控制台也一句不提。
 *
 * 白名单里是已经逐个对过账的：本地规则本就是整套重写，重名不会带来视觉变化。
 * 新增全局类名前先跑 `npm run unit`，撞上了就换个名字，别往白名单里塞。
 */
{
  const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
  const classOf = (css: string): string[] =>
    [...stripComments(css).matchAll(/^\s*\.([A-Za-z][\w-]*)/gm)].map((m) => m[1])

  const globalClasses = new Set(classOf(readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8')))

  const vueFiles: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.vue')) vueFiles.push(child)
    }
  }
  walk(fileURLToPath(new URL('../src', import.meta.url)))

  const collisions = new Map<string, Set<string>>()
  for (const file of vueFiles) {
    const src = readFileSync(file, 'utf8')
    const styleStart = src.indexOf('<style')
    if (styleStart < 0) continue
    for (const name of classOf(src.slice(styleStart))) {
      if (!globalClasses.has(name)) continue
      if (!collisions.has(name)) collisions.set(name, new Set())
      collisions.get(name)!.add(file.slice(file.lastIndexOf('/') + 1))
    }
  }

  // 白名单：本地规则覆盖了全局那一条涉及的全部视觉属性，重名不改变渲染结果
  const allowed: Record<string, string> = {
    block: 'AssistView 整套重写了卡片外观（边框/圆角/底色），只差 overflow',
    block__head: 'AssistView 自己给了间距与对齐',
    block__title: 'AssistView 自己给了字号与颜色',
    btn: 'HomeView 只加了 .btn.is-flying 修饰符，本意就是叠在全局按钮上',
    card: 'RecordView 的值与全局一致，另加了内边距',
    switch: 'SettingsView 改了开关的布局方式，原生输入框本就该藏起来',
  }

  const unexpected = [...collisions].filter(([name]) => !(name in allowed))
  check(
    '全局类名没有和组件本地类名撞名',
    unexpected.length === 0,
    unexpected.length
      ? `${unexpected.map(([n, f]) => `.${n}（${[...f].join('、')}）`).join(' ')} —— 换掉全局那个名字`
      : '',
  )

  // 白名单也得跟着实现走：哪条已经不撞了就该删掉，否则以后误以为它还冲突
  const stale = Object.keys(allowed).filter((name) => !collisions.has(name))
  check('重名白名单里没有失效条目', stale.length === 0, stale.length ? `${stale.join('、')} 已不再重名，删掉` : '')
}

/* ------------------------------------------------ 录制音频窗口的接线守门 */

{
  const readText = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const main = readText('electron/main.js')
  const preload = readText('electron/preload.cjs')
  const record = readText('src/views/RecordView.vue')
  const dropzone = readText('src/components/MaterialBoard.vue')
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
  /*
   * 只看 `openRecorder` 自己那一小段：素材区里「移除」「清空」的确认框是
   * 正当的（会丢字幕），不能因为同一个文件里有 dialog.confirm 就算违规。
   */
  const recorderFrom = dropzone.indexOf('async function openRecorder')
  const recorderTo = dropzone.indexOf('function loadDemo')
  const recorderSrc =
    recorderFrom >= 0 && recorderTo > recorderFrom ? dropzone.slice(recorderFrom, recorderTo) : ''
  check(
    '点入口直接开窗（先置锁再 open），不再弹「接下来会打开窗口」那种无意义确认',
    recorderSrc.length > 0 &&
      !recorderSrc.includes('dialog.confirm') &&
      recorderSrc.indexOf('setRecordActive(true)') >= 0 &&
      recorderSrc.indexOf('setRecordActive(true)') < recorderSrc.indexOf('record.open()'),
    '点「录制音频」的意图已经够明确，多一步确认是纯噪音',
  )
  check(
    '录音窗口存在期间主界面有锁遮罩，关窗后解除',
    app.includes('ui.recordActive') && app.includes('onRecordClosed'),
    '没有锁就会重蹈 AI 窗口改造前的「流程没走完又点一次入口」',
  )
}

/* -------------------------------------------- 设置页：二级菜单与搜索索引 */
{
  const readSource = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const settingsView = readSource('src/views/SettingsView.vue')

  // 词条区按分组铺开，「共 N 词」又是各分节之和 —— 跨组重复会让两个数对不上，
  // 用户会把「软件算错了」当成 bug 报上来
  const groupSum = COMMON_WORD_GROUPS.reduce((sum, g) => sum + g.words.length, 0)
  check(
    '常用词分组之和等于总词数（跨组不重复）',
    groupSum === COMMON_WORDS.length,
    `${groupSum} vs ${COMMON_WORDS.length}`,
  )

  const domIds = new Set(Array.from(settingsView.matchAll(/\bid="([a-z0-9-]+)"/gi), (m) => m[1]))

  /*
   * 索引里的每个 id 都必须真在页面上。删区块时忘了删索引，用户会「搜得到、
   * 点进去没反应」—— 这类 bug 界面上看不出来，只能靠扫描钉死。
   */
  const missingSections = SETTINGS_ENTRIES.filter((e) => !domIds.has(e.section)).map(
    (e) => e.section,
  )
  check(
    '搜索索引的区块 id 都存在于设置页',
    missingSections.length === 0,
    missingSections.join(','),
  )

  const missingAnchors = SETTINGS_ENTRIES.filter((e) => e.anchor && !domIds.has(e.anchor)).map(
    (e) => e.anchor as string,
  )
  check(
    '搜索索引的控件锚点都存在于设置页',
    missingAnchors.length === 0,
    missingAnchors.join(','),
  )

  // 反方向：新增区块却忘了进索引，就是「界面有这一项、搜不到」
  const blockIds = Array.from(
    settingsView.matchAll(/<section id="([a-z0-9-]+)" class="block"/gi),
    (m) => m[1],
  )
  const indexedSections = new Set(SETTINGS_ENTRIES.map((e) => e.section))
  const unindexed = blockIds.filter((id) => !indexedSections.has(id))
  check('设置页每个区块都在搜索索引里', unindexed.length === 0, unindexed.join(','))

  // 每个分组都得有内容，否则左侧会出现点了什么都不显示的空组
  const emptyGroups = SETTINGS_GROUPS.filter(
    (g) => !SETTINGS_ENTRIES.some((e) => e.group === g.id),
  ).map((g) => g.id)
  check('每个分组都至少有一个设置项', emptyGroups.length === 0, emptyGroups.join(','))

  const unknownGroups = SETTINGS_ENTRIES.filter(
    (e) => !SETTINGS_GROUPS.some((g) => g.id === e.group),
  ).map((e) => e.id)
  check('设置项的分组都存在', unknownGroups.length === 0, unknownGroups.join(','))

  const ids = SETTINGS_ENTRIES.map((e) => e.id)
  check('设置项 id 不重复', new Set(ids).size === ids.length, String(ids.length))

  // 深链：模型页点「更改存储位置」靠它决定先切哪一组
  check('深链能找到所属分组', groupOfDomId('models-dir') === 'engine', String(groupOfDomId('models-dir')))
  check('深链也认控件锚点', groupOfDomId('field-maxCharsPerLine') === 'subtitle')
  check('陌生 id 不瞎猜分组', groupOfDomId('not-a-setting') === null)

  /* ---- 搜索 ---- */
  const hitIds = (q: string): string[] => searchSettings(q).map((e) => e.id)
  check('搜「编码」命中默认编码', hitIds('编码').includes('export-encoding'), hitIds('编码').join(','))
  check('搜「毛玻璃」命中外观项', hitIds('毛玻璃').includes('glass'), hitIds('毛玻璃').join(','))
  check('搜「gbk」按同义词命中', hitIds('gbk').includes('export-encoding'), hitIds('gbk').join(','))
  check('搜「字数」命中单行上限', hitIds('字数').includes('spec-zh'), hitIds('字数').join(','))
  check('搜「热键」命中快捷键', hitIds('热键').includes('shortcuts'), hitIds('热键').join(','))
  check('空搜索不出结果', searchSettings('   ').length === 0)

  // 多个词是 AND：两个词必须同时命中同一条，否则「导出 gbk」会翻出所有导出项
  const both = hitIds('导出 gbk')
  check(
    '多词搜索按 AND 收窄',
    both.length === 1 && both[0] === 'export-encoding',
    both.join(','),
  )

  /*
   * 页面级大标题已整体删除（2026-11-01）：当前页名由窗口标题栏正中(.titlebar__view)
   * 与左侧导航的选中态共同指示，页面里再写一遍只是重复，还把真正的内容往下压。
   * 这条守两件事：四个视图都不许把 .view__head 写回来；样式表里也不许残留这套规则。
   */
  const headSurfaces = [
    'src/views/HomeView.vue',
    'src/views/ModelView.vue',
    'src/views/SettingsView.vue',
    'src/views/AboutView.vue',
    'src/styles/global.css',
  ]
  const headLeftovers = headSurfaces.filter((rel) =>
    /view__(head|title|desc)/.test(readSource(rel)),
  )
  check(
    '页面不再渲染 .view__head / .view__title',
    headLeftovers.length === 0,
    headLeftovers.join(','),
  )

  /*
   * 热词同音纠正（2026-11-04）。
   *
   * 这套规则的每一条都是「宁漏勿错」的取舍，所以断言必须**成对**：
   * 该改的要改，容易误伤的必须原样留着。只测前一半等于没测。
   */
  {
    const homeSrc = readSource('src/views/HomeView.vue')
    const projSrc = readSource('src/stores/project.ts')
    /*
     * 这条守的是两套通道的分工：提示词只有一百多字预算，超出的词**不能消失**。
     * 界面要写明白「注入有限额、纠正用全量」，后端要真的拿全量词表去纠正。
     */
    check(
      '首页讲清注入预算与全量热词后处理',
      /PROMPT_BUDGET_CHARS/.test(homeSrc) &&
        /超出的词仍全部参与识别后的同音纠正/.test(homeSrc) &&
        /全量热词参与/.test(homeSrc),
      '预算只约束注入，被截掉的词仍要在结果文本里生效',
    )
    check(
      '纠正用全量热词且受开关控制',
      /settings\.termFix\s*\?\s*collectFixTerms\(settings\.promptTerms, settings\.lexiconIds\)/.test(
        projSrc,
      ),
      '若拿 buildPrompt 的 usedTerms 去纠正，超预算的词就被悄悄丢掉了',
    )

    /*
     * 误伤回归：内置常见词表里的 3180 个词，每一个都是「本来就写对了」的文本。
     * 拿**全量词库**（不是只塞三个手填词）去跑，任何一个被改都是 bug。
     *
     * 真实踩过（2026-11-04）：拼音表收了古音，「百 / 跑」都有 bo2、
     * 「位 / 机」都有 wei4，于是「百分 → 跑分」「单位 → 单机」；
     * 「必须 / 必需」这类两个都合法的同音词也会被改。加了常见词与歧义词
     * 白名单后归零。这条断言是「宁可漏不可误伤」的底线，不许删。
     */
    const fullTerms = collectFixTerms('扫盲、贝叶斯、直播带货', LEXICONS.map((l) => l.id))
    const fullFixer = createTermFixer(fullTerms)
    const wrongly = COMMON_WORDS.filter((w) => fullFixer(w).hits.length > 0)
    check('常见词在全量词库下零误伤', wrongly.length === 0, wrongly.slice(0, 8).join('、'))

    const contextSamples = [
      '我们今天登陆了网站',
      '订金与定金不是一个意思',
      '必须把这个权力说清楚',
      '学位和学历不是一回事',
    ]
    const contextHits = contextSamples.filter((s) => fullFixer(s).hits.length > 0)
    check('语境歧义词一律不改写', contextHits.length === 0, contextHits.join(' / '))

    const basic = createTermFixer(['扫盲', '贝叶斯', '直播带货'])

    const typo = basic('这期讲讲扫忙的意义')
    check('同音错字被纠正（扫忙 → 扫盲）', typo.text === '这期讲讲扫盲的意义', typo.text)

    const already = basic('这期讲讲扫盲的意义')
    check('原文已经正确时不重复替换', already.hits.length === 0 && already.text === '这期讲讲扫盲的意义')

    const semi = basic('还讲了贝叶思公式')
    check('部分字错也能纠正（贝叶思 → 贝叶斯）', semi.text === '还讲了贝叶斯公式', semi.text)

    // 反例：三个字全不一样，没有任何一个字面锚点 —— 改它没有任何依据
    const noAnchor = basic('这期讲讲别的')
    check('整段都不相同则不替换', noAnchor.hits.length === 0, noAnchor.text)

    // 反例：声调不同。「事实」shí shí / 「实施」shí shī，改错就把原意写反
    const toneDiff = createTermFixer(['实施'])('这是事实')
    check(
      '声调不同不算同音（事实 ≠ 实施）',
      toneDiff.text === '这是事实' && toneDiff.hits.length === 0,
      toneDiff.text,
    )

    // 反例：同一个字面上的坑 —— 「现存」xiàn cún / 「显存」xiǎn cún
    const toneDiff2 = createTermFixer(['显存'])('现存的空间不够')
    check('声调不同不误改（现存 ≠ 显存）', toneDiff2.text === '现存的空间不够', toneDiff2.text)

    // 反例：原文片段本身就是另一个热词，不许被覆盖
    const literal = createTermFixer(['实施', '事实'])('这是事实')
    check('原文是另一个热词时不覆盖', literal.text === '这是事实', literal.text)

    // 反例：等长才替换。长度不同意味着要增删字，时间码就对不上了
    const lenDiff = createTermFixer(['直播带货'])('直播带祸')
    check('四字词照常纠正', lenDiff.text === '直播带货', lenDiff.text)
    const lenDiff2 = createTermFixer(['直播带货'])('直播带')
    check('长度不同不替换', lenDiff2.text === '直播带' && lenDiff2.hits.length === 0, lenDiff2.text)

    // 反例：不能跨标点。跨过去就等于改了另一句的开头
    const cut = createTermFixer(['扫盲'])('扫，忙')
    check('不跨标点匹配', cut.text === '扫，忙' && cut.hits.length === 0, cut.text)

    // 单字热词不参与：一个字换掉的收益抵不上误伤面
    const single = createTermFixer(['熵'])('这个商很重要')
    check('单字热词不参与替换', single.text === '这个商很重要', single.text)

    // 含英文 / 数字的热词没有拼音可言，直接放弃
    const latin = createTermFixer(['GPT4'])('用的 GPD4')
    check('非纯汉字热词不参与', latin.text === '用的 GPD4', latin.text)

    // 歧义：两个不同的热词都能对上，没有任何依据二选一
    const ambiguous = createTermFixer(['扫盲', '扫芒'])('讲讲扫忙')
    check('歧义时原地不动', ambiguous.text === '讲讲扫忙', ambiguous.text)

    // 等长是硬约束：时间码按字数不变的前提才敢动
    const samples = ['扫忙', '贝叶思', '直播带祸', '扫盲', '随便说点什么']
    const sameLen = samples.every((s) => {
      const r = createTermFixer(['扫盲', '贝叶斯', '直播带货'])(s)
      return Array.from(r.text).length === Array.from(s).length
    })
    check('替换前后字数完全一致', sameLen)

    // 分段：只改 text，不动 origin（识别流程末尾会用 alignOrigin 统一对齐）
    const fixed = applyTermFix([seg(0, 1, '讲讲扫忙')], ['扫盲'])
    check(
      '纠正只改 text，不动 origin',
      fixed.segments[0].text === '讲讲扫盲' && fixed.segments[0].origin === '讲讲扫忙',
      `${fixed.segments[0].text} / ${fixed.segments[0].origin}`,
    )
    check('纠正记录可用于提示', fixed.hits.length === 1 && fixed.hits[0].to === '扫盲')

    // 没有热词时整条链路必须零改动（老用户没填热词，升级后不该有任何意外）
    const empty = applyTermFix([seg(0, 1, '讲讲扫忙')], [])
    check('热词为空时完全不动', empty.segments[0].text === '讲讲扫忙' && empty.hits.length === 0)
  }
}

/* ------------------------------------------------------------ 说话人分离 */

{
  /** 只有时间与编号的说话人段，字段与引擎输出一致 */
  const span = (start: number, end: number, speaker: number) => ({ start, end, speaker })

  // 完全落在同一段里：最理想的情况，必须判对
  const inside = assignSpeakers([seg(1, 2, '甲')], [span(0.5, 3, 0)])
  check('落在同一段内直接归属', inside.segments[0].speaker === 0 && inside.speakers === 1)

  // 跨越换人点：一句横跨两个人，按重叠时长取最长的那一边
  const across = assignSpeakers(
    [seg(1, 5, '甲乙')],
    [span(0, 2, 0), span(2, 6, 1)],
  )
  check('跨越换人点按重叠时长取最长', across.segments[0].speaker === 1, String(across.segments[0].speaker))

  /*
   * 擦边：两个字的一条正好卡在两人之间，两边各盖一点点。
   * 这时「谁盖得多」由噪声决定，不构成证据 —— 宁可沿用上一条。
   */
  const edge = assignSpeakers(
    [seg(0, 3, '甲甲'), seg(2.8, 3.6, '乙')],
    [span(0, 3, 0), span(3.5, 9, 1)],
  )
  check('覆盖比例不足时沿用上一条', edge.segments[1].speaker === 0, String(edge.segments[1].speaker))

  // 首条就落空：没有任何前文可继承，留空而不是瞎猜
  const lonely = assignSpeakers([seg(10, 11, '丙')], [span(0, 5, 0)])
  check('首条无依据时不猜', lonely.segments[0].speaker === undefined && lonely.untouched === 1)

  // 没跑分离（或分离失败返回空）：一个字都不许动
  const none = assignSpeakers([seg(1, 2, '甲')], [])
  check(
    '没有分离结果时完全不动',
    none.segments[0].speaker === undefined && none.tagged === 0 && none.untouched === 1,
  )

  // 人数按最大编号 + 1 推算：聚类编号不保证连续，不能拿段数当人数
  const people = assignSpeakers([seg(1, 2, '甲')], [span(0, 3, 2)])
  check('人数按最大编号推算', people.speakers === 3, String(people.speakers))

  // 只写 speaker，时间码与文本一个都不许变
  const orig = seg(1, 2, '原文')
  const kept = assignSpeakers([orig], [span(0, 3, 0)]).segments[0]
  check(
    '只补标注，不动时间码与文本',
    kept.start === 1 && kept.end === 2 && kept.text === '原文' && kept.speaker === 0,
  )

  // 单人音频：整段只有一个编号，不该被拆成多人
  const single = assignSpeakers(
    [seg(0, 3, '甲'), seg(3, 6, '乙'), seg(6, 9, '丙')],
    [span(0, 3, 0), span(3, 6, 0), span(6, 9, 0)],
  )
  check(
    '单人音频不会被拆成多人',
    single.speakers === 1 && single.segments.every((s) => s.speaker === 0),
  )

  check('标签从 1 开始数', speakerLabel(0) === '讲话人 1' && speakerLabel(undefined) === '')

  /*
   * 称呼：自定义优先，空/空白退回默认。
   * 空串是很常见的一手（用户清空输入框想「恢复原名」），它不能被当成一个
   * 名叫「」的讲话人 —— 导出时就会变成「：字幕」。
   */
  check(
    '自定义称呼优先于默认名',
    speakerName(0, { 0: '张三' }) === '张三' && speakerName(0, {}) === defaultSpeakerName(0),
  )
  check('空白称呼退回默认名', speakerName(2, { 2: '   ' }) === '讲话人 3')
  check('没有编号时没有称呼', speakerName(undefined, { 0: '张三' }) === '')

  /* ---- 称呼的增删改：全部是纯函数，返回新数组 ---- */
  const spkSegs: SubtitleSegment[] = [
    { ...seg(0, 1, '一'), speaker: 0 },
    { ...seg(1, 2, '二'), speaker: 1 },
    { ...seg(2, 3, '三'), speaker: 0 },
  ]
  const listed = listSpeakers(spkSegs, { 0: '张三' }, [5])
  check(
    '列出讲话人并统计条数',
    listed.length === 3 &&
      listed[0].name === '张三' &&
      listed[0].count === 2 &&
      listed[1].count === 1 &&
      listed[2].index === 5 &&
      listed[2].count === 0,
    JSON.stringify(listed),
  )

  check('新编号不复用已删掉的号', nextSpeakerIndex(spkSegs, [5]) === 6)
  check('只有条目时按最大编号 +1', nextSpeakerIndex(spkSegs) === 2)

  const changedSpk = setSpeakerFor(spkSegs, [spkSegs[1].id], 0)
  check(
    '批量改讲话人',
    changedSpk.changed === 1 && changedSpk.segments.filter((s) => s.speaker === 0).length === 3,
    JSON.stringify(changedSpk.segments.map((s) => s.speaker)),
  )
  check('改讲话人不改原数组', spkSegs[1].speaker === 1)
  check('已经是同一个人的不算改动', setSpeakerFor(spkSegs, [spkSegs[0].id], 0).changed === 0)

  const cleared = setSpeakerFor(spkSegs, [spkSegs[0].id], undefined)
  check(
    '清除标识是真的删字段',
    cleared.changed === 1 && !('speaker' in cleared.segments[0]),
  )

  const merged = mergeSpeakerInto(spkSegs, 1, 0)
  check(
    '并入他人后只剩一个编号',
    merged.changed === 1 && merged.segments.every((s) => s.speaker === 0),
  )
  check('并给自己等于没改', mergeSpeakerInto(spkSegs, 1, 1).changed === 0)

  const wiped = clearSpeaker(spkSegs, 0)
  check(
    '清除某人的全部标识',
    wiped.changed === 2 && wiped.segments.filter((s) => s.speaker === 0).length === 0,
  )

  /*
   * 导出：默认不写讲话人标签。
   *
   * 这条断言守的是「默认行为不变」—— 升级之后，没开分离的老工程导出来的
   * 文件必须和以前逐字节一样。
   */
  const withSpk: SubtitleSegment = { ...seg(0, 2, '第一句'), speaker: 0 }
  const plain = serializeSrt([withSpk], {})
  check('默认导出不带讲话人标签', !plain.includes('讲话人'), plain.split('\n')[2])

  const prefixed = serializeSrt([withSpk], { speakerPrefix: true })
  check('开启后 SRT 写成「称呼：字幕」', prefixed.includes('讲话人 1：第一句'), prefixed.split('\n')[2])

  // 自定义称呼要跟着走：用户改完名字导出还是「讲话人 1」就白改了
  const named = serializeSrt([withSpk], { speakerPrefix: true, speakerNames: { 0: '张三' } })
  check('导出用自定义称呼', named.includes('张三：第一句'), named.split('\n')[2])

  // ASS 有 Name 列，写在那里比塞进文本干净；逗号会破坏字段分隔，必须抹掉
  const ass = serializeAss([withSpk], { speakerPrefix: true, speakerNames: { 0: '张三,李四' } })
  check(
    'ASS 称呼写进 Name 列',
    /Dialogue: 0,[^,]+,[^,]+,Default,张三 李四,0,0,0,,第一句/.test(ass) && !ass.includes('张三：'),
    ass.split('\n').find((l) => l.startsWith('Dialogue')),
  )

  // VTT 用语音标签，别在文本里硬编
  const vtt = serializeVtt([withSpk], { speakerPrefix: true, speakerNames: { 0: '张三' } })
  check('VTT 用 <v> 语音标签', vtt.includes('<v 张三>第一句'), vtt.split('\n').pop())

  // 双语只标一次：同一条字幕的两行不属于两个讲话人
  const bilingual: SubtitleSegment = {
    ...seg(0, 2, '第一句'),
    speaker: 1,
    translations: { en: 'First line' },
  }
  const bi = serializeSrt([bilingual], { lang: 'both', translationLang: 'en', speakerPrefix: true })
  check(
    '双语音只标一次',
    (bi.match(/讲话人 2：/g) ?? []).length === 1,
    bi.split('\n').slice(2).join(' | '),
  )
}

/* ---- 说话人分离的接线（源码扫描） ---- */
{
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const engineSrc = readSource('engine-onnx/src/main.cpp')
  const onnxCmake = readSource('engine-onnx/CMakeLists.txt')
  const mainSrc = readSource('electron/main.js')
  const projectSrc = readSource('src/stores/project.ts')
  const settingsSrc = readSource('src/stores/settings.ts')

  // 引擎侧：命令真的实现了，且 sherpa 的分离模块真的编进去了。
  // 只写命令不打开模块，运行时会返回 "Speaker diarization is not enabled"，
  // 而单元测试和打包都不会报错 —— 这个坑实际踩过一次。
  check('引擎实现 diarize 命令', /cmd\s*==\s*"diarize"/.test(engineSrc))
  check(
    '分离模块编译开关已打开',
    /SHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION\s+ON/.test(onnxCmake),
    '关着的时候引擎能编过、跑起来才报 not enabled',
  )

  // 主进程：一次性进程，跑完必须退出，别留常驻。
  check('主进程注册分离接口', /ipcMain\.handle\('engine:diarize'/.test(mainSrc))
  check(
    '分离进程用完即退',
    /client\.diarize\([\s\S]{0,900}?finally\s*\{[\s\S]{0,200}?client\.stop\(\)/.test(mainSrc),
    '分离是一次性任务，常驻会白占几十 MB',
  )

  // 渲染层：默认关闭，且分离必须排在整条流水线最后一步 ——
  // 放前面的话，后面的标点切分与按规格折行都会重排条目，编号跟着错位。
  check('说话人分离默认关闭', /speakerDiarization:\s*false/.test(settingsSrc))
  const assignAt = projectSrc.indexOf('assignSpeakers(')
  const wrapAt = projectSrc.indexOf('applyLineWrap(')
  const fixAt = projectSrc.indexOf('applyTermFix(')
  check(
    '分离排在字幕后处理之后',
    assignAt > wrapAt && assignAt > fixAt && wrapAt > 0,
    `assign=${assignAt} wrap=${wrapAt} fix=${fixAt}`,
  )

  /*
   * 字幕表的说话人列是「随数据出现」的：没开分离就不占宽度。
   * 列数与格子数必须一起变 —— 表头 5 个格子配 6 条轨道（或反过来），
   * 整张表会从「字幕文本」那一列开始错位，而且只在有说话人时才看得出来。
   *
   * 6 → 5 是因为「忽略告警」那一列撤掉了（按钮挪进了右键菜单）。
   */
  const tableSrc = readSource('src/components/SubtitleTable.vue')
  const tracks = (sel: string): number => {
    const at = tableSrc.indexOf(sel)
    if (at < 0) return -1
    const m = tableSrc.slice(at, at + 600).match(/grid-template-columns:\s*([^;]+);/)
    if (!m) return -1
    // minmax(0, 1fr) 里带空格和逗号，先整体折成一个记号再数，否则会被算成两列
    return m[1].replace(/minmax\([^)]*\)/g, 'X').trim().split(/\s+/).length
  }
  const plainTracks = tracks('.subtable__head,\n.row {')
  const spkTracks = tracks('.subtable__head.has-spk,\n.row.has-spk {')
  const cells = (tableSrc.match(/v-if="hasSpeakers"/g) ?? []).length
  check('说话人列默认不占宽度', plainTracks === 5, `轨道数 ${plainTracks}`)
  check('有说话人时多一列', spkTracks === 6, `轨道数 ${spkTracks}`)
  check(
    '表头与行同时切列',
    cells === 2,
    `v-if="hasSpeakers" 出现 ${cells} 次，应为 2（表头 + 行）`,
  )

  /*
   * 讲话人的三块界面：侧栏面板、表格里的换人入口、导出里的筛选。
   *
   * 这三块各自都能单独跑起来，但少一处就会变成「功能在、入口不在」：
   * 面板没挂上去 = 改不了名；表格那格不可点 = 只能整批改；导出没筛选 =
   * 台账里勾了人也不生效。
   */
  const editorSrc = readSource('src/views/EditorView.vue')
  const panelSrc = readSource('src/components/SpeakerPanel.vue')
  const exportSrc = readSource('src/components/dialogs/ExportDialog.vue')
  const homeSrc = readSource('src/views/HomeView.vue')

  check('编辑器侧栏挂了讲话人面板', /<SpeakerPanel \/>/.test(editorSrc))
  check('面板能改名', /speakers\.rename\(/.test(panelSrc))
  check(
    '删除时两种去向都给了',
    /mergeSpeakerInto\(/.test(panelSrc) && /clearSpeaker\(/.test(panelSrc),
    '只清除标识会让「其实同一个人」的两段发言永远分开',
  )
  check('表格里点称呼就能换人', /openSpeakerMenu\(\$event, seg\)/.test(tableSrc))
  check('字幕条带右键菜单', /@contextmenu="openRowMenu\(\$event, seg\)"/.test(tableSrc))

  /*
   * 右键菜单在表格与时间轴上是**同一份**实现。
   *
   * 两处各写一份时最容易出现的偏差是「表格里能合并、时间轴上合并是灰的」，
   * 而且只在多选时暴露。所以守门不看某一句文案，而是盯住接线方式：
   * 两边都从 useSegmentMenu 取，且谁也没有自己拼菜单项列表。
   */
  const timelineSrc = readSource('src/components/TimelineTrack.vue')
  const menuSrc = readSource('src/composables/useSegmentMenu.ts')
  check(
    '时间轴的字幕条也能右键',
    /@contextmenu="onBarContextMenu\(\$event, bar\.seg\)"/.test(timelineSrc) &&
      /<UiMenu/.test(timelineSrc),
    '时间轴上没有右键入口，多选之后只能回表格里操作',
  )
  check(
    '两处右键菜单是同一份实现',
    /useSegmentMenu\(/.test(tableSrc) &&
      /useSegmentMenu\(/.test(timelineSrc) &&
      !/tidyMenu\(\[/.test(tableSrc) &&
      !/tidyMenu\(\[/.test(timelineSrc),
    '组件里自己拼菜单项，迟早与另一处不一致',
  )
  check(
    '菜单项集中在 composable',
    /label: '合并选中'/.test(menuSrc) &&
      /label: '更改讲话人'/.test(menuSrc) &&
      /label: '在播放头分割'/.test(menuSrc),
    'composable 里找不到菜单项，说明实现又散回组件了',
  )
  check(
    '时间轴不给自己做不到的菜单项',
    /useSegmentMenu\(\)/.test(timelineSrc),
    '时间轴的条上没有输入框，传了 beginEdit 就会出现点了没反应的「编辑文本」',
  )
  check(
    '表格能给「编辑文本」',
    /useSegmentMenu\(\{[\s\S]{0,200}beginEdit/.test(tableSrc),
    '不传 beginEdit，表格里就少了直接进编辑的入口',
  )
  check(
    '导出会带上称呼与筛选',
    /speakerNames: namesOf\.get/.test(exportSrc) && /filteredSummary/.test(exportSrc),
    '只传标签不传称呼，导出来的永远是「讲话人 N」',
  )

  /*
   * 导出的两处目录输入框都能调起系统选框。
   *
   * 只给文本框 = 让用户手打 `D:\Podcast\第12期`，敲错一个字符就只剩一句「目录不存在」。
   * 两处（统一目录、逐文件清单）都要有，少一处那一种模式就还是瞎输。
   */
  check(
    '统一目录旁能调起系统选框',
    /export__dirrow[\s\S]{0,900}pickDir\('unified'/.test(exportSrc) &&
      /pickDirectory\(/.test(exportSrc),
    '只有一个文本框，用户得手打整条路径',
  )
  check(
    '逐文件的目录框旁也能调起系统选框',
    /plan__dirrow[\s\S]{0,900}pickDir\(item\.fileId/.test(exportSrc),
    '「每个文件分别指定」那种模式下仍然只能手输',
  )
  check(
    '导出弹窗顶部没有可收起的汇总条',
    !/export__summary/.test(exportSrc) && !/收起清单/.test(exportSrc),
    '「将输出到 N 个目录 / 收起清单」这块是纯导航，已经删掉了',
  )

  // 分离开关必须已经从折叠里挪出来：它藏在「高级选项」里时，没人找得到
  const advAt = homeSrc.indexOf('class="adv field--wide"')
  const spkAt = homeSrc.indexOf('settings.speakerDiarization')
  check(
    '分离开关不在高级选项里',
    spkAt > 0 && advAt > 0 && spkAt < advAt,
    `开关在 ${spkAt}、折叠在 ${advAt}`,
  )
  check('分离开关改名为「区分不同的讲话人」', /区分不同的讲话人/.test(homeSrc))

  /*
   * 导入页的形态（2026-11-04 定）：素材区融合拖放与列表、一个入口通吃、
   * 页面不整页滚、批量方式归设置。
   *
   * 这几条彼此依赖：只做「两栏」而留着整页滚动，卡片就没有独立的滚动条；
   * 只做「一个入口」而 accept 里没有字幕后缀，用户选了字幕文件会被静默丢弃。
   */
  const boardSrc = readSource('src/components/MaterialBoard.vue')
  check(
    '导入只有一个入口（音频与字幕同一个选择器）',
    !homeSrc.includes('导入字幕文件') && /accept="[^"]*\.srt[^"]*"/.test(boardSrc),
    '两个按钮等于逼用户先判断「我这是音频还是字幕」，那是给软件省事',
  )
  check(
    '素材方块可拖动排序',
    /draggable="true"/.test(boardSrc) && /project\.reorderIntake\(/.test(boardSrc),
    '不能拖动就只剩上下箭头，调顺序很别扭',
  )
  check(
    '末尾常驻「+」入口',
    /tile--add/.test(boardSrc) && /name="plus"/.test(boardSrc),
    '空队列时整块画布就没有落点了',
  )
  check(
    '批量处理方式归到设置里',
    /批量处理方式/.test(homeSrc) && !/批量处理方式/.test(boardSrc),
    '它描述的是这一批怎么合成结果，属于设置而不是某个文件',
  )
  check(
    '页面不整页滚动，改由两张卡片各自滚',
    /\.view--fill \.view__body \{[\s\S]{0,140}overflow: hidden/.test(homeSrc) &&
      /\.board__grid \{[\s\S]{0,160}overflow-y: auto/.test(boardSrc) &&
      /\.settings \{[\s\S]{0,200}overflow-y: auto/.test(homeSrc),
    '整页一滚，两栏就失去了「各自独立」的意义',
  )
}
/* ------------------------------------------------ 页面组件必须单根 */

{
  /*
   * 每个页面组件只能有一个根节点。
   *
   * 根元素外面多一个注释节点，组件就成了多根片段；App.vue 里的
   * `<Transition mode="out-in">` 因此等不到离场回调 —— 切页会整页空白，
   * 控制台一句错都不报。这个坑真踩过一次（HomeView 顶上那段排版说明），
   * 只有逐页点开才发现，肉眼和类型检查都拦不住，只能靠守门。
   */
  const views = ['HomeView', 'EditorView', 'ModelView', 'SettingsView', 'AboutView']
  for (const name of views) {
    const src = readFileSync(new URL(`../src/views/${name}.vue`, import.meta.url), 'utf8')
    const roots = parseSfc(src).descriptor.template?.ast?.children ?? []
    const root = roots[0] as { type: number } | undefined
    check(
      `${name} 只有一个根节点`,
      roots.length === 1 && root?.type === 1,
      `根节点 ${roots.length} 个（type ${roots.map((n) => (n as { type: number }).type).join(',')}）：注释也算节点`,
    )
  }
}

/* ------------------------------------------------ 内嵌字体 */

{
  /*
   * 字体必须**随包带上**，不能只写一个回退栈。
   *
   * 之前就是只写栈：Windows 默认没有思源黑体，用户机器上实际渲染的是微软雅黑，
   * 同一行字幕换台电脑字宽就变。而这件事在开发机上永远看不出来 —— 开发机装了思源黑体。
   * 所以守门盯着「文件在不在、CSS 有没有真的用上」，不盯文案。
   */
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const fontsCss = readSource('src/styles/fonts.css')
  const tokensCss = readSource('src/styles/tokens.css')
  const mainTs = readSource('src/main.ts')

  const fontFile = new URL('../src/assets/fonts/noto-sans-sc-subset.woff2', import.meta.url)
  const fontBytes = existsSync(fontFile) ? statSync(fontFile).size : 0

  check(
    '内嵌字体文件真的在仓库里（不是占位空文件）',
    fontBytes > 1_000_000,
    fontBytes === 0 ? '缺 src/assets/fonts/noto-sans-sc-subset.woff2' : `${(fontBytes / 1048576).toFixed(1)} MB`,
  )
  check(
    '@font-face 指向那个 woff2，且声明为变量字重',
    /@font-face/.test(fontsCss) &&
      /noto-sans-sc-subset\.woff2/.test(fontsCss) &&
      /font-weight:\s*100 900/.test(fontsCss),
    '一条 100–900 覆盖 400/500/600 三档，比分三个静态字重省得多',
  )
  check(
    '样式入口真的导入了 fonts.css（且排在 tokens 之前）',
    /import '\.\/styles\/fonts\.css'/.test(mainTs) &&
      mainTs.indexOf('styles/fonts.css') < mainTs.indexOf('styles/tokens.css'),
    '漏了这一行，前面那条 @font-face 就是一段没人用的 CSS',
  )
  check(
    '--font-sans 以内嵌字体打头',
    /--font-sans:\s*"Noto Sans SC"/.test(tokensCss),
    '排在系统字体后面就白内嵌了：装了思源黑体的机器会先用系统那份',
  )
}

/* ------------------------------------------------ 许可清单不许漏项 */

{
  /*
   * 「随产物分发的东西必须能在「关于」页里找到」。
   *
   * 上一版漏了两类：说话人分离的两个声纹模型（随包分发，却一栏都没有）、
   * 以及 fastcluster（BSD 明文要求二进制分发时在文档里带署名）。
   * 这类东西漏了不会报错、界面也一切正常，只能靠清单对账。
   */
  const readSource = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const about = readSource('src/views/AboutView.vue')
  const third = readSource('licenses/THIRD-PARTY.md')

  const pairs: [string, string][] = [
    ['声纹切分模型（pyannote）', 'pyannote'],
    ['声纹模型（CAM++）', 'CAM++'],
    ['说话人聚类（fastcluster）', 'fastcluster'],
    ['内嵌字体', 'Open Font License'],
  ]
  for (const [label, needle] of pairs) {
    check(
      `「关于」页与第三方清单都写了${label}`,
      about.includes(needle) && third.includes(needle),
      '两处要同时有：关于页给用户看，THIRD-PARTY.md 随安装包分发',
    )
  }

  check(
    '内嵌字体的许可原文随包（licenses/Open-Font-License-1.1.txt）',
    existsSync(new URL('../licenses/Open-Font-License-1.1.txt', import.meta.url)) &&
      /SIL Open Font License/i.test(readSource('licenses/Open-Font-License-1.1.txt')),
    'OFL 要求分发时随附许可全文',
  )
}

/* ------------------------------------------------ 进度条三态（源码扫描） */
{
  /*
   * 进度条以前会停在 99% 不动，根因是**两套进度各走各的**：
   * 状态栏读 `project.progress`（按文件数折算，识别占满全程），
   * 而讲话人分离只往 `ui` 的任务栈里写，任务栈是另一套 UI。
   * 于是分离在跑、进度条却停在识别最后那个 99%。
   *
   * 现在改成「工作单元」：识别一遍算一单元，启用分离再加一单元，
   * 识别与分离共用同一条进度条；拿不到可信百分比时走不确定态。
   *
   * 这些都是「少写一行就退化、且退化后界面不报错」的接线，只能靠守门。
   */
  const readSrc = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const projectSrc = readSrc('src/stores/project.ts')
  const statusSrc = readSrc('src/components/AppStatusBar.vue')
  const appSrc = readSrc('src/App.vue')
  const mainSrc = readSrc('electron/main.js')
  const iconSrc = readSrc('src/components/Icon.vue')
  const materialSrc = readSrc('src/components/MaterialBoard.vue')
  const filetreeSrc = readSrc('src/components/FileTree.vue')

  check(
    '进度不再按「文件数」折算',
    !/const perFile = 100 \/ queue\.length/.test(projectSrc) &&
      projectSrc.includes('const setUnitProgress ='),
    '旧的折算把每个文件占满 1/队列长度，讲话人分离因此无处安放，只能把进度钉在 99%',
  )
  check(
    '分离的真实百分比接进了同一条进度条',
    /onDiarizeProgress[\s\S]{0,800}setUnitProgress\(currentUnitBase, passes, percent \/ 100\)/.test(
      projectSrc,
    ),
    '分离只写任务栈的话，状态栏那条进度条在分离阶段是死的',
  )
  check(
    '拿不到百分比时仍记录下来（界面不再据此换形态）',
    projectSrc.includes('const progressStalled = ref(false)') &&
      /progressStalled\.value = true/.test(projectSrc),
    '预处理与分离聚类这两段确实拿不到可信百分比，值得留一笔；但界面不能再跟着它变',
  )
  check(
    '底栏文案只说「正在处理 某个文件」',
    /progressLabel\.value = queue\[0\] \? `正在处理 \$\{queue\[0\]\.name\}`/.test(projectSrc) &&
      /currentUnitLabel = `正在处理 \$\{file\.name\}`/.test(projectSrc) &&
      // 遍数、阶段都进日志，不再出现在底栏文案里
      !projectSrc.includes('（第 ${k + 1}/${passes} 遍）'),
    '文案一长一短，底栏中间那块就跟着动，进度条看起来像在抖',
  )
  check(
    '进度条回到单一形态（没有滑动短条、没有省略号）',
    !statusSrc.includes('progress-glide') &&
      !statusSrc.includes('is-indeterminate') &&
      !statusSrc.includes('···') &&
      statusSrc.includes('statusbar__progress-bar'),
    '一有进度就切数字条、一超时就切滑动条，2.5 秒来回一次，观感上就是进度条在跳',
  )
  check(
    '进度区悬停摊开运行日志，且关得不那么急',
    statusSrc.includes('@mouseenter="openLog"') &&
      statusSrc.includes('@mouseleave="scheduleClose"') &&
      statusSrc.includes('statusbar__log') &&
      // 进度区与气泡之间有空隙，立刻关就够不到气泡了
      statusSrc.includes('closeTimer') &&
      statusSrc.includes('statusbar__log::after'),
    '进度条说不清在等什么，就把引擎日志给用户看；移开即收，但不许收得让人够不到',
  )
  check(
    '引擎日志收进日志 store',
    appSrc.includes('onLog') && appSrc.includes('logs.push'),
    '主进程发了 engine:log，渲染层没人听就等于没有',
  )
  check(
    '分离进程的日志也转发到界面',
    /client\.on\('log'[\s\S]{0,400}send\('engine:log'/.test(mainSrc),
    '分离是另一个引擎进程，日志不转发的话分离阶段气泡里一片空白',
  )
  check(
    'spinner 自带旋转',
    iconSrc.includes('icon--spin') && iconSrc.includes('@keyframes icon-spin'),
    '旋转属于这个图标的语义，放在图标自己身上才不会漏掉使用点',
  )
  check(
    '处理中的角标都指向同一个 spinner 图标',
    materialSrc.includes("processing: 'spinner'") &&
      filetreeSrc.includes("processing: 'spinner'"),
    '导入页方块与编辑器文件树都要转起来',
  )
  check(
    '旋转只做一处（状态栏不再自己写动画）',
    !/statusbar__spin\s*\{[\s\S]{0,120}animation/.test(statusSrc),
    '两处动画叠在同一个元素上会互相覆盖，且以后改转速要改两处',
  )
}

/* ------------------------------------------------ 导出讲话人标签的默认值 */
{
  /*
   * 开了「区分不同的讲话人」的人，导出时不带标签等于白分离 —— 所以要默认勾上。
   * 但**用户手动改过之后必须听他的**，否则他再也关不掉。
   *
   * 「默认值」和「记忆」要分开记，所以有个 `speakerPrefixUserSet` 标记。
   * 少了这个标记，默认勾上之后写回磁盘，下次就分不清是默认还是他选的。
   *
   * 还有一处容易打架：导出弹窗、导出内容、就地保存三处各判一次，
   * 迟早出现「导出带标签、按一次保存标签没了」。统一读 `speakerPrefixEffective`。
   */
  const readSrc = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const settingsSrc = readSrc('src/stores/settings.ts')
  const exportSrc = readSrc('src/components/dialogs/ExportDialog.vue')
  const editorSrc = readSrc('src/views/EditorView.vue')

  check(
    '默认值与用户记忆分开记',
    settingsSrc.includes('speakerPrefixUserSet: boolean') &&
      settingsSrc.includes('const speakerPrefixEffective = computed'),
    '合成一个布尔值就分不清「这是默认」还是「这是他选的」',
  )
  check(
    '用户动过勾之后就记成他的选择',
    /settings\.speakerPrefix = value[\s\S]{0,120}settings\.speakerPrefixUserSet = true/.test(
      exportSrc,
    ),
    '不记这个标记，他下次打开弹窗又被默认值覆盖',
  )
  check(
    '导出弹窗读的是生效值',
    exportSrc.includes('settings.speakerPrefixEffective') &&
      !/v-model="settings\.speakerPrefix"/.test(exportSrc),
    '直接绑原值的话，勾选显示与导出内容会对不上',
  )
  check(
    '就地保存与导出用同一口径',
    editorSrc.includes('settings.speakerPrefixEffective'),
    '两处各判一次，会出现「导出带标签、按一次保存就把标签抹掉」',
  )
}

/* ------------------------------------------------ 跨文件讲话人对应关系 */
{
  /*
   * 编号只是「这个文件里的第几个人」。A 文件的 1 号与 B 文件的 1 号
   * 未必是同一个人 —— 两个文件各拍各的，编号相同纯属巧合。
   *
   * 推断只能靠**用户自己起的名字**：同名即同一人。
   * 系统给的「讲话人 N」在每个文件里都叫这个数，拿它当依据等于把
   * 两个陌生人绑成一个人 —— 这正是老版本「所有文件共用一套称呼」的病根。
   */
  const plan = planSpeakerMapping([
    { id: 'a', indexes: [0, 1], names: { '0': '小包', '1': '王五' } },
    { id: 'b', indexes: [0, 1], names: { '0': '小包' } },
  ])
  check(
    '同名认定为同一个人',
    plan.mapping.a['0'] === plan.mapping.b['0'],
    `a0=${plan.mapping.a['0']} b0=${plan.mapping.b['0']}`,
  )
  check(
    '统一称呼沿用用户的名字',
    plan.globals[plan.mapping.a['0']]?.name === '小包',
    plan.globals[plan.mapping.a['0']]?.name,
  )
  check(
    '认不出名字的各算各的',
    plan.mapping.a['1'] !== plan.mapping.b['1'],
    '默认称呼不是证据，不能拿来绑人',
  )

  const defPlan = planSpeakerMapping([
    { id: 'a', indexes: [0], names: {} },
    { id: 'b', indexes: [0], names: {} },
  ])
  check(
    '两个文件同名的「讲话人 1」不合并',
    defPlan.mapping.a['0'] !== defPlan.mapping.b['0'],
    '系统给的称呼不是证据',
  )

  check(
    '默认称呼不算用户起的名字',
    !isUserSpeakerName(0, defaultSpeakerName(0)) && isUserSpeakerName(0, '小包'),
  )

  /*
   * 试听片段：不到 3 秒听不出是谁。
   * 单条够长就用单条；不够就顺着往下攒；攒不够就把区间撑到 3 秒。
   */
  const longOne = pickSampleRange([{ start: 0, end: 5 }])
  check('单条够长就用单条', longOne?.start === 0 && longOne?.end === 5)

  const gathered = pickSampleRange([
    { start: 0, end: 1.5 },
    { start: 1.5, end: 3.2 },
  ])
  check(
    '单条不够就顺着攒到 3 秒',
    gathered !== null && gathered.end - gathered.start >= 3,
    gathered ? String(gathered.end - gathered.start) : 'null',
  )

  const stretched = pickSampleRange([{ start: 0, end: 1 }], 10)
  check(
    '实在不够就把区间撑到 3 秒',
    stretched !== null && stretched.end - stretched.start >= 3,
    stretched ? String(stretched.end - stretched.start) : 'null',
  )

  const capped = pickSampleRange([{ start: 0, end: 1 }], 2)
  check(
    '音频本身就这么长时不越界',
    capped !== null && capped.end <= 2,
    capped ? String(capped.end) : 'null',
  )
}

/* ------------------------------------------------ 跨文件共用：接线（源码扫描） */
{
  const readSrc = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const speakerSrc = readSrc('src/stores/speakers.ts')
  const panelSrc = readSrc('src/components/SpeakerPanel.vue')
  const mapSrc = readSrc('src/components/dialogs/SpeakerMapDialog.vue')
  const appSrc = readSrc('src/App.vue')
  const uiSrc = readSrc('src/stores/ui.ts')

  check(
    '每个文件的称呼表永远保留',
    speakerSrc.includes('const byFile = ref<Record<string, Record<string, string>>>({})') &&
      speakerSrc.includes('const mapping = ref<Record<string, Record<string, number>>>({})'),
    '共用模式只是多了一层对应关系，不该把各文件自己的称呼表换掉',
  )
  check(
    '共用模式下改称呼改的是全局那一位',
    /shared\.value[\s\S]{0,400}setGlobalName\(g, name\)/.test(speakerSrc),
    '否则改一个文件的名字、界面上显示的却是统一的称呼，两边对不上',
  )
  check(
    '共用模式下的称呼来自对应关系，不是按编号硬取',
    /function namesOf[\s\S]{0,600}globalName\(g\)/.test(speakerSrc),
    '按编号硬取就是老毛病：A 的 1 号与 B 的 1 号被当成同一个人',
  )
  check(
    '第一次勾选要先弹窗确认',
    panelSrc.includes('mappingConfirmed') &&
      panelSrc.includes("ui.openDialog('speaker-map')") &&
      /el\.checked = false/.test(panelSrc),
    '没确认就没生效，勾选框要弹回去',
  )
  check(
    '开关旁边有「调整对应关系」入口',
    panelSrc.includes('openMap') && panelSrc.includes('调整对应关系'),
    '确认之后用户还得能回来改',
  )
  check(
    '对应关系表挂在应用层',
    appSrc.includes('SpeakerMapDialog') && uiSrc.includes("'speaker-map'"),
    '弹窗要从侧栏之外也能打开',
  )
  check(
    '表格末尾留两个空行',
    mapSrc.includes('usedRows.value.length + 2'),
    '空行是「新建一个对应关系」的入口，不能没有',
  )
  check(
    '表格的行号是 0 起的显式数组',
    mapSrc.includes('v-for="row in rowIndexes"') &&
      // 只看模板段：脚本里的说明文字会原样写出那个反例写法
      !/v-for="row in totalRows"/.test(mapSrc.slice(mapSrc.indexOf('<template>'))),
    '`v-for="x in n"` 是从 1 数到 n 的，行号会整体差一位：第 0 行显示第 1 行的人',
  )
  check(
    '拖拽落到某一行 = 归入那一行',
    speakerSrc.includes('function moveToRow') && mapSrc.includes('onRowDrop'),
    '拖拽语义要与表格的行对应起来',
  )
  check(
    '试听至少 3 秒',
    mapSrc.includes('pickSampleRange'),
    '两个字的一声「嗯」谁也认不出来',
  )
}

/* ------------------------------------------------ 共用称呼的默认值 / 合并模式分离 */
{
  const readSrc = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const projectSrc = readSrc('src/stores/project.ts')
  const settingsSrc = readSrc('src/stores/settings.ts')
  const speakerSrc = readSrc('src/stores/speakers.ts')
  const panelSrc = readSrc('src/components/SpeakerPanel.vue')
  const mapSrc = readSrc('src/components/dialogs/SpeakerMapDialog.vue')

  check(
    '共用称呼的初值由建项目时的模式决定（合并默认开，分开默认关）',
    speakerSrc.includes("shared: mode === 'merge'") && speakerSrc.includes('const shared = ref(true)'),
    '独立处理时各文件各拍各的，默认绑在一起就是老毛病；合并成一条时间线才是一套人',
  )
  check(
    '切换批量模式时共用称呼一律重置，不留「用户点过就不再跟」的例外',
    !projectSrc.includes('speakerNamesSharedUserSet') &&
      !panelSrc.includes('speakerNamesSharedUserSet') &&
      !settingsSrc.includes('speakerNamesSharedUserSet'),
    '留了这个例外，合并模式下被自动打开一次就再也关不掉 —— 切回独立处理依然勾着',
  )
  check(
    '共用称呼不落盘，且启动时强制复位',
    // 两处：DEFAULT_SETTINGS 与 persist 写出的快照
    (settingsSrc.match(/speakerNamesShared: false,/g) ?? []).length >= 2 &&
      settingsSrc.includes('merged.speakerNamesShared = false'),
    '批量模式启动恒为独立处理，存下来的 true 只会变成一个「自己勾上」的勾选框',
  )
  check(
    '从「调整对应关系」进表，确认后不会顺手打开共用开关',
    mapSrc.includes('if (speakers.pendingShareConfirm) speakers.shared = true') &&
      /function openMap[\s\S]{0,200}pendingShareConfirm = false/.test(panelSrc) &&
      /el\.checked = false[\s\S]{0,300}pendingShareConfirm = true/.test(panelSrc),
    '只有勾选引来的那一次确认才该打开共用，否则用户点一次确认就被强行共用',
  )
  check(
    '合并模式：分离放到最后统一跑',
    projectSrc.includes('if (!isMerge.value && settings.speakerDiarization') &&
      /isMerge\.value && settings\.speakerDiarization[\s\S]{0,2400}assignSpeakers/.test(projectSrc),
    '一边识别一边分离，所有片段各自跑一遍，模型要重复加载好几次',
  )
  check(
    '合并模式下各文件的讲话人编号都从 0 起，不加 nextIndex 偏移',
    !/nextIndex \+= assigned\.speakers/.test(projectSrc) &&
      !/seg\.speaker \+ nextIndex/.test(projectSrc),
    '编号是子项目本地的；偏移与「编号本地」自相矛盾，且推断只看名字不看编号',
  )
  check(
    '取消共用回到各文件原来的称呼',
    !/function setGlobalName[\s\S]{0,900}const target = \(byFile\.value\[fileId\] \?\?= \{\}\)/.test(
      speakerSrc,
    ),
    '改全局称呼时往各文件的表里写，取消勾选就再也回不到原来的称呼',
  )
  check(
    '没进对应关系的人仍用他自己的称呼',
    speakerSrc.includes('const out: Record<string, string> = { ...own }'),
    '少这个兜底，刚识别完 / 面板还没挂载时侧栏会整片退回「讲话人 N」，看着像名字被吃了',
  )
  check(
    '改名遇到还没建对应的人也不会丢',
    /if \(g !== undefined\)[\s\S]{0,700}const target = \(byFile\.value\[fileId\] \?\?= \{\}\)/.test(
      speakerSrc,
    ),
    '共用模式下一改名就 no-op，用户会以为输入框坏了',
  )
}

/* ------------------------------------------------ 讲话人表 / 侧栏排序 / 进度条 */
{
  const readSrc = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const speakerSrc = readSrc('src/stores/speakers.ts')
  const mapSrc = readSrc('src/components/dialogs/SpeakerMapDialog.vue')
  const treeSrc = readSrc('src/components/FileTree.vue')
  const statusSrc = readSrc('src/components/AppStatusBar.vue')
  const appSrc = readSrc('src/App.vue')
  const projectSrc = readSrc('src/stores/project.ts')

  check(
    '对应关系表按内容撑开、可横向滚动',
    mapSrc.includes('width: max-content') &&
      mapSrc.includes('table-layout: auto') &&
      // 定宽均分会把文件列压成「S···」，认不出是哪一列
      !/table-layout:\s*fixed/.test(mapSrc) &&
      !/\.spkmap__file\s*\{[^}]*text-overflow:\s*ellipsis/.test(mapSrc),
    '文件一多，每列被压到几十像素，表头只剩一个字母，等于这张表没法看',
  )
  check(
    '删掉一位讲话人，对应关系也跟着删',
    /function forget[\s\S]{0,700}delete map\[String\(index\)\]/.test(speakerSrc) &&
      // 无条件删：不再只看共用模式
      !/function forget[\s\S]{0,400}if \(settings\.speakerNamesShared\)/.test(speakerSrc),
    '独立处理时删了人，mapping 里那条还留着 —— 打开表会看到一个已经没有语料的标签',
  )
  check(
    '对应关系表会清掉已经不存在的编号',
    /const alive = new Set\(indexes\.map\(String\)\)/.test(speakerSrc) &&
      /if \(!alive\.has\(key\)\) delete map\[key\]/.test(speakerSrc),
    '旧映射没人收拾，删除看着像没生效',
  )
  check(
    '侧栏子项目列表可拖拽排序（两种模式共用同一套行）',
    // 前缀匹配：识别中禁拖是底线；后面可以再叠别的条件（比如搜索时不拖）
    treeSrc.includes(':draggable="!project.recognizing') &&
      treeSrc.includes('project.reorder(from, to)') &&
      // 合并模式下顺序就是时间轴先后，必须走 store 的 reorder 去重建产物
      /function onDrop[\s\S]{0,900}project\.reorder/.test(treeSrc) &&
      // 两种模式不再各写一份模板：一套行渲染，顺序语义天然一致
      !/v-if="isMerge"[\s\S]{0,2000}v-else/.test(treeSrc),
    '拖来拖去只能改列表样子、不改合并时间码，就等于什么都没改',
  )

  /* ---------------------------------------------------- P7：右键菜单 / 多选 / 搜索 */
  const sideMenuSrc = readSrc('src/composables/useSidebarMenu.ts')
  const editorSrc = readSrc('src/views/EditorView.vue')

  check(
    '侧栏右键菜单收在一个 composable 里，FileTree 只挂一份 UiMenu',
    treeSrc.includes('useSidebarMenu') &&
      (treeSrc.match(/<UiMenu/g) ?? []).length === 1 &&
      /'重新识别'/.test(sideMenuSrc) &&
      /'从项目中移除'/.test(sideMenuSrc) &&
      /'删除项目…'/.test(sideMenuSrc),
    '菜单项散在组件里，迟早出现「右键能用、行内按钮不能用」的分叉',
  )
  {
    // 反例自检：不带过滤的 finalize 必须匹配不上（否则这条断言等于没写）
    const finalizeRe =
      /function finalize\(items: MenuItem\[\], one: boolean\)[\s\S]{0,300}one \? items : items\.filter\(\(it\) => !it\.disabled/
    check(
      '多选时菜单不显示灰项，单选留灰项说明原因',
      finalizeRe.test(sideMenuSrc) &&
        !finalizeRe.test('function finalize(items: MenuItem[], one: boolean) {\n  return tidyMenu(items)\n}'),
      '多选菜单里一排点不动的灰项，用户会以为是卡了',
    )
  }
  check(
    '删除项目先二次确认，确认里写着会删磁盘文件',
    /confirmWithOption\(\{[\s\S]{0,400}项目文件会从磁盘上删除[\s\S]{0,400}checkboxLabel: '只从列表移除/
      .test(sideMenuSrc) &&
      /res\.checked[\s\S]{0,120}closeDraft[\s\S]{0,80}else await project\.deleteDrafts/.test(
        sideMenuSrc,
      ) &&
      /async function deleteDrafts[\s\S]{0,600}bridge\.project\.delete/.test(projectSrc),
    '「删除项目」和「关闭项目」长得太像，不拦一下就有人把工程文件删了',
  )
  check(
    '子项目改名清非法字符：边打边替换 + 落盘前再清一遍',
    treeSrc.includes('@input="onRenameInput"') &&
      /replaceIllegalChars\(el\.value\)/.test(treeSrc) &&
      /function renameItem[\s\S]{0,200}sanitizeFileName/.test(projectSrc),
    '名字会变成导出文件名，带着 `*?` 存盘时会被系统吞掉或直接失败',
  )
  check(
    '重识别灰掉时右侧写明原因（没有音频 / 正在识别）',
    /key: 'item:recognize'[\s\S]{0,700}'没有音频'/.test(sideMenuSrc),
    '灰着不给理由，用户只会以为软件坏了',
  )
  check(
    '侧栏搜索：项目名命中出整组，只有子项目命中就只留那一行',
    /row\.name\.toLowerCase\(\)\.includes\(q\)[\s\S]{0,120}return \{ \.\.\.row, view \}[\s\S]{0,200}kept\.length > 0/.test(
      treeSrc,
    ) && treeSrc.includes(':draggable="!project.recognizing && !query.trim()"'),
    '搜索时还能拖拽，一拖就把看不见的顺序也改了',
  )
  check(
    '「保存项目」只存当前项目，「保存全部项目」走小三角',
    /function saveProjectFile\(\): void \{[\s\S]{0,200}?\}/.test(editorSrc) &&
      !/function saveProjectFile[\s\S]{0,200}saveAllProjects/.test(editorSrc) &&
      // 小三角与主按钮拼成一组（`.btngroup`），点它才知道还有「保存全部」
      /class="btngroup"[\s\S]{0,800}openSaveMenu[\s\S]{0,300}chevron-down/.test(editorSrc) &&
      /key: 'save-all'/.test(editorSrc),
    '主按钮一下存了别的项目，属于意料之外的副作用',
  )
  check(
    '底栏进度区宽度定死，进度条不随文案平移',
    /\.statusbar__center\s*\{[^}]*width:\s*344px/.test(statusSrc) &&
      /\.statusbar__progress-text\s*\{[^}]*flex:\s*1/.test(statusSrc),
    '文案一换长度就变，进度条被顶得左右晃，看着像进度自己在抖',
  )
  check(
    '任务栏进度用总进度',
    /project\.recognizing[\s\S]{0,200}project\.progress \/ 100/.test(appSrc),
    '任务栈那个百分比是「当前这个文件」的，多文件时每个文件结束都回 0',
  )
  check(
    '识别文案只说在处理哪个文件',
    /progressLabel\.value = queue\[0\] \? `正在处理/.test(projectSrc) &&
      !projectSrc.includes('正在预处理') &&
      !projectSrc.includes('正在分析讲话人'),
    '阶段细节写日志就够了，底栏只说人话',
  )
}

/* --------------------------------------------------- 项目文件（P0） */

{
  /* ---- 命名规则：每一条都会变成磁盘上的文件名 ---- */
  check('项目默认名：单个子项目去扩展名', defaultProjectName(['S03E12.mp3']) === 'S03E12')
  check(
    '项目默认名：多个加「等」',
    defaultProjectName(['S03E12.mp3', 'S03E13.mp3']) === 'S03E12 等',
  )
  check('项目默认名：空列表给个兜底', defaultProjectName([]) === '未命名项目')

  const bad = sanitizeFileName('a:b*c?')
  check('文件名非法字符替换成下划线', bad.value === 'a_b_c_' && bad.replaced, bad.value)
  check('结尾的点与空格会被 Windows 吞掉，先去掉', sanitizeFileName('名字. ').value === '名字')
  check('超长项目名被截断到 120', sanitizeFileName('x'.repeat(200)).value.length === 120)
  check('合法名字原样通过', sanitizeFileName('第 7 期闲聊').value === '第 7 期闲聊')

  check('文件名自动补 .xbsgp', projectFileName('第 7 期') === '第 7 期.xbsgp')
  check('已带后缀不重复补', projectFileName('a.xbsgp') === 'a.xbsgp')
  check('扩展名判断不看大小写', isProjectPath('D:\\a\\B.XBSGP'))
  check('同一个路径：大小写与分隔符都不敏感', samePath('D:\\A\\B.xbsgp', 'd:/a/b.XBSGP'))
  check('不同路径不算同名', !samePath('D:\\A\\x.xbsgp', 'D:\\A\\y.xbsgp'))
  check('空路径不参与比较', !samePath('', 'D:\\A\\x.xbsgp'))
}

{
  /* ---- .xbsgp 往返：存什么、不存什么 ---- */
  const items = [
    {
      id: 'item_a',
      name: 'S03E12.mp3',
      path: 'D:\\Audio\\S03E12.mp3',
      ext: 'mp3',
      sizeBytes: 29384756,
      durationSec: 1832.4,
      status: 'pending' as const,
      segments: [
        {
          id: 'seg1',
          start: 0.4,
          end: 3.2,
          text: '大家好',
          origin: '大家好',
          issues: [{ level: 'error' as const, code: 'X', message: 'm' }],
          translations: { en: 'hi' },
          acked: true,
          speaker: 0,
          originFileId: 'item_a',
        },
      ],
    },
  ]
  const doc = buildProjectDoc({
    name: 'S03E12',
    activeItemId: 'item_a',
    shared: true,
    mtimeOf: () => 123,
    items,
    appVersion: '9.9.9',
  })
  const text = toProjectText(doc)
  check('落盘是明文 JSON（能手工救、能 diff）', text.startsWith('{\n  "magic": "xbsgp"'))
  check('校验结论不落盘（每次现算）', !text.includes('"issues"'))
  check('视图标记 originFileId 不落盘（本地只认自己的时间码）', !text.includes('originFileId'))
  check('用户「忽略告警」的批注要跟着项目走', text.includes('"acked": true'))

  const back = fromProjectText(text)
  check('读回来成功', back.ok, back.ok ? '' : back.error)
  if (back.ok) {
    const seg0 = back.doc.project.items[0].segments[0]
    check('时间码原样读回（本地，从 0 起）', seg0.start === 0.4 && seg0.end === 3.2)
    check('译文读回', seg0.translations?.en === 'hi')
    check('讲话人与忽略标记读回', seg0.speaker === 0 && seg0.acked === true)
    check('校验结论重新算，读回来是空的', seg0.issues.length === 0)
    check('项目名与 shared 读回', back.doc.project.name === 'S03E12' && back.doc.project.shared)
    check('音频媒体信息读回', back.doc.project.items[0].media?.path === 'D:\\Audio\\S03E12.mp3')
  }

  check('不是本软件的文件要拒绝', !fromProjectText('{"hello":1}').ok)
  check('坏 JSON 要拒绝', !fromProjectText('{').ok)

  const future = JSON.parse(text) as Record<string, unknown>
  future.version = 99
  const r2 = fromProjectText(JSON.stringify(future))
  check('更高版本的格式要拒绝，不猜着读', !r2.ok && r2.error.includes('v99'))

  const empty = JSON.parse(text) as Record<string, unknown>
  ;(empty.project as Record<string, unknown>).items = []
  check('没有任何子项目也拒绝', !fromProjectText(JSON.stringify(empty)).ok)
}

{
  /* ---- 源码守门：P0 的结构性约定 ---- */
  const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const proj = read('src/stores/project.ts')
  const table = read('src/components/SubtitleTable.vue')
  const saveDlg = read('src/components/dialogs/SaveProjectDialog.vue')
  const mainSrc = read('electron/main.js')
  const fileSrc = read('electron/project-file.js')

  check('合并产物物化那一套已经拆掉', !/\bmergedFile\b/.test(proj))
  check(
    '合并时间轴的拼接函数已删除',
    !existsSync(new URL('../src/utils/mergeTimeline.ts', import.meta.url)),
  )
  check('项目视图的 segments 是访问器', /Object\.defineProperty\(view, 'segments'/.test(proj))
  check('偏移是派生值，不落盘', /const itemOffsets = computed/.test(proj) && !proj.includes('mergedOffsets:'))
  check('编辑目标统一经 targetOf', /function targetOf\(/.test(proj))
  check(
    '三处直接写下标改成 store 方法',
    proj.includes('function replaceSegment(') &&
      proj.includes('function insertSegmentAfter(') &&
      table.includes('project.replaceSegment(') &&
      table.includes('project.insertSegmentAfter(') &&
      !table.includes('file.segments[at] = ') &&
      !table.includes('file.segments.splice('),
  )
  check(
    '打开项目不会把刚打开的项目标成脏的',
    /suppressDirty = true/.test(proj) && /suppressDirty = false/.test(proj),
  )
  check(
    '保存对话框实时校验同目录重名',
    saveDlg.includes('bridge.fs.exists(path)') && saveDlg.includes('该目录已有同名项目'),
  )
  check(
    '写项目是原子写（临时文件 + 改名）',
    fileSrc.includes('.tmp-${process.pid}') && fileSrc.includes('await fs.rename(tmp, target)'),
  )
  check('覆盖前把旧工程备份成 .bak', fileSrc.includes('${target}.bak'))
  check(
    '另存为一律拒绝覆盖已有工程',
    /allowOverwrite[\s\S]{0,400}existsSync\(target\)/.test(fileSrc),
  )
  check('改名走真正的 rename，不是另存再删', mainSrc.includes("ipcMain.handle('project:rename'"))
}

/* ---- 项目文件落盘：真的写进临时目录，验异常路径 ---- */
{
  const dir = await mkdtemp(join(tmpdir(), 'xbsgp-test-'))
  const target = join(dir, 'sub', 'A.xbsgp')

  const w1 = await writeProjectFile(target, '{"a":1}', false)
  check('写新项目：目录不存在会自动建', w1.ok && (await readFileAsync(target, 'utf8')) === '{"a":1}')

  const w2 = await writeProjectFile(target, '{"a":2}', false)
  check(
    '另存到已存在的文件：拒绝，且原文件一个字节都没动',
    !w2.ok && w2.code === 'exists' && (await readFileAsync(target, 'utf8')) === '{"a":1}',
    JSON.stringify(w2),
  )

  const w3 = await writeProjectFile(target, '{"a":2}', true)
  check('保存到自己的路径：覆盖成功', w3.ok && (await readFileAsync(target, 'utf8')) === '{"a":2}')
  check(
    '覆盖前把旧内容备份成 .bak',
    (await readFileAsync(`${target}.bak`, 'utf8')) === '{"a":1}',
  )

  const after = await readdirAsync(join(dir, 'sub'))
  check('写盘没留下临时文件', after.every((f) => !f.includes('.tmp-')), after.join(', '))

  const moved = await renameProjectFile(target, join(dir, 'sub', 'B.xbsgp'))
  check(
    '改名：磁盘文件名跟着改，内容不变',
    moved.ok && (await readFileAsync(join(dir, 'sub', 'B.xbsgp'), 'utf8')) === '{"a":2}',
  )

  await writeFileAsync(join(dir, 'sub', 'C.xbsgp'), 'other')
  const blocked = await renameProjectFile(join(dir, 'sub', 'B.xbsgp'), join(dir, 'sub', 'C.xbsgp'))
  check(
    '改名撞上已有文件：拒绝，且两边都还在',
    !blocked.ok &&
      blocked.code === 'exists' &&
      existsSync(join(dir, 'sub', 'B.xbsgp')) &&
      existsSync(join(dir, 'sub', 'C.xbsgp')),
  )

  await rmAsync(dir, { recursive: true, force: true })
}

/* ------------------------------------------------- P1–P3：项目级讲话人 / 映射 / 纯字幕 */

{
  const readSrc = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const projectSrc = readSrc('src/stores/project.ts')
  const speakerSrc = readSrc('src/stores/speakers.ts')
  const settingsSrc = readSrc('src/stores/settings.ts')
  const historySrc = readSrc('src/stores/history.ts')
  const xbsgpSrc = readSrc('src/utils/xbsgp.ts')

  /* ---- P1-1：共用称呼是项目级属性 ---- */
  check(
    '「共用一套称呼」是项目级：存在 speakers 里，settings 只剩废弃占位',
    speakerSrc.includes('const shared = ref(true)') &&
      /shared\.value/.test(speakerSrc) &&
      !/settings\.speakerNamesShared/.test(speakerSrc) &&
      /@deprecated[\s\S]{0,240}speakerNamesShared: boolean/.test(settingsSrc),
    '放在设置里，打开 A 勾着共用、切到 B 也勾着 —— 两份工程互相污染',
  )
  check(
    '建项目 / 关项目 / 打开项目三处都跟着换 shared',
    /emptySnapshot\(batchMode\.value\)/.test(projectSrc) &&
      /useSpeakerStore\(\)\.resetAll\(\)/.test(projectSrc) &&
      /speakers\.shared = doc\.project\.shared/.test(projectSrc),
    '少一处就会「换了工程但开关还停在上一份」',
  )

  /* ---- P1-1b：对应关系表一个子项目一列 ---- */
  check(
    '对应关系表按子项目分列，不再给一条「合并时间轴」',
    /const speakerMappingFiles = computed\(\(\) =>[\s\S]{0,400}supportedFiles\.value\.map/.test(
      projectSrc,
    ) && !/const speakerMappingFiles[\s\S]{0,600}viewFile\.value/.test(projectSrc),
    '只有一列时两段的「讲话人 1」挤在同一格里，分不出谁是谁',
  )
  check(
    '讲话人面板作用在活动子项目上，不落到虚拟视图 id',
    /project\.activeFile \?\? project\.viewFile/.test(readSrc('src/components/SpeakerPanel.vue')),
    '改到 `__merged__` 上等于改了空气：界面显示成功，字幕上的称呼一点没变',
  )

  /* ---- P1-2：回退记录是项目级一份 ---- */  check(
    '回退记录按项目分桶，不按子项目',
    historySrc.includes('分桶') &&
      // 所有编辑点的 `file` 都是项目拼接视图，键恒为那一个常量 id
      /const file = project\.viewFile/.test(readSrc('src/components/SubtitleTable.vue')),
    '按子项目分桶时，光标换一段就撤不回刚才那一步',
  )

  /* ---- P2-1：音频缺失检查 ---- */
  check(
    '打开项目就核对音频，纯字幕子项目不参与',
    /async function checkMedia/.test(projectSrc) &&
      /const bad = await checkMedia\(\)/.test(projectSrc) &&
      /if \(!f\.path \|\| f\.demo \|\| !isSupported\(f\.ext\)\) return/.test(projectSrc),
    '不查就会出现「打开项目一片空波形」，而用户以为文件丢了；把纯字幕算成缺失则满屏警告',
  )
  check(
    '大小或修改时间对不上算「被换过」',
    /f\.sizeBytes > 0 && typeof st\.size === 'number' && st\.size !== f\.sizeBytes/.test(
      projectSrc,
    ) && /Math\.abs\(st\.mtimeMs - f\.mediaMtimeMs\) > 1500/.test(projectSrc),
    '只看文件在不在，同长不同内容会被当成没事，波形与时间码悄悄错位',
  )

  /* ---- P2-2：音频映射 ---- */
  check(
    '映射音频不动字幕、不触发重新识别',
    /async function remapMedia/.test(projectSrc) &&
      !/async function remapMedia[\s\S]{0,2000}startRecognition/.test(projectSrc) &&
      !/async function remapMedia[\s\S]{0,2000}\.segments = /.test(projectSrc),
    '替用户缩放时间码、或者顺手重识别一遍，都是在他没要求的时候改内容',
  )
  check(
    '映射后重建波形与拼接播放，并清掉缺失标记',
    /media\.value\.delete\(fileId\)/.test(projectSrc) &&
      /void syncMergedMedia\(\)/.test(projectSrc) &&
      /delete mediaState\.value\[fileId\]/.test(projectSrc),
    '换了音频还沿用旧波形与旧时长，界面上就一直在按老文件画',
  )

  /* ---- P3：纯字幕子项目 ---- */
  check(
    '重新读取源文件走历史，可以撤销',
    /async function reloadSubtitle[\s\S]{0,1200}history\.commit\(file\.id, file\.segments, '重新读取源文件'/.test(
      projectSrc,
    ),
    '读回旧内容会抹掉用户的修改，不能撤销就等于不可逆',
  )

  const docPure = buildProjectDoc({
    name: 'P',
    activeItemId: 'a',
    shared: false,
    mtimeOf: () => 111,
    appVersion: 'test',
    items: [
      {
        id: 'a',
        name: 'ep01.srt',
        path: 'D:\\src\\ep01.srt',
        sizeBytes: 0,
        durationSec: 12,
        status: 'pending',
        segments: [],
        subtitleFormat: 'srt',
        subtitlePath: 'D:\\src\\ep01.srt',
        ext: 'srt',
      },
      {
        id: 'b',
        name: 'ep02.mp3',
        path: 'D:\\src\\ep02.mp3',
        sizeBytes: 999,
        durationSec: 30,
        status: 'pending',
        segments: [],
        ext: 'mp3',
      },
    ],
  })
  check(
    '纯字幕子项目：srt 记在 sourcePath，不当成音频',
    docPure.project.items[0].media === null &&
      docPure.project.items[0].sourcePath === 'D:\\src\\ep01.srt' &&
      docPure.project.items[1].media?.path === 'D:\\src\\ep02.mp3' &&
      docPure.project.items[1].sourcePath === undefined,
    JSON.stringify(docPure.project.items.map((i) => [i.kind, i.media, i.sourcePath])),
  )
  const round = fromProjectText(toProjectText(docPure))
  check(
    '纯字幕往返：读回来仍认得出源文件、且没有音频',
    round.ok &&
      round.doc.project.items[0].media === null &&
      round.doc.project.items[0].sourcePath === 'D:\\src\\ep01.srt',
    round.ok ? '' : round.error,
  )
  const docMapped = buildProjectDoc({
    name: 'P',
    activeItemId: 'm',
    shared: false,
    mtimeOf: () => 5,
    appVersion: 'test',
    items: [
      {
        id: 'm',
        name: 'ep01.srt',
        path: 'D:\\src\\ep01.mp3',
        sizeBytes: 12,
        durationSec: 30,
        status: 'pending',
        segments: [],
        subtitleFormat: 'srt',
        subtitlePath: 'D:\\src\\ep01.srt',
        ext: 'mp3',
      },
    ],
  })
  check(
    '映射过音频的纯字幕子项目：音频与字幕源各归各',
    docMapped.project.items[0].kind === 'audio' &&
      docMapped.project.items[0].media?.path === 'D:\\src\\ep01.mp3' &&
      docMapped.project.items[0].sourcePath === 'D:\\src\\ep01.srt',
    JSON.stringify(docMapped.project.items[0]),
  )

  check(
    '落盘不写派生字段（issues / mediaState）',
    !/function segmentToDoc[\s\S]{0,900}issues/.test(xbsgpSrc) &&
      !/mediaState/.test(xbsgpSrc),
    '存下来的校验结论会变成「打开就看到去年的报错」',
  )
}

/* ---------------------------------------------- 第 9 轮：工作台与表格结构 */

{
  const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

  const sideSrc = read('src/components/AppSidebar.vue')
  check(
    '侧栏入口任何时刻可点（不拿「有没有文件」当门槛）',
    !/disabled:\s*project\.supportedFiles\.length === 0/.test(sideSrc) &&
      /function go\(item: NavItem\): void \{\s*ui\.navigate\(item\.key\)/.test(sideSrc),
    '识别中进不去工作台，等于「一边识别一边翻已完成的」这条路被堵死',
  )

  const tableSrc = read('src/components/SubtitleTable.vue')
  const menuSrc = read('src/composables/useSegmentMenu.ts')
  check(
    '「忽略告警」只在右键菜单里，不再占表格一列',
    !/row__ack/.test(tableSrc) && !/cell--flag/.test(tableSrc) && /key: 'ack'/.test(menuSrc),
    '它挂在行尾占掉 78px，是整张表最贵的低频按钮',
  )
  check(
    '撤销 / 重做搬到表格工具栏',
    /class="opgroup"/.test(tableSrc) &&
      /history\.undo\(/.test(tableSrc) &&
      !/history__note/.test(read('src/components/ToolPanel.vue')),
    '两个按钮住在改字幕的那张表上，不必横跨窗口去找',
  )
  check(
    '历史步数只在悬停提示里说，且与实现同源',
    /最多保留 \$\{MAX_STEPS\} 步/.test(tableSrc) &&
      /export const MAX_STEPS/.test(read('src/stores/history.ts')),
    '限制说明不该常驻占一行；数字写死在文案里也会跟实现脱钩',
  )
  check(
    '窄窗口：工具栏与表格都可横滑，行有最小宽度',
    /\.subtable__toolbar \{[^}]*overflow-x: auto/s.test(tableSrc) &&
      /\.subtable__head,\s*\.row \{[^}]*min-width: 620px/s.test(tableSrc) &&
      /\.subtable__body \{[^}]*overflow-x: auto/s.test(tableSrc),
    '被压成竖排的字比「要滑一下」糟得多',
  )
  check(
    '表头跟着正文横移',
    /translateX\(\$\{-scrollLeft\}px\)/.test(tableSrc) &&
      /scrollLeft\.value = body\.scrollLeft/.test(tableSrc),
    '两个滚动容器各滚各的，列名会跟内容对不上',
  )

  const mapSrc = read('src/components/dialogs/AudioMapDialog.vue')
  check(
    '音频映射按扩展名判「有没有音频」',
    /isSupported\(f\.ext\)/.test(mapSrc) &&
      !/const current = computed\(\(\) => file\.value\?\.path/.test(mapSrc),
    '纯字幕子项目的 path 是它自己的 .srt，直接显示会写成「当前音频：xxx.srt」',
  )

  const barSrc = read('src/components/AppStatusBar.vue')
  check(
    '状态栏三个数字都报全工程合计',
    /project\.allFiles/.test(barSrc) &&
      /project\.allSegments/.test(barSrc) &&
      /project\.allDuration/.test(barSrc) &&
      /project\.allPendingReview/.test(barSrc) &&
      !/project\.files\.length/.test(barSrc),
    '它在最外一层横跨全宽，说的就该是整个软件',
  )

  const workSrc = read('src/views/EditorView.vue')
  check(
    '侧栏落到底、底栏缩回右半边',
    /\.editor \{[^}]*grid-template-columns: auto minmax\(0, 1fr\)/s.test(workSrc) &&
      /:deep\(\.filetree\) \{[^}]*grid-row: 1 \/ span 2/s.test(workSrc) &&
      /\.editor__foot \{[^}]*grid-column: 2/s.test(workSrc),
    '一行「当前项目」的数字铺满全宽，会被读成全局',
  )
  check(
    '中间区有最小宽度，窄窗口整体横滑',
    /\.editor__center \{[^}]*min-width: 360px/s.test(workSrc) &&
      /\.editor__body \{[^}]*overflow-x: auto/s.test(workSrc),
    '780px 宽时中间只剩七十几个像素，表格里除复选框什么都放不下',
  )

  const tlSrc = read('src/components/TimelineTrack.vue')
  check(
    '时间轴滚轮走平滑（写目标值，不直接跳）',
    /panGoalSec \+= pixels \/ pxPerSec\.value/.test(tlSrc) &&
      !/viewStartSec\.value \+= pixels/.test(tlSrc) &&
      /requestAnimationFrame\(stepAnim\)/.test(tlSrc),
    '一格滚轮直接加进 viewStartSec，画面就是一跳一跳的',
  )
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)