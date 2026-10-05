<template>
  <section v-if="ready" class="page" data-module="transformer">
    <header class="page-head">
      <div>
        <h2>主变压器管理</h2>
        <p class="page-desc">试验结论、试验日期与试验人提交后一次写进台账并落库；先撤告警再投运，告警撤销留痕；主变状态实时回写发电计划可用容量。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportLedger">导出台账明细</button>
        <button class="btn" type="button" @click="exportAlarmLedger">导出告警履历</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">运行变压器 / 总台数</span>
        <strong class="stat-value">{{ available.count }} / {{ available.total }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">可用容量（回写发电计划）</span>
        <strong class="stat-value">{{ available.mva }} MVA</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">告警变压器（含未解除告警）</span>
        <strong class="stat-value">{{ statusCount('告警') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待试验 / 停运</span>
        <strong class="stat-value">{{ statusCount('待试验') }} / {{ statusCount('停运') }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>变压器编号</span>
        <input v-model="keyword" placeholder="按编号/容量/试验人检索" />
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.record.id)">
          <td>{{ row.record.变压器编号 }}</td>
          <td>{{ row.record.容量等级 }}</td>
          <td>{{ row.record.额定容量MVA }} MVA</td>
          <td>{{ row.record.油温 }}</td>
          <td>{{ row.record.绕组温度 }}</td>
          <td>{{ row.record.油位 }}</td>
          <td>{{ row.record.瓦斯保护 }}</td>
          <td>{{ row.test?.试验日期 ?? '—' }}</td>
          <td>{{ row.test?.试验人 ?? '—' }}</td>
          <td :class="row.test?.试验结论 === '不合格' ? 'limit-on' : ''">{{ row.test?.试验结论 ?? '—' }}</td>
          <td>{{ row.test?.越限项 || '—' }}</td>
          <td>{{ row.record.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openTest(row.record)">提交试验</button>
            <button class="link" type="button" @click="openPublish(row.record)">发布告警</button>
            <button
              class="link"
              type="button"
              :disabled="!row.hasActiveAlarm"
              @click="openRevoke(row.record)"
            >撤销告警</button>
            <button class="link" type="button" @click="runEnergize(row.record)">投运</button>
            <button class="link" type="button" @click="runShutdown(row.record)">停运检修</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的主变压器记录</td>
        </tr>
      </tbody>
    </table>
    <p class="subtle">同一条告警未解除前不能重复发布；油温或瓦斯保护仍越限时不能撤销告警、不能投运。</p>

    <h3 class="section-title">告警履历（撤销不删除，仅留痕）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in alarmColumns" :key="column">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="alarm in alarms" :key="alarm.alarmNo">
          <td>{{ alarm.alarmNo }}</td>
          <td>{{ alarm.变压器编号 }}</td>
          <td>{{ alarm.发布时间 }}</td>
          <td>{{ alarm.发布人 }}</td>
          <td>{{ alarm.告警内容 }}</td>
          <td>{{ alarm.越限项 || '—' }}</td>
          <td :class="alarm.状态 === '未解除' ? 'limit-on' : 'limit-off'">{{ alarm.状态 }}</td>
          <td>{{ alarm.撤销时间 || '—' }}</td>
          <td>{{ alarm.撤销人 || '—' }}</td>
          <td>{{ alarm.撤销原因 || '—' }}</td>
        </tr>
        <tr v-if="!alarms.length">
          <td :colspan="alarmColumns.length" class="empty-state">暂无告警记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 台主变压器，数据已落库（{{ storageKey }}），刷新或返回仍是同一份</span>
      <span v-if="message.ok" class="success-text">{{ message.text }}</span>
      <span v-else-if="message.text" class="error-text">{{ message.text }}</span>
    </footer>

    <!-- 提交试验 -->
    <div v-if="dialog === 'test'" class="modal-mask" @click.self="closeDialog">
      <form class="modal-card" @submit.prevent="submitTestForm">
        <h3>提交试验结论 · {{ form.code }}</h3>
        <div class="modal-check">
          <span>越限判定（限值：油温≥85℃、绕组温度≥105℃、油位/瓦斯保护非正常）</span>
          <ul>
            <li v-for="check in checks" :key="check.label" :class="check.exceeded ? 'limit-on' : 'limit-off'">
              {{ check.label }}：{{ check.exceeded ? '越限' : '正常' }}
            </li>
          </ul>
        </div>
        <div class="modal-field">
          <span>试验日期</span>
          <input v-model="form.date" type="date" required />
        </div>
        <div class="modal-field">
          <span>试验人（必须签名）</span>
          <input v-model="form.technician" placeholder="本次试验负责人姓名" required />
        </div>
        <div class="modal-field">
          <span>油温（℃）</span>
          <input v-model="form.oilTemp" placeholder="如 62" />
        </div>
        <div class="modal-field">
          <span>绕组温度（℃）</span>
          <input v-model="form.windingTemp" placeholder="如 78" />
        </div>
        <div class="modal-field">
          <span>油位</span>
          <input v-model="form.oilLevel" placeholder="正常 / 偏高 / 偏低 …" />
        </div>
        <div class="modal-field">
          <span>瓦斯保护</span>
          <input v-model="form.gasRelay" placeholder="正常投入 / 轻瓦斯动作 …" />
        </div>
        <div class="modal-field">
          <span>试验结论</span>
          <select v-model="form.verdict">
            <option value="合格">合格</option>
            <option value="不合格">不合格</option>
          </select>
        </div>
        <p class="subtle">同一台主变重复提交：试验时间更新则覆盖旧结论，不叠加；早于既有结论的提交会被拒绝。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" :disabled="busy" @click="closeDialog">取消</button>
          <button class="btn primary" type="submit" :disabled="busy">{{ busy ? '提交中…' : '确认提交' }}</button>
        </div>
      </form>
    </div>

    <!-- 发布告警 -->
    <div v-if="dialog === 'publish'" class="modal-mask" @click.self="closeDialog">
      <form class="modal-card" @submit.prevent="submitPublishForm">
        <h3>发布告警 · {{ form.code }}</h3>
        <div class="modal-check">
          <span>当前读数越限项</span>
          <ul>
            <li v-if="!formExceeded.length" class="limit-off">当前读数未判定到越限项，可人工填写告警内容发布</li>
            <li v-for="label in formExceeded" :key="label" class="limit-on">{{ label }}</li>
          </ul>
        </div>
        <div class="modal-field">
          <span>告警内容（留空则按越限项自动生成）</span>
          <textarea v-model="form.alarmContent" rows="3" />
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" :disabled="busy" @click="closeDialog">取消</button>
          <button class="btn primary" type="submit" :disabled="busy">{{ busy ? '发布中…' : '确认发布' }}</button>
        </div>
      </form>
    </div>

    <!-- 撤销告警 -->
    <div v-if="dialog === 'revoke'" class="modal-mask" @click.self="closeDialog">
      <form class="modal-card" @submit.prevent="submitRevokeForm">
        <h3>撤销告警 · {{ form.code }}</h3>
        <p class="subtle">撤销后告警仍保留在履历中（状态变为「已撤销」），主变先进入「停运」，再执行投运恢复。</p>
        <div class="modal-field">
          <span>撤销原因（必填，留痕）</span>
          <textarea v-model="form.revokeReason" rows="3" placeholder="如：更换冷却器后复测油温 64℃、瓦斯保护正常" required />
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" :disabled="busy" @click="closeDialog">取消</button>
          <button class="btn primary" type="submit" :disabled="busy">{{ busy ? '提交中…' : '确认撤销' }}</button>
        </div>
      </form>
    </div>
  </section>
  <section v-else class="page">
    <p class="subtle">正在加载主变链路台账…</p>
    <p v-if="initMessage" class="error-text">{{ initMessage }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { useSessionStore } from '@/stores/session'
import {
  energizeTransformer,
  getAlarms,
  getChain,
  getLatestTests,
  getAvailableSummary,
  publishAlarm,
  revokeAlarm,
  shutdownTransformer,
  submitTest,
} from '@/data/chain/chain-service'
import { CHAIN_STORAGE_KEY } from '@/data/chain/chain-store'
import { downloadCsv, exportAlarms, exportTransformers } from '@/data/chain/chain-export'
import { evaluateReadings, todayText } from '@/data/chain/limits'
import type { AlarmRecord, LimitCheck, TransformerRecord, TransformerTest } from '@/data/chain/types'

const session = useSessionStore()
const storageKey = CHAIN_STORAGE_KEY
const statuses = ['待试验', '运行中', '告警', '停运']
const columns = ['变压器编号', '容量等级', '额定容量', '油温', '绕组温度', '油位', '瓦斯保护', '试验日期', '试验人', '试验结论', '越限项']
const alarmColumns = ['告警编号', '变压器编号', '发布时间', '发布人', '告警内容', '越限项', '状态', '撤销时间', '撤销人', '撤销原因']

const ready = ref(false)
const initMessage = ref('')
const busy = ref(false)
const message = reactive<{ ok: boolean; text: string }>({ ok: true, text: '' })

const keyword = ref('')
const statusFilter = ref('')
const dialog = ref<'' | 'test' | 'publish' | 'revoke'>('')
const activeId = ref<number | null>(null)

const form = reactive({
  code: '',
  date: todayText(),
  technician: session.operator,
  oilTemp: '',
  windingTemp: '',
  oilLevel: '',
  gasRelay: '',
  verdict: '合格' as '合格' | '不合格',
  alarmContent: '',
  revokeReason: '',
})

const chainRows = ref<{ record: TransformerRecord; test?: TransformerTest; hasActiveAlarm: boolean }[]>([])
const alarms = ref<AlarmRecord[]>([])
const available = ref({ count: 0, mva: 0, total: 0 })

const checks = computed<LimitCheck[]>(() =>
  evaluateReadings({
    油温: form.oilTemp,
    绕组温度: form.windingTemp,
    油位: form.oilLevel,
    瓦斯保护: form.gasRelay,
  }).checks,
)
const formExceeded = computed(() => checks.value.filter((item) => item.exceeded).map((item) => item.label))

const rows = computed(() => {
  const kw = keyword.value.trim()
  return chainRows.value.filter((row) => {
    if (statusFilter.value && row.record.status !== statusFilter.value) {
      return false
    }
    if (!kw) {
      return true
    }
    return [row.record.变压器编号, row.record.容量等级, row.test?.试验人 ?? '', row.test?.试验结论 ?? '']
      .some((cell) => cell.includes(kw))
  })
})
const total = computed(() => rows.value.length)
const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: chainRows.value.filter((row) => row.record.status === status).length })),
)
function statusCount(status: string): number {
  return chainRows.value.filter((row) => row.record.status === status).length
}

function snapshot() {
  const state = getChain()
  const tests = getLatestTests()
  const testByTransformer = new Map(tests.map((test) => [test.transformerId, test]))
  const activeAlarms = new Set(
    state.alarms.filter((alarm) => alarm.状态 === '未解除').map((alarm) => alarm.transformerId),
  )
  chainRows.value = state.transformers.map((record) => ({
    record,
    test: testByTransformer.get(record.id),
    hasActiveAlarm: activeAlarms.has(record.id),
  }))
  alarms.value = [...state.alarms].sort((a, b) => b.id - a.id)
  available.value = getAvailableSummary()
}

function reload() {
  if (!ready.value) {
    return
  }
  snapshot()
}

function resetFilters() {
  keyword.value = ''
  statusFilter.value = ''
  reload()
}

function currentRecord(): TransformerRecord | undefined {
  return getChain().transformers.find((item) => item.id === activeId.value)
}

function resetForm(record: TransformerRecord) {
  form.code = record.变压器编号
  form.date = todayText()
  form.technician = session.operator
  form.oilTemp = record.油温
  form.windingTemp = record.绕组温度
  form.oilLevel = record.油位
  form.gasRelay = record.瓦斯保护
  form.verdict = '合格'
  form.alarmContent = ''
  form.revokeReason = ''
}

function openTest(record: TransformerRecord) {
  activeId.value = record.id
  resetForm(record)
  dialog.value = 'test'
}
function openPublish(record: TransformerRecord) {
  activeId.value = record.id
  resetForm(record)
  dialog.value = 'publish'
}
function openRevoke(record: TransformerRecord) {
  activeId.value = record.id
  resetForm(record)
  dialog.value = 'revoke'
}
function closeDialog() {
  dialog.value = ''
  activeId.value = null
}

async function guardRun(action: () => Promise<{ ok: boolean; message: string }>) {
  busy.value = true
  try {
    const result = await action()
    message.ok = result.ok
    message.text = result.message
    if (result.ok) {
      closeDialog()
      snapshot()
    }
  } finally {
    busy.value = false
  }
}

function submitTestForm() {
  if (activeId.value === null) {
    return
  }
  const id = activeId.value
  guardRun(() =>
    submitTest({
      id,
      试验日期: form.date,
      试验人: form.technician,
      试验结论: form.verdict,
      油温: form.oilTemp,
      绕组温度: form.windingTemp,
      油位: form.oilLevel,
      瓦斯保护: form.gasRelay,
    }),
  )
}

function submitPublishForm() {
  if (activeId.value === null) {
    return
  }
  const id = activeId.value
  guardRun(() => publishAlarm({ id, 告警内容: form.alarmContent, operator: session.operator }))
}

function submitRevokeForm() {
  if (activeId.value === null) {
    return
  }
  const id = activeId.value
  guardRun(() => revokeAlarm({ id, 撤销原因: form.revokeReason, operator: session.operator }))
}

function runEnergize(record: TransformerRecord) {
  guardRun(() => energizeTransformer({ id: record.id, operator: session.operator }))
}
function runShutdown(record: TransformerRecord) {
  guardRun(() => shutdownTransformer({ id: record.id }))
}

function exportLedger() {
  const tests = getLatestTests()
  const { filename, content } = exportTransformers(getChain().transformers, tests, keyword.value, statusFilter.value)
  downloadCsv(filename, content)
  message.ok = true
  message.text = '导出列与页面台账一致'
}
function exportAlarmLedger() {
  const { filename, content } = exportAlarms(getAlarms())
  downloadCsv(filename, content)
}

onMounted(async () => {
  const { initChain } = await import('@/data/chain/chain-service')
  const result = await initChain()
  if (!result.ok) {
    initMessage.value = result.message
    return
  }
  ready.value = true
  snapshot()
})
</script>
