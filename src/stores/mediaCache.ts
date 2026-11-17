import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MediaCacheStats } from '@/types/engine'

/** 空统计。浏览器预览与「主进程还没回话」都用它，省得到处判空 */
const EMPTY: MediaCacheStats = { bytes: 0, count: 0, limit: 0, dir: '', files: [] }

/**
 * 解码缓存的占用与清理。
 *
 * 这份缓存是**源采样率**的单声道 PCM（48kHz 一小时 345MB），是软件里唯一
 * 会自己长大的目录。它的定位是「可再生的中间物」：删了不影响任何工程数据，
 * 只是下次播放那段音频时重新解一遍。所以这里只管两件事 ——
 * 让用户**看得见**占了多少，以及**能自己动手**删。
 *
 * 数据源只有主进程（`media:cache-stats`），这里不做任何本地推算：
 * 缓存键是 sha1，渲染层既不知道也别该知道目录里有什么。
 */
export const useMediaCacheStore = defineStore('mediaCache', () => {
  const stats = ref<MediaCacheStats>(EMPTY)
  /** 正在取/正在删。设置页与底栏都据此显示忙碌态 */
  const busy = ref(false)
  /** 取过一次没有。底栏靠它区分「0」和「还不知道」 */
  const loaded = ref(false)

  /** 有缓存吗。底栏只在真有东西时才占位置 */
  const hasCache = computed(() => stats.value.count > 0)

  /** 占用比例 0~1，给设置页的条子用。没有上限时按 0 处理 */
  const ratio = computed(() => {
    const { bytes, limit } = stats.value
    if (!(limit > 0)) return 0
    return Math.min(1, bytes / limit)
  })

  async function refresh(): Promise<void> {
    const bridge = window.xbaos
    if (!bridge?.media?.cacheStats) {
      // 浏览器预览没有主进程，缓存也不存在：给一份空统计，界面照常渲染
      stats.value = EMPTY
      loaded.value = true
      return
    }
    try {
      stats.value = await bridge.media.cacheStats()
    } catch {
      // 取不到就保持上一次的值：底栏一块数字不值得弹错误
      stats.value = EMPTY
    }
    loaded.value = true
  }

  /**
   * 清除缓存。
   *
   * 不传名字 = 全部清除。返回真正删掉的份数（删不掉的会被跳过，比如正被
   * 播放器占用），调用方据此决定提示语。
   */
  async function clear(names?: string[]): Promise<number> {
    const bridge = window.xbaos
    if (!bridge?.media?.clearCache) return 0
    busy.value = true
    try {
      const res = await bridge.media.clearCache(names)
      stats.value = res.stats
      loaded.value = true
      return res.removed
    } catch {
      return 0
    } finally {
      busy.value = false
    }
  }

  return { stats, busy, loaded, hasCache, ratio, refresh, clear }
})
