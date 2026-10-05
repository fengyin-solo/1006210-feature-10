import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'

// 按能力而不是按 window 判断：Node 测试垫片里只有 localStorage、没有 window。
function storage(): Storage | null {
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    return globalThis.localStorage
  }
  return null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const ls = storage()
  if (!ls) {
    return fallback
  }
  const raw = ls.getItem(STORAGE_KEY)
  if (!raw) {
    ls.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 新版本可能给种子行补了新列：对已有数据按 id 把缺失字段补回来，
    // 既不覆盖用户改动，也能让首次迁移读到完整字段（如额定容量MVA）。
    const merged = clone(fallback)
    for (const key of Object.keys(parsed)) {
      const storedRows = parsed[key] ?? []
      const seedRows = fallback[key] ?? []
      const seedById = new Map(seedRows.map((row) => [Number(row.id), row]))
      merged[key] = storedRows.map((row) => {
        const seed = seedById.get(Number(row.id))
        return seed ? { ...seed, ...row } : row
      })
    }
    return merged
  } catch {
    ls.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  storage()?.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 丢弃内存缓存，下一次读取直接从 localStorage 重新装载（测试与跨标签页场景用）。 */
export function reloadStore(): void {
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}
