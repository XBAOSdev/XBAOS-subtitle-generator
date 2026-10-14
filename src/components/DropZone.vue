<script setup lang="ts">
import { ref } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { SUPPORTED_LABELS, UNSUPPORTED_LABELS } from '@/utils/formats'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()

const inputRef = ref<HTMLInputElement | null>(null)

function pick(): void {
  inputRef.value?.click()
}

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  if (files.length > 0) project.receiveDroppedFiles(files)
  input.value = ''
}

function loadDemo(): void {
  project.loadDemo()
  ui.notify('info', '已载入演示数据', '仅开发预览可用，正式版本不含此入口')
}

/**
 * 打开录音窗口。
 *
 * **不弹确认直接开窗**：录音窗口本身就是「要录什么」的选择现场（勾选输入源、
 * 点开始才会真的采集），开窗前再多问一句纯属多一步操作 —— 用户点「录制音频」
 * 的意图已经够明确了。关闭时的防丢确认在窗口那侧把关。
 */
async function openRecorder(): Promise<void> {
  const bridge = window.xbaos
  if (!bridge?.record?.open) {
    ui.notify('info', '浏览器预览模式下不可用', '录音需要以桌面应用方式运行')
    return
  }
  ui.setRecordActive(true)
  await bridge.record.open()
}

const isDev = import.meta.env.DEV
</script>

<template>
  <section class="dropzone">
    <!-- 紧凑横向条：图标 + 两行文案 + 主按钮。原来那种居中的大虚线框
         占了近半屏却只干一件事，反而把真正的重点（队列与开始按钮）挤下去了。 -->
    <div class="dropzone__bar" @click="pick">
      <span class="dropzone__icon">
        <Icon name="import" :size="20" />
      </span>
      <span class="dropzone__text">
        <span class="dropzone__title">把音频文件拖到这里，或点击选择</span>
        <span class="dropzone__sub">支持一次选多个，识别全部在本机完成</span>
      </span>
      <span class="spacer" />
      <!-- 两个按钮结构一致（图标 + 文案），视觉轻重有别：
           「添加音频」是主路径用实心主按钮，「录制音频」是补充入口用次级按钮 -->
      <button class="btn" type="button" @click.stop="openRecorder">
        <Icon name="mic" :size="14" />
        <span>录制音频</span>
      </button>
      <button class="btn btn--primary" type="button" @click.stop="pick">
        <Icon name="import" :size="14" />
        <span>添加音频</span>
      </button>
      <button v-if="isDev" class="dropzone__dev" type="button" @click.stop="loadDemo">
        载入演示数据
      </button>
    </div>

    <!-- 格式标注，常驻一行 -->
    <div class="dropzone__formats">
      <span class="dropzone__tag dropzone__tag--ok">支持</span>
      <span class="dropzone__list">{{ SUPPORTED_LABELS.join(' ') }}</span>
      <span class="dropzone__sep" aria-hidden="true">/</span>
      <span class="dropzone__tag dropzone__tag--no">不支持</span>
      <span class="dropzone__list dropzone__list--muted">
        {{ UNSUPPORTED_LABELS.join(' ') }}
      </span>
      <button class="dropzone__why" type="button" @click="ui.openDialog('format-help')">
        原因
      </button>
    </div>

    <input
      ref="inputRef"
      class="sr-only"
      type="file"
      multiple
      accept=".mp3,.wav,.flac,.ogg,.oga,.opus,.aif,.aiff,audio/*"
      @change="onChange"
    />
  </section>
</template>

<style scoped>
.dropzone {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.dropzone__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  /* 行间距只在换行后起作用：窄窗下按钮排到文字下一行时留出呼吸 */
  row-gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1.5px dashed var(--color-border-strong);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
  cursor: pointer;
  transition: border-color var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out);
}

.dropzone__bar:hover {
  border-color: var(--color-accent-border);
  background: var(--color-bg-inset);
}

.dropzone__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md);
  background: var(--color-accent-subtle);
  color: var(--color-accent);
}

.dropzone__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /*
   * flex 默认把可收缩项压到 min-content，而中文的 min-content 只有一个字宽
   * —— 文字会被挤成一字一行竖排。给它保底 200px：放不下就让按钮换行，
   * 绝不压缩文字。
   */
  flex: 1 1 200px;
  min-width: 200px;
}

.dropzone__title {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
}

.dropzone__sub {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.dropzone__dev {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
  text-decoration: underline;
  text-decoration-style: dotted;
}

.dropzone__dev:hover {
  color: var(--color-accent);
}

.dropzone__formats {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: 0 var(--space-1);
  font-size: var(--font-size-xs);
}

.dropzone__tag {
  flex: none;
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: var(--weight-medium);
}

.dropzone__tag--ok {
  background: var(--color-success-subtle);
  color: var(--color-success);
}

.dropzone__tag--no {
  background: var(--color-bg-subtle);
  color: var(--color-text-tertiary);
}

.dropzone__list {
  color: var(--color-text-secondary);
  letter-spacing: 0.02em;
}

.dropzone__list--muted {
  color: var(--color-text-tertiary);
}

.dropzone__sep {
  color: var(--color-border-strong);
}

.dropzone__why {
  font-size: 11px;
  color: var(--color-accent);
  text-decoration: underline;
  text-decoration-style: dotted;
}
</style>
