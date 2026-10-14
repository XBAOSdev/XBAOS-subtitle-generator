import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { useUiStore, TASK_MODEL_DOWNLOAD } from './ui'
import type { ModelDownloadEvent } from '@/types/engine'

export interface DownloadEntry {
  percent: number
  received: number
  total: number
}

/**
 * 模型下载状态。
 *
 * 为什么放在 store 而不是模型管理页里：下载几百 MB 要跑几分钟，用户很可能中途
 * 切去别的页面、甚至回去导入音频。状态若挂在页面组件上，`onBeforeUnmount` 一
 * 取消订阅，进度就再也收不到了 —— 而主进程那边的下载其实还在跑，用户切回来
 * 看到的却是一片空白（连「正在下载」的标签都没了，按钮又变回「下载」）。
 * 放到 store 里，页面来去都不影响订阅。
 */
export const useDownloadsStore = defineStore('downloads', () => {
  const ui = useUiStore()

  /** 正在下载的模型 key（主进程限制同一时刻只允许一个） */
  const activeKey = ref<string | null>(null)
  const progress = reactive<Record<string, DownloadEntry>>({})
  /** key → 显示名。下载事件里不带名字，而通知文案要用 */
  const nameOf = reactive<Record<string, string>>({})

  let subscribed = false

  function ensureSubscribed(): void {
    if (subscribed) return
    const api = window.xbaos?.models
    if (!api?.onProgress) return
    api.onProgress(onEvent)
    subscribed = true
  }

  /** 收尾：清掉这个 key 的进度、退出任务栈、撤掉任务栏进度条 */
  function finish(key: string): void {
    activeKey.value = null
    delete progress[key]
    ui.endTask(TASK_MODEL_DOWNLOAD)
  }

  function onEvent(ev: ModelDownloadEvent): void {
    const name = nameOf[ev.key] ?? ev.key
    switch (ev.status) {
      case 'start':
        activeKey.value = ev.key
        progress[ev.key] = { percent: 0, received: 0, total: 0 }
        ui.beginTask(TASK_MODEL_DOWNLOAD, `正在下载 ${name}`)
        break

      case 'progress': {
        const entry = (progress[ev.key] ??= { percent: 0, received: 0, total: 0 })
        entry.received = ev.received ?? 0
        entry.total = ev.total ?? 0
        entry.percent = ev.percent ?? 0
        // 任务栏那一份要跟着走：用户切走后界面上的细进度条看不见，
        // 任务栏上那条才是他唯一的信息来源
        ui.updateTask(TASK_MODEL_DOWNLOAD, entry.percent)
        break
      }

      case 'done':
        finish(ev.key)
        if (ev.already) {
          ui.notify('info', `${name} 已存在`, '无需重复下载')
        } else {
          ui.notify('success', `${name} 已下载`, '点击「切换使用」开始用它识别')
          // 下载完往往人已经不在软件前面了，闪一下任务栏把人叫回来
          ui.flashTaskBar()
        }
        break

      case 'canceled':
        finish(ev.key)
        ui.notify('info', '下载已取消', '已下载的部分保留，下次继续')
        break

      case 'error':
        finish(ev.key)
        ui.notify('error', `${name} 下载失败`, ev.message ?? '')
        break
    }
  }

  async function start(key: string, name: string): Promise<void> {
    nameOf[key] = name
    const api = window.xbaos?.models
    if (!api) {
      ui.notify('info', '浏览器预览无法下载模型', '请在桌面应用中使用')
      return
    }
    ensureSubscribed()
    try {
      await api.download(key)
      activeKey.value = key
    } catch (err) {
      ui.notify('error', '无法开始下载', err instanceof Error ? err.message : String(err))
    }
  }

  async function cancel(key: string): Promise<void> {
    await window.xbaos?.models?.cancelDownload(key)
  }

  return { activeKey, progress, start, cancel }
})
