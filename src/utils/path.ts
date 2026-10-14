/**
 * 路径处理。
 *
 * 渲染进程拿到的路径全部来自主进程（`pathForFile` / `dialog.pickAudio`），
 * 一律是 Windows 绝对路径。这里不引入 node:path —— 渲染进程开了
 * contextIsolation，本来就拿不到 Node；而且浏览器预览模式下也得能跑。
 * 因此只做最小必要的事情：按两种分隔符切分。
 */

/** 取所在目录。没有分隔符时返回空串 */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  // i === 0 说明是 "\foo" 这种根目录形式，目录部分应当是 "\"
  return i < 0 ? '' : p.slice(0, i)
}

/** 取文件名（含扩展名） */
export function nameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i < 0 ? p : p.slice(i + 1)
}

/** 取扩展名，小写，不含点 */
export function extOfPath(p: string): string {
  const name = nameOf(p)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 去掉扩展名的文件名 */
export function stemOf(p: string): string {
  const name = nameOf(p)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/** 拼接目录与文件名，沿用目录自身的分隔符风格 */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const useBackslash = dir.includes('\\') || /^[A-Za-z]:/.test(dir)
  const sep = useBackslash ? '\\' : '/'
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sep + name
}
