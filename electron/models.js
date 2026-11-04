/**
 * 模型发现、架构判定与选用。
 *
 * 上一版只认「模型目录里一个 .bin 文件」，改成多引擎之后有两类模型：
 *   文件型  models/ggml-small.bin                    → whisper（GGML）
 *   目录型  models/sensevoice-small/                 → sherpa-onnx（ONNX）
 *             ├─ model.int8.onnx
 *             └─ tokens.txt
 *
 * 用户往目录里丢什么，就得按内容判断该用哪套引擎 —— 不能只凭后缀。
 * 判定结果按「文件指纹」缓存：用户没换模型、文件没变，就不重复检查。
 *
 * 只读不写。下载落盘在 model-download.js，路径规则在 paths.js。
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  ARCH_WHISPER,
  ARCH_SHERPA,
  FALLBACK_ORDER,
  findCatalog,
  findCatalogByDiskId,
} from './model-catalog.js'
import { modelSearchDirs } from './paths.js'

/** SenseVoice 的 tokens.txt 里有语言/情绪/事件标记，是它最稳的指纹 */
const SENSEVOICE_MARK = '<|nospeech|>'

/** sherpa-onnx 引擎认这两个文件名，别的名字它不会找，所以这里也只认这两个 */
const ONNX_NAMES = ['model.int8.onnx', 'model.onnx']

/**
 * 架构判定缓存：目录/文件路径 → { sig, arch, variant }
 *
 * `sig` 是「这堆文件还是原来那堆」的指纹。用户在资源管理器里换了模型，
 * 指纹变了就重判；否则直接命中缓存 —— 这就是「不每次都检查一遍」。
 */
const archCache = new Map()

function statSig(full) {
  try {
    const st = fs.statSync(full)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return ''
  }
}

/**
 * 读文件尾部若干字节。
 *
 * 为什么读尾巴：SenseVoice 的语言/情绪/事件标记（`<|zh|>` `<|nospeech|>` …）
 * 全部排在 tokens.txt 的**最后几行** —— 文件 315KB，`<|nospeech|>` 在
 * 314469 字节处，读前 4KB 永远读不到。词表正文几千行，只有尾巴有指纹。
 */
function readTail(full, bytes = 16384) {
  try {
    const st = fs.statSync(full)
    const start = Math.max(0, st.size - bytes)
    const fd = fs.openSync(full, 'r')
    const buf = Buffer.alloc(Math.min(bytes, st.size))
    const n = fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * 判定一个目录型模型的架构与变体。
 *
 * 目前只有 SenseVoice 一套 ONNX 权重能跑（引擎的 model_type 写死 sense_voice），
 * 所以认不出指纹的目录要标出来：界面变灰、说明「不支持」，而不是让用户
 * 点了「使用」再收到一句引擎报错。
 *
 * @returns {{arch: string, variant: 'sensevoice'|'unknown', onnx?: string} | null}
 */
function inspectDirModel(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }

  const onnx = ONNX_NAMES.find((n) => entries.includes(n))
  const hasTokens = entries.includes('tokens.txt')
  if (!onnx || !hasTokens) return null

  const onnxPath = path.join(dir, onnx)
  const tokensPath = path.join(dir, 'tokens.txt')
  const sig = `${onnx}:${statSig(onnxPath)}|${statSig(tokensPath)}`

  const cached = archCache.get(dir)
  if (cached && cached.sig === sig) return cached.value

  const variant = readTail(tokensPath).includes(SENSEVOICE_MARK) ? 'sensevoice' : 'unknown'
  const value = { arch: ARCH_SHERPA, variant, onnx }
  archCache.set(dir, { sig, value })
  return value
}

/** 文件型模型：只认 .bin，架构是 whisper（ggml） */
function inspectFileModel(file) {
  if (!file.toLowerCase().endsWith('.bin')) return null
  return { arch: ARCH_WHISPER, variant: 'ggml' }
}

function dirSize(dir, names) {
  let total = 0
  for (const name of names) {
    try {
      total += fs.statSync(path.join(dir, name)).size
    } catch {
      /* 读不到就按 0 算，列表不该因为一个坏文件整份失败 */
    }
  }
  return total
}

function fileSize(full) {
  try {
    return fs.statSync(full).size
  } catch {
    return 0
  }
}

/**
 * 磁盘标识 → 内置清单的逻辑短名，认不出就是用户自己的模型。
 *
 * 必须按 `id`（磁盘名）查，不能按 `key`（`small`）查：两者不是一回事，
 * 用 key 比对文件名会永远落空，内置条目就会在「自己的模型」里重复出现。
 */
function catalogKeyOf(id) {
  return findCatalogByDiskId(id)?.key ?? ''
}

/**
 * 列出所有能找到的模型，按查找目录的优先级去重。
 *
 * 同一个标识只保留优先级最高的那一份 —— 否则「用户目录还有一份同样的模型」
 * 会在界面上显示成两条一模一样的记录。
 *
 * @returns {Array<{id, name, kind, arch, variant, path, dir, source, size, builtin, catalogKey}>}
 */
export function listModels(ctx) {
  const found = new Map()

  for (const { dir, source } of modelSearchDirs(ctx)) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 目录不存在或没权限，跳过
    }

    for (const dirent of entries) {
      const id = dirent.name
      if (found.has(id)) continue

      const full = path.join(dir, id)

      if (dirent.isFile()) {
        const info = inspectFileModel(id)
        if (!info) continue
        found.set(id, {
          id,
          name: id.replace(/\.bin$/i, ''),
          kind: 'file',
          arch: info.arch,
          variant: info.variant,
          path: full,
          dir,
          source,
          size: fileSize(full),
          builtin: !!catalogKeyOf(id),
          catalogKey: catalogKeyOf(id),
        })
        continue
      }

      if (!dirent.isDirectory()) continue
      const info = inspectDirModel(full)
      if (!info) continue

      found.set(id, {
        id,
        name: id,
        kind: 'dir',
        arch: info.arch,
        variant: info.variant,
        path: full,
        dir,
        source,
        size: dirSize(full, fs.readdirSync(full)),
        builtin: !!catalogKeyOf(id),
        catalogKey: catalogKeyOf(id),
      })
    }
  }

  return [...found.values()]
}

/** 按标识找一个模型；绝对路径也接受（高级用户手动指定） */
export function findModelById(id, ctx) {
  if (!id) return null
  if (path.isAbsolute(id)) {
    let dirent = null
    try {
      dirent = fs.statSync(id)
    } catch {
      return null
    }
    if (dirent.isDirectory()) {
      const info = inspectDirModel(id)
      if (!info) return null
      return {
        id: path.basename(id),
        name: path.basename(id),
        kind: 'dir',
        arch: info.arch,
        variant: info.variant,
        path: id,
        dir: path.dirname(id),
        source: 'absolute',
        size: dirSize(id, fs.readdirSync(id)),
        builtin: false,
        catalogKey: '',
      }
    }
    const info = inspectFileModel(id)
    if (!info) return null
    return {
      id: path.basename(id),
      name: path.basename(id).replace(/\.bin$/i, ''),
      kind: 'file',
      arch: info.arch,
      variant: info.variant,
      path: id,
      dir: path.dirname(id),
      source: 'absolute',
      size: dirent.size,
      builtin: false,
      catalogKey: '',
    }
  }

  return listModels(ctx).find((m) => m.id === id) ?? null
}

/**
 * 从磁盘上已有的模型里挑一个兜底。
 *
 * 顺序见 model-catalog.js 的 FALLBACK_ORDER：能力优先，SenseVoice 在首位。
 * 只在「用户从未选过模型」时生效；显式选过谁就用谁。
 */
export function pickModel(ctx) {
  const installed = listModels(ctx)
  if (installed.length === 0) return null

  for (const key of FALLBACK_ORDER) {
    const catalog = findCatalog(key)
    if (!catalog) continue
    const hit = installed.find((m) => m.id === catalog.id)
    if (hit) return hit
  }
  // 一个内置条目都没装：用户自己放的模型里挑第一个能跑的
  return installed.find((m) => m.arch === ARCH_SHERPA) ?? installed[0]
}

/**
 * 解析「这次到底用哪个模型」。
 *
 * @param {string} requested 用户选过的标识，空串表示没选过
 * @returns {{entry: object, fellBack: boolean} | null}
 */
export function resolveModel(requested, ctx) {
  if (requested) {
    const hit = findModelById(requested, ctx)
    if (hit) return { entry: hit, fellBack: false }
  }
  const fallback = pickModel(ctx)
  return fallback ? { entry: fallback, fellBack: !!requested } : null
}

/** 缓存清理。换模型目录、删模型之后调一次，别让旧指纹赖着 */
export function clearArchCache() {
  archCache.clear()
}
