/**
 * 语义自检运行器：rolldown 打包 tools/unit-check.ts 后用 node 执行。
 * 直接跑 .ts 需要实验开关，打包一步反而更接近真实构建路径。
 */
import { rolldown } from 'rolldown'
import { writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const outFile = path.join(repoRoot, '.workbuddy', 'unit-check.mjs')

const bundle = await rolldown({
  input: path.join(repoRoot, 'tools', 'unit-check.ts'),
  resolve: { alias: { '@': path.join(repoRoot, 'src') } },
})

const { output } = await bundle.generate({ format: 'esm' })
await writeFile(outFile, output[0].code)

const run = spawnSync(process.execPath, [outFile], { stdio: 'inherit' })
await rm(outFile, { force: true })
process.exit(run.status ?? 1)
