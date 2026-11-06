/**
 * 项目文件（`.xbsgp`）的磁盘操作。
 *
 * 从 `main.js` 里单独拆出来只有一个理由：**能测**。写盘这件事有三条必须同时
 * 成立的性质（不覆盖别人的工程、不留半截文件、改名前后文件名与内容一致），
 * 而它们全都只在出现异常时才暴露 —— 靠手点根本覆盖不到。
 *
 * 这里只管字节，不关心 JSON 里是什么。
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

export const PROJECT_EXT = 'xbsgp'

/** 后缀补齐：用户在对话框里删掉 `.xbsgp` 也要能存成项目文件 */
export function withProjectExt(p) {
  if (!p) return p
  return p.toLowerCase().endsWith(`.${PROJECT_EXT}`) ? p : `${p}.${PROJECT_EXT}`
}

/**
 * 写项目文件。
 *
 * 三件事必须一起做，少一件就会在断电或异常退出时留下半截文件：
 *   1. 先写临时文件并 fsync —— 内容真正落到盘上；
 *   2. 覆盖已有文件前，把它复制成 `.xbsgp.bak`；
 *   3. rename 覆盖 —— 同一分区上是原子的，读到的要么是旧文件、要么是新文件。
 *
 * `allowOverwrite` 为 false 时目标已存在直接拒绝：这是「另存为」与「保存到
 * 自己的路径」的唯一区别，判定放在主进程以避开「渲染进程判完、写盘之间又被
 * 建了一个同名文件」的时隙。
 */
export async function writeProjectFile(target, content, allowOverwrite) {
  if (!target) return { ok: false, code: 'io', message: '没有指定保存位置' }
  const tmp = `${target}.tmp-${process.pid}`
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (!allowOverwrite && existsSync(target)) {
      return { ok: false, code: 'exists', message: '该目录已有同名项目，请换个名字' }
    }
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (existsSync(target)) {
      // 备份失败不拦保存：备份是保险，不是前置条件
      try {
        await fs.copyFile(target, `${target}.bak`)
      } catch {
        /* 忽略 */
      }
    }
    await fs.rename(tmp, target)
    return { ok: true, path: target }
  } catch (err) {
    try {
      await fs.unlink(tmp)
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    return { ok: false, code: 'io', message: err.message }
  }
}

/**
 * 重命名项目文件。
 *
 * 必须是真的 `rename` 而不是「另存一份再删旧的」：后者中间有一瞬间磁盘上
 * 存在两份，删失败就留下一个再也认不出来的废文件。目标已存在时直接拒绝 ——
 * 覆盖别人的工程文件是不可接受的。
 */
export async function renameProjectFile(from, to) {
  try {
    if (existsSync(to)) {
      return { ok: false, code: 'exists', message: '该目录已有同名项目' }
    }
    await fs.rename(from, to)
    return { ok: true, path: to }
  } catch (err) {
    return { ok: false, code: 'io', message: err.message }
  }
}
