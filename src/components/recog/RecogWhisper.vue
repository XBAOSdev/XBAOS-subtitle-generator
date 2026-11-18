<script setup lang="ts">
/**
 * whisper.cpp（GGML）的识别设置。
 *
 * 这份面板可以有「推理深度」和提示词预算，因为这套引擎两样都收：解码参数
 * 能改（多遍 + 变温），提示词能注入。另一份面板（RecogSherpa.vue）里没有
 * 这一栏 —— 不是藏起来了，是那套引擎真的没有。
 *
 * 讲话人、批量方式、字号规格、音频前处理这些与架构无关的项，两份面板各写一份。
 * 看起来是重复，但这是刻意的：每份面板要能被独立改写而不牵连另一份，否则
 * 「以后换个架构就换套 UI」这件事就做不到了。共用的是外观（styles/recog.css）。
 */
import { computed } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import type { BatchMode } from '@/types'
import { LEXICONS, lexiconWordCount } from '@/data/lexicons'
import { DEPTH_ORDER, DEPTH_PRESETS } from '@/utils/reasoningDepth'
import { PROMPT_BUDGET_CHARS, buildPrompt } from '@/utils/prompt'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const settings = useSettingsStore()
const ui = useUiStore()

/**
 * whisper 支持的语言远不止这五种，这里只放常用的几项。
 * 清单短一点更容易扫，冷门语种在同一次会话里改一次就够。
 */
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
 * 不是技术限制，是取舍：6 个人分摊一段对话，每人常常只剩十几秒，再往上分
 * 主要是在噪声里找人了。真要更多，需要的是更强的声纹模型，不是多几个选项。
 */
const SPEAKER_COUNT_OPTIONS = [2, 3, 4, 5, 6]

/** 提示词实时预览：占了多少预算、注入了多少词、是否被截断 */
const promptPreview = computed(() =>
  buildPrompt({ terms: settings.promptTerms, lexiconIds: settings.lexiconIds }),
)

function toggleLexicon(id: string): void {
  const ids = settings.lexiconIds
  settings.lexiconIds = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

/**
 * 选批量处理模式：这个开关只回答「这一批识别结果建几个项目」。
 * 唯一的限制是识别进行中不许切（进度单元的前缀和是启动时算好的）。
 */
function pickMode(mode: BatchMode): void {
  if (!project.setBatchMode(mode)) {
    ui.notify('warning', '识别进行中', '当前批次完成后再切换，已导入的内容不受影响')
  }
}
</script>

<template>
  <div class="recog">
    <label class="field">
      <span class="field__label">识别语言</span>
      <select v-model="settings.language" class="select">
        <option v-for="item in LANGUAGE_OPTIONS" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>
      <span class="field__hint">自动检测在短音频上容易判错。已知语言时直接选择。</span>
    </label>

    <div class="field">
      <div class="field__head">
        <span class="field__label">推理深度</span>
        <span class="field__tag mono">约 ×{{ DEPTH_PRESETS[settings.reasoningDepth].timeFactor }} 耗时</span>
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
      <span class="field__hint">{{ DEPTH_PRESETS[settings.reasoningDepth].hint }}</span>
    </div>

    <div class="field">
      <div class="field__head">
        <span class="field__label">领域词库</span>
        <span class="lex-budget mono" :class="{ 'is-over': promptPreview.truncated }">
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
          核心词已超出预算，被舍弃的前几个：{{ promptPreview.droppedCore.slice(0, 6).join('、') }}
        </template>
        <template v-else>
          将注入 {{ promptPreview.usedTerms.length }} 个词
          <template v-if="promptPreview.dropped.length > 0">
            ，另有 {{ promptPreview.dropped.length }} 个扩展词超出预算。深度模式会按音频里实际出现的词挑选。
          </template>
        </template>
      </span>
    </div>

    <div class="field">
      <div class="field__head">
        <span class="field__label">热词提示</span>
        <label class="switch switch--sm" title="全量热词参与，字数相同、读音一致才替换">
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
        注入模型受 {{ PROMPT_BUDGET_CHARS }} 字预算限制。超出的词仍全部参与识别后的同音纠正。
      </span>
    </div>

    <!-- 讲话人单独成块：它是「这段音频里有几个人」这种一眼就该看见的决定 -->
    <div class="field speakers">
      <div class="speakers__body">
        <label class="switch">
          <input v-model="settings.speakerDiarization" type="checkbox" />
          <span class="switch__track" />
          <span>区分不同的讲话人</span>
        </label>
        <span class="field__hint">识别后按音色分出不同的人，编辑页可以逐个改称呼。</span>
      </div>
      <label v-if="settings.speakerDiarization" class="speakers__count">
        <span>人数</span>
        <select v-model.number="settings.speakerCount" class="select">
          <option :value="0">自动</option>
          <option v-for="n in SPEAKER_COUNT_OPTIONS" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
    </div>

    <!-- 批量方式属于设置：它描述这一批文件怎么合成结果，不是某个文件的状态 -->
    <div v-if="project.intakeSupported.length > 1" class="field">
      <div class="field__head">
        <span class="field__label">批量处理方式</span>
        <span v-if="project.recognizing" class="field__tag">识别中</span>
      </div>
      <div class="modes">
        <button
          class="mode"
          :class="{ 'is-active': project.batchMode === 'merge', 'is-locked': project.recognizing }"
          type="button"
          :disabled="project.recognizing"
          @click="pickMode('merge')"
        >
          <span class="mode__icon"><Icon name="layers" :size="16" /></span>
          <span class="mode__body">
            <span class="mode__title">合并为一个项目</span>
            <span class="mode__hint">多份音频排成一条时间轴，一起编辑与导出</span>
          </span>
        </button>

        <button
          class="mode"
          :class="{ 'is-active': project.batchMode === 'separate', 'is-locked': project.recognizing }"
          type="button"
          :disabled="project.recognizing"
          @click="pickMode('separate')"
        >
          <span class="mode__icon"><Icon name="list" :size="16" /></span>
          <span class="mode__body">
            <span class="mode__title">每个文件各建一个项目</span>
            <span class="mode__hint">每份单独成一个项目，互不影响</span>
          </span>
        </button>
      </div>
      <span class="field__hint">
        <template v-if="project.recognizing">识别中不能切换，结束后可改。</template>
        <template v-else>导入顺序即时间轴顺序。</template>
      </span>
    </div>

    <details class="adv">
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
</template>
