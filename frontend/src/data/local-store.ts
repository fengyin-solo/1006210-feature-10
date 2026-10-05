import {
  SCHEMA_VERSION,
  SEED_ROWS,
  SEED_SPARE_TODOS,
  SEED_TRANSFORMER_ALARMS,
} from './seed'
import type {
  EntryRow,
  SchemaState,
  SpareTodo,
  TransformerAlarm,
} from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshState(): SchemaState {
  return {
    __version: SCHEMA_VERSION,
    entries: clone(SEED_ROWS),
    transformerAlarms: clone(SEED_TRANSFORMER_ALARMS),
    spareTodos: clone(SEED_SPARE_TODOS),
  }
}

/** 越限判定在迁移与服务层共用：油温超过 85℃ 视为越限。 */
export function isOilTempOverLimit(value: unknown): boolean {
  const num = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(num) && num > 85
}

/** 瓦斯保护非正常投运（退出、动作、异常等）视为越限。 */
export function isGasProtectionAbnormal(value: unknown): boolean {
  const text = String(value ?? '').trim()
  if (text === '') return false
  return text !== '正常投运' && text !== '正常'
}

// ---- 存量迁移 -------------------------------------------------------------
// v1：只有扁平的 {模块: 行[]}，没有试验结论、告警、待办。
// 迁移原则：原有编号、数组顺序与既有结论一律保留，不被新版重排；缺项按规则补齐并标注来源。
function migrateV1Rows(oldEntries: Record<string, EntryRow[]>): SchemaState {
  const entries: Record<string, EntryRow[]> = clone(oldEntries)
  const fallback = SEED_ROWS

  // 其它模块：v1 里没有就用当前种子补齐（老用户本地缺后续新增模块时的兜底，不动已有模块）。
  for (const key of Object.keys(fallback)) {
    if (!entries[key]) {
      entries[key] = clone(fallback[key])
    }
  }

  const paperSigner = '纸质报告未署名'
  const alarms: TransformerAlarm[] = []
  let alarmSeq = 1

  entries.transformer = (entries.transformer ?? []).map((row) => {
    const next: EntryRow = { ...row }
    const status = String(next.status ?? '')
    const hasDate = String(next['试验日期'] ?? '').trim() !== ''
    // 早期只有纸质报告、没有试验人：统一补“纸质报告未署名”，不猜具体人名，来源字段可追溯。
    const paperRecord = hasDate && String(next['试验人'] ?? '').trim() === ''

    if (!('试验人' in next)) next['试验人'] = paperRecord ? paperSigner : ''
    if (!('试验结论' in next)) {
      next['试验结论'] = status === '运行中' ? '合格' : status === '告警' ? '不合格' : ''
    }
    if (!('投运日期' in next)) {
      next['投运日期'] = status === '运行中' ? String(next['试验日期'] ?? '') : ''
    }
    if (!('额定容量MVA' in next)) {
      const capacity = parseFloat(String(next['容量等级'] ?? ''))
      next['额定容量MVA'] = Number.isFinite(capacity) ? capacity : 0
    }
    if (!('资料来源' in next)) {
      next['资料来源'] = paperRecord ? '纸质报告回填' : '系统升级回填'
    }
    if (!('运行状态' in next) || String(next['运行状态']).includes('样例')) {
      next['运行状态'] = status
    }
    // 占位文本不是真读数，清空以免误参与越限判定。
    for (const field of ['油温', '绕组温度', '油位', '瓦斯保护']) {
      if (String(next[field] ?? '').includes('样例')) next[field] = ''
    }
    if (!('试验日期' in next)) next['试验日期'] = ''

    // 存量仍在告警的主变：按既有状态补一条有效告警痕迹，不丢“发布过的告警”。
    if (status === '告警') {
      const oilOver = isOilTempOverLimit(next['油温'])
      const gasAbnormal = isGasProtectionAbnormal(next['瓦斯保护'])
      alarms.push({
        id: alarmSeq++,
        transformerId: Number(next.id),
        变压器编号: String(next['变压器编号'] ?? ''),
        告警类型: oilOver ? '油温越限' : gasAbnormal ? '瓦斯保护' : '运行异常',
        发布时间: `${String(next['试验日期'] ?? '')} 00:00`,
        发布人: paperSigner,
        发布原因: '系统升级迁移：该主变台账状态为告警，补录有效告警',
        状态: '有效',
        撤销时间: '',
        撤销人: '',
        撤销原因: '',
        资料来源: '系统升级回填',
      })
    }
    return next
  })

  // 发电计划回写：迁移时就与主变台账对齐，两处可用台数一致。
  syncGenerationCapacity(entries)

  return {
    __version: SCHEMA_VERSION,
    entries,
    transformerAlarms: alarms,
    spareTodos: clone(SEED_SPARE_TODOS).sort((a, b) =>
      a.登记时间 < b.登记时间 ? -1 : a.登记时间 > b.登记时间 ? 1 : 0,
    ),
  }
}

/** 以主变台账为唯一事实源，重算发电计划每一行的可用主变台数与容量。 */
export function syncGenerationCapacity(entries: Record<string, EntryRow[]>): void {
  const transformers = entries.transformer ?? []
  const available = transformers.filter((row) => String(row.status) === '运行中')
  const count = available.length
  const capacity = available.reduce(
    (sum, row) => sum + (Number(row['额定容量MVA']) || 0),
    0,
  )
  entries.generation = (entries.generation ?? []).map((row) => ({
    ...row,
    可用主变台数: count,
    可用主变容量: capacity,
  }))
}

function readStorage(): SchemaState {
  const fallback = freshState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as SchemaState | Record<string, EntryRow[]>
    // v1 扁平结构：走迁移，原有编号与既有结论保留。
    if (!('__version' in parsed)) {
      const migrated = migrateV1Rows(parsed as Record<string, EntryRow[]>)
      persist(migrated)
      return migrated
    }
    const state = parsed as SchemaState
    // 种子里新增的模块兜底补进来。
    let changed = false
    for (const key of Object.keys(SEED_ROWS)) {
      if (!state.entries[key]) {
        state.entries[key] = clone(SEED_ROWS[key])
        changed = true
      }
    }
    state.transformerAlarms ??= []
    state.spareTodos ??= []
    if (changed) persist(state)
    return state
  } catch (error) {
    // 数据损坏到无法解析：不静默吞掉，落回种子并提示。
    persist(fallback)
    console.warn('台账数据解析失败，已恢复为初始数据：', error)
    return fallback
  }
}

/** 落库失败的统一原因，便于上层把“为什么没写成”告诉值班员。 */
export class PersistError extends Error {
  constructor(
    message: string,
    readonly reason: 'quota' | 'serialization' | 'unavailable' | 'unknown',
  ) {
    super(message)
    this.name = 'PersistError'
  }
}

function persist(state: SchemaState): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new PersistError('本机存储不可用，台账无法落库（浏览器禁用了本地存储）', 'unavailable')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(state)
  } catch {
    throw new PersistError('台账数据序列化失败，本次改动未保存', 'serialization')
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  } catch (error) {
    // 同时兼容真实 DOMException 与测试/旧浏览器里带 name 的普通异常。
    const name = String((error as { name?: string })?.name ?? '')
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      throw new PersistError('浏览器存储已满，台账未能保存，请清理本地存储后重试', 'quota')
    }
    throw new PersistError(`台账写入失败：${name || '未知存储错误'}`, 'unknown')
  }
}

let cache: SchemaState | null = null

export function getState(): SchemaState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

// ---- 读写 API -------------------------------------------------------------
export function allRows(): Record<string, EntryRow[]> {
  return getState().entries
}

export function listRows(key: string): EntryRow[] {
  return getState().entries[key] ?? []
}

export function listTransformerAlarms(): TransformerAlarm[] {
  return getState().transformerAlarms
}

export function listSpareTodos(): SpareTodo[] {
  // 存量清单按登记时间排序；新记录追加后读取顺序始终稳定。
  return [...getState().spareTodos].sort((a, b) =>
    a.登记时间 < b.登记时间 ? -1 : a.登记时间 > b.登记时间 ? 1 : a.id - b.id,
  )
}

export function nextAlarmId(): number {
  return getState().transformerAlarms.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

export function nextSpareTodoId(): number {
  return getState().spareTodos.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

/**
 * 提交一次台账事务：整份状态一次写库，保证主变台账、告警、待办、发电容量同生共死。
 * 超时/断线（存储被占用或一次性写失败）自动重试一次：重读最新状态后重放改动，
 * 两次都失败则抛出带原因的 PersistError，由上层转告值班员，不做假成功。
 */
export function commitState(
  mutate: (state: SchemaState) => void,
  options: { retry?: boolean } = {},
): SchemaState {
  const retry = options.retry ?? true
  const run = (): SchemaState => {
    const state = clone(getState())
    mutate(state)
    persist(state)
    cache = state
    return state
  }
  try {
    return run()
  } catch (error) {
    if (!retry || !(error instanceof PersistError)) throw error
    cache = null // 重读一次，避免拿着旧快照覆盖并发改动
    try {
      return run()
    } catch (secondError) {
      cache = null
      throw secondError
    }
  }
}

export function resetRows(key: string): EntryRow[] {
  // 单模块重置只回滚该模块，告警/待办/容量联动保持现状。
  const state = commitState((draft) => {
    draft.entries[key] = clone(SEED_ROWS[key] ?? [])
    if (key === 'transformer') syncGenerationCapacity(draft.entries)
  })
  return state.entries[key] ?? []
}

/** 清空全部台账并回到种子（含告警与待办），主要给测试用。 */
export function resetAll(): SchemaState {
  const state = freshState()
  persist(state)
  cache = state
  return state
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 测试专用：丢掉内存缓存，下一次读取重新走 localStorage（模拟刷新页面）。 */
export function __resetCacheForTest(): void {
  cache = null
}
