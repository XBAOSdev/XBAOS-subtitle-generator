/** 时间码与格式化工具 */

const pad = (n: number, len = 2): string => String(Math.floor(n)).padStart(len, '0')

/**
 * 秒 → 标准时间码
 * @param sec 秒
 * @param msSeparator 毫秒分隔符，SRT 用逗号，VTT 用点
 */
export function toTimecode(sec: number, msSeparator = ','): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0
  const totalMs = Math.round(safe * 1000)
  const h = Math.floor(totalMs / 3_600_000)
  const m = Math.floor((totalMs % 3_600_000) / 60_000)
  const s = Math.floor((totalMs % 60_000) / 1000)
  const ms = totalMs % 1000
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}${pad(ms, 3)}`
}

/** 秒 → 列表里用的紧凑时间码 01:23.400（不显示小时） */
export function toShortTimecode(sec: number): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0
  const totalMs = Math.round(safe * 1000)
  const m = Math.floor(totalMs / 60_000)
  const s = Math.floor((totalMs % 60_000) / 1000)
  const ms = totalMs % 1000
  return `${pad(m)}:${pad(s)}.${pad(ms, 3)}`
}

/**
 * 时间码字符串 → 秒。
 * 兼容 00:00:01,200 / 00:00:01.200 / 01:02.5 / 12.34
 * 返回 null 表示无法解析。
 */
export function parseTimecode(input: string): number | null {
  const raw = input.trim()
  if (!raw) return null

  const normalized = raw.replace(',', '.')
  const parts = normalized.split(':')
  if (parts.length > 3) return null

  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d*\.?\d*$/.test(part) || part === '' || part === '.') return null
    nums.push(Number(part))
  }
  if (nums.some((n) => Number.isNaN(n))) return null

  let seconds = 0
  for (const n of nums) seconds = seconds * 60 + n
  return seconds
}

/** 解析相对调整表达式，如 +0.5 / -0.3。返回偏移秒数或 null */
export function parseRelativeOffset(input: string): number | null {
  const raw = input.trim()
  if (!/^[+-]\d*\.?\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** 秒 → 人类可读时长。12:34 或 1:02:03 */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--'
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 秒 → 带小数秒的时长，用于需要更精确的场景。00:02.500 */
export function formatDurationPrecise(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${pad(m)}:${pad(Math.floor(s), 2)}.${pad(Math.round((s % 1) * 1000), 3)}`
}

/** 字节数 → 可读大小 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** i
  const digits = i === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[i]}`
}

/** 秒 → 估算耗时文本，如 约 6 分钟 */
export function formatEstimate(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '即将完成'
  if (sec < 60) return `约 ${Math.ceil(sec)} 秒`
  const min = Math.ceil(sec / 60)
  if (min < 60) return `约 ${min} 分钟`
  const h = Math.floor(min / 60)
  const rest = min % 60
  return rest === 0 ? `约 ${h} 小时` : `约 ${h} 小时 ${rest} 分钟`
}

/** 数字千分位 */
export function formatNumber(n: number): string {
  return n.toLocaleString('zh-CN')
}
