import {
  commitState,
  isGasProtectionAbnormal,
  isOilTempOverLimit,
  listRows,
  listSpareTodos,
  listTransformerAlarms,
  nextAlarmId,
  nextSpareTodoId,
  PersistError,
  syncGenerationCapacity,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  SpareTodo,
  TransformerAlarm,
} from '@/data/types'

// 阈值口径：油温 > 85℃ 判越限；瓦斯保护非“正常投运/正常”判异常。绕组温度仅记录，不卡投运。
export const OIL_TEMP_LIMIT = 85

const DEFAULT_OPERATOR = '值班管理员'

export type TransformerRow = EntryRow

/** 试验提交表单：结论、试验日期、试验人随读数一次写进主变压器台账。 */
export type TestSubmission = {
  油温: string
  绕组温度: string
  油位: string
  瓦斯保护: string
  试验日期: string
  试验人: string
  试验结论: '合格' | '不合格'
  资料来源?: string
}

export type AlarmSubmission = {
  告警类型: string
  发布原因: string
  发布人?: string
}

export type AlarmRevocation = {
  撤销原因: string
  撤销人?: string
}

export function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function listTransformers(): EntryRow[] {
  return listRows('transformer')
}

export function getTransformer(id: number): EntryRow | undefined {
  return listTransformers().find((row) => Number(row.id) === id)
}

function oilOverLimit(row: EntryRow): boolean {
  return isOilTempOverLimit(row['油温'])
}

function gasIsAbnormal(row: EntryRow): boolean {
  return isGasProtectionAbnormal(row['瓦斯保护'])
}

/** 该主变当前是否存在未撤销的有效告警（任何类型都算，必须先撤才能投运）。 */
export function activeAlarms(transformerId: number): TransformerAlarm[] {
  return listTransformerAlarms().filter(
    (alarm) => alarm.transformerId === transformerId && alarm.状态 === '有效',
  )
}

// 不同告警类型对应的消缺建议与备件，落到备品备件待办清单时用。
const SPARE_HINTS: Record<string, { 事项: string; 建议备件: string }> = {
  油温越限: { 事项: '检查冷却系统并更换冷却器风扇电机，复核油温', 建议备件: '冷却风扇电机 YSF-90L-4' },
  绕组温度: { 事项: '检查绕组冷却回路，必要时更换温度传感器', 建议备件: '绕组温度传感器 PT100' },
  油位异常: { 事项: '检查油位计与密封，补油或更换油位计', 建议备件: '油位计 UZF-200' },
  瓦斯保护: { 事项: '检查气体继电器与密封垫，必要时更换继电器', 建议备件: '气体继电器 QJ4-25' },
  运行异常: { 事项: '排查主变运行异常原因并消缺', 建议备件: '按排查结果申领' },
}

function spareHint(type: string): { 事项: string; 建议备件: string } {
  return SPARE_HINTS[type] ?? { 事项: `按${type}告警排查消缺`, 建议备件: '按排查结果申领' }
}

/**
 * 同一台主变只保留一份待办：按变压器编号 upsert（覆盖式，与试验结论口径一致）。
 * 复测合格时关闭原待办并留下关闭痕迹；不合格则更新成最新一次的消缺事项。
 */
function upsertSpareTodo(
  todos: SpareTodo[],
  row: EntryRow,
  patch: { 事项: string; 建议备件: string; 状态: SpareTodo['状态']; 关闭时间?: string; 关闭原因?: string },
): void {
  const index = todos.findIndex(
    (item) => item.transformerId === Number(row.id) && item.状态 === '待处理',
  )
  if (patch.状态 === '已关闭') {
    if (index < 0) return
    todos[index] = {
      ...todos[index],
      状态: '已关闭',
      关闭时间: patch.关闭时间 ?? nowText(),
      关闭原因: patch.关闭原因 ?? '复测合格，投运前自动关闭',
    }
    return
  }
  if (index >= 0) {
    // 覆盖：以最新一次试验/告警的事项为准，不叠加多条。
    todos[index] = {
      ...todos[index],
      事项: patch.事项,
      建议备件: patch.建议备件,
      登记时间: nowText(),
    }
    return
  }
  todos.push({
    id: nextSpareTodoId(),
    来源单号: `SPARE-TODO-${String(nextSpareTodoId()).padStart(4, '0')}`,
    transformerId: Number(row.id),
    变压器编号: String(row['变压器编号'] ?? ''),
    事项: patch.事项,
    建议备件: patch.建议备件,
    登记时间: nowText(),
    状态: '待处理',
    关闭时间: '',
    关闭原因: '',
    资料来源: '系统录入',
  })
}

function persistReason(error: unknown): string {
  if (error instanceof PersistError) return error.message
  return '台账写入失败，请检查本机存储后重试'
}

/**
 * 提交试验：结论、试验日期、试验人一次落库（覆盖式：同一台主变只保留最后一次，按试验时间覆盖）。
 * 合格且没有有效告警 → 运行中；油温越限或瓦斯异常时不允许出“合格”结论；
 * 有有效告警时结论照落，但状态留在告警，先撤告警再投运。
 */
export function submitTest(id: number, form: TestSubmission): ActionResult {
  const target = getTransformer(id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的主变压器` }
  }
  if (!form.试验日期) {
    return { ok: false, message: '试验日期必填，存量纸质报告也要按报告日期回填' }
  }
  if (!form.试验人.trim()) {
    return { ok: false, message: '试验人必填；只有纸质报告、查不到试验人时填“纸质报告未署名”' }
  }

  const oilOver = isOilTempOverLimit(form.油温)
  const gasBad = isGasProtectionAbnormal(form.瓦斯保护)
  if (form.试验结论 === '合格' && (oilOver || gasBad)) {
    const reasons = [
      oilOver ? `油温${String(form.油温).trim()}℃超过${OIL_TEMP_LIMIT}℃限值` : '',
      gasBad ? `瓦斯保护为「${form.瓦斯保护}」非正常投运` : '',
    ].filter(Boolean)
    return {
      ok: false,
      message: `不能提交合格结论：${reasons.join('，')}。请先处置并复测，或改判不合格`,
    }
  }

  const hadActiveAlarm = activeAlarms(id).length > 0
  try {
    commitState((draft) => {
      const rows = draft.entries.transformer
      const index = rows.findIndex((row) => Number(row.id) === id)
      const prev = rows[index]
      const qualified = form.试验结论 === '合格'
      // 有有效告警时，即便结论合格也不能投运：先撤告警再投运。
      const nextStatus = qualified && !hadActiveAlarm ? '运行中' : hadActiveAlarm ? '告警' : '待试验'
      rows[index] = {
        ...prev,
        status: nextStatus,
        pending: nextStatus === '运行中' || nextStatus === '告警',
        abnormal: nextStatus === '告警',
        油温: form.油温.trim(),
        绕组温度: form.绕组温度.trim(),
        油位: form.油位.trim(),
        瓦斯保护: form.瓦斯保护.trim(),
        试验日期: form.试验日期,
        试验人: form.试验人.trim(),
        试验结论: form.试验结论,
        投运日期:
          nextStatus === '运行中' && !String(prev['投运日期'] ?? '').trim()
            ? form.试验日期
            : String(prev['投运日期'] ?? ''),
        资料来源: form.资料来源 ?? String(prev['资料来源'] ?? '系统录入'),
        运行状态: nextStatus,
      }
      // 试验结论联动备品备件待办：不合格刷新消缺事项，合格关闭待办，两处同一份。
      upsertSpareTodo(draft.spareTodos, rows[index], qualified
        ? { 事项: '', 建议备件: '', 状态: '已关闭', 关闭时间: nowText(), 关闭原因: `复测合格（${form.试验日期} ${form.试验人.trim()}），投运前关闭` }
        : { ...spareHint(oilOver ? '油温越限' : gasBad ? '瓦斯保护' : '运行异常'), 状态: '待处理' })
      syncGenerationCapacity(draft.entries)
    })
  } catch (error) {
    return { ok: false, message: persistReason(error) }
  }

  if (hadActiveAlarm) {
    return {
      ok: true,
      message: '试验结论已落库，但仍有有效告警未撤销：请先“撤销告警”，主变才能转回运行中',
    }
  }
  return form.试验结论 === '合格'
    ? { ok: true, message: `试验合格，主变已投运（试验日期 ${form.试验日期}，试验人 ${form.试验人.trim()}）` }
    : { ok: true, message: '不合格结论已落库，主变保持待试验，消缺事项已进入备品备件待办清单' }
}

/** 发布告警：仅对运行中的主变生效，告警痕迹 append-only 保留。 */
export function publishAlarm(id: number, form: AlarmSubmission): ActionResult {
  const target = getTransformer(id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的主变压器` }
  }
  if (String(target.status) !== '运行中') {
    return { ok: false, message: `主变当前为「${target.status}」，只有运行中的主变才能发布告警` }
  }
  if (activeAlarms(id).length > 0) {
    return { ok: false, message: '该主变已有有效告警，不能重复发布；处置后请先撤销原告警' }
  }
  if (!form.告警类型 || !form.发布原因.trim()) {
    return { ok: false, message: '告警类型与发布原因必填' }
  }
  const hint = spareHint(form.告警类型)
  try {
    commitState((draft) => {
      const rows = draft.entries.transformer
      const index = rows.findIndex((row) => Number(row.id) === id)
      const prev = rows[index]
      rows[index] = { ...prev, status: '告警', pending: true, abnormal: true, 运行状态: '告警' }
      draft.transformerAlarms.push({
        id: nextAlarmId(),
        transformerId: id,
        变压器编号: String(prev['变压器编号'] ?? ''),
        告警类型: form.告警类型,
        发布时间: nowText(),
        发布人: (form.发布人 ?? DEFAULT_OPERATOR).trim() || DEFAULT_OPERATOR,
        发布原因: form.发布原因.trim(),
        状态: '有效',
        撤销时间: '',
        撤销人: '',
        撤销原因: '',
        资料来源: '系统录入',
      })
      upsertSpareTodo(draft.spareTodos, prev, { ...hint, 状态: '待处理' })
      syncGenerationCapacity(draft.entries)
    })
  } catch (error) {
    return { ok: false, message: persistReason(error) }
  }
  return { ok: true, message: `告警已发布并留痕，主变转为告警态，消缺事项已进入备品备件待办清单` }
}

/**
 * 撤销告警：油温或瓦斯保护仍越限时不允许撤销；撤销是“留痕关闭”，记录不删除。
 * 全部有效告警撤完后主变自动转回运行中（先撤告警再投运，由台账一次完成）。
 */
export function revokeAlarm(id: number, form: AlarmRevocation): ActionResult {
  const target = getTransformer(id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的主变压器` }
  }
  const active = activeAlarms(id)
  if (active.length === 0) {
    return { ok: false, message: '该主变没有有效告警可撤销' }
  }
  if (!form.撤销原因.trim()) {
    return { ok: false, message: '撤销原因必填，撤销痕迹要能说明为什么消警' }
  }
  const oilTooHigh = oilOverLimit(target)
  const gasBad = gasIsAbnormal(target)
  if (oilTooHigh || gasBad) {
    const reasons = [
      oilTooHigh ? `油温${String(target['油温'] ?? '').trim()}℃仍超过${OIL_TEMP_LIMIT}℃限值` : '',
      gasBad ? `瓦斯保护仍为「${String(target['瓦斯保护'] ?? '').trim()}」` : '',
    ].filter(Boolean)
    return {
      ok: false,
      message: `不能撤销告警：${reasons.join('，')}。请先提交复测合格的试验结论，恢复后再撤告警`,
    }
  }
  try {
    commitState((draft) => {
      const stamp = nowText()
      const revoker = (form.撤销人 ?? DEFAULT_OPERATOR).trim() || DEFAULT_OPERATOR
      for (const alarm of draft.transformerAlarms) {
        if (alarm.transformerId === id && alarm.状态 === '有效') {
          alarm.状态 = '已撤销'
          alarm.撤销时间 = stamp
          alarm.撤销人 = revoker
          alarm.撤销原因 = form.撤销原因.trim()
        }
      }
      const rows = draft.entries.transformer
      const index = rows.findIndex((row) => Number(row.id) === id)
      const prev = rows[index]
      const conclusion = String(prev['试验结论'] ?? '')
      const canRun = conclusion === '合格'
      rows[index] = {
        ...prev,
        status: canRun ? '运行中' : '待试验',
        pending: canRun,
        abnormal: false,
        运行状态: canRun ? '运行中' : '待试验',
        投运日期:
          canRun && !String(prev['投运日期'] ?? '').trim()
            ? String(prev['试验日期'] ?? '')
            : String(prev['投运日期'] ?? ''),
      }
      upsertSpareTodo(draft.spareTodos, prev, {
        事项: '',
        建议备件: '',
        状态: '已关闭',
        关闭时间: stamp,
        关闭原因: `告警撤销：${form.撤销原因.trim()}`,
      })
      syncGenerationCapacity(draft.entries)
    })
  } catch (error) {
    return { ok: false, message: persistReason(error) }
  }
  return { ok: true, message: '告警已撤销并保留痕迹，主变已转回运行中，发电计划可用容量已同步' }
}

/** 停运检修：状态改停运并同步容量；再投运需要重新提交试验。 */
export function takeOutOfService(id: number, reason: string): ActionResult {
  const target = getTransformer(id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的主变压器` }
  }
  if (String(target.status) === '停运') {
    return { ok: false, message: '主变已经是停运状态' }
  }
  try {
    commitState((draft) => {
      const rows = draft.entries.transformer
      const index = rows.findIndex((row) => Number(row.id) === id)
      const prev = rows[index]
      rows[index] = { ...prev, status: '停运', pending: false, abnormal: false, 运行状态: '停运' }
      upsertSpareTodo(draft.spareTodos, prev, {
        事项: reason.trim() ? `停运检修：${reason.trim()}` : '停运检修，按检修工单消缺',
        建议备件: '按检修工单申领',
        状态: '待处理',
      })
      syncGenerationCapacity(draft.entries)
    })
  } catch (error) {
    return { ok: false, message: persistReason(error) }
  }
  return { ok: true, message: '主变已停运检修，发电计划可用容量已扣减；再投运请重新提交试验' }
}

// ---- 查询视图 -------------------------------------------------------------
export type TransformerAvailability = {
  总台数: number
  可用台数: number
  可用容量: number
}

export function transformerAvailability(): TransformerAvailability {
  const rows = listTransformers()
  const running = rows.filter((row) => String(row.status) === '运行中')
  return {
    总台数: rows.length,
    可用台数: running.length,
    可用容量: running.reduce((sum, row) => sum + (Number(row['额定容量MVA']) || 0), 0),
  }
}

export { listTransformerAlarms, listSpareTodos }
