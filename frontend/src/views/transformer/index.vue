<template>
  <section class="page" data-module="transformer">
    <header class="page-head">
      <div>
        <h2>主变压器管理</h2>
        <p class="page-desc">
          试验结论一次落库，刷新/返回仍是同一份；油温或瓦斯越限先撤告警再投运；可用容量实时回写发电计划。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记主变压器</button>
        <button class="btn" type="button" @click="exportRows">导出主变压器台账</button>
        <button class="btn" type="button" @click="exportAlarms">导出告警记录</button>
        <button class="btn" type="button" @click="exportTodos">导出试验消缺待办</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">可用容量：{{ availability.可用容量 }} MVA（与发电计划一致）</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>有效告警</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>
            <span v-if="activeMap.get(Number(row.id))?.length" class="alarm-tag">
              {{ activeMap.get(Number(row.id))?.map((a) => a.告警类型).join('、') }}
            </span>
            <span v-else>—</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openTest(row)">提交试验</button>
            <button
              v-if="String(row.status) === '运行中'"
              class="link" type="button" @click="openAlarm(row)"
            >发布告警</button>
            <button
              v-if="activeMap.get(Number(row.id))?.length"
              class="link" type="button" @click="openRevoke(row)"
            >撤销告警</button>
            <button
              v-if="String(row.status) !== '停运'"
              class="link" type="button" @click="openOutage(row)"
            >停运检修</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无主变压器数据，可先登记主变压器</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">告警记录（撤销留痕，不删除）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in alarmColumns" :key="column">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="alarm in alarms" :key="alarm.id">
          <td v-for="column in alarmColumns" :key="column">{{ alarmCell(alarm, column) }}</td>
        </tr>
        <tr v-if="!alarms.length">
          <td :colspan="alarmColumns.length" class="empty-state">暂无告警记录</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">试验消缺待办（与备品备件页同一份）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in todoColumns" :key="column">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in todos" :key="todo.id">
          <td v-for="column in todoColumns" :key="column">{{ todoCell(todo, column) }}</td>
        </tr>
        <tr v-if="!todos.length">
          <td :colspan="todoColumns.length" class="empty-state">暂无试验消缺待办</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 台主变压器 · 台账落库后刷新页面不回退</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 提交试验 -->
    <div v-if="dialog === 'test' && testForm" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>提交试验结论 · {{ testForm.变压器编号 }}</h3>
        <div class="form-grid">
          <label><span>油温(℃)</span>
            <input v-model="testForm.油温" placeholder="限值85℃，超过为越限" />
          </label>
          <label><span>绕组温度(℃)</span>
            <input v-model="testForm.绕组温度" placeholder="仅记录，不卡投运" />
          </label>
          <label><span>油位</span>
            <input v-model="testForm.油位" placeholder="正常 / 偏高 / 偏低" />
          </label>
          <label><span>瓦斯保护</span>
            <select v-model="testForm.瓦斯保护">
              <option value="">请选择</option>
              <option value="正常投运">正常投运</option>
              <option value="正常">正常</option>
              <option value="动作">动作</option>
              <option value="退出">退出</option>
              <option value="异常">异常</option>
            </select>
          </label>
          <label><span>试验日期</span>
            <input v-model="testForm.试验日期" type="date" />
          </label>
          <label><span>试验人</span>
            <input v-model="testForm.试验人" placeholder="纸质报告查无试验人填：纸质报告未署名" />
          </label>
          <label class="span-2"><span>试验结论</span>
            <span class="radio-line">
              <label><input type="radio" value="合格" v-model="testForm.试验结论" /> 合格</label>
              <label><input type="radio" value="不合格" v-model="testForm.试验结论" /> 不合格</label>
            </span>
          </label>
        </div>
        <p class="dialog-hint">
          结论、日期、试验人一次写入台账（同一台主变按试验时间覆盖，不叠加）。合格且无有效告警即转运行中。
        </p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="busy" @click="doSubmitTest">
            {{ busy ? '提交中…' : '确认提交' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 发布告警 -->
    <div v-if="dialog === 'alarm' && alarmForm" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>发布告警 · {{ alarmForm.变压器编号 }}</h3>
        <div class="form-grid">
          <label><span>告警类型</span>
            <select v-model="alarmForm.告警类型">
              <option value="">请选择</option>
              <option v-for="type in alarmTypes" :key="type" :value="type">{{ type }}</option>
            </select>
          </label>
          <label><span>发布人</span>
            <input v-model="alarmForm.发布人" :placeholder="defaultOperator" />
          </label>
          <label class="span-2"><span>发布原因</span>
            <textarea v-model="alarmForm.发布原因" rows="2"></textarea>
          </label>
        </div>
        <p class="dialog-hint">发布后进入告警态并生成备品备件消缺待办，告警记录全程留痕。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="busy" @click="doPublishAlarm">确认发布</button>
        </div>
      </div>
    </div>

    <!-- 撤销告警 -->
    <div v-if="dialog === 'revoke' && revokeForm" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>撤销告警 · {{ revokeForm.变压器编号 }}</h3>
        <p class="dialog-hint">
          当前有效告警：{{ activeMap.get(revokeForm.id)?.map((a) => a.告警类型).join('、') }}。
          油温(≤85℃)与瓦斯保护恢复正常才允许撤销；撤销后自动转回运行中，告警记录保留为「已撤销」。
        </p>
        <div class="form-grid">
          <label><span>撤销人</span>
            <input v-model="revokeForm.撤销人" :placeholder="defaultOperator" />
          </label>
          <label class="span-2"><span>撤销原因</span>
            <textarea v-model="revokeForm.撤销原因" rows="2" placeholder="如：复测油温72℃、瓦斯保护正常投运，缺陷消除"></textarea>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="busy" @click="doRevokeAlarm">确认撤销并投运</button>
        </div>
      </div>
    </div>

    <!-- 停运检修 -->
    <div v-if="dialog === 'outage' && outageForm" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>停运检修 · {{ outageForm.变压器编号 }}</h3>
        <div class="form-grid">
          <label class="span-2"><span>停运/检修原因（写入消缺待办）</span>
            <textarea v-model="outageForm.原因" rows="2"></textarea>
          </label>
        </div>
        <p class="dialog-hint">停运后发电计划可用容量立即扣减；再投运需重新提交试验结论。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="busy" @click="doTakeOutage">确认停运</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadCsv, exportRowsCsv, listEntries, moduleMeta } from '@/api/local-service'
import {
  listSpareTodos,
  listTransformerAlarms,
  publishAlarm as publishAlarmApi,
  revokeAlarm as revokeAlarmApi,
  submitTest as submitTestApi,
  takeOutOfService as takeOutOfServiceApi,
  transformerAvailability,
  type AlarmRevocation,
  type AlarmSubmission,
  type TestSubmission,
  type TransformerAvailability,
} from '@/api/transformer-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, SpareTodo, TransformerAlarm } from '@/data/types'

const meta = moduleMeta('transformer')
const store = useSessionStore()
const defaultOperator = store.operator
const columns = ["变压器编号", "容量等级", "额定容量MVA", "油温", "绕组温度", "油位", "瓦斯保护", "试验日期", "试验人", "试验结论", "投运日期", "资料来源"]
const alarmColumns = ["id", "变压器编号", "告警类型", "发布时间", "发布人", "发布原因", "状态", "撤销时间", "撤销人", "撤销原因", "资料来源"]
const todoColumns = ["来源单号", "变压器编号", "事项", "建议备件", "登记时间", "状态", "关闭时间", "关闭原因", "资料来源"]
const alarmTypes = ["油温越限", "绕组温度", "油位异常", "瓦斯保护", "运行异常"]

const rows = ref<EntryRow[]>([])
const alarms = ref<TransformerAlarm[]>([])
const todos = ref<SpareTodo[]>([])
const total = ref(0)
const errorMessage = ref('')
const busy = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ["变压器编号", "容量等级", "试验人"]
const statuses = ["待试验", "运行中", "告警", "停运"]
const availability = ref<TransformerAvailability>({ 总台数: 0, 可用台数: 0, 可用容量: 0 })

const stats = computed(() => [
  { label: "运行变压器", value: rows.value.filter((r) => String(r.status) === '运行中').length },
  { label: "告警变压器", value: rows.value.filter((r) => String(r.status) === '告警').length },
  { label: "待试验变压器", value: rows.value.filter((r) => String(r.status) === '待试验').length },
  { label: "可用主变台数", value: availability.value.可用台数 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const activeMap = computed(() => {
  const map = new Map<number, TransformerAlarm[]>()
  for (const alarm of alarms.value) {
    if (alarm.状态 !== '有效') continue
    const list = map.get(alarm.transformerId) ?? []
    list.push(alarm)
    map.set(alarm.transformerId, list)
  }
  return map
})

function formatCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === '') return '—'
  return String(value)
}

function alarmCell(alarm: TransformerAlarm, column: string): string {
  const value = alarm[column as keyof TransformerAlarm]
  return value === undefined || value === '' ? '—' : String(value)
}

function todoCell(todo: SpareTodo, column: string): string {
  const value = todo[column as keyof SpareTodo]
  return value === undefined || value === '' ? '—' : String(value)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    alarms.value = listTransformerAlarms()
    todos.value = listSpareTodos()
    availability.value = transformerAvailability()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '主变压器台账读取失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  const payload = listEntries(meta.key, filters.value)
  const header = ['编号', ...meta.fields, '当前状态']
  const data = payload.items.map((row: EntryRow) => [
    String(row.id),
    ...meta.fields.map((field) => String(row[field] ?? '')),
    String(row.status),
  ])
  const file = exportRowsCsv('主变压器-台账.csv', header, data)
  downloadCsv(file.filename, file.content)
}

function exportAlarms() {
  const data = alarms.value.map((a) => alarmColumns.map((c) => alarmCell(a, c) === '—' ? '' : String(a[c as keyof TransformerAlarm] ?? '')))
  const file = exportRowsCsv('主变压器-告警记录.csv', alarmColumns, data)
  downloadCsv(file.filename, file.content)
}

function exportTodos() {
  const data = todos.value.map((t) => todoColumns.map((c) => String(t[c as keyof SpareTodo] ?? '')))
  const file = exportRowsCsv('试验消缺待办-清单.csv', todoColumns, data)
  downloadCsv(file.filename, file.content)
}

function openCreate() {
  errorMessage.value = '主变压器登记入口尚未接入审批流'
}

// ---- 弹窗 ----
type DialogKind = '' | 'test' | 'alarm' | 'revoke' | 'outage'
const dialog = ref<DialogKind>('')

const testForm = ref<(TestSubmission & { id: number; 变压器编号: string }) | null>(null)
const alarmForm = ref<(AlarmSubmission & { id: number; 变压器编号: string; 发布人: string }) | null>(null)
const revokeForm = ref<(AlarmRevocation & { id: number; 变压器编号: string; 撤销人: string }) | null>(null)
const outageForm = ref<{ id: number; 变压器编号: string; 原因: string } | null>(null)

function closeDialog() {
  dialog.value = ''
  testForm.value = null
  alarmForm.value = null
  revokeForm.value = null
  outageForm.value = null
}

function openTest(row: EntryRow) {
  testForm.value = {
    id: Number(row.id),
    变压器编号: String(row['变压器编号'] ?? ''),
    油温: String(row['油温'] ?? ''),
    绕组温度: String(row['绕组温度'] ?? ''),
    油位: String(row['油位'] ?? ''),
    瓦斯保护: String(row['瓦斯保护'] ?? ''),
    试验日期: String(row['试验日期'] ?? ''),
    试验人: String(row['试验人'] ?? ''),
    试验结论: '合格',
  }
  dialog.value = 'test'
}

function openAlarm(row: EntryRow) {
  alarmForm.value = {
    id: Number(row.id),
    变压器编号: String(row['变压器编号'] ?? ''),
    告警类型: '油温越限',
    发布原因: '',
    发布人: defaultOperator,
  }
  dialog.value = 'alarm'
}

function openRevoke(row: EntryRow) {
  revokeForm.value = {
    id: Number(row.id),
    变压器编号: String(row['变压器编号'] ?? ''),
    撤销原因: '',
    撤销人: defaultOperator,
  }
  dialog.value = 'revoke'
}

function openOutage(row: EntryRow) {
  outageForm.value = { id: Number(row.id), 变压器编号: String(row['变压器编号'] ?? ''), 原因: '' }
  dialog.value = 'outage'
}

function finish(message: string, ok: boolean) {
  busy.value = false
  closeDialog()
  if (ok) {
    reload()
    errorMessage.value = ''
  } else {
    reload()
    errorMessage.value = message
  }
}

function doSubmitTest() {
  if (!testForm.value) return
  busy.value = true
  // 写库失败由数据层自动重试一次；仍失败时把原因透传给值班员，不做假成功。
  const result = submitTestApi(testForm.value.id, { ...testForm.value })
  finish(result.message, result.ok)
}

function doPublishAlarm() {
  if (!alarmForm.value) return
  busy.value = true
  const result = publishAlarmApi(alarmForm.value.id, {
    告警类型: alarmForm.value.告警类型,
    发布原因: alarmForm.value.发布原因,
    发布人: alarmForm.value.发布人,
  })
  finish(result.message, result.ok)
}

function doRevokeAlarm() {
  if (!revokeForm.value) return
  busy.value = true
  const result = revokeAlarmApi(revokeForm.value.id, {
    撤销原因: revokeForm.value.撤销原因,
    撤销人: revokeForm.value.撤销人,
  })
  finish(result.message, result.ok)
}

function doTakeOutage() {
  if (!outageForm.value) return
  busy.value = true
  const result = takeOutOfServiceApi(outageForm.value.id, outageForm.value.原因)
  finish(result.message, result.ok)
}

onMounted(reload)
</script>

<style scoped>
.page-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.section-title { font-size: 14px; margin: 18px 0 8px; }
.alarm-tag { color: #b42318; background: #fee4e2; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.modal {
  width: 560px; max-width: 92vw; background: #fff; border-radius: 10px;
  padding: 18px 20px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.25);
}
.modal h3 { margin: 0 0 12px; font-size: 15px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.form-grid .span-2 { grid-column: span 2; }
.form-grid input, .form-grid select, .form-grid textarea {
  padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; font-family: inherit;
}
.radio-line { display: flex; gap: 18px; padding-top: 4px; }
.dialog-hint { font-size: 12px; color: var(--muted); margin: 10px 0; line-height: 1.6; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
