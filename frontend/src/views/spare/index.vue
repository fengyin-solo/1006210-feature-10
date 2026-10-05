<template>
  <section class="page" data-module="spare">
    <header class="page-head">
      <div>
        <h2>备品备件管理</h2>
        <p class="page-desc">维护备品备件，围绕备件编号、备件名称、规格型号、适用设备做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记备品备件</button>
        <button class="btn" type="button" @click="exportRows">导出备品备件清单</button>
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

    <h3 class="section-title">试验消缺待办清单（主变试验/告警自动落入，与主变压器页同一份）</h3>
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
      <span>共 {{ total }} 条备品备件记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadCsv,
  downloadEntries,
  exportRowsCsv,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listSpareTodos } from '@/api/transformer-service'
import type { EntryRow, SpareTodo } from '@/data/types'

const meta = moduleMeta('spare')
const columns = ["备件编号", "备件名称", "规格型号", "适用设备", "存放位置", "现有数量", "最低储备量", "备件状态"]
const todoColumns = ["来源单号", "变压器编号", "事项", "建议备件", "登记时间", "状态", "关闭时间", "关闭原因", "资料来源"]
const actions = ["办理验收", "领用备件", "提交补充"]
const statuses = ["待验收", "已登记", "已领用", "待补充"]
const stats = [{"label": "已登记备件", "value": 0}, {"label": "待补充备件", "value": 0}, {"label": "本月领用", "value": 0}]

const rows = ref<EntryRow[]>([])
const todos = ref<SpareTodo[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportTodos() {
  const data = todos.value.map((t) =>
    todoColumns.map((c) => String(t[c as keyof SpareTodo] ?? '')),
  )
  const file = exportRowsCsv('试验消缺待办-清单.csv', todoColumns, data)
  downloadCsv(file.filename, file.content)
}

function todoCell(todo: SpareTodo, column: string): string {
  const value = todo[column as keyof SpareTodo]
  return value === undefined || value === '' ? '—' : String(value)
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

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todos.value = listSpareTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备品备件列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.section-title { font-size: 14px; margin: 18px 0 8px; }
</style>
