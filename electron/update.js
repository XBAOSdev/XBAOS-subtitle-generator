/**
 * 自动更新检查。
 *
 * 边界刻意划得很窄：**只检查、不下载、不安装、不替换文件**。
 * 检查的产物是一份 JSON（版本清单），读到之后由界面决定怎么提示。
 * 真要把安装包拉下来并替换运行中的程序，需要独立进程 + 校验 + 回滚，
 * 那是另一件事，不混在这里做 —— 联网面越小，出事的面就越小。
 *
 * 这个文件是**纯逻辑**，不 import electron、不碰文件系统：
 *   - 主进程通过 `net.fetch`（走 Chromium 网络栈，自动用系统代理与系统证书）注入 fetchImpl
 *   - 单元测试注入一个假的 fetchImpl，断言分支行为
 * 所有网络相关的东西都是注入进来的，所以它可以在 Node 里被完整测试。
 */

/** 版本清单里必须与软件对得上的标识 */
export const MANIFEST_ID = 'subtitle-generator'

/**
 * 清单地址。**由软件官网自己承担版本检测**（Cloudflare Pages，纯静态，清单只有几 KB）：
 * 官网页面与软件读的是同一份 JSON，版本号只留一处真相源，不再依赖 update.xbaos.com.cn。
 * 安装包体积太大（520MB）放不进 Pages（单文件上限 25 MiB），
 * 所以清单里的 `download.url` 指向网盘分享链接，官网不放二进制。
 *
 * 桌面端可用环境变量 XBAOS_UPDATE_URL 覆盖（联调与探针用）。
 */
export const MANIFEST_URL = 'https://subtitle.xbaos.com.cn/data/subtitle.json'

export const DEFAULT_TIMEOUT_MS = 8000

/**
 * 版本号是否合法。接受 2~4 段数字（`0.1.0` / `1.2` / `1.2.3.4`），
 * 不接受 `v1.0`、`1.0-beta`、`1.0.0+build` 这类形式 ——
 * 与其猜用户的意图，不如直接判非法让清单作者改。
 */
export function isValidVersion(value) {
  return typeof value === 'string' && /^\d+(\.\d+){1,3}$/.test(value.trim())
}

/**
 * 逐段按数字比较版本号。
 * @returns {number} a < b 返回 -1，相等 0，a > b 返回 1
 */
export function compareVersions(a, b) {
  const pa = String(a).trim().split('.')
  const pb = String(b).trim().split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    // 段数不同时短的一侧补 0：1.2 与 1.2.0 视为相同
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0
    const y = Number.parseInt(pb[i] ?? '0', 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 校验清单的形状。
 *
 * `id` 只在**清单里有**的时候才比对：缺失视为「作者没写」，放行；
 * 写了但对不上，说明读到的是别的软件的清单（例如路径配错），必须拦下 ——
 * 否则会拿着别的软件的最新版本号去提示更新，属于静默的错误。
 */
export function parseManifest(raw, expectedId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '更新清单不是一个 JSON 对象' }
  }
  if (!isValidVersion(raw.latest)) {
    return { ok: false, message: '更新清单里缺少合法的 latest 版本号（形如 0.2.0）' }
  }
  if (expectedId && typeof raw.id === 'string' && raw.id.trim() && raw.id.trim() !== expectedId) {
    return { ok: false, message: `清单标识是 ${raw.id}，与本软件（${expectedId}）对不上` }
  }
  return { ok: true }
}

/** 取 latest 对应的那一条发布记录，作为本次更新的内容说明 */
export function pickReleaseNotes(manifest) {
  const latest = String(manifest.latest ?? '').trim()
  const releases = Array.isArray(manifest.releases) ? manifest.releases : []
  const hit = releases.find((item) => item && String(item.version ?? '').trim() === latest)
  const items = hit && Array.isArray(hit.items)
    ? hit.items.filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim())
    : []
  return {
    title: hit && typeof hit.title === 'string' ? hit.title.trim() : '',
    date: hit && typeof hit.date === 'string' ? hit.date.trim() : '',
    items,
  }
}

/**
 * 允许交给系统浏览器打开的外链域名。
 *
 * 软件承诺「全过程本地」，外链只放行自家域名 —— 这一条在渲染进程的
 * `setWindowOpenHandler` 和这里的「前往官网更新」两处都要成立，所以判据放在这，
 * 两边共用一份，免得改了域名之后只改了一处、另一处静默失效。
 */
export const ALLOWED_EXTERNAL_HOSTS = ['xbaos.com.cn']

/** 主机名是否属于放行域名（含其子域，例如 subtitle.xbaos.com.cn） */
export function isAllowedExternalHost(host) {
  const value = String(host || '').toLowerCase()
  if (!value) return false
  return ALLOWED_EXTERNAL_HOSTS.some((base) => value === base || value.endsWith(`.${base}`))
}

/**
 * 把外部链接规范成可以交给系统的形式，不允许的返回空串。
 *
 * 两道闸：① 只放行 https（`file:` 与注册过的自定义协议都会被 `shell.openExternal`
 * 交给对应程序处理，那是真正危险的部分）；② 只放行自家域名。
 */
export function allowedExternalUrl(target) {
  if (typeof target !== 'string') return ''
  const value = target.trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return ''
    if (!isAllowedExternalHost(url.hostname)) return ''
    return url.toString()
  } catch {
    return ''
  }
}

/**
 * 检查更新。
 *
 * @param {object} options
 * @param {string} options.currentVersion       本机版本，来自 app.getVersion()
 * @param {string} [options.url]                清单地址
 * @param {string} [options.expectedId]         期望的清单标识
 * @param {Function} options.fetchImpl          形如 fetch 的实现（主进程注入 net.fetch）
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]          取时间戳，测试时可控
 * @returns {Promise<object>} 见下方 state 字段：latest / update / error
 */
export async function checkForUpdate(options) {
  const {
    currentVersion,
    url = MANIFEST_URL,
    expectedId = MANIFEST_ID,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => Date.now(),
  } = options ?? {}

  const fail = (reason, message, code = null) => ({
    ok: false,
    state: 'error',
    reason,
    message,
    code,
    current: typeof currentVersion === 'string' ? currentVersion : '',
  })

  if (typeof fetchImpl !== 'function') return fail('unknown', '当前环境没有可用的网络请求实现')
  if (!isValidVersion(currentVersion)) {
    return fail('unknown', `本机版本号「${currentVersion}」不是合法版本号，无法比较`)
  }

  /*
   * 反缓存。
   *
   * 清单放在 CDN 上，浏览器/代理/V8 缓存任一层命中都会把新版本号压住，
   * 表现成「明明改了清单，软件还说不更新」——这种问题极难排查。
   * 加一个每次都不同的查询串，让任何一层都认定这是新请求。
   * 清单本身只有几 KB，不值得为缓存优化。
   */
  let target = url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('_', String(now()))
    target = parsed.toString()
  } catch {
    /* URL 不合法就原样交给 fetch，让错误信息更贴近真实原因 */
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => {
    if (controller) controller.abort()
  }, timeoutMs)

  let res
  try {
    res = await fetchImpl(target, {
      signal: controller ? controller.signal : undefined,
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    clearTimeout(timer)
    if (controller && controller.signal.aborted) {
      return fail('timeout', `连接更新服务器超时（${timeoutMs} 毫秒内没有响应）`)
    }
    return fail('network', `连不上更新服务器：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }

  const status = Number(res && res.status) || 0
  if (!res || res.ok === false) {
    return fail('http', `更新服务器返回 HTTP ${status || '未知'}`, status || null)
  }

  let raw
  try {
    raw = await res.json()
  } catch {
    // 200 但内容不是 JSON：常见于域名被解析到一个错误页面（登录门户、运营商劫持页）
    return fail('format', '更新清单不是合法的 JSON，可能是域名被解析到了别的页面', status)
  }

  const parsed = parseManifest(raw, expectedId)
  if (!parsed.ok) return fail('format', parsed.message, status)

  const latest = String(raw.latest).trim()
  const release = pickReleaseNotes(raw)

  const base = {
    ok: true,
    current: String(currentVersion),
    latest,
    updated: typeof raw.updated === 'string' && raw.updated.trim() ? raw.updated.trim() : release.date,
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    homepage: typeof raw.homepage === 'string' ? raw.homepage.trim() : '',
    download:
      raw.download && typeof raw.download === 'object'
        ? {
            label: typeof raw.download.label === 'string' ? raw.download.label : '',
            url: typeof raw.download.url === 'string' ? raw.download.url : '',
          }
        : null,
  }

  // 本机不落后就不提示。清单版本更低（用户装了更新的版本）同样按「已是最新」处理
  if (compareVersions(latest, currentVersion) <= 0) {
    return { ...base, state: 'latest' }
  }

  const notes = raw.notes && typeof raw.notes === 'object' ? raw.notes : {}

  return {
    ...base,
    state: 'update',
    highlight: typeof notes.highlight === 'string' ? notes.highlight.trim() : '',
    upgradeHint: typeof notes.upgradeHint === 'string' ? notes.upgradeHint.trim() : '',
    releaseTitle: release.title,
    notes: release.items,
  }
}
