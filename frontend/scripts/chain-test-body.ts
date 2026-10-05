/**
 * 链路验证用例（被 run-chain-tests.mjs 打包后在 Node 执行，非生产代码）。
 */

// Node 环境下的 localStorage 垫片：让数据层与页面走同一套持久化路径。
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}
;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage

import { SEED_ROWS } from '@/data/seed'
import { reloadStore, storageKey as getEntriesKey } from '@/data/local-store'
import {
  CHAIN_STORAGE_KEY,
  __clearCachedChain,
  __resetChain,
  __setTransportDelay,
  __setTransportFault,
} from '@/data/chain/chain-store'
import {
  closeSpareTodo,
  energizeTransformer,
  getAlarms,
  getAvailableSummary,
  getChain,
  getLatestTests,
  getSpareTodos,
  getTransformers,
  initChain,
  publishAlarm,
  revokeAlarm,
  shutdownTransformer,
  submitTest,
} from '@/data/chain/chain-service'
import { PAPER_TECHNICIAN, migrateChain } from '@/data/chain/migrate'
import { evaluateReadings, parseCapacityMva, parseNumber } from '@/data/chain/limits'
import { exportAlarms, exportSpareTodos, exportTransformers } from '@/data/chain/chain-export'

type TestFn = () => Promise<void> | void
const tests: { name: string; fn: TestFn }[] = []
function test(name: string, fn: TestFn) {
  tests.push({ name, fn })
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
function resetWorld() {
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(getEntriesKey(), JSON.stringify(SEED_ROWS))
  reloadStore()
  __resetChain()
  __setTransportFault('none')
}
__setTransportDelay(0)

// ---------- 纯函数：越限判定与容量解析 ----------
test('越限口径：油温/绕组温度/油位/瓦斯保护', () => {
  assert(evaluateReadings({ 油温: '85℃', 绕组温度: '100℃', 油位: '正常', 瓦斯保护: '正常投入' }).exceededLabels.join('；').includes('油温'), '85℃ 应判油温越限')
  assert(evaluateReadings({ 油温: '84℃', 绕组温度: '106℃', 油位: '正常', 瓦斯保护: '正常' }).exceededLabels.join('；').includes('绕组温度'), '106℃ 应判绕组越限')
  assert(evaluateReadings({ 油温: '60℃', 绕组温度: '70℃', 油位: '偏低', 瓦斯保护: '正常' }).exceededLabels.join('；').includes('油位'), '油位偏低应越限')
  assert(evaluateReadings({ 油温: '60℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '轻瓦斯动作' }).exceededLabels.join('；').includes('瓦斯'), '轻瓦斯动作应越限')
  assert(evaluateReadings({ 油温: '60℃', 绕组温度: '70℃', 油位: '正常范围内', 瓦斯保护: '投入无动作' }).exceededLabels.length === 0, '正常读数不应越限')
  assert(parseNumber('63MVA') === 63, '数值解析失败')
  assert(parseCapacityMva('50000kVA') === 50, 'kVA 应换算成 MVA')
  assert(parseCapacityMva('40MVA/35kV') === 40, 'MVA 解析失败')
})

// ---------- 存量迁移 ----------
test('迁移：原有编号与既有结论保留，不重排', () => {
  resetWorld()
  const legacy = JSON.parse(JSON.stringify(SEED_ROWS))
  // 模拟存量行里已经录过试验结论：迁移必须沿用，不重新判定覆盖。
  legacy.transformer[1]['试验结论'] = '合格'
  legacy.transformer[1]['试验人'] = '李工'
  const state = migrateChain({ transformer: legacy.transformer, spare: legacy.spare }, '2026-10-01')
  assert(state.transformers.map((item) => item.id).join(',') === '1,2,3', '主变 id 必须保持 1,2,3')
  assert(state.transformers[1].变压器编号 === 'TRAN-0002', '变压器编号不能被重排')
  const t2 = state.tests.find((item) => item.transformerId === 2)!
  assert(t2.试验结论 === '合格' && t2.试验人 === '李工', '既有试验结论/试验人必须原样保留')
  assert(t2.结论来源 === '电子台账迁移', '有试验人的存量记录来源应为电子台账迁移')
})

test('迁移：存量试验按试验日期回填，纸质报告无试验人时补齐并标注', () => {
  resetWorld()
  const state = migrateChain({ transformer: SEED_ROWS.transformer, spare: SEED_ROWS.spare }, '2026-10-01')
  // TRAN-0001 没有试验日期，不生成试验记录；0002/0003 按试验日期回填
  assert(!state.tests.some((item) => item.transformerId === 1), '无试验日期不应回填试验记录')
  const paper = state.tests.filter((item) => item.试验人 === PAPER_TECHNICIAN)
  assert(paper.length === 2, '两份纸质报告都应补成未署名')
  assert(paper.every((item) => item.结论来源.includes('试验人缺项')), '纸质报告必须标注试验人缺项')
  assert(state.tests.find((item) => item.transformerId === 3)!.试验结论 === '不合格', 'TRAN-0003 读数越限应回填不合格')
  assert(state.tests.find((item) => item.transformerId === 2)!.试验结论 === '合格', 'TRAN-0002 读数正常应回填合格')
})

test('迁移：告警态补建未解除告警，发布信息缺项要标注来源', () => {
  resetWorld()
  const state = migrateChain({ transformer: SEED_ROWS.transformer, spare: SEED_ROWS.spare }, '2026-10-01')
  assert(state.alarms.length === 1, '只有一台告警主变，只应补一条告警')
  const alarm = state.alarms[0]
  assert(alarm.状态 === '未解除' && alarm.变压器编号 === 'TRAN-0003', '存量告警必须是未解除且挂在 0003')
  assert(alarm.alarmNo === 'ALM-0001', '告警编号应从 0001 起')
  assert(alarm.来源.includes('缺项'), '没有发布人/发布时间必须标注缺项')
  assert(alarm.发布人.includes('缺项'), '发布人缺项应补占位文本')
})

test('迁移：待办按登记时间升序迁移，主变结论与待补充备件都纳入且标注缺项', () => {
  resetWorld()
  const state = migrateChain({ transformer: SEED_ROWS.transformer, spare: SEED_ROWS.spare }, '2026-10-01')
  // TRAN-0003 告警+不合格 -> 待办（登记时间 2026-08-28）；SPAR-0003 待补充（2026-08-20）
  assert(state.spareTodos.length === 2, '应迁移出两条待办')
  assert(state.spareTodos[0].来源编号 === 'SPAR-0003', '8-20 的备件待办应排在前面')
  assert(state.spareTodos[1].来源编号 === 'TRAN-0003', '8-28 的主变待办应排在后面')
  assert(state.spareTodos.every((todo) => todo.id > 0 && todo.todoNo.startsWith('TODO-')), '待办数字主键连续且业务编号稳定')
  assert(state.spareTodos[1].事项.includes('TRAN-0003'), '主变待办事项要点名主变')
})

// ---------- 初始化、刷新重读 ----------
test('初始化迁移落库；重新进入页面读到同一份，不退回待试验', async () => {
  resetWorld()
  let result = await initChain()
  assert(result.ok, `初始化应成功：${result.message}`)
  const stored = JSON.parse(globalThis.localStorage.getItem(CHAIN_STORAGE_KEY)!)
  assert(stored.transformers.length === 3 && stored.tests.length === 2, '链路库应已落库')

  // 模拟刷新：清掉两份内存缓存（不动 localStorage），重新 init 必须从存储读回。
  reloadStore()
  __clearCachedChain()
  result = await initChain()
  assert(result.ok, '刷新后初始化应成功')
  assert(getTransformers().find((item) => item.id === 3)!.status === '告警', '告警主变刷新后仍是告警，不退回待试验')
  assert(getLatestTests().length === 2, '刷新后试验结论仍是同一份')
})

// ---------- 提交试验：落库、覆盖、越限门槛 ----------
test('提交试验：结论/日期/试验人一次写入台账并落库', async () => {
  resetWorld()
  await initChain()
  const result = await submitTest({
    id: 1, 试验日期: '2026-10-02', 试验人: '王试验', 试验结论: '合格',
    油温: '55℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '正常投入',
  })
  assert(result.ok, result.message)
  assert(getTransformers().find((item) => item.id === 1)!.status === '运行中', '合格且无告警应直接运行中')
  const persisted = JSON.parse(globalThis.localStorage.getItem(CHAIN_STORAGE_KEY)!)
  const t1 = persisted.tests.find((item: { transformerId: number }) => item.transformerId === 1)
  assert(t1.试验人 === '王试验' && t1.试验日期 === '2026-10-02' && t1.试验结论 === '合格', '结论必须真落库')
  // 通用台账镜像
  const entries = JSON.parse(globalThis.localStorage.getItem(getEntriesKey())!)
  const row = entries.transformer.find((item: { id: number }) => item.id === 1)
  assert(row.试验人 === '王试验' && row.试验结论 === '合格' && row.status === '运行中', '主变通用台账必须同值镜像')
})

test('重复提交：按试验时间覆盖，只保留最后一次；更早日期被拒绝', async () => {
  resetWorld()
  await initChain()
  const okInput = { 油温: '55℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '正常投入' }
  await submitTest({ id: 1, 试验日期: '2026-10-02', 试验人: '王试验', 试验结论: '合格', ...okInput })
  const second = await submitTest({ id: 1, 试验日期: '2026-10-05', 试验人: '赵复测', 试验结论: '合格', ...okInput })
  assert(second.ok, second.message)
  const tests = getLatestTests().filter((item) => item.transformerId === 1)
  assert(tests.length === 1 && tests[0].试验日期 === '2026-10-05' && tests[0].试验人 === '赵复测', '重复提交必须只留最新一条')
  const earlier = await submitTest({ id: 1, 试验日期: '2026-10-01', 试验人: '旧报告', 试验结论: '合格', ...okInput })
  assert(!earlier.ok && earlier.message.includes('不能覆盖'), '更早试验日期不能覆盖新结论')
})

test('读数越限时不能出合格结论，也不能投运', async () => {
  resetWorld()
  await initChain()
  const rejected = await submitTest({
    id: 1, 试验日期: '2026-10-02', 试验人: '王试验', 试验结论: '合格',
    油温: '90℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '正常',
  })
  assert(!rejected.ok && rejected.message.includes('越限'), '油温越限不得合格')
  const unqualified = await submitTest({
    id: 1, 试验日期: '2026-10-02', 试验人: '王试验', 试验结论: '不合格',
    油温: '90℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '正常',
  })
  assert(unqualified.ok, unqualified.message)
  assert(getTransformers().find((item) => item.id === 1)!.status === '停运', '不合格无告警时应停运')
  const energize = await energizeTransformer({ id: 1 })
  assert(!energize.ok && energize.message.includes('越限'), '油温越限不允许投运')
})

// ---------- 告警：发布、撤销门槛、留痕 ----------
test('发布告警只追加；重复发布拒绝', async () => {
  resetWorld()
  await initChain()
  const first = await publishAlarm({ id: 2, 告警内容: '', operator: '值班员' })
  assert(first.ok, first.message)
  assert(getAlarms().filter((item) => item.transformerId === 2).length === 1, '应只追加一条')
  const duplicate = await publishAlarm({ id: 2, 告警内容: '', operator: '值班员' })
  assert(!duplicate.ok, '未解除前不能重复发布')
  assert(getTransformers().find((item) => item.id === 2)!.status === '告警', '发布后主变应为告警态')
})

test('油温/瓦斯仍越限时不允许撤销告警；合格后撤销留痕，再投运', async () => {
  resetWorld()
  await initChain() // TRAN-0003 迁移后自带未解除告警且越限
  const blocked = await revokeAlarm({ id: 3, 撤销原因: '处理好了', operator: '值班员' })
  assert(!blocked.ok && /油温|瓦斯/.test(blocked.message), '越限未消不应允许撤告警')
  const noReason = await revokeAlarm({ id: 3, 撤销原因: '  ', operator: '值班员' })
  assert(!noReason.ok, '撤销原因必填')

  // 处理缺陷后提交合格试验（此时告警仍在：结论落库但不自动投运）
  const fixed = await submitTest({
    id: 3, 试验日期: '2026-10-03', 试验人: '孙检修', 试验结论: '合格',
    油温: '64℃', 绕组温度: '80℃', 油位: '正常', 瓦斯保护: '正常投入',
  })
  assert(fixed.ok && fixed.message.includes('先撤销告警'), fixed.message)
  assert(getTransformers().find((item) => item.id === 3)!.status === '告警', '告警未撤前仍是告警态')
  const energizeBlocked = await energizeTransformer({ id: 3 })
  assert(!energizeBlocked.ok && energizeBlocked.message.includes('先撤销告警'), '必须先撤告警再投运')

  const revoked = await revokeAlarm({ id: 3, 撤销原因: '更换冷却器与瓦斯继电器，复测合格', operator: '孙检修' })
  assert(revoked.ok, revoked.message)
  assert(getTransformers().find((item) => item.id === 3)!.status === '停运', '撤告警后应停在停运，等待投运')
  const alarm = getAlarms().find((item) => item.transformerId === 3 && item.状态 === '已撤销')!
  assert(alarm && alarm.撤销时间 && alarm.撤销人 === '孙检修' && alarm.撤销原因.includes('冷却器'), '撤销必须留痕且记录不丢失')

  const running = await energizeTransformer({ id: 3, operator: '孙检修' })
  assert(running.ok, running.message)
  assert(getTransformers().find((item) => item.id === 3)!.status === '运行中', '投运后应运行中')
})

test('瓦斯保护越限是硬门槛：只把油温恢复正常仍不能撤告警', async () => {
  resetWorld()
  await initChain()
  // TRAN-0003：油温修好，但瓦斯仍动作
  await submitTest({
    id: 3, 试验日期: '2026-10-03', 试验人: '孙检修', 试验结论: '不合格',
    油温: '70℃', 绕组温度: '110℃', 油位: '偏低', 瓦斯保护: '轻瓦斯动作',
  })
  const blocked = await revokeAlarm({ id: 3, 撤销原因: '油温已处理', operator: '孙检修' })
  assert(!blocked.ok && blocked.message.includes('瓦斯'), '瓦斯保护越限时必须拦截')
})

// ---------- 回写发电计划：两处同值 ----------
test('主变状态回写发电计划：可用台数/容量与主变台账对得上', async () => {
  resetWorld()
  await initChain()
  // 初始：仅 TRAN-0002 运行中（63MVA）
  let summary = getAvailableSummary()
  assert(summary.count === 1 && summary.mva === 63, `初始可用应为 1 台 63MVA，实际 ${JSON.stringify(summary)}`)
  const entriesBefore = JSON.parse(globalThis.localStorage.getItem(getEntriesKey())!)
  assert(entriesBefore.generation.every((row: { 可用主变台数: number; 可用容量MVA: number }) =>
    row.可用主变台数 === 1 && row.可用容量MVA === 63), '每条发电计划都应写回 1/63')

  await submitTest({
    id: 1, 试验日期: '2026-10-02', 试验人: '王试验', 试验结论: '合格',
    油温: '55℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '正常投入',
  })
  summary = getAvailableSummary()
  assert(summary.count === 2 && summary.mva === 113, `TRAN-0001 投运后应为 2 台 113MVA，实际 ${JSON.stringify(summary)}`)
  const entriesAfter = JSON.parse(globalThis.localStorage.getItem(getEntriesKey())!)
  assert(entriesAfter.generation.every((row: { 可用主变台数: number; 可用容量MVA: number }) =>
    row.可用主变台数 === 2 && row.可用容量MVA === 113), '发电计划必须与主变台账同步为 2/113')

  await shutdownTransformer({ id: 2 })
  summary = getAvailableSummary()
  assert(summary.count === 1 && summary.mva === 50, '停运后应回到 1 台 50MVA')
})

// ---------- 备品备件待办 ----------
test('不合格结论落入备品备件待办；复测合格自动闭环，记录保留', async () => {
  resetWorld()
  await initChain()
  await submitTest({
    id: 1, 试验日期: '2026-10-02', 试验人: '王试验', 试验结论: '不合格',
    油温: '92℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '正常',
  })
  const open = getSpareTodos().filter((todo) => todo.transformerId === 1 && todo.状态 === '待处理')
  assert(open.length === 1 && open[0].来源 === '试验结论' && open[0].备件建议.includes('温控'), '不合格应生成主变待办')
  // 再来一次不合格：同主办待办只更新不新增
  await submitTest({
    id: 1, 试验日期: '2026-10-03', 试验人: '王试验', 试验结论: '不合格',
    油温: '93℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '正常',
  })
  assert(getSpareTodos().filter((todo) => todo.transformerId === 1 && todo.状态 === '待处理').length === 1, '同一主变待办不得叠加')
  // 复测合格：自动闭环
  await submitTest({
    id: 1, 试验日期: '2026-10-04', 试验人: '王试验', 试验结论: '合格',
    油温: '60℃', 绕组温度: '70℃', 油位: '正常', 瓦斯保护: '正常',
  })
  const closed = getSpareTodos().find((todo) => todo.transformerId === 1 && todo.状态 === '已闭环')!
  assert(closed && closed.闭环原因 === '复测合格自动闭环' && closed.闭环人 === '王试验', '复测合格应自动闭环并留痕')
})

test('待办支持手工闭环；迁移来的备件待办可在同一清单办理', async () => {
  resetWorld()
  await initChain()
  const spareTodo = getSpareTodos().find((todo) => todo.来源编号 === 'SPAR-0003')!
  assert(spareTodo, '迁移应带来 SPAR-0003 待办')
  const result = await closeSpareTodo({ todoId: spareTodo.id, operator: '库管员' })
  assert(result.ok, result.message)
  const after = getSpareTodos().find((todo) => todo.id === spareTodo.id)!
  assert(after.状态 === '已闭环' && after.闭环原因 === '手工闭环' && after.闭环人 === '库管员', '手工闭环要留痕')
})

// ---------- 传输层：重试一次 ----------
test('瞬时超时：自动重试一次后成功，且记录不重复', async () => {
  resetWorld()
  await initChain()
  __setTransportFault('transient-timeout')
  const result = await publishAlarm({ id: 2, 告警内容: '瞬时故障验证', operator: '值班员' })
  assert(result.ok, `瞬时超时重试一次后应成功：${result.message}`)
  assert(getAlarms().filter((item) => item.transformerId === 2).length === 1, '重试不得产生重复告警')
})

test('持续超时：重试一次仍失败，返回原因且数据不落库', async () => {
  resetWorld()
  await initChain()
  __setTransportFault('persistent-timeout')
  const result = await publishAlarm({ id: 2, 告警内容: '持续故障', operator: '值班员' })
  assert(!result.ok && result.message.includes('重试一次仍失败'), `应提示重试失败原因：${result.message}`)
  __setTransportFault('none')
  assert(getAlarms().filter((item) => item.transformerId === 2).length === 0, '失败提交不得落库')
  assert(getTransformers().find((item) => item.id === 2)!.status === '运行中', '失败后内存状态不应被改动')
})

test('断线：给出断线原因，不伪造成功', async () => {
  resetWorld()
  await initChain()
  __setTransportFault('offline')
  const result = await publishAlarm({ id: 2, 告警内容: '断线', operator: '值班员' })
  assert(!result.ok && result.message.includes('断线'), result.message)
  __setTransportFault('none')
})

// ---------- 导出 ----------
test('导出明细与页面台账同列同值', () => {
  resetWorld()
  const state = migrateChain({ transformer: SEED_ROWS.transformer, spare: SEED_ROWS.spare }, '2026-10-01')
  const tests = state.tests
  const ledger = exportTransformers(state.transformers, tests, '', '')
  const lines = ledger.content.replace(/^﻿/, '').split('\n')
  assert(lines.length === state.transformers.length + 1, '导出行数应等于主变数+表头')
  assert(lines[0].split(',').includes('试验人') && lines[0].split(',').includes('试验结论'), '导出列应包含试验人/结论')
  const filtered = exportTransformers(state.transformers, tests, 'TRAN-0003', '告警').content.replace(/^﻿/, '').split('\n')
  assert(filtered.length === 2 && filtered[1].includes('TRAN-0003'), '带过滤导出应与页面过滤一致')
  const alarmCsv = exportAlarms(state.alarms).content
  assert(alarmCsv.includes('ALM-0001') && alarmCsv.includes('未解除'), '告警履历导出应包含存量告警')
  const todoCsv = exportSpareTodos(state.spareTodos).content.replace(/^﻿/, '').split('\n')
  assert(todoCsv.length === state.spareTodos.length + 1, '待办导出行数应一致')
})

// ---------- 运行 ----------
let passed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
console.log(`\n${passed}/${tests.length} 用例通过`)
if (passed !== tests.length) {
  process.exit(1)
}
