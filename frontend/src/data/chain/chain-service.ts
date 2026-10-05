/**
 * 主变链路服务：试验结论、告警撤销、投运与备品备件待办的全部业务规则都在这里。
 * 页面只收集输入，不做状态判断。
 *
 * 关键约定：
 * - 试验结论按「试验时间」覆盖：同一台主变只有一条试验记录，重复提交用更晚试验
 *   日期的结论覆盖，不叠加；早于既有结论的提交直接拒绝。
 * - 告警只追加：撤销不删记录，状态改为「已撤销」并留下撤销时间/人/原因。
 * - 油温或瓦斯保护仍越限：不允许撤销告警、也不允许投运，必须先处理再撤告警、再投运。
 * - 每次提交先整库落库，再同步主变台账与发电计划的可用容量，两处同值。
 */

import { allRows } from '@/data/local-store'

import { annotateSpareRows, mirrorChainToEntries } from './chain-entries'
import {
  CHAIN_STORAGE_KEY,
  TransportError,
  getCachedChain,
  isChainState,
  parseChain,
  readChainRaw,
  setCachedChain,
  writeChainState,
} from './chain-store'
import { evaluateReadings, nowText } from './limits'
import { migrateChain } from './migrate'
import type {
  AlarmRecord,
  ChainState,
  ServiceResult,
  SpareTodo,
  TestVerdict,
  TransformerRecord,
  TransformerTest,
} from './types'

const DEFAULT_OPERATOR = '值班管理员'
const HARD_GATE_LABELS = ['油温', '瓦斯保护异常']

export type TestInput = {
  id: number
  试验日期: string
  试验人: string
  试验结论: TestVerdict
  油温: string
  绕组温度: string
  油位: string
  瓦斯保护: string
}

export type AlarmInput = {
  id: number
  告警内容: string
  operator: string
}

export type RevokeInput = {
  id: number // 主变 id：一台主变同时至多一条未解除告警
  撤销原因: string
  operator: string
}

function hardGateExceeded(record: TransformerRecord): string[] {
  const { exceededLabels } = evaluateReadings(record)
  return exceededLabels.filter((label) => HARD_GATE_LABELS.some((gate) => label.includes(gate)))
}

export async function initChain(): Promise<ServiceResult> {
  const existing = getCachedChain()
  if (existing) {
    return { ok: true, message: '' }
  }
  try {
    const raw = await readChainRaw()
    if (raw) {
      let state: ChainState
      try {
        const parsed: unknown = parseChain(raw)
        if (!isChainState(parsed)) {
          throw new Error('链路记录结构不完整')
        }
        state = parsed
      } catch (error) {
        throw new TransportError(
          `本地链路记录已损坏（${error instanceof Error ? error.message : '解析失败'}），请清除 ${CHAIN_STORAGE_KEY} 后重新迁移`,
          'persistence',
          false,
        )
      }
      setCachedChain(state)
      // 旧标签页里 entries 可能被改过，进入页面时重新镜像一次，保证两处对得上。
      mirrorChainToEntries(state)
      return { ok: true, message: '' }
    }
    const legacy = allRows()
    const state = migrateChain({
      transformer: legacy.transformer ?? [],
      spare: legacy.spare ?? [],
    })
    await writeChainState(state)
    setCachedChain(state)
    annotateSpareRows(state)
    mirrorChainToEntries(state)
    return { ok: true, message: '' }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof TransportError
        ? error.message
        : `链路台账初始化失败：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

function requireState(): ChainState {
  const state = getCachedChain()
  if (!state) {
    throw new TransportError('链路台账尚未加载，请刷新后重试', 'persistence', false)
  }
  return state
}

async function commit(next: ChainState): Promise<void> {
  // 先落库、再更新内存、最后镜像：落库失败时内存不会提前变成新值。
  await writeChainState(next)
  setCachedChain(next)
  mirrorChainToEntries(next)
}

function fail(error: unknown, prefix: string): ServiceResult {
  return {
    ok: false,
    message: error instanceof TransportError
      ? `${prefix}未落库：${error.message}`
      : `${prefix}失败：${error instanceof Error ? error.message : '未知错误'}`,
  }
}

function findTransformer(state: ChainState, id: number): TransformerRecord | undefined {
  return state.transformers.find((item) => item.id === id)
}

function latestTestOf(state: ChainState, transformerId: number): TransformerTest | undefined {
  return state.tests
    .filter((item) => item.transformerId === transformerId)
    .sort((a, b) => b.试验日期.localeCompare(a.试验日期))[0]
}

function activeAlarmOf(state: ChainState, transformerId: number): AlarmRecord | undefined {
  return state.alarms.find((item) => item.transformerId === transformerId && item.状态 === '未解除')
}

function openTodoOf(state: ChainState, transformerId: number): SpareTodo | undefined {
  return state.spareTodos.find((item) => item.transformerId === transformerId && item.状态 === '待处理')
}

/** 提交试验：结论、试验日期、试验人一次写进主变台账；同一台主变按试验时间覆盖。 */
export async function submitTest(input: TestInput): Promise<ServiceResult> {
  try {
    const state = requireState()
    const record = findTransformer(state, input.id)
    if (!record) {
      return { ok: false, message: `没有找到编号为 ${input.id} 的主变压器` }
    }
    const date = input.试验日期.trim()
    const technician = input.试验人.trim()
    if (!date) {
      return { ok: false, message: '试验日期不能为空' }
    }
    if (!technician) {
      return { ok: false, message: '试验人必须签名；早期纸质报告的未署名记录只在迁移时统一补齐' }
    }
    const readings = {
      油温: input.油温.trim(),
      绕组温度: input.绕组温度.trim(),
      油位: input.油位.trim(),
      瓦斯保护: input.瓦斯保护.trim(),
    }
    const { exceededLabels } = evaluateReadings(readings)
    if (input.试验结论 === '合格' && exceededLabels.length > 0) {
      return {
        ok: false,
        message: `油温/绕组温度/油位/瓦斯保护仍越限（${exceededLabels.join('；')}），不能出具合格结论，也不能投运`,
      }
    }

    const previous = latestTestOf(state, input.id)
    if (previous && date < previous.试验日期) {
      return {
        ok: false,
        message: `该主变已有 ${previous.试验日期} 的试验结论，更早（${date}）的提交不能覆盖，请核对试验日期`,
      }
    }

    const test: TransformerTest = {
      id: record.id,
      transformerId: record.id,
      变压器编号: record.变压器编号,
      试验日期: date,
      试验人: technician,
      试验结论: input.试验结论,
      ...readings,
      越限项: exceededLabels.join('；'),
      结论来源: '现场录入',
    }
    // 只保留最后一次：同一天复测覆盖当天记录，不同日期替换旧记录。
    const tests = [...state.tests.filter((item) => item.transformerId !== input.id), test]

    const updated: TransformerRecord = {
      ...record,
      ...readings,
      试验日期: date,
    }

    const activeAlarm = activeAlarmOf(state, input.id)
    let nextStatus: TransformerRecord['status'] = updated.status
    let note = ''
    let todos = state.spareTodos
    if (input.试验结论 === '合格') {
      // 复测合格：试验结论带出的待办自动闭环，留痕而不是删除。
      todos = todos.map((todo) =>
        todo.transformerId === input.id && todo.状态 === '待处理'
          ? {
              ...todo,
              状态: '已闭环' as const,
              闭环时间: nowText(),
              闭环人: technician,
              闭环原因: '复测合格自动闭环' as const,
              事项: `${todo.事项}（${date} 复测合格）`,
            }
          : todo,
      )
      if (activeAlarm) {
        note = '结论已落库；该主变尚有未解除告警，须先撤销告警再投运'
      } else {
        nextStatus = '运行中'
        note = '试验合格，已投运'
      }
    } else {
      nextStatus = activeAlarm ? updated.status : '停运'
      note = '试验结论不合格，不能投运，已转入备品备件待办'
      todos = upsertFailureTodo(state.spareTodos, updated, test, todos)
    }
    const transformers = state.transformers.map((item) =>
      item.id === input.id ? { ...updated, status: nextStatus } : item,
    )

    await commit({ ...state, transformers, tests, spareTodos: todos })
    return { ok: true, message: `试验结论已写入台账（${date} ${technician}）。${note}` }
  } catch (error) {
    return fail(error, '试验结论')
  }
}

function upsertFailureTodo(
  origin: SpareTodo[],
  record: TransformerRecord,
  test: TransformerTest,
  base: SpareTodo[],
): SpareTodo[] {
  const suggestion = suggestSpares(test)
  const content = `主变 ${record.变压器编号} 试验结论不合格，需安排复检：${test.越限项 || '具体越限项缺项'}`
  const existing = openTodoOf({ spareTodos: origin } as ChainState, record.id)
  if (existing) {
    // 同一台主变的待办只有一条：重复不合格结论更新内容，不新增。
    return base.map((todo) =>
      todo.id === existing.id
        ? {
            ...todo,
            事项: content,
            备件建议: suggestion,
            登记时间: test.试验日期,
            缺项标注: todo.缺项标注,
          }
        : todo,
    )
  }
  const id = origin.reduce((max, todo) => Math.max(max, todo.id), 0) + 1
  const todo: SpareTodo = {
    id,
    todoNo: `TODO-TRAN-${String(record.id).padStart(4, '0')}`,
    transformerId: record.id,
    变压器编号: record.变压器编号,
    事项: content,
    备件建议: suggestion,
    来源: '试验结论',
    来源编号: record.变压器编号,
    登记时间: test.试验日期,
    状态: '待处理',
    闭环时间: '',
    闭环人: '',
    闭环原因: '',
    缺项标注: '',
  }
  return [...base, todo]
}

function suggestSpares(test: TransformerTest): string {
  const labels = test.越限项 ? test.越限项.split('；').filter(Boolean) : []
  const parts: string[] = []
  if (labels.some((label) => label.includes('油温'))) parts.push('冷却器/温控元件')
  if (labels.some((label) => label.includes('绕组'))) parts.push('绕组温控器')
  if (labels.some((label) => label.includes('油位'))) parts.push('绝缘油/密封件')
  if (labels.some((label) => label.includes('瓦斯'))) parts.push('瓦斯继电器/密封件')
  return parts.length ? parts.join('、') : '按复检结果储备备件'
}

/** 发布告警：只追加新记录；已有未解除告警时拒绝重复发布。 */
export async function publishAlarm(input: AlarmInput): Promise<ServiceResult> {
  try {
    const state = requireState()
    const record = findTransformer(state, input.id)
    if (!record) {
      return { ok: false, message: `没有找到编号为 ${input.id} 的主变压器` }
    }
    if (activeAlarmOf(state, input.id)) {
      return { ok: false, message: '该主变已有未解除告警，不能重复发布；处理后请先撤销原告警' }
    }
    const exceeded = evaluateReadings(record).exceededLabels
    const id = state.alarms.reduce((max, alarm) => Math.max(max, alarm.id), 0) + 1
    const alarm: AlarmRecord = {
      id,
      alarmNo: `ALM-${String(id).padStart(4, '0')}`,
      transformerId: record.id,
      变压器编号: record.变压器编号,
      发布时间: nowText(),
      发布人: input.operator || DEFAULT_OPERATOR,
      告警内容: input.告警内容.trim() || (exceeded.length ? `主变越限：${exceeded.join('；')}` : '人工发布告警'),
      越限项: exceeded.join('；'),
      状态: '未解除',
      撤销时间: '',
      撤销人: '',
      撤销原因: '',
      来源: '现场发布',
    }
    const transformers = state.transformers.map((item) =>
      item.id === input.id ? { ...item, status: '告警' as const } : item,
    )
    await commit({ ...state, alarms: [...state.alarms, alarm], transformers })
    return { ok: true, message: `告警 ${alarm.alarmNo} 已发布并落库，状态改为「告警」` }
  } catch (error) {
    return fail(error, '告警发布')
  }
}

/** 撤销告警：油温或瓦斯保护仍越限时不允许；撤销留下时间、人、原因，不删除记录。 */
export async function revokeAlarm(input: RevokeInput): Promise<ServiceResult> {
  try {
    const state = requireState()
    const record = findTransformer(state, input.id)
    if (!record) {
      return { ok: false, message: `没有找到编号为 ${input.id} 的主变压器` }
    }
    const alarm = activeAlarmOf(state, input.id)
    if (!alarm) {
      return { ok: false, message: '该主变没有未解除的告警，无需撤销' }
    }
    const gates = hardGateExceeded(record)
    if (gates.length > 0) {
      return {
        ok: false,
        message: `${gates.join('；')}仍越限，不允许撤销告警；先消除缺陷、复测合格后再撤告警、再投运`,
      }
    }
    const reason = input.撤销原因.trim()
    if (!reason) {
      return { ok: false, message: '撤销告警必须填写原因，履历要留痕' }
    }
    const operator = input.operator || DEFAULT_OPERATOR
    const alarms = state.alarms.map((item) =>
      item.id === alarm.id
        ? {
            ...item,
            状态: '已撤销' as const,
            撤销时间: nowText(),
            撤销人: operator,
            撤销原因: reason,
          }
        : item,
    )
    // 撤销告警后不直接投运：状态退出「告警」、停在「停运」，必须再走一次投运。
    const transformers = state.transformers.map((item) =>
      item.id === input.id ? { ...item, status: '停运' as const } : item,
    )
    await commit({ ...state, alarms, transformers })
    return { ok: true, message: `告警 ${alarm.alarmNo} 已撤销（${operator}），请执行「投运」恢复运行` }
  } catch (error) {
    return fail(error, '告警撤销')
  }
}

/** 投运：没有未解除告警、最新结论合格且油温/瓦斯保护不越限，才能改回运行中。 */
export async function energizeTransformer(input: { id: number; operator?: string }): Promise<ServiceResult> {
  try {
    const state = requireState()
    const record = findTransformer(state, input.id)
    if (!record) {
      return { ok: false, message: `没有找到编号为 ${input.id} 的主变压器` }
    }
    if (activeAlarmOf(state, input.id)) {
      return { ok: false, message: '尚有未解除告警：先撤销告警再投运' }
    }
    const gates = hardGateExceeded(record)
    if (gates.length > 0) {
      return { ok: false, message: `${gates.join('；')}仍越限，不允许投运` }
    }
    const test = latestTestOf(state, input.id)
    if (!test) {
      return { ok: false, message: '尚未提交试验结论，不能投运' }
    }
    if (test.试验结论 !== '合格') {
      return { ok: false, message: `最新试验结论（${test.试验日期}）为不合格，不能投运` }
    }
    if (record.status === '运行中') {
      return { ok: false, message: '该主变已是运行中，不用重复投运' }
    }
    const transformers = state.transformers.map((item) =>
      item.id === input.id ? { ...item, status: '运行中' as const } : item,
    )
    await commit({ ...state, transformers })
    return { ok: true, message: `主变 ${record.变压器编号} 已投运，可用容量已回写发电计划` }
  } catch (error) {
    return fail(error, '投运')
  }
}

/** 停运检修：告警履历保持原样（是否解除按流程单独处理）。 */
export async function shutdownTransformer(input: { id: number }): Promise<ServiceResult> {
  try {
    const state = requireState()
    const record = findTransformer(state, input.id)
    if (!record) {
      return { ok: false, message: `没有找到编号为 ${input.id} 的主变压器` }
    }
    if (record.status === '停运') {
      return { ok: false, message: '该主变已处于停运状态' }
    }
    const transformers = state.transformers.map((item) =>
      item.id === input.id ? { ...item, status: '停运' as const } : item,
    )
    await commit({ ...state, transformers })
    return { ok: true, message: `主变 ${record.变压器编号} 已停运检修` }
  } catch (error) {
    return fail(error, '停运')
  }
}

/** 备品备件待办手工闭环：记录仍在，只是状态改为已闭环并留痕。 */
export async function closeSpareTodo(input: { todoId: number; operator: string }): Promise<ServiceResult> {
  try {
    const state = requireState()
    const todo = state.spareTodos.find((item) => item.id === input.todoId)
    if (!todo) {
      return { ok: false, message: `没有找到编号为 ${input.todoId} 的待办` }
    }
    if (todo.状态 === '已闭环') {
      return { ok: false, message: '该待办已闭环，不用重复操作' }
    }
    const spareTodos = state.spareTodos.map((item) =>
      item.id === input.todoId
        ? {
            ...item,
            状态: '已闭环' as const,
            闭环时间: nowText(),
            闭环人: input.operator || DEFAULT_OPERATOR,
            闭环原因: '手工闭环' as const,
          }
        : item,
    )
    await commit({ ...state, spareTodos })
    return { ok: true, message: `待办 ${todo.todoNo} 已闭环` }
  } catch (error) {
    return fail(error, '待办闭环')
  }
}

// ---------- 读取：所有入口都从这一份内存态读，初始化在 App 启动时完成 ----------

export function getChain(): ChainState {
  return requireState()
}

export function getTransformers(): TransformerRecord[] {
  return requireState().transformers
}

export function getLatestTests(): TransformerTest[] {
  const state = requireState()
  const map = new Map<number, TransformerTest>()
  for (const test of state.tests) {
    const current = map.get(test.transformerId)
    if (!current || current.试验日期 < test.试验日期) {
      map.set(test.transformerId, test)
    }
  }
  return [...map.values()]
}

export function getAlarms(): AlarmRecord[] {
  return requireState().alarms
}

export function getSpareTodos(): SpareTodo[] {
  return requireState().spareTodos
}

export function getAvailableSummary(): { count: number; mva: number; total: number } {
  const state = requireState()
  const running = state.transformers.filter((item) => item.status === '运行中')
  return {
    count: running.length,
    mva: Math.round(running.reduce((sum, item) => sum + item.额定容量MVA, 0) * 100) / 100,
    total: state.transformers.length,
  }
}

export { CHAIN_STORAGE_KEY }
