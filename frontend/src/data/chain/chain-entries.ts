/**
 * 链路库 ↔ 通用 entries 库（localStorage）的同值镜像。
 *
 * 链路库（chain-store）是主变、试验、告警、待办的权威来源；
 * 每次链路落库成功后，这里把字段同步回通用 entries 库，让运营概览、
 * 发电计划页、备品备件页等「别的入口」读到的也是同一份，不会出现
 * 一边说投运、一边还算停运。
 */

import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import type { ChainState } from './types'

export type {
  AlarmRecord,
  AlarmState,
  ChainState,
  LimitCheck,
  ServiceResult,
  SpareTodo,
  TestVerdict,
  TodoStatus,
  TransformerRecord,
  TransformerStatus,
  TransformerTest,
  TransportFault,
} from './types'

/** 迁移读取通用台账时只需要「按列名取值」，这里放宽成任意行结构。 */
export interface EntryRowLike {
  id: number | string
  status?: string
  [field: string]: string | number | boolean | undefined
}

function updateRows(key: string, mutate: (row: EntryRow) => EntryRow | null): EntryRow[] {
  const rows = listRows(key)
  const next = rows.map((row) => mutate(row)).filter((row): row is EntryRow => row !== null)
  saveRows(key, next)
  return next
}

function availableCapacity(state: ChainState): { count: number; mva: number } {
  const running = state.transformers.filter((item) => item.status === '运行中')
  return {
    count: running.length,
    mva: running.reduce((sum, item) => sum + item.额定容量MVA, 0),
  }
}

export function mirrorChainToEntries(state: ChainState): void {
  const chainById = new Map(state.transformers.map((item) => [item.id, item]))

  // 主变台账：试验结论/日期/试验人/当前状态等一次写进同一行，原行其余字段保留。
  updateRows('transformer', (row) => {
    const record = chainById.get(Number(row.id))
    if (!record) {
      return row
    }
    const test = state.tests
      .filter((item) => item.transformerId === record.id)
      .sort((a, b) => b.试验日期.localeCompare(a.试验日期))[0]
    return {
      ...row,
      status: record.status,
      pending: record.status !== '停运',
      abnormal: record.status === '告警',
      容量等级: record.容量等级,
      额定容量MVA: record.额定容量MVA,
      油温: record.油温,
      绕组温度: record.绕组温度,
      油位: record.油位,
      瓦斯保护: record.瓦斯保护,
      试验日期: test?.试验日期 ?? '',
      试验人: test?.试验人 ?? '',
      试验结论: test?.试验结论 ?? '',
      越限项: test?.越限项 ?? '',
      结论来源: test?.结论来源 ?? '',
      可用主变台数: '', // 全厂量，写在发电计划上；主变行留空避免逐行误读
      可用容量MVA: '',
      运行状态: record.status,
    }
  })

  // 发电计划：主变状态回写可用容量，每一条计划读到的可用台数/容量都相同。
  const { count, mva } = availableCapacity(state)
  updateRows('generation', (row) => ({
    ...row,
    可用主变台数: count,
    可用容量MVA: mva,
  }))
}

/** 迁移时把待补充备件的登记时间等缺项信息带回（仅在原列不存在时补，不覆盖原值）。 */
export function annotateSpareRows(state: ChainState): void {
  const bySource = new Map(state.spareTodos.filter((todo) => todo.来源 === '备品备件台账回填').map((todo) => [todo.来源编号, todo]))
  updateRows('spare', (row) => {
    const code = String(row['备件编号'] ?? '')
    const todo = bySource.get(code)
    if (!todo) {
      return row
    }
    const next: EntryRow = { ...row }
    if (!String(next['登记时间'] ?? '') && todo.登记时间) {
      next['登记时间'] = todo.登记时间
    }
    next['待办来源'] = todo.来源
    next['缺项标注'] = todo.缺项标注
    return next
  })
}
