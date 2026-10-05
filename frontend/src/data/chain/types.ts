/**
 * 主变压器「试验 → 告警 → 投运」链路的领域类型。
 *
 * 这条链路不再只改内存里的 status：试验结论、告警履历、备品备件待办都作为
 * 独立记录真正落库，主变状态再回写发电计划。两处读到的同一份数据都由
 * src/data/chain/chain-store.ts 统一持久化。
 */

export type TransformerStatus = '待试验' | '运行中' | '告警' | '停运'

export type TestVerdict = '合格' | '不合格'

export type AlarmState = '未解除' | '已撤销'

export type TodoStatus = '待处理' | '已闭环'

export type TodoSource =
  | '试验结论' // 由主变试验结论直接落入待办
  | '主变试验结论回填' // 存量台账迁移：迁移时仍在告警/停运且最后结论不合格
  | '备品备件台账回填' // 存量备品备件台账迁移：待补充的备件

export type TodoClosedReason = '复测合格自动闭环' | '手工闭环' | ''

/** 主变试验结论：同一台主变只保留试验时间最新的一条，重复提交按试验时间覆盖。 */
export type TransformerTest = {
  id: number
  transformerId: number
  变压器编号: string
  试验日期: string
  试验人: string
  试验结论: TestVerdict
  油温: string
  绕组温度: string
  油位: string
  瓦斯保护: string
  越限项: string
  结论来源: string
}

/** 告警记录：只追加、不删除。撤销不抹掉发布痕迹，而是把状态改成「已撤销」并记下撤销信息。 */
export type AlarmRecord = {
  id: number
  alarmNo: string
  transformerId: number
  变压器编号: string
  发布时间: string
  发布人: string
  告警内容: string
  越限项: string
  状态: AlarmState
  撤销时间: string
  撤销人: string
  撤销原因: string
  来源: string
}

/** 备品备件待办：别的入口打开也是同一份，按来源+来源编号幂等合并。 */
export type SpareTodo = {
  id: number
  todoNo: string
  transformerId: number // 主变试验待办时指向主变；备件台账回填时为 0
  变压器编号: string
  事项: string
  备件建议: string
  来源: TodoSource
  来源编号: string
  登记时间: string
  状态: TodoStatus
  闭环时间: string
  闭环人: string
  闭环原因: TodoClosedReason
  缺项标注: string
}

/**
 * 主变台账行：链路库是主变字段的权威来源，
 * 通用 entries 库里的 transformer 行每次提交时按 id 镜像同值，保证两处一致。
 */
export type TransformerRecord = {
  id: number
  变压器编号: string
  容量等级: string
  额定容量MVA: number
  油温: string
  绕组温度: string
  油位: string
  瓦斯保护: string
  试验日期: string
  运行状态: string
  status: TransformerStatus
}

export type ChainState = {
  schemaVersion: number
  transformedAt: string
  tests: TransformerTest[]
  alarms: AlarmRecord[]
  spareTodos: SpareTodo[]
  transformers: TransformerRecord[]
}

export type ServiceResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}

/** 传输层可注入的故障类型：用来模拟超时/断线，验证「重试一次」的行为。 */
export type TransportFault =
  | 'none'
  | 'transient-timeout' // 第一次调用超时、重连后恢复：应重试成功
  | 'persistent-timeout' // 持续超时：重试一次仍失败，给出原因
  | 'offline' // 已断线：不重试，直接给出原因
  | 'quota' // 持久化失败（如配额超限）：重试无意义，直接给出原因

export type LimitCheck = {
  label: string
  exceeded: boolean
}
