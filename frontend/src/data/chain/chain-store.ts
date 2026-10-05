/**
 * 主变链路库的持久化底座：带版本号的 localStorage 存储 + 传输层（重试一次）。
 *
 * - 所有试验/告警/待办/主变台账改动都先在这里整库落盘，落盘成功才更新内存，
 *   因此刷新、返回、关掉重开读到的都是同一份。
 * - 提交走「整库覆盖」而不是局部追加：覆盖本身幂等，超时重连后重试一次不会
 *   产生重复记录；试验结论的「按试验时间覆盖」在上层 service 保证。
 * - 超时或断线：只重试一次，仍失败就把原因抛给调用方；
 *   配额超限/本地存储损坏这类持久性错误不重试（重试没有意义）。
 */

import type { ChainState, TransportFault } from './types'

export const CHAIN_STORAGE_KEY = 'hydropower-plant-om:transformer-chain:v1'
export const MIGRATION_VERSION = 1

export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'offline' | 'persistence',
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'TransportError'
  }
}

export interface KvBackend {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// Node/测试环境用内存 KV；浏览器环境用 localStorage。
const memoryKv = new Map<string, string>()

const defaultBackend: KvBackend = {
  getItem(key) {
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
      return globalThis.localStorage.getItem(key)
    }
    return memoryKv.has(key) ? memoryKv.get(key)! : null
  },
  setItem(key, value) {
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
      globalThis.localStorage.setItem(key, value)
    } else {
      memoryKv.set(key, value)
    }
  },
  removeItem(key) {
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
      globalThis.localStorage.removeItem(key)
    } else {
      memoryKv.delete(key)
    }
  },
}

let backend: KvBackend = defaultBackend
let cache: ChainState | null = null
let delayMs = 60

// 故障注入：默认关闭；测试用 __setTransportFault 模拟超时/断线/配额超限。
let faultMode: TransportFault = 'none'
// 瞬时超时只在「下一次」传输上生效，重试时就恢复，用来验证重试成功的路径。
let transientPending = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 测试辅助：替换 KV（默认内存实现），方便在 Node 里跑迁移与链路用例。 */
export function __useKvBackend(next: KvBackend): void {
  backend = next
  cache = null
}

/** 测试辅助：设置下一次/持续的传输故障。 */
export function __setTransportFault(fault: TransportFault): void {
  faultMode = fault
  transientPending = fault === 'transient-timeout'
}

/** 测试辅助：调节传输耗时（用例里调到 0，页面保持短暂延迟模拟真实提交）。 */
export function __setTransportDelay(ms: number): void {
  delayMs = ms
}

/** 测试辅助：只清内存缓存，模拟刷新页面后从存储重新装载（不删数据）。 */
export function __clearCachedChain(): void {
  cache = null
}

/** 测试辅助：清掉链路库与内存缓存（不动通用 entries 库）。 */
export function __resetChain(): void {
  backend.removeItem(CHAIN_STORAGE_KEY)
  cache = null
  faultMode = 'none'
  transientPending = false
}

export function getCachedChain(): ChainState | null {
  return cache
}

export function setCachedChain(state: ChainState): void {
  cache = state
}

/** 模拟一次网络传输：延迟后按注入的故障模式决定成败。 */
async function transport<T>(label: string, op: () => T): Promise<T> {
  await sleep(delayMs)
  if (faultMode === 'offline') {
    throw new TransportError('网络已断线，无法连接本地数据服务', 'offline', true)
  }
  if (faultMode === 'persistent-timeout') {
    throw new TransportError(`${label}超时，数据服务持续无响应`, 'timeout', true)
  }
  if (faultMode === 'transient-timeout' && transientPending) {
    transientPending = false
    throw new TransportError(`${label}超时（连接已中断后恢复）`, 'timeout', true)
  }
  if (faultMode === 'quota') {
    throw new TransportError('本地存储写入失败：配额超限，数据未落库', 'persistence', false)
  }
  try {
    return op()
  } catch (error) {
    throw new TransportError(
      `本地存储写入失败：${error instanceof Error ? error.message : '未知错误'}，数据未落库`,
      'persistence',
      false,
    )
  }
}

/**
 * 超时或断线只重试一次；持久性错误不重试。
 * 重试仍失败时抛出的错误信息就是最终给用户看的原因。
 */
async function withRetry<T>(label: string, op: () => T): Promise<T> {
  try {
    return await transport(label, op)
  } catch (error) {
    if (error instanceof TransportError && error.retryable) {
      await sleep(delayMs)
      try {
        return await transport(`${label}重试`, op)
      } catch (retryError) {
        if (retryError instanceof TransportError) {
          throw new TransportError(`${retryError.message}；已自动重试一次仍失败，请稍后再试`, retryError.kind, false)
        }
        throw retryError
      }
    }
    throw error
  }
}

export async function readChainRaw(): Promise<string | null> {
  return withRetry('读取链路记录', () => backend.getItem(CHAIN_STORAGE_KEY))
}

export async function writeChainState(state: ChainState): Promise<void> {
  const raw = JSON.stringify(state)
  await withRetry('提交链路记录', () => backend.setItem(CHAIN_STORAGE_KEY, raw))
}

export function parseChain(raw: string): ChainState {
  return JSON.parse(raw) as ChainState
}

export function isChainState(value: unknown): value is ChainState {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const state = value as Record<string, unknown>
  return Array.isArray(state.transformers) && Array.isArray(state.tests)
    && Array.isArray(state.alarms) && Array.isArray(state.spareTodos)
}
