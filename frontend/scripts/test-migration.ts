// 存量迁移验证：v1 扁平库（无试验结论/试验人/告警/待办）升级后
// - 原有编号与数组顺序不重排
// - 纸质报告无试验人统一补「纸质报告未署名」，资料来源标注
// - 运行中按试验日期回填合格结论与投运日期；告警态补一条有效告警
// - 发电计划可用台数与主变台账对齐；存量待办按登记时间排序、缺项标来源
import { check, installMemoryStorage, passedCount } from './helpers.ts'

async function main() {
  const v1 = {
    station: [], unit: [], governor: [], excitation: [],
    transformer: [
      // id42：有试验日期、无试验人 -> 纸质报告回填
      { id: 42, status: '运行中', pending: true, abnormal: false, 变压器编号: 'TRAN-0042', 容量等级: '75MVA/110kV', 油温: '60', 绕组温度: '65', 油位: '正常', 瓦斯保护: '正常投运', 试验日期: '2026-07-01', 运行状态: '运行中' },
      // id7：告警态、无试验人、油温越限 -> 补有效告警、不合格
      { id: 7, status: '告警', pending: true, abnormal: true, 变压器编号: 'TRAN-0007', 容量等级: '240MVA/220kV', 油温: '90', 绕组温度: '95', 油位: '正常', 瓦斯保护: '正常投运', 试验日期: '2026-07-02', 运行状态: '告警' },
      // id9：待试验、无日期无试验人 -> 不瞎补结论/试验人
      { id: 9, status: '待试验', pending: true, abnormal: false, 变压器编号: 'TRAN-0009', 容量等级: '50MVA', 油温: '', 绕组温度: '', 油位: '', 瓦斯保护: '', 试验日期: '', 运行状态: '待试验' },
    ],
    gate: [], seepage: [], displacement: [], trashrack: [], overhaul: [], bearing: [],
    cooling: [], hydrology: [], flood: [],
    generation: [{ id: 1, status: '执行中', pending: false, abnormal: false, 计划编号: 'GENE-OLD-1' }],
    protection: [], defect: [], crew: [], spare: [],
  }
  const env = installMemoryStorage()
  env.mem['hydropower-plant-om:entries'] = JSON.stringify(v1)

  const store = await import('../src/data/local-store.ts')
  const service = await import('../src/api/transformer-service.ts')

  const rows = service.listTransformers()
  check('迁移后仍是3台', rows.length === 3)
  check('编号与顺序不重排', rows.map((r) => String(r['变压器编号'])).join(',') === 'TRAN-0042,TRAN-0007,TRAN-0009')
  check('原id保留(42/7/9)', rows.map((r) => r.id).join(',') === '42,7,9')

  const t42 = rows[0]
  check('纸质报告补试验人', t42['试验人'] === '纸质报告未署名')
  check('资料来源标注纸质回填', t42['资料来源'] === '纸质报告回填')
  check('运行中回填合格结论', t42['试验结论'] === '合格')
  check('投运日期按试验日期回填', t42['投运日期'] === '2026-07-01')
  check('额定容量从容量等级解析75', Number(t42['额定容量MVA']) === 75)

  const t7 = rows[1]
  check('告警态回填不合格', t7['试验结论'] === '不合格')
  check('告警态纸质无试验人补署名', t7['试验人'] === '纸质报告未署名')
  const active = service.activeAlarms(7)
  check('补录一条有效告警(不丢)', active.length === 1 && active[0].告警类型 === '油温越限')
  check('补录告警标来源', active[0].资料来源 === '系统升级回填')

  const t9 = rows[2]
  check('待试验不瞎补结论', t9['试验结论'] === '')
  check('待试验不瞎补试验人', t9['试验人'] === '')

  // 发电计划迁移时即对齐：仅 1 台运行(75)。
  const gen = store.listRows('generation')[0]
  check('发电计划可用台数=1', gen['可用主变台数'] === 1)
  check('发电计划可用容量=75', gen['可用主变容量'] === 75)

  // 存量待办：种子按登记时间升序，缺来源项有标注。
  const todos = service.listSpareTodos()
  const times = todos.map((t) => t.登记时间)
  const sorted = [...times].sort()
  check('存量待办按登记时间排序', JSON.stringify(times) === JSON.stringify(sorted))
  check('缺来源项已标注', todos.some((t) => t.资料来源.includes('待核实')))

  // 迁移结果已持久化（刷新后不再重复迁移，结论保留）。
  store.__resetCacheForTest()
  const again = service.listTransformers()
  check('刷新后既有结论保留', again[0]['试验结论'] === '合格' && again[1]['试验结论'] === '不合格')
  check('刷新后告警仍在', service.activeAlarms(7).length === 1)
  const raw = JSON.parse(env.mem['hydropower-plant-om:entries'])
  check('版本号已写为2', raw.__version === 2)

  console.log(`\n存量迁移 ${passedCount()} 项断言全部通过`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
