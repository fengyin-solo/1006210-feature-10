import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitState,
  listRows,
  resetRows,
  syncGenerationCapacity,
} from '@/data/local-store'
import type { ActionResult, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: Record<string, unknown>[], filters: Record<string, string>): Record<string, unknown>[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return {
    items: matched as PageResult['items'],
    total: matched.length,
    page: 1,
    size: matched.length,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  try {
    commitState((draft) => {
      const targetRows = draft.entries[key]
      const targetIndex = targetRows.findIndex((row) => Number(row.id) === id)
      targetRows[targetIndex] = {
        ...targetRows[targetIndex],
        status: target,
        pending: target !== lastStatus,
        abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
      }
      // 任何入口改动主变台账，都立即回写发电计划可用容量，两处口径始终一致。
      if (key === 'transformer') {
        targetRows[targetIndex].运行状态 = target
        syncGenerationCapacity(draft.entries)
      }
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '台账写入失败，请稍后重试',
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const rows = listRows(key).map((row) => [
    String(row.id),
    ...meta.fields.map((field) => String(row[field] ?? '')),
    String(row.status),
  ])
  return { filename: `${meta.name}-清单.csv`, content: toCsv([header, ...rows]) }
}

/** CSV 单元格转义：含逗号、引号、换行的内容加双引号，保证导出明细与页面台账逐格对得上。 */
export function toCsv(rows: (string | number)[][]): string {
  const escape = (value: string | number) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return `﻿${rows.map((row) => row.map(escape).join(',')).join('\n')}`
}

export function exportRowsCsv(
  filename: string,
  header: string[],
  rows: (string | number)[][],
): { filename: string; content: string } {
  return { filename, content: toCsv([header, ...rows]) }
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

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadCsv(filename, content)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
