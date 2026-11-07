<script setup lang="ts">
/**
 * 「音频映射」对话框。
 *
 * 子项目与音频之间的对应关系在项目文件里只存一个路径，路径随时可能失效：
 * 换台电脑、盘符变了、素材被挪走。没有这个入口，用户唯一的出路是删掉子项目
 * 重新导入 —— 字幕、讲话人、译文全丢。
 *
 * 三条与方案一致的行为：
 *  - **所有子项目都能映射**，包括纯字幕的（挂上音频就有了波形与试听）；
 *  - 换音频**不动字幕、不提示时长变化**：慢速版字幕对不上是用户自己的判断；
 *  - **映射完不触发重新识别**，也不弹「要不要重新识别」。
 */
import { computed, ref } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { isSupported } from '@/utils/formats'
import ModalDialog from './ModalDialog.vue'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()

const fileId = String(ui.dialogPayload.fileId ?? '')
const file = computed(() => project.supportedFiles.find((f) => f.id === fileId) ?? null)

/** 用户新选的路径；为空表示还没选 */
const picked = ref('')
const busy = ref(false)

/** 当前状态。刚选完新文件时以「待应用」为准 */
const state = computed(() => (picked.value ? 'picked' : (project.mediaStateOf(fileId) ?? 'ok')))

const stateText = computed(() => {
  switch (state.value) {
    case 'missing':
      return '文件不存在'
    case 'changed':
      return '大小或修改时间与记录不同'
    case 'picked':
      return '待应用'
    default:
      return '已校验'
  }
})

/**
 * 这个子项目**现在挂着的音频**。
 *
 * 不能直接读 `file.path`：纯字幕子项目的 `path` 指向它自己那个 .srt
 * （导入时的落点），于是「当前音频」会显示成 `…\音频\数据单位换算.srt` ——
 * 一个字号看着像音频、实际是字幕文件的路径。判据是扩展名：`path`/`ext`
 * 始终描述同一个文件，映射过音频之后 ext 就变成 wav/mp3 这一族了。
 */
const current = computed(() => {
  const f = file.value
  return f && isSupported(f.ext) ? f.path : ''
})
/** 还没有音频：纯字幕子项目，或者音频映射被清掉过 */
const subtitleOnly = computed(() => !current.value)

async function pick(): Promise<void> {
  const bridge = window.xbaos
  if (!bridge) return
  const list = await bridge.dialog.pickAudio()
  if (list.length > 0) picked.value = list[0]
}

async function apply(): Promise<void> {
  if (!picked.value || busy.value) return
  busy.value = true
  const ok = await project.remapMedia(fileId, picked.value)
  busy.value = false
  if (ok) ui.closeDialog()
}

function close(): void {
  ui.closeDialog()
}
</script>

<template>
  <ModalDialog
    title="音频映射"
    :subtitle="file?.name ?? ''"
    width="560px"
    @close="close"
  >
    <div class="audiomap">
      <div class="audiomap__field">
        <span class="audiomap__label">当前音频</span>
        <p v-if="current" class="audiomap__path" :title="current">
          <Icon name="file-audio" :size="12" />
          <span>{{ current }}</span>
        </p>
        <p v-else class="audiomap__none">无</p>
      </div>

      <div class="audiomap__field">
        <span class="audiomap__label">新路径</span>
        <div class="audiomap__row">
          <input
            v-model="picked"
            class="input audiomap__input"
            type="text"
            spellcheck="false"
            :placeholder="subtitleOnly ? '选择一份音频，之后就能重新识别' : '选择音频文件'"
          />
          <button class="btn audiomap__pick" type="button" @click="pick">选择文件</button>
        </div>
        <p
          class="audiomap__note"
          :class="{ 'audiomap__note--warn': state === 'missing' || state === 'changed' }"
        >
          {{ stateText }}
        </p>
      </div>

      <p class="audiomap__hint">
        换音频不会改字幕，也不会自动重新识别。
      </p>
    </div>

    <template #footer>
      <button class="btn" type="button" @click="close">取消</button>
      <button class="btn btn--primary" type="button" :disabled="!picked || busy" @click="apply">
        应用
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.audiomap {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.audiomap__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.audiomap__label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.audiomap__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.audiomap__input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
}

.audiomap__pick {
  flex: none;
}

.audiomap__path {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
  overflow: hidden;
  white-space: nowrap;
}

.audiomap__path span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.audiomap__none {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.audiomap__note {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.audiomap__note--warn {
  color: var(--color-danger);
}

.audiomap__hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
