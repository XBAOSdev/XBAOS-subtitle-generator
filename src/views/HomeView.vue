<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useI18n } from '@/composables/useI18n'
import type { BatchMode, FileStatus } from '@/types'
import { formatBytes, formatDuration, formatEstimate } from '@/utils/format'
import { LEXICONS, lexiconWordCount } from '@/data/lexicons'
import { DEPTH_ORDER, DEPTH_PRESETS, estimateSeconds } from '@/utils/reasoningDepth'
import { PROMPT_BUDGET_CHARS, buildPrompt } from '@/utils/prompt'
import DropZone from '@/components/DropZone.vue'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()
const settings = useSettingsStore()
const { t } = useI18n()

const LANGUAGE_OPTIONS = [
  { value: 'zh', label: '简体中文' },
  { value: 'auto', label: '自动检测' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
]

/** 提示词实时预览：占用多少预算、注入了多少词、是否被截断 */
const promptPreview = computed(() =>
  buildPrompt({ terms: settings.promptTerms, lexiconIds: settings.lexiconIds }),
)

function toggleLexicon(id: string): void {
  const ids = settings.lexiconIds
  settings.lexiconIds = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

const STATUS_ICON: Record<FileStatus, string> = {
  queued: 'clock',
  processing: 'spinner',
  pending: 'dot',
  reviewed: 'check',
  edited: 'check',
  issue: 'alert',
  failed: 'alert',
  unsupported: 'ban',
}

function statusIcon(status: FileStatus): string {
  return STATUS_ICON[status]
}

function statusLabel(status: FileStatus): string {
  return t(`status.${status}`)
}

const pendingFiles = computed(() =>
  project.files.filter((f) => f.status === 'queued' || f.status === 'failed'),
)

const canStart = computed(() => pendingFiles.value.length > 0 && !project.recognizing)

/** 依据当前后端与推理深度估算耗时。auto 档取中间值，不敢许空头承诺 */
const estimate = computed(() => {
  const kind: 'gpu' | 'cpu' | 'unknown' =
    settings.backend === 'cpu' ? 'cpu' : settings.backend === 'vulkan' ? 'gpu' : 'unknown'
  return formatEstimate(
    estimateSeconds(project.totalDuration, settings.reasoningDepth, kind),
  )
})

const depthHint = computed(() => DEPTH_PRESETS[settings.reasoningDepth])

function move(index: number, delta: number): void {
  project.reorder(index, index + delta)
}

/**
 * 从队列移除单个文件。
 *
 * 该文件**已经有识别结果**时才确认一次 —— 移除按钮和上移/下移挤在一起，
 * 误触概率不低，而这一下会连带丢掉那个文件的所有字幕。没有结果的文件
 * 直接删，不打扰。
 */
async function remove(id: string, name: string): Promise<void> {
  const file = project.files.find((f) => f.id === id)
  const count = file?.segments.length ?? 0

  if (count > 0) {
    const message = `「${name}」已经识别出 ${count} 条字幕，移除后这些字幕会一并丢失，且无法恢复。`
    const detail = '磁盘上的原始文件不会被删除，只是从队列里移出。'
    const bridge = window.xbaos
    if (bridge) {
      const ok = await bridge.dialog.confirm({
        title: '从队列移除',
        message,
        detail,
        buttons: ['取消', '移除'],
        defaultId: 0,
        cancelId: 0,
      })
      if (ok !== 1) return
    } else if (!window.confirm(`${message}\n\n${detail}`)) {
      return
    }
  }

  project.removeFile(id)
  ui.notify('info', '已从队列移除', name)
}

/**
 * 点队列里的条目 = 切预览目标。
 * 合并模式下编辑器里只有一条拼接产物，这里切换只会把画面换掉，
 * 所以合并模式直接忽略。
 */
function pickFile(id: string): void {
  if (project.isMerge) return
  project.setActiveFile(id)
}

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

/** 清空队列。会把已经识别出来的内容一起删掉，所以必须把风险讲清楚 */
async function clearAll(): Promise<void> {
  const total = project.files.length
  const withResult = project.supportedFiles.filter((f) => f.segments.length > 0)
  const segmentCount = withResult.reduce((n, f) => n + f.segments.length, 0)

  const detail =
    (withResult.length > 0
      ? `队列里有 ${withResult.length} 个文件已经识别出 ${segmentCount} 条字幕，清空会把它们一并删除且无法恢复，未导出的内容会丢失。批量处理模式的锁定也会一并解除。`
      : '清空后可以重新导入文件，批量处理模式的锁定也会一并解除。') +
    '调整导入顺序、移除单个文件都不会影响已经识别出来的内容，只有清空会。'

  const bridge = window.xbaos
  if (bridge) {
    const ok = await bridge.dialog.confirm({
      title: '清空队列',
      message: `确定要清空队列中的 ${total} 个文件吗？`,
      detail,
      buttons: ['取消', '清空'],
      defaultId: 0,
      cancelId: 0,
    })
    if (ok !== 1) return
  } else if (!window.confirm(`确定要清空队列中的 ${total} 个文件吗？\n\n${detail}`)) {
    return
  }

  project.clearAll()
  ui.notify(
    'info',
    '队列已清空',
    segmentCount > 0 ? `同时删除了 ${segmentCount} 条识别结果` : undefined,
  )
}

/** 导入已有字幕文件直接进编辑器（SRT / VTT / ASS） */
async function importSubtitle(): Promise<void> {
  const bridge = window.xbaos
  if (!bridge) {
    ui.notify('info', '浏览器预览无法读取文件', '请在桌面应用中使用')
    return
  }
  const paths = await bridge.dialog.pickSubtitle()
  if (paths.length === 0) return
  let ok = 0
  for (const p of paths) {
    const done = await project.addSubtitleFromPath(p)
    if (done) ok += 1
  }
  if (ok > 0) ui.navigate('editor')
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
  <div class="view">
    <header class="view__head">
      <div class="view__head-inner">
        <h1 class="view__title">导入音频</h1>
        <p class="view__desc">
          识别与导出全部在本机完成，不联网、不上传。识别完成后先进入预览，确认无误再导出。
        </p>
      </div>
    </header>

    <div class="view__body">
      <div class="view__body-inner">
        <div class="io">
          <!-- 主列：导入 → 队列 → 批量方式，按操作顺序排列 -->
          <div class="io__main">
            <section class="block">
              <div class="block__head">
                <span class="step">1</span>
                <span class="block__title">导入音频</span>
              </div>
              <div class="block__body">
                <DropZone />

                <div class="sub-import">
                  <button class="btn btn--sm" type="button" @click="importSubtitle">
                    <Icon name="type" :size="13" />
                    <span>导入字幕文件</span>
                  </button>
                  <span class="hint">
                    直接编辑已有的 SRT / VTT / ASS 字幕，改完可覆盖保存回原文件
                  </span>
                </div>
              </div>
            </section>

            <!-- 音频队列 -->
            <section v-if="project.hasFiles" class="block">
              <div class="block__head">
                <span class="step">2</span>
                <span class="block__title">确认队列</span>
                <span class="hint">{{ project.files.length }} 个文件</span>
                <span class="spacer" />
                <button class="btn btn--ghost btn--sm" type="button" @click="clearAll">
                  清空
                </button>
              </div>

              <ul class="queue">
                <li
                  v-for="(file, index) in project.files"
                  :key="file.id"
                  class="queue__row"
                  :class="{
                    'is-unsupported': file.status === 'unsupported',
                    'is-active': !project.isMerge && project.activeFileId === file.id,
                    'is-static': project.isMerge,
                  }"
                  @click="pickFile(file.id)"
                >
                  <span class="queue__index mono">{{ index + 1 }}</span>

                  <span class="queue__status" :class="`queue__status--${file.status}`">
                    <Icon :name="statusIcon(file.status)" :size="14" />
                  </span>

                  <div class="queue__main">
                    <div class="queue__line">
                      <span class="queue__name">{{ file.name }}</span>
                      <span class="queue__badge">{{ statusLabel(file.status) }}</span>
                    </div>
                    <div class="queue__meta">
                      <span>{{ file.ext.toUpperCase() }}</span>
                      <span class="queue__dot" aria-hidden="true">|</span>
                      <span>{{ formatBytes(file.sizeBytes) }}</span>
                      <span class="queue__dot" aria-hidden="true">|</span>
                      <span>{{ formatDuration(file.durationSec) }}</span>
                      <template v-if="file.segments.length > 0">
                        <span class="queue__dot" aria-hidden="true">|</span>
                        <span>{{ file.segments.length }} 条字幕</span>
                      </template>
                    </div>
                    <p v-if="file.message" class="queue__message">{{ file.message }}</p>
                  </div>

                  <span class="queue__dir mono" :title="file.dir">{{ file.dir }}</span>

                  <div class="queue__actions">
                    <button
                      class="queue__btn"
                      type="button"
                      title="上移"
                      :disabled="index === 0"
                      @click.stop="move(index, -1)"
                    >
                      <Icon name="arrow-up" :size="13" />
                    </button>
                    <button
                      class="queue__btn"
                      type="button"
                      title="下移"
                      :disabled="index === project.files.length - 1"
                      @click.stop="move(index, 1)"
                    >
                      <Icon name="arrow-down" :size="13" />
                    </button>
                    <button
                      class="queue__btn queue__btn--danger"
                      type="button"
                      title="移除"
                      @click.stop="remove(file.id, file.name)"
                    >
                      <Icon name="trash" :size="13" />
                    </button>
                  </div>
                </li>
              </ul>
            </section>

            <!-- 批量处理方式 -->
            <section v-if="project.supportedFiles.length > 1" class="block">
              <div class="block__head">
                <span class="step">3</span>
                <span class="block__title">批量处理方式</span>
                <span class="spacer" />
                <span class="hint">
                  <template v-if="project.batchModeLocked">
                    已锁定，切换需先清空队列
                  </template>
                  <template v-else>导入顺序即拼接顺序，开始识别后锁定</template>
                </span>
              </div>
              <div class="block__body block__body--modes">
                <button
                  class="mode"
                  :class="{
                    'is-active': project.batchMode === 'merge',
                    'is-locked': project.batchModeLocked,
                  }"
                  type="button"
                  @click="pickMode('merge')"
                >
                  <span class="mode__icon"><Icon name="layers" :size="18" /></span>
                  <span class="mode__body">
                    <span class="mode__title">合并为一条时间轴</span>
                    <span class="mode__hint">
                      按导入顺序拼接，时间码依次累加，输出单个字幕文件
                    </span>
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
                  <span class="mode__icon"><Icon name="list" :size="18" /></span>
                  <span class="mode__body">
                    <span class="mode__title">各自独立处理</span>
                    <span class="mode__hint">每个音频单独识别，输出多个独立的字幕文件</span>
                  </span>
                  <span v-if="project.batchModeLocked" class="mode__lock">
                    <Icon name="lock" :size="11" />
                  </span>
                </button>
              </div>
            </section>
          </div>

          <!-- 侧列：识别设置。落点固定，方便每次导入前顺手调一下 -->
          <aside class="io__side">
            <section class="block">
              <div class="block__head">
                <Icon name="sliders" :size="14" />
                <span class="block__title">识别设置</span>
                <span class="spacer" />
                <span class="hint">即时生效</span>
              </div>
              <div class="block__body recog">
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
                  <span class="field__hint">固定为中文可避免误判成其他语言</span>
                </label>

                <div class="field">
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
                      @click="settings.reasoningDepth = id"
                    >
                      {{ DEPTH_PRESETS[id].label }}
                    </button>
                  </div>
                  <span class="field__hint">{{ depthHint.hint }}</span>
                </div>

                <div class="field">
                  <div class="field__head">
                    <span class="field__label">领域词库</span>
                    <span
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
                    <template v-if="promptPreview.truncated">
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

                <label class="field">
                  <span class="field__label">热词提示</span>
                  <textarea
                    v-model="settings.promptTerms"
                    class="textarea"
                    rows="2"
                    placeholder="节目名、人名、专业术语，用换行或逗号分隔"
                  />
                  <span class="field__hint">提示引擎这些词的写法，可提升专有名词准确率</span>
                </label>

                <details class="adv">
                  <summary class="adv__sum">
                    <Icon name="chevron-right" :size="13" class="adv__caret" />
                    <span>高级选项</span>
                    <span class="adv__hint">字幕排版与音质前处理</span>
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
          </aside>
        </div>
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
/* ---- 两栏骨架 ---- */
.io {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  gap: var(--space-5);
  align-items: start;
}

.io__main {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.io__side {
  position: sticky;
  top: 0;
  min-width: 0;
}

/*
 * 两栏骨架需要「主列 + 336px 设置面板 + 间距」都放得下才不挤。
 * 窗口内容宽度低于 1200px 时主列会被压到 500px 以下，DropZone 的按钮、
 * 词库胶囊、双列输入框全都开始互相倾轧 —— 此时直接收成单栏，
 * 设置面板排到主列下方（sticky 也一并撤掉，避免盖不住滚动）。
 */
@media (max-width: 1200px) {
  .io {
    grid-template-columns: minmax(0, 1fr);
  }

  .io__side {
    position: static;
  }
}

/* ---- 步骤序号 ---- */
.step {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-pill);
  background: var(--color-accent-subtle);
  color: var(--color-accent-text);
  font-size: 11px;
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

/* ---- 导入区的字幕入口 ---- */
.sub-import {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
}

/* 「开始识别」按钮在圆点飞出去的那 460ms 里隐去自己。
   用 visibility 而不是 display / v-if：**布局不能动** —— 按钮一消失，
   同一行的「去预览」会往右滑一格，看起来像是页面抖了一下。 */
.btn.is-flying {
  visibility: hidden;
}

/* ---- 识别设置面板 ---- */
.recog {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
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
  padding: 4px var(--space-2) 4px var(--space-2);
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

.adv__hint {
  margin-left: auto;
  font-weight: var(--weight-regular);
  color: var(--color-text-tertiary);
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

/* ---- 队列 ---- */
.queue {
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.queue__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-1);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}

.queue__row:hover {
  background: var(--color-bg-hover);
}

.queue__row.is-active {
  background: var(--color-bg-selected);
  border-color: var(--color-accent-border);
}

.queue__row.is-unsupported {
  opacity: 0.72;
}

/* 合并模式下点队列不切预览，就不要给出可点的光标暗示 */
.queue__row.is-static {
  cursor: default;
}

.queue__row.is-static:hover {
  background: none;
}

.queue__index {
  flex: none;
  width: 20px;
  text-align: center;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.queue__status {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  color: var(--color-text-tertiary);
}

.queue__status--processing {
  color: var(--color-accent);
}

.queue__status--processing :deep(.icon) {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.queue__status--edited,
.queue__status--reviewed {
  color: var(--color-success);
}

.queue__status--issue,
.queue__status--failed {
  color: var(--color-warning);
}

.queue__status--unsupported {
  color: var(--color-text-disabled);
}

.queue__main {
  flex: 1;
  min-width: 0;
}

.queue__line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.queue__name {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue__badge {
  flex: none;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  color: var(--color-text-tertiary);
  font-size: 11px;
}

.queue__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.queue__dot {
  color: var(--color-border-strong);
}

.queue__message {
  margin-top: 3px;
  font-size: 11px;
  color: var(--color-warning);
}

.queue__dir {
  flex: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-text-tertiary);
  direction: rtl;
  text-align: left;
}

.queue__actions {
  flex: none;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.queue__row:hover .queue__actions,
.queue__row.is-active .queue__actions {
  opacity: 1;
}

.queue__btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
}

.queue__btn:hover:not(:disabled) {
  background: var(--color-bg-active);
  color: var(--color-text-primary);
}

.queue__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.queue__btn--danger:hover:not(:disabled) {
  background: var(--color-danger-subtle);
  color: var(--color-danger);
}

/* ---- 批量方式 ---- */
.block__body--modes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.mode {
  position: relative;
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
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
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
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
  gap: 2px;
  min-width: 0;
}

.mode__title {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
}

.mode__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}
</style>
