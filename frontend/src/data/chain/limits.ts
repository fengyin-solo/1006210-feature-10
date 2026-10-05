/**
 * 主变试验的越限判定与数值解析，全部是纯函数，页面与迁移共用一套口径。
 *
 * 限值口径（主变压器常规运行限值）：
 * - 顶层油温 ≥ 85℃ 越限；
 * - 绕组温度 ≥ 105℃ 越限；
 * - 油位：除「正常 / 合格 / 在限 / 正常范围内」之外的描述（高、低、异常、缺油…）均判越限；
 * - 瓦斯保护：除「正常 / 投入 / 无动作 / 合格 / 正常范围内」之外（动作、跳闸、报警、异常、
 *   退出、缺项…）均判越限——瓦斯保护是硬门槛，越限就不允许把状态改回运行中。
 */

import type { LimitCheck } from './types'

export const OIL_TEMP_LIMIT = 85
export const WINDING_TEMP_LIMIT = 105

export const OIL_LEVEL_NORMAL = ['正常', '合格', '在限', '正常范围内']
export const GAS_RELAY_NORMAL = ['正常', '投入', '无动作', '合格', '正常范围内']

/** 从「85℃」「85.0 °C」「63MVA」这类文本里取第一个数；取不到返回 null（按缺项处理）。 */
export function parseNumber(text: string | number | undefined | null): number | null {
  if (typeof text === 'number') {
    return Number.isFinite(text) ? text : null
  }
  if (text === undefined || text === null) {
    return null
  }
  const matched = String(text).match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return null
  }
  const value = Number(matched[0])
  return Number.isFinite(value) ? value : null
}

/** 容量等级里解析额定容量（MVA），例：63MVA / 50000kVA(=50MVA) / 31.5兆伏安；解析不到按 0 处理。 */
export function parseCapacityMva(text: string): number {
  const value = parseNumber(text)
  if (value === null) {
    return 0
  }
  if (/kva/i.test(text) && !/mva/i.test(text) && !/兆伏安/.test(text)) {
    return Math.round((value / 1000) * 100) / 100
  }
  return value
}

function textLike(text: string, whitelist: string[]): boolean {
  const normalized = text.trim()
  return normalized !== '' && whitelist.some((word) => normalized.includes(word))
}

export function checkOilTemp(value: string): LimitCheck {
  const degree = parseNumber(value)
  return {
    label: `油温≥${OIL_TEMP_LIMIT}℃`,
    exceeded: degree !== null && degree >= OIL_TEMP_LIMIT,
  }
}

export function checkWindingTemp(value: string): LimitCheck {
  const degree = parseNumber(value)
  return {
    label: `绕组温度≥${WINDING_TEMP_LIMIT}℃`,
    exceeded: degree !== null && degree >= WINDING_TEMP_LIMIT,
  }
}

export function checkOilLevel(value: string): LimitCheck {
  const missing = value.trim() === ''
  return {
    label: '油位异常',
    exceeded: missing || !textLike(value, OIL_LEVEL_NORMAL),
  }
}

export function checkGasRelay(value: string): LimitCheck {
  const missing = value.trim() === ''
  return {
    label: '瓦斯保护异常',
    exceeded: missing || !textLike(value, GAS_RELAY_NORMAL),
  }
}

export type ReadingInput = {
  油温: string
  绕组温度: string
  油位: string
  瓦斯保护: string
}

/** 汇总一次试验读数的越限项；返回的 checks 与页面提示同源。 */
export function evaluateReadings(input: ReadingInput): { checks: LimitCheck[]; exceededLabels: string[] } {
  const checks = [
    checkOilTemp(input.油温),
    checkWindingTemp(input.绕组温度),
    checkOilLevel(input.油位),
    checkGasRelay(input.瓦斯保护),
  ]
  return {
    checks,
    exceededLabels: checks.filter((item) => item.exceeded).map((item) => item.label),
  }
}

export function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function nowText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hour = String(now.getHours()).padStart(2, '0')
  const minute = String(now.getMinutes()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day} ${hour}:${minute}`
}
