// 纯逻辑测试运行器：esbuild 打包 scripts/test-*.ts 后用 node 执行，无需浏览器。
// 覆盖：主变试验→告警→撤销→投运链路、v1 存量迁移、写库单次重试。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const tests = [
  'scripts/test-transformer-chain.ts',
  'scripts/test-migration.ts',
  'scripts/test-retry.ts',
]

for (const entry of tests) {
  const out = path.join('/tmp', path.basename(entry).replace('.ts', '.mjs'))
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    alias: { '@': path.join(root, 'src') },
    logLevel: 'warning',
  })
  await import(pathToFileURL(out).href + `?v=${Date.now()}`)
  rmSync(out, { force: true })
}
