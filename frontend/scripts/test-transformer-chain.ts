// 主链路：试验落库、越限阻断、先撤告警再投运、容量回写、覆盖语义、两入口一致、导出口径、刷新不回退。
import { check, installMemoryStorage, passedCount } from './helpers.ts'

async function main() {
  installMemoryStorage()
  const store = await import('../src/data/local-store.ts')
  const service = await import('../src/api/transformer-service.ts')
  const localService = await import('../src/api/local-service.ts')

  store.resetAll()

  // 1. 提交合格试验：结论/日期/试验人一次落库，转运行中，容量回写发电计划。
  let r = service.submitTest(1, {
    油温: '60', 绕组温度: '66', 油位: '正常', 瓦斯保护: '正常投运',
    试验日期: '2026-10-05', 试验人: '陈试验', 试验结论: '合格',
  })
  check('1 提交合格试验成功', r.ok, r.message)
  let t1 = service.getTransformer(1)!
  check('1 结论/试验人/日期已落库', t1['试验结论'] === '合格' && t1['试验人'] === '陈试验' && t1['试验日期'] === '2026-10-05')
  check('1 状态转运行中', String(t1.status) === '运行中')
  check('1 投运日期写入', t1['投运日期'] === '2026-10-05')
  const genRows = store.listRows('generation')
  check('1 发电计划可用台数回写为3', genRows.every((g: any) => g['可用主变台数'] === 3))
  check('1 发电计划可用容量回写为330', genRows.every((g: any) => g['可用主变容量'] === 330))

  // 2. 模拟刷新页面：清缓存重读 localStorage，仍是同一份，不退回待试验。
  store.__resetCacheForTest()
  t1 = service.getTransformer(1)!
  check('2 刷新后重读仍为运行中', String(t1.status) === '运行中')
  check('2 刷新后结论与试验人仍在', t1['试验结论'] === '合格' && t1['试验人'] === '陈试验')

  // 3. 油温越限(>85)或瓦斯异常：不允许出合格结论，台账不被写脏。
  r = service.submitTest(2, {
    油温: '91', 绕组温度: '95', 油位: '正常', 瓦斯保护: '正常投运',
    试验日期: '2026-10-05', 试验人: '陈试验', 试验结论: '合格',
  })
  check('3 油温91℃禁止合格结论', !r.ok && r.message.includes('85'))
  check('3 台账保持运行中', String(service.getTransformer(2)!.status) === '运行中')
  r = service.submitTest(2, {
    油温: '60', 绕组温度: '70', 油位: '正常', 瓦斯保护: '动作',
    试验日期: '2026-10-05', 试验人: '陈试验', 试验结论: '合格',
  })
  check('3b 瓦斯保护动作禁止合格结论', !r.ok && r.message.includes('瓦斯'))

  // 4. 发布告警：告警态、容量扣减、告警痕迹、消缺待办同生。
  r = service.publishAlarm(2, { 告警类型: '油温越限', 发布原因: '油温升高', 发布人: '值班甲' })
  check('4 发布告警成功', r.ok, r.message)
  check('4 主变转告警', String(service.getTransformer(2)!.status) === '告警')
  check('4 容量扣减为210(剩余2台)', service.transformerAvailability().可用容量 === 210)
  check('4 有效告警存在', service.activeAlarms(2).length === 1)
  const todoOpen = service.listSpareTodos().find((x: any) => x.transformerId === 2 && x.状态 === '待处理')
  check('4 消缺待办已生成', !!todoOpen && todoOpen.事项.includes('冷却'))

  // 5. 有有效告警时：复测合格结论照落库，但不允许投运，提示先撤告警。
  r = service.submitTest(2, {
    油温: '70', 绕组温度: '72', 油位: '正常', 瓦斯保护: '正常投运',
    试验日期: '2026-10-06', 试验人: '陈试验', 试验结论: '合格',
  })
  check('5 有告警时结论落库但不投运', r.ok && r.message.includes('撤销告警'))
  check('5 状态仍为告警', String(service.getTransformer(2)!.status) === '告警')
  check('5 容量未虚增仍210', service.transformerAvailability().可用容量 === 210)

  // 6. 撤销告警：自动投运、告警留痕为已撤销、待办关闭留痕、容量恢复。
  r = service.revokeAlarm(2, { 撤销原因: '复测恢复正常', 撤销人: '值班乙' })
  check('6 撤销告警成功', r.ok, r.message)
  check('6 自动转回运行中', String(service.getTransformer(2)!.status) === '运行中')
  const alarm2 = service.listTransformerAlarms().find((a: any) => a.transformerId === 2)!
  check('6 告警痕迹保留且为已撤销', alarm2.状态 === '已撤销' && alarm2.撤销人 === '值班乙' && !!alarm2.撤销时间)
  const todo2 = service.listSpareTodos().find((x: any) => x.transformerId === 2)
  check('6 待办关闭并留痕', todo2.状态 === '已关闭' && !!todo2.关闭时间 && todo2.关闭原因.includes('复测合格'))
  check('6 容量恢复330', service.transformerAvailability().可用容量 === 330)

  // 7. 读数仍越限时禁止撤销；必须复测恢复 -> 再撤 -> 再投运。
  service.publishAlarm(3, { 告警类型: '油温越限', 发布原因: '92℃越限', 发布人: '甲' })
  r = service.revokeAlarm(3, { 撤销原因: '想先撤再说', 撤销人: '乙' })
  check('7 油温仍92℃禁止撤销', !r.ok && r.message.includes('不能撤销'))
  r = service.submitTest(3, {
    油温: '70', 绕组温度: '72', 油位: '正常', 瓦斯保护: '正常投运',
    试验日期: '2026-10-06', 试验人: '陈试验', 试验结论: '合格',
  })
  check('7 复测合格先落库(仍告警态)', r.ok && String(service.getTransformer(3)!.status) === '告警')
  r = service.revokeAlarm(3, { 撤销原因: '复测正常，缺陷消除', 撤销人: '乙' })
  check('7 恢复后撤销并自动投运', r.ok && String(service.getTransformer(3)!.status) === '运行中')
  check('7 四台运行容量510', service.transformerAvailability().可用容量 === 510)
  check('7 发电计划同步为4台/510', store.listRows('generation').every((g: any) => g['可用主变台数'] === 4 && g['可用主变容量'] === 510))

  // 8. 同一台主变重复提交：按试验时间覆盖，不叠加；不合格时待办也只有一份。
  service.publishAlarm(3, { 告警类型: '瓦斯保护', 发布原因: '信号异常', 发布人: '甲' })
  const todoCountBefore = service.listSpareTodos().filter((x: any) => x.transformerId === 3 && x.状态 === '待处理').length
  service.submitTest(3, {
    油温: '88', 绕组温度: '90', 油位: '正常', 瓦斯保护: '正常投运',
    试验日期: '2026-10-07', 试验人: '复测员甲', 试验结论: '不合格',
  })
  service.submitTest(3, {
    油温: '89', 绕组温度: '91', 油位: '偏高', 瓦斯保护: '正常投运',
    试验日期: '2026-10-08', 试验人: '复测员乙', 试验结论: '不合格',
  })
  const t3 = service.getTransformer(3)!
  check('8 台账只保留最后一次(复测员乙/08日/89℃)', t3['试验人'] === '复测员乙' && t3['试验日期'] === '2026-10-08' && String(t3['油温']) === '89')
  const todoCountAfter = service.listSpareTodos().filter((x: any) => x.transformerId === 3 && x.状态 === '待处理').length
  check('8 待办覆盖不叠加(仍1条)', todoCountBefore === 1 && todoCountAfter === 1)

  // 9. 两个入口读到同一份（主变页与备件页都调同一个 listSpareTodos）。
  const viaTransformerPage = service.listSpareTodos()
  const viaSparePage = service.listSpareTodos()
  check('9 两入口待办同一份同顺序', JSON.stringify(viaTransformerPage) === JSON.stringify(viaSparePage))

  // 10. 导出明细与页面台账一致：表头+4行，且最新结论/试验人出现在导出中。
  const exported = localService.exportEntries('transformer')
  const lines = exported.content.split('\n')
  check('10 导出行数=表头+4台', lines.length === 5, lines.length.toString())
  check('10 导出台行含最新结论与试验人', lines.some((l: string) => l.includes('复测员乙') && l.includes('不合格')))
  check('10 导出行含纸质回填试验人', lines.some((l: string) => l.includes('纸质报告未署名')))
  const genExport = localService.exportEntries('generation').content
  const genLive = store.listRows('generation')
  const genDataLines = genExport.split('\n').slice(1)
  check(
    '10 发电计划导出值与实时台账逐行一致',
    genLive.every((g: any, i: number) => genDataLines[i].includes(String(g['可用主变台数'])) && genDataLines[i].includes(String(g['可用主变容量']))),
  )

  // 11. 停运检修：容量扣减，再投运需重新提交合格试验。此时 id3 仍在第8步的瓦斯告警中，运行的是 id1/2/4（120+120+90=330）。
  check('11 停运前可用容量330', service.transformerAvailability().可用容量 === 330)
  r = service.takeOutOfService(4, '年度检修')
  check('11 停运成功', r.ok)
  check('11 容量扣减为240(剩id1/id2两台)', service.transformerAvailability().可用容量 === 240)
  r = service.submitTest(4, {
    油温: '55', 绕组温度: '60', 油位: '正常', 瓦斯保护: '正常投运',
    试验日期: '2026-10-09', 试验人: '检修后复测', 试验结论: '合格',
  })
  check('11 重新试验合格恢复投运', r.ok && String(service.getTransformer(4)!.status) === '运行中')
  check('11 容量恢复330', service.transformerAvailability().可用容量 === 330)

  console.log(`\n核心链路 ${passedCount()} 项断言全部通过`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
