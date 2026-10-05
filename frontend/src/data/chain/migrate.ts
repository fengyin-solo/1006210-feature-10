/**
 * 一次性迁移：把通用 entries 库里的存量主变/备件台账迁进链路库。
 *
 * 规则（对应迁移要求）：
 * - 原有编号与既有结论保持不动：主变 id、变压器编号原样保留，不重排；
 *   存量行若已带「试验结论」字段，直接沿用，不重新判定覆盖。
 * - 存量试验记录按「试验日期」回填成试验结论；早期只有纸质报告、没有试验人的，
 *   试验人统一补「纸质报告（未署名）」，并在结论来源里标注试验人缺项。
 * - 迁移时仍处于「告警」的主变，补建一条「未解除」告警；发布时间/发布人/内容
 *   缺项时按状态回补并标注来源，绝不伪造精确时间。
 * - 存量待办清单按登记时间迁移：主变试验结论回填的待办（告警/停运且结论不合格）
 *   与备品备件台账里「待补充」的备件合并后按登记时间升序编号，缺项逐条标注来源。
 */

import type {
  AlarmRecord,
  ChainState,
  EntryRowLike,
  SpareTodo,
  TransformerRecord,
  TransformerStatus,
  TransformerTest,
} from './chain-entries'
import { evaluateReadings, parseCapacityMva, todayText } from './limits'
import { MIGRATION_VERSION } from './chain-store'

export const PAPER_TECHNICIAN = '纸质报告（未署名）'
const MISSING_PUBLISHER = '状态回补（发布人缺项）'

type LegacyBundle = {
  transformer: EntryRowLike[]
  spare: EntryRowLike[]
}

function asText(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  return String(value)
}

function toTransformerStatus(row: EntryRowLike): TransformerStatus {
  const status = asText(row.status)
  return (['待试验', '运行中', '告警', '停运'] as TransformerStatus[]).includes(status as TransformerStatus)
    ? (status as TransformerStatus)
    : '待试验'
}

function spareSuggestion(rows: TransformerTest[], test: TransformerTest): string {
  const labels = test.越限项 ? test.越限项.split('；').filter(Boolean) : []
  const parts: string[] = []
  if (labels.some((label) => label.includes('油温'))) parts.push('冷却器/温控元件')
  if (labels.some((label) => label.includes('绕组'))) parts.push('绕组温控器')
  if (labels.some((label) => label.includes('油位'))) parts.push('绝缘油/密封件')
  if (labels.some((label) => label.includes('瓦斯'))) parts.push('瓦斯继电器/密封件')
  return parts.length ? parts.join('、') : '按复检结果储备备件'
}

export function buildTransformerRecord(row: EntryRowLike): TransformerRecord {
  return {
    id: Number(row.id),
    变压器编号: asText(row['变压器编号']),
    容量等级: asText(row['容量等级']),
    额定容量MVA: parseCapacityMva(asText(row['容量等级'])),
    油温: asText(row['油温']),
    绕组温度: asText(row['绕组温度']),
    油位: asText(row['油位']),
    瓦斯保护: asText(row['瓦斯保护']),
    试验日期: asText(row['试验日期']),
    运行状态: asText(row['运行状态']),
    status: toTransformerStatus(row),
  }
}

/** 存量试验记录按试验日期回填；没有试验人的早期纸质报告用 PAPER_TECHNICIAN 补齐。 */
export function buildMigratedTest(row: EntryRowLike, recordId: number): TransformerTest | null {
  const date = asText(row['试验日期'])
  if (!date) {
    return null
  }
  const readings = {
    油温: asText(row['油温']),
    绕组温度: asText(row['绕组温度']),
    油位: asText(row['油位']),
    瓦斯保护: asText(row['瓦斯保护']),
  }
  const { exceededLabels } = evaluateReadings(readings)
  const existingVerdict = asText(row['试验结论'])
  const verdict = existingVerdict === '合格' || existingVerdict === '不合格'
    ? existingVerdict
    : exceededLabels.length === 0
      ? '合格'
      : '不合格'
  const technician = asText(row['试验人']).trim()
  const fromPaper = technician === ''
  return {
    id: recordId,
    transformerId: Number(row.id),
    变压器编号: asText(row['变压器编号']),
    试验日期: date,
    试验人: fromPaper ? PAPER_TECHNICIAN : technician,
    试验结论: verdict,
    ...readings,
    越限项: exceededLabels.join('；'),
    结论来源: fromPaper ? '纸质报告回填（试验人缺项）' : '电子台账迁移',
  }
}

function buildMigratedAlarm(row: EntryRowLike, seq: number, migrationDate: string): AlarmRecord {
  const readings = {
    油温: asText(row['油温']),
    绕组温度: asText(row['绕组温度']),
    油位: asText(row['油位']),
    瓦斯保护: asText(row['瓦斯保护']),
  }
  const { exceededLabels } = evaluateReadings(readings)
  const publishedAt = asText(row['告警发布时间']) || asText(row['试验日期'])
  const publisher = asText(row['告警发布人']).trim()
  const content = asText(row['告警内容']).trim()
  return {
    id: seq,
    alarmNo: `ALM-${String(seq).padStart(4, '0')}`,
    transformerId: Number(row.id),
    变压器编号: asText(row['变压器编号']),
    发布时间: publishedAt || migrationDate,
    发布人: publisher || MISSING_PUBLISHER,
    告警内容: content || (exceededLabels.length ? `主变越限：${exceededLabels.join('；')}` : '主变越限告警（内容缺项）'),
    越限项: exceededLabels.join('；'),
    状态: '未解除',
    撤销时间: '',
    撤销人: '',
    撤销原因: '',
    来源: publishedAt && publisher ? '状态回补' : '状态回补（发布信息缺项）',
  }
}

function buildTransformerTodo(row: EntryRowLike, test: TransformerTest, migrationDate: string): SpareTodo {
  const date = test.试验日期
  const missingDate = !date
  return {
    id: -1, // 合并后按登记时间统一编号
    todoNo: `TODO-TRAN-${String(row.id).padStart(4, '0')}`,
    transformerId: Number(row.id),
    变压器编号: test.变压器编号,
    事项: `主变 ${test.变压器编号} 试验结论不合格，需安排复检：${test.越限项 || '具体越限项缺项'}`,
    备件建议: spareSuggestion([], test),
    来源: '主变试验结论回填',
    来源编号: test.变压器编号,
    登记时间: date || migrationDate,
    状态: '待处理',
    闭环时间: '',
    闭环人: '',
    闭环原因: '',
    缺项标注: missingDate ? '试验日期缺项，按迁移时间登记' : '',
  }
}

function buildSpareTodo(row: EntryRowLike, migrationDate: string): SpareTodo {
  const code = asText(row['备件编号']) || `SPAR-${Number(row.id)}`
  const name = asText(row['备件名称']) || '备件名称缺项'
  const registeredAt = asText(row['登记时间']) || asText(row['入库时间'])
  return {
    id: -1,
    todoNo: `TODO-SPAR-${String(row.id).padStart(4, '0')}`,
    transformerId: 0,
    变压器编号: '',
    事项: `备件待补充：${name}（${code}），现有 ${asText(row['现有数量']) || '缺项'} / 最低储备 ${asText(row['最低储备量']) || '缺项'}`,
    备件建议: `${name}${asText(row['规格型号']) ? ` ${asText(row['规格型号'])}` : ''}`,
    来源: '备品备件台账回填',
    来源编号: code,
    登记时间: registeredAt || migrationDate,
    状态: '待处理',
    闭环时间: '',
    闭环人: '',
    闭环原因: '',
    缺项标注: registeredAt ? '' : '登记时间缺项，按迁移时间登记',
  }
}

export function migrateChain(legacy: LegacyBundle, migratedAt = todayText()): ChainState {
  const transformers = legacy.transformer.map(buildTransformerRecord)

  // 存量试验记录：按试验日期回填，结论与试验人一次写死；id 沿用主变编号，保持原编号不重排。
  const tests = legacy.transformer
    .map((row) => buildMigratedTest(row, Number(row.id)))
    .filter((item): item is TransformerTest => item !== null)

  // 迁移时仍在告警的主变，发布过的告警不丢失，补成「未解除」履历。
  let alarmSeq = 0
  const alarms: AlarmRecord[] = legacy.transformer
    .filter((row) => toTransformerStatus(row) === '告警')
    .map((row) => buildMigratedAlarm(row, ++alarmSeq, migratedAt))

  const latestTestById = new Map<number, TransformerTest>()
  for (const test of tests) {
    latestTestById.set(test.transformerId, test)
  }

  // 存量待办：告警/停运且最后结论不合格的主变 + 备件台账里待补充的备件。
  const pendingTodos: SpareTodo[] = []
  for (const row of legacy.transformer) {
    const status = toTransformerStatus(row)
    const test = latestTestById.get(Number(row.id))
    if ((status === '告警' || status === '停运') && test && test.试验结论 === '不合格') {
      pendingTodos.push(buildTransformerTodo(row, test, migratedAt))
    }
  }
  for (const row of legacy.spare) {
    if (asText(row.status) === '待补充') {
      pendingTodos.push(buildSpareTodo(row, migratedAt))
    }
  }

  // 存量清单按登记时间迁移（缺项的排末尾），再顺序赋数字主键；业务编号 TODO-* 不随顺序变化。
  pendingTodos.sort((a, b) => (a.登记时间 || '9999').localeCompare(b.登记时间 || '9999'))
  const spareTodos = pendingTodos.map((todo, index) => ({ ...todo, id: index + 1 }))

  return {
    schemaVersion: MIGRATION_VERSION,
    transformedAt: migratedAt,
    transformers,
    tests,
    alarms,
    spareTodos,
  }
}
