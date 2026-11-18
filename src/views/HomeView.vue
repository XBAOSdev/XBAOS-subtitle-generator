<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useModelStore } from '@/stores/model'
import { formatDuration, formatEstimate } from '@/utils/format'
import { estimateSeconds } from '@/utils/reasoningDepth'
import MaterialBoard from '@/components/MaterialBoard.vue'
import RecogSettings from '@/components/recog/RecogSettings.vue'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()
const settings = useSettingsStore()
const model = useModelStore()

const pendingFiles = computed(() => project.pendingIntake)

/** 没有模型就没有识别可谈：按钮直接禁用，右侧面板同时给出「请配置模型」 */
const canStart = computed(
  () => pendingFiles.value.length > 0 && !project.recognizing && !model.missing,
)

/** 依据当前后端与推理深度估算耗时。auto 档取中间值，不敢许空头承诺 */
const estimate = computed(() => {
  const kind: 'gpu' | 'cpu' | 'unknown' =
    settings.backend === 'cpu' ? 'cpu' : settings.backend === 'vulkan' ? 'gpu' : 'unknown'
  // 与识别时同一条判据：不支持多遍解码的模型按单遍算
  const depth = model.caps.decode ? settings.reasoningDepth : 'standard'
  return formatEstimate(estimateSeconds(project.intakeDuration, depth, kind))
})

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
  // 失败的条目会留在队列里（带原因），成功的已经落进项目
  const failed = project.intake.filter((f) => f.status === 'failed').length
  if (project.progress < 100) {
    ui.notify('warning', '识别已取消', '未完成的文件仍留在队列中，可重新开始')
    return
  }
  ui.notify(
    failed > 0 ? 'warning' : 'success',
    failed > 0 ? `识别完成，${failed} 个文件失败` : '识别完成',
    failed > 0 ? '失败的文件仍留在队列中，可重试' : '已切换到字幕工作台',
  )
  // 还有失败项就留在导入页：用户得看着原因决定重试还是换文件（2.4）
  if (failed === 0) ui.navigate('editor')
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

        <RecogSettings />
      </div>
    </div>

    <footer class="view__foot">
      <div class="view__foot-inner">
        <!-- 没有模型时，底栏先说清楚「缺什么」，而不是继续报「待识别几个」 -->
        <span v-if="model.missing" class="hint hint--warn">没有可用的识别模型，请先在模型管理页配置</span>
        <span v-else-if="project.intake.length > 0" class="hint">
          待识别 {{ pendingFiles.length }} 个
          <template v-if="project.intakeDuration > 0">
            ，总时长 {{ formatDuration(project.intakeDuration) }}，{{ estimate }}
          </template>
        </span>
        <span v-else class="hint">还没有导入任何音频</span>

        <span class="spacer" />

        <button
          v-if="project.files.length > 0 || project.recognizing"
          class="btn btn--lg"
          type="button"
          @click="ui.navigate('editor')"
        >
          去工作台
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
          <Icon name="zap" :size="14" />
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
  /*
   * 右侧设置栏随窗口变宽、有上限；左侧素材区吃掉剩下的宽度。
   *
   * 上限从 368 提到 420：368 是按默认窗口算的，窗口一拉宽它就再也不动了，
   * 而「识别语言 / 推理深度 / 热词」这些控件的天然宽度远不止 368 ——
   * 宽屏下让它们长长，扫一眼就能读完，比一排挤在一起的下拉框好用。
   * 但如果无限制地放，素材区会被挤成一条，所以到 420 就停。
   * 下限 300 不动：窄窗口下这一栏再窄就放不下四个深度分段了。
   */
  grid-template-columns: minmax(0, 1fr) clamp(300px, 24vw, 420px);
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
    scrollbar-gutter: stable;
  }

  .view--fill .view__body-inner {
    height: auto;
    grid-template-columns: minmax(0, 1fr);
  }
}


/* 「开始识别」按钮在圆点飞出去的那 460ms 里隐去自己。
   用 visibility 而不是 display / v-if：**布局不能动** —— 按钮一消失，
   同一行的「去工作台」会往右滑一格，看起来像是页面抖了一下。 */
.btn.is-flying {
  visibility: hidden;
}

/* 没有模型：底栏那行提示改成告警色，它是可操作的（去模型页配一个） */
.hint--warn {
  color: var(--color-warning);
}

</style>
