import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useSettingsStore } from './settings'
import type { ActiveModelInfo, ArchCaps } from '@/types/engine'

/**
 * 当前模型与架构。界面上「哪些功能可用」的**唯一来源**。
 *
 * 为什么不各组件自己判断：能力取决于模型架构，而架构要由主进程读模型内容才能
 * 定（ONNX 目录要读 tokens.txt）。散在各处判断的话，换一种模型类型就要翻遍
 * 三四个组件，漏一处就出现「按钮能点但引擎只会报错」。
 *
 * 默认值是「全都可用」：浏览器预览没有桥、首次刷新也还没回来，这时若默认
 * 全部禁用，界面会先闪一下灰，预览环境更是永远灰着。真有不支持的能力，
 * 刷新一次就会把对应项关掉。
 */
const ALL_CAPS: ArchCaps = { prompt: true, translate: true, decode: true, gpu: true }

export const useModelStore = defineStore('model', () => {
  const settings = useSettingsStore()

  const arch = ref('')
  const archLabel = ref('')
  const entry = ref<ActiveModelInfo['entry']>(null)
  const caps = ref<ArchCaps>({ ...ALL_CAPS })
  /**
   * 架构是用户手动指定、且与模型内容判定不一致。
   * 界面据此说明「按指定架构运行」—— 否则用户会以为软件认错了模型。
   */
  const archForced = ref(false)
  /** 是否已成功拿到主进程的结果（浏览器预览下永远为 false） */
  const ready = ref(false)

  async function refresh(): Promise<void> {
    const api = window.xbaos?.models
    if (!api?.active) return
    try {
      const info = await api.active(settings.modelFile, settings.arch)
      arch.value = info.arch
      archLabel.value = info.archLabel
      entry.value = info.entry
      caps.value = info.caps ?? { ...ALL_CAPS }
      archForced.value = info.archForced === true
      ready.value = true
    } catch {
      /* 读不到就保持上一次的结论，别把界面突然全锁上 */
    }
  }

  // 切换模型、切换架构后所有依赖能力的控件都要跟着变 —— 在 store 里监听一次，
  // 免得每个页面各自 watch 设置
  watch([() => settings.modelFile, () => settings.arch], () => void refresh())

  /**
   * 确实没有可用模型。
   *
   * 必须等主进程答过一次才成立：浏览器预览没有桥，`entry` 永远是 null，
   * 若直接拿它判「没有模型」，预览与探针里整页都会变成空态。
   */
  const missing = computed(() => ready.value && entry.value === null)

  return { arch, archLabel, entry, caps, archForced, ready, missing, refresh }
})
