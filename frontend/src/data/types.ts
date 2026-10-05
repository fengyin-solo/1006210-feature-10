/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 主变告警记录：发布与撤销都留痕，撤销只是改状态，记录永不丢失。 */
export type TransformerAlarm = {
  id: number
  transformerId: number
  变压器编号: string
  告警类型: string
  发布时间: string
  发布人: string
  发布原因: string
  状态: '有效' | '已撤销'
  撤销时间: string
  撤销人: string
  撤销原因: string
  资料来源: string
}

/** 备品备件待办：由主变试验/告警链路落到这一份清单，任何入口读到的都是它。 */
export type SpareTodo = {
  id: number
  来源单号: string
  transformerId: number | null
  变压器编号: string
  事项: string
  建议备件: string
  登记时间: string
  状态: '待处理' | '已关闭'
  关闭时间: string
  关闭原因: string
  资料来源: string
}

/** 结构化台账库：版本号驱动存量数据迁移，entries/告警/待办同一次落库。 */
export type SchemaState = {
  __version: number
  entries: Record<string, EntryRow[]>
  transformerAlarms: TransformerAlarm[]
  spareTodos: SpareTodo[]
}
