<script setup lang="ts">
/**
 * 识别设置面板的外壳。
 *
 * 这一栏里的设置**按架构分家**：whisper 与 sherpa-onnx 能调的东西本来就不一样，
 * 共用一套模板只能靠「能力位把不支持的那几项灰掉」，结果是一屏里既有能用的也有
 * 永远用不上的，用户还得自己分辨哪个是哪个。一份架构一份面板之后，每份面板
 * 只写这套引擎真的有的东西 —— 以后适配了第三种模型，加一个文件在这里登记一行
 * 即可，不必回头改老面板。
 *
 * 外壳只负责三件事：标题、当前模型与架构、按架构挑面板。
 *
 * 架构的来源是主进程（读模型内容判定），设置里的「识别架构」只在用户手动指定
 * 时覆盖它 —— 见 `stores/settings.ts` 的同名字段。
 */
import { computed, type Component } from 'vue'
import Icon from '@/components/Icon.vue'
import { useModelStore } from '@/stores/model'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import RecogWhisper from './RecogWhisper.vue'
import RecogSherpa from './RecogSherpa.vue'

const model = useModelStore()
const settings = useSettingsStore()
const ui = useUiStore()

/**
 * 架构 → 面板。新增架构时在这里登记一行。
 *
 * 刻意不用「默认落到 whisper」的兜底：真出现一份没登记的面板时，
 * 显示一份别的引擎的设置比显示一句「没有」更糟 —— 用户会照着调，
 * 而调的那些参数根本没有被送到引擎。
 */
const PANELS: Record<string, Component> = {
  whisper: RecogWhisper,
  sherpa: RecogSherpa,
}

/**
 * 当前架构。
 *
 * 主进程答过就以它为准（手动指定的值也已经体现在里面）；没答过
 * （浏览器预览）时按设置里的选择来，仍是「自动」就按 whisper ——
 * 它是能力最全的一套，预览环境里每个控件都能点到。
 */
const arch = computed(() => {
  if (model.arch) return model.arch
  return settings.arch === 'auto' ? 'whisper' : settings.arch
})

const panel = computed(() => PANELS[arch.value] ?? null)
const modelName = computed(() => model.entry?.name ?? '')

function openSettings(): void {
  ui.navigate('settings', 'field-arch')
}

function openModels(): void {
  ui.navigate('models')
}
</script>

<template>
  <section class="col">
    <header class="col__head">
      <Icon name="sliders" :size="14" class="recog__headicon" />
      <span class="col__title">识别设置</span>
      <span class="spacer" />
      <span class="hint">即时生效</span>
    </header>

    <!-- 当前模型与架构：用户换了模型之后，这一行是「现在到底在用什么」的唯一交代 -->
    <div v-if="model.entry" class="recog__meta">
      <span class="recog__model" :title="modelName">{{ modelName }}</span>
      <span class="recog__arch">{{ model.archLabel }}</span>
      <span v-if="model.archForced" class="recog__forced" title="架构由设置手动指定，不是自动判定结果">
        手动指定
      </span>
      <button class="recog__link" type="button" @click="openSettings">更改</button>
    </div>

    <!--
      没有模型时不显示任何设置项：这些参数全部取决于架构，先有模型才谈得上配置。
      只给一句结论和一个出口，不解释「为什么」——为什么在模型页。
    -->
    <div v-if="model.missing" class="recog recog--empty">
      <Icon name="cpu" :size="22" class="recog__empty-icon" />
      <p class="recog__empty-title">请配置模型</p>
      <button class="btn btn--sm btn--primary" type="button" @click="openModels">
        <Icon name="import" :size="13" />
        <span>打开模型管理</span>
      </button>
    </div>

    <Component :is="panel" v-else-if="panel" />

    <div v-else class="recog recog--empty">
      <Icon name="alert" :size="22" class="recog__empty-icon" />
      <p class="recog__empty-title">当前架构没有对应的识别设置</p>
      <p class="recog__empty-hint">请在设置中把识别架构改为自动，或换用一个已知架构的模型。</p>
    </div>
  </section>
</template>

<style scoped>
.recog__headicon {
  flex: none;
  color: var(--color-text-tertiary);
}
</style>
