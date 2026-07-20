<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { KnownPingNetworkFamily } from '@/utils/pingNetwork'
import type { PingTaskInfo } from '@/utils/rpc'
import { computed, ref, watch } from 'vue'
import { Spinner } from '@/components/ui/spinner'
import { queryMetrics } from '@/services/metrics.service'
import { normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'
import { createPingTaskMeta, isKnownPingNetworkFamily, PING_NETWORK_LABELS } from '@/utils/pingNetwork'

const props = defineProps<{ nodes: NodeData[], tasks: PingTaskInfo[], advanced?: boolean }>()

interface MetricStats { avg: number | null, p95: number | null, p99: number | null }
interface PeriodStats { latency: MetricStats, loss: MetricStats }
interface QualityRow { key: string, label: string, peak: PeriodStats, offPeak: PeriodStats }
interface NodeQuality { uuid: string, name: string, rows: QualityRow[] }
interface TaskSamples { peakLatency: number[], offPeakLatency: number[], peakLoss: number[], offPeakLoss: number[] }

const EMPTY_METRIC: MetricStats = { avg: null, p95: null, p99: null }
const loading = ref(false)
const error = ref('')
const qualities = ref<NodeQuality[]>([])
let loadSequence = 0

function percentile(values: number[], ratio: number): number | null {
  if (!values.length)
    return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const low = sorted[lower]!
  const high = sorted[upper]!
  return lower === upper ? low : low + (high - low) * (position - lower)
}

function metricStats(values: number[]): MetricStats {
  if (!values.length)
    return { ...EMPTY_METRIC }
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  }
}

function averageMetricStats(items: MetricStats[]): MetricStats {
  const averageKey = (key: keyof MetricStats) => {
    const values = items.map(item => item[key]).filter((value): value is number => value !== null)
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  }
  return { avg: averageKey('avg'), p95: averageKey('p95'), p99: averageKey('p99') }
}

function averagePeriods(items: PeriodStats[]): PeriodStats {
  return {
    latency: averageMetricStats(items.map(item => item.latency)),
    loss: averageMetricStats(items.map(item => item.loss)),
  }
}

function beijingPeak(time: string): boolean {
  const hour = (new Date(time).getUTCHours() + 8) % 24
  return hour >= 20
}

function formatMetric(stats: MetricStats, unit: string): string {
  if (stats.avg === null)
    return '-'
  const digits = unit === '%' ? 2 : 0
  const average = `均 ${stats.avg.toFixed(digits)}${unit}`
  return props.advanced
    ? `${average} · P95 ${stats.p95?.toFixed(digits) ?? '-'}${unit} · P99 ${stats.p99?.toFixed(digits) ?? '-'}${unit}`
    : average
}

async function loadQuality() {
  const sequence = ++loadSequence
  const entityIds = props.nodes.map(node => node.uuid).filter(Boolean)
  if (!entityIds.length || !props.tasks.length) {
    qualities.value = []
    return
  }

  loading.value = true
  error.value = ''
  try {
    const result = await queryMetrics({
      metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
      entity_ids: entityIds,
      hours: 24 * 7,
      downsample: true,
      fill_empty: false,
      max_points: 24 * 7,
      aggregation: 'avg',
    })
    if (sequence !== loadSequence)
      return

    const taskFamilies = new Map<number, KnownPingNetworkFamily>()
    for (const task of props.tasks) {
      const meta = createPingTaskMeta(task, task.name)
      if (meta && isKnownPingNetworkFamily(meta.family))
        taskFamilies.set(meta.id, meta.family)
    }

    const samples = new Map<string, TaskSamples>()
    for (const series of normalizeMetricSeriesList(result.series)) {
      const taskId = Number(pingTaskId(series))
      const family = taskFamilies.get(taskId)
      if (!family)
        continue
      const key = `${series.entity_id}|${family}|${taskId}`
      const entry = samples.get(key) ?? { peakLatency: [], offPeakLatency: [], peakLoss: [], offPeakLoss: [] }
      for (const point of series.points) {
        if (point.value === null || !Number.isFinite(point.value))
          continue
        const peak = beijingPeak(point.time)
        if (series.metric_key === PING_LATENCY_METRIC)
          (peak ? entry.peakLatency : entry.offPeakLatency).push(point.value)
        else if (series.metric_key === PING_LOSS_METRIC)
          (peak ? entry.peakLoss : entry.offPeakLoss).push(point.value * 100)
      }
      samples.set(key, entry)
    }

    qualities.value = props.nodes.map((node) => {
      const carrierRows: QualityRow[] = []
      for (const family of ['telecom', 'unicom', 'mobile'] as KnownPingNetworkFamily[]) {
        const taskEntries = [...samples.entries()]
          .filter(([key]) => key.startsWith(`${node.uuid}|${family}|`))
          .map(([, value]) => value)
        if (!taskEntries.length)
          continue
        const periods = taskEntries.map(entry => ({
          peak: { latency: metricStats(entry.peakLatency), loss: metricStats(entry.peakLoss) },
          offPeak: { latency: metricStats(entry.offPeakLatency), loss: metricStats(entry.offPeakLoss) },
        }))
        carrierRows.push({
          key: family,
          label: PING_NETWORK_LABELS[family],
          peak: averagePeriods(periods.map(item => item.peak)),
          offPeak: averagePeriods(periods.map(item => item.offPeak)),
        })
      }
      const rows = carrierRows.length
        ? [...carrierRows, { key: 'overall', label: '三网等权', peak: averagePeriods(carrierRows.map(row => row.peak)), offPeak: averagePeriods(carrierRows.map(row => row.offPeak)) }]
        : []
      return { uuid: node.uuid, name: node.name, rows }
    }).filter(item => item.rows.length)
  }
  catch (err) {
    if (sequence === loadSequence)
      error.value = err instanceof Error ? err.message : '7 日 Ping 统计加载失败'
  }
  finally {
    if (sequence === loadSequence)
      loading.value = false
  }
}

const inputKey = computed(() => `${props.nodes.map(node => node.uuid).sort().join('|')}::${props.tasks.map(task => task.id).sort((a, b) => a - b).join('|')}`)
watch(inputKey, () => void loadQuality(), { immediate: true })
</script>

<template>
  <section class="pointer-events-auto rounded-md bg-background/45 p-3 backdrop-blur-sm">
    <div class="mb-2 flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">
        7 日三网质量
      </h3>
      <span class="text-[11px] text-muted-foreground">高峰 20:00-24:00 · 小时聚合</span>
    </div>
    <Spinner :show="loading">
      <p v-if="error" class="py-3 text-xs text-destructive">
        {{ error }}
      </p>
      <div v-else-if="qualities.length" class="grid gap-3">
        <div v-for="node in qualities" :key="node.uuid" class="overflow-x-auto">
          <div class="mb-1 text-xs font-semibold">
            {{ node.name }}
          </div>
          <table class="w-full min-w-[720px] text-[11px]">
            <thead class="text-muted-foreground">
              <tr>
                <th class="w-20 py-1 text-left">
                  线路
                </th><th class="py-1 text-left">
                  7 日高峰
                </th><th class="py-1 text-left">
                  7 日非高峰
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in node.rows" :key="row.key" class="border-t border-border/40" :class="row.key === 'overall' && 'font-semibold'">
                <td class="py-1.5 pr-2">
                  {{ row.label }}
                </td>
                <td class="py-1.5 pr-4">
                  <div>延迟 {{ formatMetric(row.peak.latency, ' ms') }}</div><div>丢包 {{ formatMetric(row.peak.loss, '%') }}</div>
                </td>
                <td class="py-1.5">
                  <div>延迟 {{ formatMetric(row.offPeak.latency, ' ms') }}</div><div>丢包 {{ formatMetric(row.offPeak.loss, '%') }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p v-else class="py-3 text-xs text-muted-foreground">
        暂无可用的三网聚合数据
      </p>
    </Spinner>
  </section>
</template>
