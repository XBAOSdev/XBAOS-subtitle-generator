<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useModelStore } from '@/stores/model'
import type { BatchMode } from '@/types'
import { formatDuration, formatEstimate } from '@/utils/format'
import { LEXICONS, lexiconWordCount } from '@/data/lexicons'
import { DEPTH_ORDER, DEPTH_PRESETS, estimateSeconds } from '@/utils/reasoningDepth'
import { PROMPT_BUDGET_CHARS, buildPrompt } from '@/utils/prompt'
import MaterialBoard from '@/components/MaterialBoard.vue'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()
const settings = useSettingsStore()
const model = useModelStore()

/**
 * 架构能力。不支持的项一律**留在原位、变灰、写明原因** —— 直接藏掉会让用户
 * 以为软件少了一块，下次换回 whisper 也找不到。
 */
const canPrompt = computed(() => model.caps.prompt)
const canTune = computed(() => model.caps.decode)

const LANGUAGE_OPTIONS = [
  { value: 'zh', label: '简体中文' },
  { value: 'auto', label: '自动检测' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
]

/**
 * 讲话人数上限只到 6。
 *
 * 不是技术限制，是「报的人数越多、每个声纹样本越少」的取舍：6 个人分摊一段
 * 对话，每人常常只剩十几秒，再往上分就主要是在噪声里找人了。真要更多，用户
 * 需要的是更强的声纹模型，而不是多给几个选项。
 */
const SPEAKER_COUNT_OPTIONS = [2, 3, 4, 5, 6]

/** 提示词实时预览：占用多少预算、注入了多少词、是否被截断 */
const promptPreview = computed(() =>
  buildPrompt({ terms: settings.promptTerms, lexiconIds: settings.lexiconIds }),
)

function toggleLexicon(id: string): void {
  const ids = settings.lexiconIds
  settings.lexiconIds = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

const pendingFiles = computed(() =>
  project.files.filter((f) => f.status === 'queued' || f.status === 'failed'),
)

const canStart = computed(() => pendingFiles.value.length > 0 && !project.recognizing)

/** 依据当前后端与推理深度估算耗时。auto 档取中间值，不敢许空头承诺 */
const estimate = computed(() => {
  const kind: 'gpu' | 'cpu' | 'unknown' =
    settings.backend === 'cpu' ? 'cpu' : settings.backend === 'vulkan' ? 'gpu' : 'unknown'
  // 与 depthHint 同一条判据：不支持多遍解码的模型按单遍算
  const depth = model.caps.decode ? settings.reasoningDepth : 'standard'
  return formatEstimate(estimateSeconds(project.totalDuration, depth, kind))
})

/**
 * 推理深度的展示值。
 *
 * 当前模型不支持多遍解码时（`.caps.decode` 为假），实际只跑一遍 ——
 * 界面上的「约 ×3 耗时」必须跟着变成 ×1，否则三处信息互相矛盾：
 * 说明写着「固定单遍」、store 里也确实传 1，标签却承诺三倍耗时。
 */
const depthHint = computed(() => {
  const preset = DEPTH_PRESETS[settings.reasoningDepth]
  return model.caps.decode ? preset : { ...preset, timeFactor: 1 }
})

/**
 * 选批量处理模式。
 *
 * 识别开始前可以随便改；真正的锁定发生在「开始识别」那一刻（store 里的
 * lockBatchMode）。锁定后再切会让已经识别出来的内容归属发生变化
 * ——先前的成果被卷进合并、时间轴错位、显示错乱。要改必须先清空队列。
 */
function pickMode(mode: BatchMode): void {
  if (!project.setBatchMode(mode)) {
    ui.notify(
      'warning',
      '批量处理模式已锁定',
      '已经在识别的批次里生效了，切换会让已识别的内容归属发生变化。请先清空队列再重新选择。',
    )
  }
}

async function start(event?: MouseEvent): Promise<void> {
  if (!canStart.value) return
  const count = pendingFiles.value.length

  // 起飞点必须与按钮重合，否则圆点会「凭空出现在半空中」——所以先量按钮矩形。
  // 减少动效偏好下直接跳过：那条动画的职责是告知「进度条在下面」，
  // 而对这类用户，任何位移都是负担（进度行照常出现，信息一点没少）。
  const btn = event?.currentTarget as HTMLElement | null | undefined
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (btn && !reduceMotion) {
    const r = btn.getBoundingClientRect()
    ui.beginTaskFlight({ x: r.left, y: r.top, width: r.width, height: r.height })
  }

  ui.notify('info', `开始识别 ${count} 个文件`, '识别过程中可以随时取消')
  await project.startRecognition()
  const failed = project.files.filter((f) => f.status === 'failed').length
  if (project.progress < 100) {
    ui.notify('warning', '识别已取消', '未完成的文件仍留在队列中，可重新开始')
    return
  }
  ui.notify(
    failed > 0 ? 'warning' : 'success',
    failed > 0 ? `识别完成，${failed} 个文件失败` : '识别完成',
    '已切换到预览与编辑',
  )
  ui.navigate('editor')
}
</script>

<template>
  <div class="view view--fill">
    <!--
      两栏：素材在左、设置在右，页面本身不滚，卡片各自滚。

      为什么不是单栏纵向流：单栏里「放入内容」和「调参数」只能靠上下顺序区分，
      而这两类东西本来就不该并排出现在同一条阅读流里 —— 内容是有身份的物件，
      参数是跨会话的配置。左右分栏同时给出「位置」和「容器」两重区分，
      这是单栏做不到的。

      这条注释必须留在**根元素内部**：根元素外面哪怕只多一个注释节点，组件就变成
      多根片段，`<Transition mode="out-in">` 等不到离场回调 —— 切页会整页空白，
      且不报任何错。unit-check 里有对应的守门。
    -->
    <div class="view__body">
      <div class="view__body-inner">
        <MaterialBoard />

        <section class="col">
          <header class="col__head">
            <Icon name="sliders" :size="14" class="set__headicon" />
            <span class="col__title">识别设置</span>
            <span class="spacer" />
            <span class="hint">即时生效</span>
          </header>

          <div class="settings">
            <label class="field">
              <span class="field__label">识别语言</span>
              <select v-model="settings.language" class="select">
                <option
                  v-for="item in LANGUAGE_OPTIONS"
                  :key="item.value"
                  :value="item.value"
                >
                  {{ item.label }}
                </option>
              </select>
            </label>

            <div class="field" :class="{ 'is-off': !canTune }">
              <div class="field__head">
                <span class="field__label">推理深度</span>
                <span class="field__tag mono">约 ×{{ depthHint.timeFactor }} 耗时</span>
              </div>
              <div v-seg-thumb class="seg">
                <button
                  v-for="id in DEPTH_ORDER"
                  :key="id"
                  class="choice"
                  :class="{ 'is-active': settings.reasoningDepth === id }"
                  type="button"
                  :disabled="!canTune"
                  @click="settings.reasoningDepth = id"
                >
                  {{ DEPTH_PRESETS[id].label }}
                </button>
              </div>
              <span class="field__hint">
                <template v-if="!canTune">当前模型不支持多遍解码，固定单遍识别</template>
                <template v-else>{{ depthHint.hint }}</template>
              </span>
            </div>

            <div class="field field--wide">
              <div class="field__head">
                <span class="field__label">领域词库</span>
                <span
                  v-if="canPrompt"
                  class="lex-budget mono"
                  :class="{ 'is-over': promptPreview.truncated }"
                >
                  {{ promptPreview.chars }} / {{ PROMPT_BUDGET_CHARS }}
                </span>
              </div>
              <div class="lex-list">
                <label
                  v-for="lex in LEXICONS"
                  :key="lex.id"
                  class="lex"
                  :class="{ 'is-active': settings.lexiconIds.includes(lex.id) }"
                  :title="lex.note"
                >
                  <input
                    type="checkbox"
                    :checked="settings.lexiconIds.includes(lex.id)"
                    @change="toggleLexicon(lex.id)"
                  />
                  <span class="lex__name">{{ lex.name }}</span>
                  <span class="lex__count mono">{{ lexiconWordCount(lex) }}</span>
                </label>
              </div>
              <span class="field__hint">
                <!-- 不支持提示词注入时，词库仍然生效 —— 它还要参与识别后的断句，
                     所以勾选保持可用，只把「注入」这件事讲清楚 -->
                <template v-if="!canPrompt">
                  当前模型不接收提示词，所选词库仍用于字幕断句与识别后的同音纠正
                </template>
                <template v-else-if="promptPreview.truncated">
                  核心词已超出预算，被舍弃的前几个：{{
                    promptPreview.droppedCore.slice(0, 6).join('、')
                  }}
                </template>
                <template v-else>
                  将注入 {{ promptPreview.usedTerms.length }} 个词
                  <template v-if="promptPreview.dropped.length > 0">
                    （另有 {{ promptPreview.dropped.length }} 个扩展词超出预算，深度模式按
                    音频实际出现过的词挑选）
                  </template>
                </template>
              </span>
            </div>

            <div class="field field--wide">
              <div class="field__head">
                <span class="field__label">热词提示</span>
                <label
                  class="switch switch--sm"
                  title="全量热词参与，字数相同、读音一致才替换"
                >
                  <input v-model="settings.termFix" type="checkbox" />
                  <span class="switch__track" />
                  <span>识别后纠正同音字</span>
                </label>
              </div>
              <textarea
                v-model="settings.promptTerms"
                class="textarea"
                rows="2"
                placeholder="节目名、人名、专业术语，用换行或逗号分隔"
              />
              <span class="field__hint">
                <!-- 输入框在任何模型下都可编辑：不支持提示词的模型虽然收不到这些词，
                     它们仍要参与断句与识别后的同音纠正，禁掉等于把这条路也堵死 -->
                <template v-if="canPrompt">
                  注入模型受 {{ PROMPT_BUDGET_CHARS }} 字预算限制，超出的词仍全部参与识别后的同音纠正
                </template>
                <template v-else>
                  当前模型不接收提示词，全部热词用于断句与识别后的同音纠正
                </template>
              </span>
            </div>

            <!--
              讲话人单独成条，不再塞进折叠的高级选项：
              它是「这一段音频里到底有几个人」这种一眼就该看见的决定，
              和归一化、滤波那些调参不是一类东西。
            -->
            <div class="field field--wide speakers">
              <div class="speakers__body">
                <label class="switch">
                  <input v-model="settings.speakerDiarization" type="checkbox" />
                  <span class="switch__track" />
                  <span>区分不同的讲话人</span>
                </label>
                <span class="field__hint">
                  识别后按音色分出不同的人，编辑页里可以逐个改称呼
                </span>
              </div>
              <label v-if="settings.speakerDiarization" class="speakers__count">
                <span>人数</span>
                <select v-model.number="settings.speakerCount" class="select">
                  <option :value="0">自动</option>
                  <option v-for="n in SPEAKER_COUNT_OPTIONS" :key="n" :value="n">
                    {{ n }}
                  </option>
                </select>
              </label>
            </div>

            <!--
              批量处理方式放这里，因为它本来就是「设置」：它描述的是这一批文件
              怎么被合成结果，不是某个文件的状态。放在素材区下面时，它看起来像
              第三个区块，实际上和文件列表没有从属关系。
            -->
            <div v-if="project.supportedFiles.length > 1" class="field field--wide">
              <div class="field__head">
                <span class="field__label">批量处理方式</span>
                <span v-if="project.batchModeLocked" class="field__tag">已锁定</span>
              </div>
              <div class="modes">
                <button
                  class="mode"
                  :class="{
                    'is-active': project.batchMode === 'merge',
                    'is-locked': project.batchModeLocked,
                  }"
                  type="button"
                  @click="pickMode('merge')"
                >
                  <span class="mode__icon"><Icon name="layers" :size="16" /></span>
                  <span class="mode__body">
                    <span class="mode__title">合并为一条时间轴</span>
                    <span class="mode__hint">拼成一条时间轴，输出单个文件</span>
                  </span>
                  <span v-if="project.batchModeLocked" class="mode__lock">
                    <Icon name="lock" :size="11" />
                  </span>
                </button>

                <button
                  class="mode"
                  :class="{
                    'is-active': project.batchMode === 'separate',
                    'is-locked': project.batchModeLocked,
                  }"
                  type="button"
                  @click="pickMode('separate')"
                >
                  <span class="mode__icon"><Icon name="list" :size="16" /></span>
                  <span class="mode__body">
                    <span class="mode__title">各自独立处理</span>
                    <span class="mode__hint">各自输出多个文件</span>
                  </span>
                  <span v-if="project.batchModeLocked" class="mode__lock">
                    <Icon name="lock" :size="11" />
                  </span>
                </button>
              </div>
              <span class="field__hint">
                <template v-if="project.batchModeLocked">
                  已锁定，切换需先清空队列
                </template>
                <template v-else>导入顺序即拼接顺序，开始识别后锁定</template>
              </span>
            </div>

            <details class="adv field--wide">
              <summary class="adv__sum">
                <Icon name="chevron-right" :size="13" class="adv__caret" />
                <span>高级选项</span>
              </summary>
              <div class="adv__body">
                <div class="adv__grid">
                  <label class="field">
                    <span class="field__label">单行最大字数</span>
                    <input
                      v-model.number="settings.maxCharsPerLine"
                      class="input input--mono"
                      type="number"
                      min="6"
                      max="60"
                    />
                  </label>
                  <label class="field">
                    <span class="field__label">单条最多行数</span>
                    <input
                      v-model.number="settings.maxLinesPerSegment"
                      class="input input--mono"
                      type="number"
                      min="1"
                      max="4"
                    />
                  </label>
                </div>
                <!-- 束搜索宽度 / 采样候选数 / 场景切分 / 束搜索 / 低置信度复核
                     已整体隐藏（实测降质，见 settings.ts 的强制复位注释），代码保留 -->
                <div class="adv__switches">
                  <label class="switch">
                    <input v-model="settings.normalizeAudio" type="checkbox" />
                    <span class="switch__track" />
                    <span>识别前电平归一化</span>
                  </label>
                  <label class="switch">
                    <input v-model="settings.highPassFilter" type="checkbox" />
                    <span class="switch__track" />
                    <span>高通滤波（80Hz 低频噪声）</span>
                  </label>
                  <label class="switch">
                    <input v-model="settings.vadEnabled" type="checkbox" />
                    <span class="switch__track" />
                    <span>静音检测与长音频切分</span>
                  </label>
                </div>
              </div>
            </details>
          </div>
        </section>
      </div>
    </div>

    <footer class="view__foot">
      <div class="view__foot-inner">
        <span v-if="project.hasFiles" class="hint">
          待识别 {{ pendingFiles.length }} 个
          <template v-if="project.totalDuration > 0">
            ，总时长 {{ formatDuration(project.totalDuration) }}，{{ estimate }}
          </template>
        </span>
        <span v-else class="hint">还没有导入任何音频</span>

        <span class="spacer" />

        <button
          v-if="project.supportedFiles.length > 0"
          class="btn"
          type="button"
          @click="ui.navigate('editor')"
        >
          去预览
        </button>
        <button
          v-if="project.recognizing && ui.taskFlight === null"
          class="btn btn--lg"
          type="button"
          @click="project.cancelRecognition"
        >
          取消
        </button>
        <!-- 飞行那 460ms 里**先不给「取消」**：按钮位置留在原地并隐去自己，
             等圆点落到进度条上再说。否则按钮会在圆点刚要起飞的同一帧变成另一个
             按钮，看起来像「点了没反应，只是按钮换了」——动画的意义就没了。 -->
        <button
          v-else
          class="btn btn--primary btn--lg"
          :class="{ 'is-flying': ui.taskFlight !== null }"
          type="button"
          :disabled="!canStart"
          @click="start"
        >
          <Icon name="zap" :size="15" />
          <span>开始识别</span>
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* ---- 两栏外壳：页面不滚，卡片自己滚 ---- */
.view--fill .view__body {
  /* 这一页的高度由窗口决定，内容再多也不许把整页顶出去 */
  overflow: hidden;
  padding-bottom: var(--space-4);
}

.view--fill .view__body-inner {
  height: 100%;
  display: grid;
  /* 右侧固定宽、左侧吃掉剩下的：素材区的信息密度更高，宽度该给它 */
  grid-template-columns: minmax(0, 1fr) clamp(300px, 24vw, 368px);
  gap: var(--space-4);
  align-items: stretch;
}

/*
 * 窗口窄到两栏挤不下时退回整页滚动。
 * 此时两个卡片上下叠放、各自按内容撑开 —— 硬撑着并排只会让素材方块
 * 缩到一行一个，还不如让它滚。
 */
@media (max-width: 940px) {
  .view--fill .view__body {
    overflow-y: auto;
  }

  .view--fill .view__body-inner {
    height: auto;
    grid-template-columns: minmax(0, 1fr);
  }
}

/* ---- 设置面板 ---- */
.set__headicon {
  flex: none;
  color: var(--color-text-tertiary);
}

/*
 * 单栏纵向排列。
 * 这块从「整页两栏」变成「卡片里的一列」之后，内部横向再分两栏就太窄了 ——
 * 300~368px 里塞两个输入框，每个只剩 140px，标签都放不下。
 */
.settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

/* 单栏下这个类不再产生布局效果，保留是为了让「整行」的语义在结构上仍然可见 */
.field--wide {
  min-width: 0;
}

.field__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 20px;
}

.field__label {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
}

.field__tag {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.field__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
}

.choice {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  transition: color var(--dur-fast) var(--ease-out);
}

.choice:hover {
  color: var(--color-text-primary);
}

.choice.is-active {
  /* 选中标记（底色 + 内描边 + 投影）已经挪到滑动指示块（v-seg-thumb）身上，
   * 这里只管文字：切换时颜色平滑过渡、字重加重。 */
  color: var(--color-text-primary);
  font-weight: var(--weight-semibold);
}

.lex-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.lex {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.lex:hover {
  border-color: var(--color-border-strong);
}

.lex.is-active {
  border-color: var(--color-accent);
  background: var(--color-accent-subtle);
}

.lex input[type='checkbox'] {
  width: 13px;
  height: 13px;
  flex: none;
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.lex__name {
  font-size: var(--font-size-xs);
}

.lex.is-active .lex__name {
  color: var(--color-accent-text);
  font-weight: var(--weight-medium);
}

.lex__count {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.lex-budget {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.lex-budget.is-over {
  color: var(--color-warning);
}

/* 热词行右上角的开关：跟标题同一行，不额外占一块 */
.switch--sm {
  gap: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

/* ---- 讲话人 ---- */
.speakers {
  /* 窄栏里横排会把「人数」挤到换行，改成上下两段 */
  align-items: stretch;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  /* 用 surface 而不是 inset：开关轨道是 border-strong，压在 inset 上几乎看不见 ——
     「区分不同的讲话人」是这块的主角，不能是唯一一个看不清开关状态的开关 */
  background: var(--color-bg-surface);
}

.speakers__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.speakers__count {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.speakers__count .select {
  flex: 1;
  min-width: 0;
}

/* ---- 高级折叠 ---- */
.adv {
  border-top: 1px solid var(--color-border-subtle);
  padding-top: var(--space-3);
}

.adv__sum {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
  list-style: none;
}

.adv__sum::-webkit-details-marker {
  display: none;
}

.adv__caret {
  transition: transform var(--dur-fast) var(--ease-out);
}

.adv[open] .adv__caret {
  transform: rotate(90deg);
}

.adv__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.adv__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.adv__switches {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 「开始识别」按钮在圆点飞出去的那 460ms 里隐去自己。
   用 visibility 而不是 display / v-if：**布局不能动** —— 按钮一消失，
   同一行的「去预览」会往右滑一格，看起来像是页面抖了一下。 */
.btn.is-flying {
  visibility: hidden;
}

/* ---- 批量方式 ---- */
.modes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.mode {
  position: relative;
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.mode:hover {
  border-color: var(--color-border-strong);
}

.mode.is-active {
  /* 与 .choice 同一套：底色拾到 raised + 1px 内描边，深色下分得出选中的是哪张卡 */
  border-color: var(--color-accent-border);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-sm), inset 0 0 0 1px var(--color-accent-border);
}

/* 已锁定：不再接受切换，但当前生效的那一张仍然看得出来 */
.mode.is-locked {
  cursor: default;
}

.mode.is-locked:not(.is-active) {
  opacity: 0.6;
}

.mode.is-locked:not(.is-active):hover {
  border-color: var(--color-border);
  background: none;
}

.mode__lock {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  color: var(--color-text-tertiary);
}

.mode__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
}

.mode.is-active .mode__icon {
  background: var(--color-bg-surface);
  color: var(--color-accent);
}

.mode__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.mode__title {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
}

.mode__hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

/* ---- 当前模型不支持的功能：留在原位、变灰、附原因 ---- */
.field.is-off .field__label,
.field.is-off .field__tag {
  color: var(--color-text-tertiary);
}

.field.is-off .choice,
.field.is-off .textarea {
  cursor: not-allowed;
}

.field.is-off .choice {
  color: var(--color-text-tertiary);
}

.field.is-off .choice.is-active {
  color: var(--color-text-secondary);
}

.field.is-off .textarea {
  color: var(--color-text-tertiary);
}
</style>
