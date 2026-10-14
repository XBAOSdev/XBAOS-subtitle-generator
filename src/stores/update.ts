import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { branding, appVersion } from '@/branding'
import type { UpdateCheckResult, UpdateFailReason } from '@/types/engine'

/**
 * 更新检查的状态。
 *
 *   idle     还没查过（或用户关掉了「启动时检查」又从没手动查过）
 *   checking 请求进行中
 *   latest   查到了，版本一致
 *   update   查到了，有新版本
 *   error    没查到（网络 / HTTP / 清单格式）。**这不等于「已是最新」**
 */
export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'update' | 'error'

/** 非 HTTP 类失败的短标签。HTTP 类直接显示三位码，所以不在这张表里 */
const REASON_LABEL: Record<Exclude<UpdateFailReason, 'http'>, string> = {
  network: '网络不可达',
  timeout: '连接超时',
  format: '清单异常',
  unknown: '检查失败',
}

export const useUpdateStore = defineStore('update', () => {
  const phase = ref<UpdatePhase>('idle')
  const current = ref(appVersion)
  const latest = ref('')
  const updated = ref('')
  const highlight = ref('')
  const upgradeHint = ref('')
  const releaseTitle = ref('')
  const notes = ref<string[]>([])
  const homepage = ref('')
  const downloadLabel = ref('')
  const downloadUrl = ref('')

  const errorReason = ref<UpdateFailReason | ''>('')
  const errorCode = ref<number | null>(null)
  const errorMessage = ref('')

  /** 用户点了「稍后再说」。只在本次运行内有效，下次启动会重新提示 */
  const dismissed = ref(false)

  /** 上次完成检查的时间戳，0 表示从未检查过 */
  const checkedAt = ref(0)

  const hasUpdate = computed(() => phase.value === 'update' && !dismissed.value)
  const hasError = computed(() => phase.value === 'error')

  /**
   * 失败的短标签。HTTP 错误显示三位状态码 —— 用户看到 404 就知道是清单没了，
   * 看到 503 就知道是对方服务器的问题，比一句「检查失败」有用得多。
   */
  const errorLabel = computed(() => {
    if (errorCode.value) return String(errorCode.value)
    const reason = errorReason.value
    if (!reason || reason === 'http') return '未知错误'
    return REASON_LABEL[reason]
  })

  /**
   * 左下角提示条上的文案。返回空串表示不显示 ——
   * 「已是最新」「正在检查」「还没查过」都不该在侧边栏占位置。
   */
  const hintLabel = computed(() => {
    if (phase.value === 'update') return dismissed.value ? '' : `有新版本 v${latest.value}`
    if (phase.value === 'error') return `更新检查失败 ${errorLabel.value}`
    return ''
  })

  /** 关于页与设置页用的完整状态说明 */
  const statusLabel = computed(() => {
    switch (phase.value) {
      case 'checking':
        return '正在检查更新'
      case 'latest':
        return '已是最新版本'
      case 'update':
        return `发现新版本 v${latest.value}`
      case 'error':
        return errorMessage.value || `检查失败（${errorLabel.value}）`
      default:
        return '尚未检查更新'
    }
  })

  /** 「前往官网更新」的目标：清单里给的官网优先，退回内置品牌地址 */
  const targetUrl = computed(() => homepage.value || branding.website)

  function reset(): void {
    phase.value = 'idle'
    latest.value = ''
    updated.value = ''
    highlight.value = ''
    upgradeHint.value = ''
    releaseTitle.value = ''
    notes.value = []
    homepage.value = ''
    downloadLabel.value = ''
    downloadUrl.value = ''
    errorReason.value = ''
    errorCode.value = null
    errorMessage.value = ''
    dismissed.value = false
  }

  function apply(result: UpdateCheckResult): void {
    current.value = result.current || appVersion

    if (!result.ok || result.state === 'error') {
      phase.value = 'error'
      errorReason.value = result.reason ?? 'unknown'
      errorCode.value = typeof result.code === 'number' ? result.code : null
      errorMessage.value = result.message ?? '检查更新失败'
      return
    }

    latest.value = result.latest ?? ''
    updated.value = result.updated ?? ''
    homepage.value = result.homepage ?? ''
    downloadLabel.value = result.download?.label ?? ''
    downloadUrl.value = result.download?.url ?? ''

    if (result.state === 'update') {
      phase.value = 'update'
      dismissed.value = false
      highlight.value = result.highlight ?? ''
      upgradeHint.value = result.upgradeHint ?? ''
      releaseTitle.value = result.releaseTitle ?? ''
      notes.value = [...(result.notes ?? [])]
      return
    }

    phase.value = 'latest'
    highlight.value = ''
    upgradeHint.value = ''
    releaseTitle.value = ''
    notes.value = []
  }

  /**
   * 真正去查一次。**永不抛错** —— 失败会变成 phase='error' 与可读的原因，
   * 因为这是启动时的自动行为，抛出去只会变成没人处理的 unhandled rejection。
   */
  async function check(): Promise<void> {
    if (phase.value === 'checking') return

    const api = window.xbaos?.update
    if (!api?.check) {
      // 浏览器预览没有 Electron 桥。这里不伪造「已是最新」，
      // 因为那会让「检查更新」在预览里看起来是好的，实则什么都没查
      phase.value = 'error'
      errorReason.value = 'unknown'
      errorCode.value = null
      errorMessage.value = '当前环境不支持检查更新'
      return
    }

    phase.value = 'checking'
    try {
      apply(await api.check())
    } catch (err) {
      phase.value = 'error'
      errorReason.value = 'unknown'
      errorCode.value = null
      errorMessage.value = err instanceof Error ? err.message : String(err)
    } finally {
      checkedAt.value = Date.now()
    }
  }

  /** 打开官网更新页。返回是否成功，失败时调用方负责提示 */
  async function openTarget(url?: string): Promise<boolean> {
    const target = url || targetUrl.value
    if (!target) return false

    const api = window.xbaos?.update
    if (!api?.openUrl) {
      // 浏览器预览：退回原生行为
      window.open(target, '_blank', 'noopener,noreferrer')
      return true
    }
    try {
      const res = await api.openUrl(target)
      return !!res?.ok
    } catch {
      return false
    }
  }

  function dismiss(): void {
    dismissed.value = true
  }

  /**
   * 开发预览用：`?update=available|latest|error|http404` 直接摆出对应状态。
   * 探针靠它测左下角提示与弹窗 —— 浏览器预览里既没有 Electron 桥也没有外网。
   * 正式版没有这个入口（只在 import.meta.env.DEV 下被调用）。
   */
  function applyDevState(kind: string): void {
    const fake: UpdateCheckResult =
      kind === 'available'
        ? {
            ok: true,
            state: 'update',
            current: appVersion,
            latest: '0.2.0',
            updated: '2026-11-01',
            name: branding.productName,
            homepage: branding.website,
            download: { label: '第三方网盘下载', url: 'https://example.com/download' },
            highlight: '这一版把识别速度提了一截，并修了几个界面问题。',
            upgradeHint: '直接运行新版安装包覆盖安装即可，设置与已下载的模型都会保留。',
            releaseTitle: '性能与体验更新',
            notes: [
              '识别速度优化：VAD 切分点更贴近真实语音边界',
              '新增更新检查，发现新版本会在左下角提示',
              '修复字幕规格校验在合并模式下不刷新的问题',
            ],
          }
        : kind === 'error'
          ? {
              ok: false,
              state: 'error',
              current: appVersion,
              reason: 'network',
              code: null,
              message: '连不上更新服务器：getaddrinfo ENOTFOUND subtitle.xbaos.com.cn',
            }
          : kind.startsWith('http')
            ? {
                ok: false,
                state: 'error',
                current: appVersion,
                reason: 'http',
                code: Number.parseInt(kind.slice(4), 10) || 404,
                message: `更新服务器返回 HTTP ${kind.slice(4) || 404}`,
              }
            : kind === 'latest'
              ? {
                  ok: true,
                  state: 'latest',
                  current: appVersion,
                  latest: appVersion,
                  updated: '2026-10-08',
                  name: branding.productName,
                  homepage: branding.website,
                }
              : {
                  ok: false,
                  state: 'error',
                  current: appVersion,
                  reason: 'timeout',
                  code: null,
                  message: '连接更新服务器超时',
                }

    if (kind === 'checking') {
      phase.value = 'checking'
      return
    }
    apply(fake)
  }

  return {
    phase,
    current,
    latest,
    updated,
    highlight,
    upgradeHint,
    releaseTitle,
    notes,
    homepage,
    downloadLabel,
    downloadUrl,
    errorReason,
    errorCode,
    errorMessage,
    dismissed,
    checkedAt,
    hasUpdate,
    hasError,
    errorLabel,
    hintLabel,
    statusLabel,
    targetUrl,
    reset,
    check,
    openTarget,
    dismiss,
    applyDevState,
  }
})
