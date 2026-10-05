#!/usr/bin/env node
/**
 * 主变「试验→告警→投运」链路的 Node 验证脚本：
 *   node scripts/run-chain-tests.mjs
 *
 * src 是 TS + @ 路径别名，用仓库里已有的 esbuild 临时打包成 ESM 后在 Node 执行。
 * 覆盖：存量迁移回填、纸质报告缺项、提交落库与刷新重读、按试验时间覆盖、
 * 告警撤销门槛与留痕、投运门槛、可用容量回写两处一致、待办闭环、
 * 原有编号不重排、瞬时超时重试一次、持续失败给原因、导出与页面对齐。
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'node_modules/.cache/chain-tests')
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
const bundle = path.join(outDir, 'bundle.mjs')

await build({
  entryPoints: [path.join(root, 'scripts/chain-test-body.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundle,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'silent',
})
await import(pathToFileURL(bundle).href)
