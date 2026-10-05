/**
 * 主变链路各张表的 CSV 导出：列顺序与页面表格完全一致，
 * 导出明细按页面同样的过滤口径生成，导出来的和页面台账对得上。
 */

import type { AlarmRecord, SpareTodo, TransformerRecord, TransformerTest } from './types'

function csvCell(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows: (string | number)[][]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`
}

export const TRANSFORMER_HEADERS = [
  '变压器编号',
  '容量等级',
  '额定容量(MVA)',
  '油温',
  '绕组温度',
  '油位',
  '瓦斯保护',
  '试验日期',
  '试验人',
  '试验结论',
  '越限项',
  '当前状态',
]

export function exportTransformers(
  transformers: TransformerRecord[],
  tests: TransformerTest[],
  keyword = '',
  statusFilter = '',
): { filename: string; content: string } {
  const testByTransformer = new Map(tests.map((test) => [test.transformerId, test]))
  const kw = keyword.trim()
  const rows: (string | number)[][] = [TRANSFORMER_HEADERS]
  for (const record of transformers) {
    if (statusFilter && record.status !== statusFilter) {
      continue
    }
    const test = testByTransformer.get(record.id)
    const line = [
      record.变压器编号,
      record.容量等级,
      record.额定容量MVA,
      record.油温,
      record.绕组温度,
      record.油位,
      record.瓦斯保护,
      test?.试验日期 ?? '',
      test?.试验人 ?? '',
      test?.试验结论 ?? '',
      test?.越限项 ?? '',
      record.status,
    ]
    if (kw && !line.some((cell) => String(cell).includes(kw))) {
      continue
    }
    rows.push(line)
  }
  return { filename: '主变压器-台账.csv', content: toCsv(rows) }
}

export const ALARM_HEADERS = [
  '告警编号',
  '变压器编号',
  '发布时间',
  '发布人',
  '告警内容',
  '越限项',
  '状态',
  '撤销时间',
  '撤销人',
  '撤销原因',
  '来源',
]

export function exportAlarms(alarms: AlarmRecord[]): { filename: string; content: string } {
  const rows: (string | number)[][] = [ALARM_HEADERS]
  for (const alarm of [...alarms].sort((a, b) => a.id - b.id)) {
    rows.push([
      alarm.alarmNo,
      alarm.变压器编号,
      alarm.发布时间,
      alarm.发布人,
      alarm.告警内容,
      alarm.越限项,
      alarm.状态,
      alarm.撤销时间,
      alarm.撤销人,
      alarm.撤销原因,
      alarm.来源,
    ])
  }
  return { filename: '主变压器-告警履历.csv', content: toCsv(rows) }
}

export const SPARE_TODO_HEADERS = [
  '待办编号',
  '变压器编号',
  '事项',
  '建议备件',
  '来源',
  '来源编号',
  '登记时间',
  '状态',
  '闭环时间',
  '闭环人',
  '闭环原因',
  '缺项标注',
]

export function exportSpareTodos(todos: SpareTodo[]): { filename: string; content: string } {
  const rows: (string | number)[][] = [SPARE_TODO_HEADERS]
  for (const todo of [...todos].sort((a, b) => a.id - b.id)) {
    rows.push([
      todo.todoNo,
      todo.变压器编号,
      todo.事项,
      todo.备件建议,
      todo.来源,
      todo.来源编号,
      todo.登记时间,
      todo.状态,
      todo.闭环时间,
      todo.闭环人,
      todo.闭环原因,
      todo.缺项标注,
    ])
  }
  return { filename: '备品备件-待办清单.csv', content: toCsv(rows) }
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
