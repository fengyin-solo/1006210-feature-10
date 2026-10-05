// 纯逻辑验证：用内存版 localStorage 跑通主变「试验→告警→撤销→投运」链路，无需浏览器。
type MemoryStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  clear: () => void
}

export function installMemoryStorage(hooks: { failOnce?: boolean; failAlways?: boolean } = {}): {
  mem: Record<string, string>
  storage: MemoryStorage
  callCount: () => number
} {
  const mem: Record<string, string> = {}
  let calls = 0
  const storage: MemoryStorage = {
    getItem: (key) => (key in mem ? mem[key] : null),
    setItem: (key, value) => {
      calls += 1
      if (hooks.failAlways || (hooks.failOnce && calls === 1)) {
        const err = new Error('denied') as Error & { name: string }
        err.name = 'QuotaExceededError'
        throw err
      }
      mem[key] = value
    },
    removeItem: (key) => delete mem[key],
    clear: () => Object.keys(mem).forEach((k) => delete mem[k]),
  }
  ;(globalThis as Record<string, unknown>).window = { localStorage: storage }
  return { mem, storage, callCount: () => calls }
}

let passed = 0
export function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`✗ ${name} ${detail}`)
    process.exitCode = 1
    throw new Error(name)
  }
  passed += 1
  console.log(`✓ ${name}`)
}
export function passedCount(): number {
  return passed
}
