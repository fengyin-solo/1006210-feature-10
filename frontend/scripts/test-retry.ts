// 写库重试验证：首次写入失败（模拟超时/存储被占用）时自动重读重放一次；
// 第一次失败第二次成功 -> 业务成功；持续失败 -> 返回明确原因，不做假成功。
import { check, installMemoryStorage, passedCount } from './helpers.ts'

async function main() {
  // 场景一：先在正常存储里播种，再把下一次写弄坏，业务提交应靠内部重试成功。
  const env = installMemoryStorage()
  const store = await import('../src/data/local-store.ts')
  const service = await import('../src/api/transformer-service.ts')
  store.resetAll()

  let setCalls = 0
  let failNextOnce = true
  ;(globalThis as any).window.localStorage.setItem = (key: string, value: string) => {
    setCalls += 1
    if (failNextOnce) {
      failNextOnce = false
      const err = new Error('transient') as Error & { name: string }
      err.name = 'QuotaExceededError'
      throw err
    }
    env.mem[key] = value
  }

  const r = service.submitTest(1, {
    油温: '60', 绕组温度: '66', 油位: '正常', 瓦斯保护: '正常投运',
    试验日期: '2026-10-05', 试验人: '重试试验员', 试验结论: '合格',
  })
  check('首次失败后重试一次仍成功', r.ok, r.message)
  check('期间确实发生两次写调用', setCalls === 2)
  store.__resetCacheForTest()
  check('重试成功的数据已真落库', service.getTransformer(1)!['试验人'] === '重试试验员')

  // 场景二：存储持续失败，重试不成必须返回原因，且台账不被改动（不做假成功）。
  ;(globalThis as any).window.localStorage.setItem = () => {
    const err = new Error('quota') as Error & { name: string }
    err.name = 'QuotaExceededError'
    throw err
  }
  store.__resetCacheForTest()
  const before = service.getTransformer(2)!['试验人']
  const r2 = service.submitTest(2, {
    油温: '60', 绕组温度: '66', 油位: '正常', 瓦斯保护: '正常投运',
    试验日期: '2026-10-05', 试验人: '不应落库的试验员', 试验结论: '合格',
  })
  check('持续失败时业务返回失败', !r2.ok)
  check('失败原因明确(存储已满)', r2.message.includes('存储已满'))
  store.__resetCacheForTest()
  check('不做假成功：原试验人未被覆盖', service.getTransformer(2)!['试验人'] === before)

  console.log(`\n重试机制 ${passedCount()} 项断言全部通过`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
