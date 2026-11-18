<script setup lang="ts">
/**
 * sherpa-onnx（ONNX Runtime）的识别设置，当前对应 SenseVoice。
 *
 * 与 whisper 那份（RecogWhisper.vue）相比少了三样东西，都不是「先藏起来」：
 *
 *   · 推理深度 —— 贪心 CTC 没有温度与束搜索，每遍结果完全相同，多跑只是白花时间；
 *   · 提示词预算 —— 这套引擎不接收提示词，热词只参与断句与识别后的同音纠正；
 *   · 语言选择 —— 语种在识别时由模型自动判别，加载阶段已固定。
 *
 * 剩下的参数（音频前处理、字号规格、讲话人）是本软件自己在引擎之外做的，
 * 与用哪套模型无关，所以两份面板都有。
 */
import { computed } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import type { BatchMode } from '@/types'
import { LEXICONS, lexiconWordCount } from '@/data/lexicons'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const settings = useSettingsStore()
const ui = useUiStore()

const SPEAKER_COUNT_OPTIONS = [2, 3, 4, 5, 6]

/** 词库仍然生效（断句与同音纠正），只是不进入提示词，所以不显示预算占用 */
const selectedLexicons = computed(() =>
  LEXICONS.filter((lex) => settings.lexiconIds.includes(lex.id)),
)

function toggleLexicon(id: string): void {
  const ids = settings.lexiconIds
  settings.lexiconIds = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

function pickMode(mode: BatchMode): void {
  if (!project.setBatchMode(mode)) {
    ui.notify('warning', '识别进行中', '当前批次完成后再切换，已导入的内容不受影响')
  }
}
</script>

<template>
  <div class="recog">
    <!-- 只读而不是下拉：语种在模型加载时已固定，给一个能点但无效的下拉框只是骗人 -->
    <div class="field">
      <span class="field__label">识别语言</span>
      <span class="recog__value">自动（中文、粤语、英语、日语、韩语）</span>
      <span class="field__hint">语种在识别时自动判别，不需要选择。</span>
    </div>

    <div class="field">
      <div class="field__head">
        <span class="field__label">领域词库</span>
        <span class="field__tag mono">{{ selectedLexicons.length }} 个已选</span>
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
      <span class="field__hint">模型不接收提示词。所选词库用于字幕断句与识别后的同音纠正。</span>
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
      <span class="field__hint">模型不接收提示词。全部热词用于断句与识别后的同音纠正。</span>
    </div>

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
