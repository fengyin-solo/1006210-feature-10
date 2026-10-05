<template>
  <section class="page" data-module="spare">
    <header class="page-head">
      <div>
        <h2>备品备件管理</h2>
        <p class="page-desc">维护备品备件台账；主变试验不合格的结论自动落进下方待办清单，与主变压器页读到的是同一份。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记备品备件</button>
        <button class="btn" type="button" @click="exportRows">导出备件清单</button>
        <button class="btn" type="button" @click="exportTodos">导出待办清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待办总数（待处理/已闭环）</span>
        <strong class="stat-value">{{ openTodoCount }} / {{ todoRows.length }}</strong>
      </article>
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <h3 class="section-title">备品备件待办（主变试验结论等多入口共用一份）</h3>
    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>关键词</span>
        <input v-model="todoKeyword" placeholder="按编号/事项/来源检索" />
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="todoStatusFilter">
          <option value="">全部</option>
          <option value="待处理">待处理</option>
          <option value="已闭环">已闭环</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetTodoFilters">重置条件</button>
    </form>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in todoColumns" :key="column">{{ column }}</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in filteredTodos" :key="todo.todoNo">
          <td>{{ todo.todoNo }}</td>
          <td>{{ todo.变压器编号 || '—' }}</td>
          <td>{{ todo.事项 }}</td>
          <td>{{ todo.备件建议 }}</td>
          <td>{{ todo.来源 }}</td>
          <td>{{ todo.登记时间 }}</td>
          <td :class="todo.状态 === '待处理' ? 'limit-on' : 'limit-off'">{{ todo.状态 }}</td>
          <td>{{ todo.闭环时间 || '—' }}</td>
          <td>{{ todo.闭环原因 || '—' }}</td>
          <td>{{ todo.缺项标注 || '—' }}</td>
          <td>
            <button
              class="link"
              type="button"
              :disabled="todo.状态 !== '待处理' || busy"
              @click="runCloseTodo(todo.id)"
            >办理闭环</button>
          </td>
        </tr>
        <tr v-if="!filteredTodos.length">
          <td :colspan="todoColumns.length + 1" class="empty-state">暂无待办；主变试验不合格时会自动落入此清单</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">备品备件台账</h3>
    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无备品备件数据，可先登记备品备件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条备品备件记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import { closeSpareTodo, getSpareTodos, initChain } from '@/data/chain/chain-service'
import { downloadCsv, exportSpareTodos } from '@/data/chain/chain-export'
import type { EntryRow } from '@/data/types'
import type { SpareTodo } from '@/data/chain/types'

const session = useSessionStore()
const meta = moduleMeta('spare')
const columns = ["备件编号", "备件名称", "规格型号", "适用设备", "存放位置", "现有数量", "最低储备量", "备件状态"]
const todoColumns = ["待办编号", "变压器编号", "事项", "建议备件", "来源", "登记时间", "状态", "闭环时间", "闭环原因", "缺项标注"]
const actions = ["办理验收", "领用备件", "提交补充"]
const statuses = ["待验收", "已登记", "已领用", "待补充"]
const stats = [{"label": "已登记备件", "value": 0}, {"label": "待补充备件", "value": 0}, {"label": "本月领用", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const busy = ref(false)
const todoRows = ref<SpareTodo[]>([])
const todoKeyword = ref('')
const todoStatusFilter = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const openTodoCount = computed(() => todoRows.value.filter((todo) => todo.状态 === '待处理').length)
const filteredTodos = computed(() => {
  const kw = todoKeyword.value.trim()
  return todoRows.value
    .filter((todo) => !todoStatusFilter.value || todo.状态 === todoStatusFilter.value)
    .filter((todo) => {
      if (!kw) {
        return true
      }
      return [todo.todoNo, todo.变压器编号, todo.事项, todo.来源, todo.来源编号].some((cell) => cell.includes(kw))
    })
    .sort((a, b) => a.登记时间.localeCompare(b.登记时间) || a.id - b.id)
})

function resetFilters() {
  filters.value = {}
  reload()
}
function resetTodoFilters() {
  todoKeyword.value = ''
  todoStatusFilter.value = ''
}

function exportRows() {
  downloadEntries(meta.key)
}
function exportTodos() {
  const { filename, content } = exportSpareTodos(filteredTodos.value)
  downloadCsv(filename, content)
}

function openCreate() {
  errorMessage.value = '备品备件登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

async function runCloseTodo(todoId: number) {
  errorMessage.value = ''
  busy.value = true
  try {
    const result = await closeSpareTodo({ todoId, operator: session.operator })
    if (!result.ok) {
      errorMessage.value = result.message
    }
    reload()
  } finally {
    busy.value = false
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todoRows.value = getSpareTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备品备件列表读取失败'
  }
}

onMounted(async () => {
  const result = await initChain()
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
})
</script>
