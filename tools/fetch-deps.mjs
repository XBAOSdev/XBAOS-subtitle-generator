/**
 * 扫描 CMake 的 FetchContent 声明，把 github 依赖换成 codeload 直连下载。
 *
 * 为什么需要它：sherpa-onnx 的依赖链是级联的（sherpa → kaldi-decoder →
 * kaldifst → …），只有下载上一层之后才看得到下一层。手工一个个补太慢，
 * 而且 github.com 主域在本机不通、只有 codeload 子域可用 —— 每次都要换域名。
 *
 * 用法：node fetch-deps.mjs <项目根目录>
 * 产物落在 <项目根目录> 下，文件名按 FetchContent 的 possible_file_locations 推断。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(process.argv[2] ?? 'engine-onnx')
const depsDir = path.join(root, 'build', '_deps')

if (!fs.existsSync(depsDir)) {
  console.log('没有 build/_deps，先跑一次 cmake 配置')
  process.exit(0)
}

/** 递归收集所有 cmake 文件 */
function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(cmake|txt)$/i.test(e.name)) out.push(full)
  }
  return out
}

/**
 * 把 github 归档地址映射成 codeload 地址。
 *
 * 注意 `name` 只是**按 tag 推出的候选名**，不一定就是 FetchContent 想找的那个：
 * 上游 tag 常带 `v` 前缀（`v1.8.0`），而 `possible_file_locations` 里写的文件名
 * 往往不带（`kaldifst-1.8.0.tar.gz`）。真正落盘的名字由 expectedName() 从
 * cmake 原文里取 —— 早先直接用 `name` 判断「这个文件被需要吗」，
 * kaldifst 与 kaldi-decoder 就是这么被整包漏掉的。
 *
 * @returns {{url: string, name: string, repo: string} | null}
 */
function toCodeload(url) {
  // https://github.com/owner/repo/archive/refs/tags/v1.8.0.tar.gz
  let m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/refs\/tags\/(.+)\.(tar\.gz|zip)$/)
  if (m) {
    const [, owner, repo, tag, ext] = m
    return {
      url: `https://codeload.github.com/${owner}/${repo}/${ext === 'zip' ? 'zip' : 'tar.gz'}/refs/tags/${tag}`,
      name: `${repo}-${tag}.${ext}`,
      repo,
    }
  }
  // https://github.com/owner/repo/archive/<sha>.zip
  m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/([0-9a-f]{7,40})\.(tar\.gz|zip)$/)
  if (m) {
    const [, owner, repo, sha, ext] = m
    return {
      url: `https://codeload.github.com/${owner}/${repo}/${ext === 'zip' ? 'zip' : 'tar.gz'}/${sha}`,
      name: `${repo}-${sha}.${ext}`,
      repo,
    }
  }
  return null
}

/**
 * 从 cmake 原文的 `possible_file_locations` 里取出这个包**真正**的文件名。
 *
 * 优先取 `${CMAKE_SOURCE_DIR}/<文件名>` 那一行，因为 fetch-deps 的落盘位置就是
 * 项目根目录；找不到就退回该块里第一个 `<repo>-…` 形式的归档名。
 */
function expectedName(text, repo) {
  const block = text.match(/set\(\s*possible_file_locations([\s\S]*?)\)/)
  if (!block) return null
  const names = [...block[1].matchAll(/([\w.+-]+\.(?:tar\.gz|tgz|zip|tar\.bz2))/g)].map((m) => m[1])
  if (names.length === 0) return null
  if (text.includes(`\${CMAKE_SOURCE_DIR}/${repo}-`)) {
    const forSourceDir = names.find((n) => n.startsWith(`${repo}-`))
    if (forSourceDir) return forSourceDir
  }
  return names.find((n) => n.startsWith(`${repo}-`)) ?? null
}

const files = walk(depsDir)
const jobs = new Map()

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  // 同一个文件里，URL 变量名与 possible_file_locations 的文件名前缀能对上
  const urlRe = /set\(\s*([\w-]+)_URL\s+"(https:\/\/github\.com\/[^"]+)"\s*\)/g
  let hit
  while ((hit = urlRe.exec(text)) !== null) {
    const mapped = toCodeload(hit[2])
    if (!mapped) continue
    // 落盘名以 cmake 原文为准；推不出就退回按 tag 拼的那个
    const name = expectedName(text, mapped.repo) ?? mapped.name
    // 只有这个文件确实把该文件名列为候选时才需要（否则说明走的是别的分支）
    if (!text.includes(name)) continue
    jobs.set(name, mapped.url)
  }
}

if (jobs.size === 0) {
  console.log('本次扫描没有发现需要补的 github 依赖')
  process.exit(0)
}

let failed = 0
for (const [name, url] of jobs) {
  const target = path.join(root, name)
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
    console.log(`已存在  ${name}`)
    continue
  }
  process.stdout.write(`下载中  ${name} … `)
  try {
    execFileSync('curl', ['-sL', '--noproxy', '*', '--max-time', '300', '-o', target, url], {
      stdio: 'ignore',
    })
    const size = fs.statSync(target).size
    console.log(`${(size / 1024 / 1024).toFixed(1)} MB`)
  } catch {
    console.log('失败')
    failed++
  }
}

process.exit(failed === 0 ? 0 : 1)
