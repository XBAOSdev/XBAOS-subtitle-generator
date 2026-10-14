/** 唯一 ID 生成 */

let seq = 0

export function uid(prefix = 'id'): string {
  seq += 1
  return `${prefix}_${seq.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}
