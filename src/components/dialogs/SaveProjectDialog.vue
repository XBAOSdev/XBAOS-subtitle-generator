<script setup lang="ts">
/**
 * 「保存项目」对话框。
 *
 * 用自建对话框而不是系统原生保存框，只有一条理由：**重名要在输入时就说**。
 * 原生对话框给不了「这个目录已有同名工程」的实时反馈，用户点完保存才被拒绝，
 * 还得重新走一遍选目录、改名字的流程。`.xbsgp` 里可能是一整部片子的字幕，
 * 这里宁可多花一点代码，也不允许出现「点了保存、结果静默覆盖」的可能。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/project'
import { useUiStore } from '@/stores/ui'
import { joinPath } from '@/utils/path'
import { projectFileName, samePath, sanitizeFileName } from '@/utils/projectName'
import ModalDialog from './ModalDialog.vue'
import Icon from '@/components/Icon.vue'

const project = useProjectStore()
const ui = useUiStore()

const dir = ref(project.defaultProjectDir())
const rawName = ref(project.displayProjectName)
const busy = ref(false)
/** 目标目录里已经有同名工程 */
const conflict = ref(false)
/** 有没有正在进行的重叠检查（后发的请求要让先发的作废） */
let checkToken = 0

const clean = computed(() => sanitizeFileName(rawName.value).value)
const replaced = computed(() => clean.value !== rawName.value)
const target = computed(() => (dir.value ? joinPath(dir.value, projectFileName(clean.value)) : ''))
/** 目标正是本项目当前所在文件 → 覆盖自己，不算冲突 */
const isSelf = computed(
  () => !!project.projectPath && samePath(target.value, project.projectPath),
)
const canSave = computed(
  () => !!dir.value && !!clean.value && !conflict.value && !busy.value,
)

/** 实时重查重名。异步结果可能乱序到达，用 token 让过期的结果失效 */
async function recheck(): Promise<void> {
  const token = (checkToken += 1)
  const path = target.value
  const bridge = window.xbaos
  if (!path || !bridge || isSelf.value) {
    conflict.value = false
    return
  }
  const exists = await bridge.fs.exists(path)
  if (token !== checkToken) return
  conflict.value = exists
}

watch(target, () => void recheck())
onMounted(() => void recheck())

async function pickDir(): Promise<void> {
  const bridge = window.xbaos
  if (!bridge) return
  const picked = await bridge.dialog.pickDirectory({ title: '选择保存位置', defaultPath: dir.value })
  if (picked) dir.value = picked
}

async function submit(): Promise<void> {
  if (!canSave.value) return
  busy.value = true
  const ok = await project.saveProjectTo(target.value)
  busy.value = false
  if (ok) ui.closeDialog()
}

function close(): void {
  ui.closeDialog()
}
</script>

<template>
  <ModalDialog
    title="保存项目"
    subtitle="项目文件记录这条时间轴上的全部字幕、讲话人与顺序"
    width="560px"
    @close="close"
  >
    <div class="saveproj">
      <div class="saveproj__field">
        <label class="saveproj__label" for="sp-dir">保存位置</label>
        <div class="saveproj__row">
          <input
            id="sp-dir"
            v-model="dir"
            class="input saveproj__dir"
            type="text"
            spellcheck="false"
          />
          <button class="btn saveproj__pick" type="button" @click="pickDir">浏览</button>
        </div>
      </div>

      <div class="saveproj__field">
        <label class="saveproj__label" for="sp-name">文件名</label>
        <div class="saveproj__row">
          <input
            id="sp-name"
            v-model="rawName"
            class="input"
            type="text"
            spellcheck="false"
            maxlength="120"
          />
          <span class="saveproj__ext">.xbsgp</span>
        </div>
        <p v-if="conflict" class="saveproj__note saveproj__note--err">
          该目录已存在同名项目，请更换名称
        </p>
        <p v-else-if="replaced" class="saveproj__note">已替换不能用作文件名的字符</p>
        <p v-else class="saveproj__note">保存后项目名与磁盘文件名保持一致</p>
      </div>

      <p class="saveproj__path" :title="target">
        <Icon name="folder" :size="12" />
        <span>{{ target || '请先选择保存位置' }}</span>
      </p>
    </div>

    <template #footer>
      <button class="btn" type="button" @click="close">取消</button>
      <button class="btn btn--primary" type="button" :disabled="!canSave" @click="submit">
        保存
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.saveproj {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.saveproj__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.saveproj__label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.saveproj__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 输入框吃掉剩余宽度；`min-width: 0` 少了的话长路径会把「浏览」挤出去 */
.saveproj__row .input {
  flex: 1;
  min-width: 0;
}

.saveproj__dir {
  font-family: var(--font-mono);
  font-size: 12px;
}

.saveproj__pick {
  flex: none;
}

.saveproj__ext {
  flex: none;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.saveproj__note {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.saveproj__note--err {
  color: var(--color-danger);
}

.saveproj__path {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
  /* 路径很长，只占一行；完整值在 title 里 */
  overflow: hidden;
  white-space: nowrap;
}

.saveproj__path span {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
