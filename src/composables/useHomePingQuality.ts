import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type {
  NodePingQualitySummary,
  PingQualityMetricStats,
  PingQualityPeriodStats,
  PingQualityRow,
} from '@/types/pingQuality'
import type { NormalizedMetricSeries } from '@/utils/metricSeries'
import type { KnownPingNetworkFamily, PingLatencyAggregation, PingLossAggregation, PingTaskMeta } from '@/utils/pingNetwork'
import type { PingTaskInfo } from '@/utils/rpc'
import { computed, readonly, shallowRef, toValue, watch } from 'vue'
import { queryMetrics } from '@/services/metrics.service'
import { normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'
import { aggregatePingLatencyValues, aggregatePingLossPercentages, createPingTaskMeta, isKnownPingNetworkFamily, PING_NETWORK_LABELS, resolvePingTaskSelection } from '@/utils/pingNetwork'

interface TaskSamples {
  peakLatency: number[]
  offPeakLatency: number[]
  peakLoss: number[]
  offPeakLoss: number[]
}

interface UseHomePingQualityOptions {
  enabled?: MaybeRefOrGetter<boolean>
  taskSelections?: MaybeRefOrGetter<Partial<Record<KnownPingNetworkFamily, string>>>
  preferredKeywordsByFamily?: MaybeRefOrGetter<Partial<Record<KnownPingNetworkFamily, string[]>>>
  latencyAggregation?: MaybeRefOrGetter<PingLatencyAggregation>
  lossAggregation?: MaybeRefOrGetter<PingLossAggregation>
}

const EMPTY_METRIC: PingQualityMetricStats = { avg: null, p95: null, p99: null }
const QUALITY_NETWORK_FAMILIES: KnownPingNetworkFamily[] = ['telecom', 'unicom', 'mobile']

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

function metricStats(values: number[]): PingQualityMetricStats {
  if (!values.length)
    return { ...EMPTY_METRIC }
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  }
}

function averageMetricStats(items: PingQualityMetricStats[]): PingQualityMetricStats {
  const averageKey = (key: keyof PingQualityMetricStats) => {
    const values = items.map(item => item[key]).filter((value): value is number => value !== null)
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  }
  return { avg: averageKey('avg'), p95: averageKey('p95'), p99: averageKey('p99') }
}

function averagePeriods(items: PingQualityPeriodStats[]): PingQualityPeriodStats {
  return {
    latency: averageMetricStats(items.map(item => item.latency)),
    loss: averageMetricStats(items.map(item => item.loss)),
  }
}

function aggregateMetricStats(
  items: PingQualityMetricStats[],
  aggregate: (values: number[]) => number | null,
): PingQualityMetricStats {
  const aggregateKey = (key: keyof PingQualityMetricStats) => aggregate(
    items.map(item => item[key]).filter((value): value is number => value !== null),
  )
  return { avg: aggregateKey('avg'), p95: aggregateKey('p95'), p99: aggregateKey('p99') }
}

function aggregateTaskPeriods(
  items: PingQualityPeriodStats[],
  latencyAggregation: PingLatencyAggregation,
  lossAggregation: PingLossAggregation,
): PingQualityPeriodStats {
  return {
    latency: aggregateMetricStats(
      items.map(item => item.latency),
      values => aggregatePingLatencyValues(values, latencyAggregation),
    ),
    loss: aggregateMetricStats(
      items.map(item => item.loss),
      values => aggregatePingLossPercentages(values, lossAggregation),
    ),
  }
}

function isBeijingPeak(time: string): boolean {
  const hour = (new Date(time).getUTCHours() + 8) % 24
  return hour >= 20
}

function aggregateQualities(
  nodes: NodeData[],
  tasks: PingTaskInfo[],
  seriesList: NormalizedMetricSeries[],
  taskSelections: Partial<Record<KnownPingNetworkFamily, string>>,
  preferredKeywordsByFamily: Partial<Record<KnownPingNetworkFamily, string[]>>,
  latencyAggregation: PingLatencyAggregation,
  lossAggregation: PingLossAggregation,
): NodePingQualitySummary[] {
  const taskMetas = tasks
    .map(task => createPingTaskMeta(task, task.name))
    .filter((task): task is PingTaskMeta => Boolean(task))
  const taskFamilies = new Map<number, KnownPingNetworkFamily>()
  for (const task of taskMetas) {
    if (isKnownPingNetworkFamily(task.family))
      taskFamilies.set(task.id, task.family)
  }

  const selectedTaskIds = new Map<KnownPingNetworkFamily, Set<number>>()
  const selectedTaskLabels = new Map<KnownPingNetworkFamily, string>()
  for (const family of QUALITY_NETWORK_FAMILIES) {
    const selectedTask = taskSelections[family]
    const selectedTaskId = Number(selectedTask)
    const resolved = resolvePingTaskSelection(taskMetas, {
      mode: family,
      taskId: Number.isFinite(selectedTaskId) ? selectedTaskId : undefined,
      includeAllTasks: selectedTask === 'all',
      preferredKeywordsByFamily,
    })
    selectedTaskIds.set(family, resolved.taskIds ?? new Set<number>())
    selectedTaskLabels.set(family, resolved.label || PING_NETWORK_LABELS[family])
  }

  const samples = new Map<string, TaskSamples>()
  for (const series of seriesList) {
    const taskId = Number(pingTaskId(series))
    const family = taskFamilies.get(taskId)
    if (!family)
      continue
    const key = `${series.entity_id}|${family}|${taskId}`
    const entry = samples.get(key) ?? { peakLatency: [], offPeakLatency: [], peakLoss: [], offPeakLoss: [] }
    for (const point of series.points) {
      if (point.value === null || !Number.isFinite(point.value))
        continue
      const peak = isBeijingPeak(point.time)
      if (series.metric_key === PING_LATENCY_METRIC)
        (peak ? entry.peakLatency : entry.offPeakLatency).push(point.value)
      else if (series.metric_key === PING_LOSS_METRIC)
        (peak ? entry.peakLoss : entry.offPeakLoss).push(point.value * 100)
    }
    samples.set(key, entry)
  }

  return nodes.map((node) => {
    const carrierRows: PingQualityRow[] = []
    for (const family of QUALITY_NETWORK_FAMILIES) {
      const taskEntries = Array.from(selectedTaskIds.get(family) ?? [], taskId => samples.get(`${node.uuid}|${family}|${taskId}`))
        .filter((entry): entry is TaskSamples => Boolean(entry))
      if (!taskEntries.length)
        continue
      const periods = taskEntries.map(entry => ({
        peak: { latency: metricStats(entry.peakLatency), loss: metricStats(entry.peakLoss) },
        offPeak: { latency: metricStats(entry.offPeakLatency), loss: metricStats(entry.offPeakLoss) },
      }))
      carrierRows.push({
        key: family,
        label: selectedTaskLabels.get(family) ?? PING_NETWORK_LABELS[family],
        peak: aggregateTaskPeriods(periods.map(item => item.peak), latencyAggregation, lossAggregation),
        offPeak: aggregateTaskPeriods(periods.map(item => item.offPeak), latencyAggregation, lossAggregation),
      })
    }
    const rows: PingQualityRow[] = carrierRows.length
      ? [
          ...carrierRows,
          {
            key: 'overall',
            label: '三网等权',
            peak: averagePeriods(carrierRows.map(row => row.peak)),
            offPeak: averagePeriods(carrierRows.map(row => row.offPeak)),
          },
        ]
      : []
    return { uuid: node.uuid, name: node.name, rows }
  }).filter(item => item.rows.length)
}

export function useHomePingQuality(
  nodes: MaybeRefOrGetter<NodeData[]>,
  tasks: MaybeRefOrGetter<PingTaskInfo[]>,
  options: UseHomePingQualityOptions = {},
) {
  const loading = shallowRef(false)
  const error = shallowRef('')
  const metricSeries = shallowRef<NormalizedMetricSeries[]>([])
  let loadSequence = 0

  const qualities = computed<NodePingQualitySummary[]>(() => {
    const enabled = options.enabled === undefined || toValue(options.enabled)
    if (!enabled || !metricSeries.value.length)
      return []
    return aggregateQualities(
      toValue(nodes),
      toValue(tasks),
      metricSeries.value,
      options.taskSelections === undefined ? {} : toValue(options.taskSelections),
      options.preferredKeywordsByFamily === undefined ? {} : toValue(options.preferredKeywordsByFamily),
      options.latencyAggregation === undefined ? 'average' : toValue(options.latencyAggregation),
      options.lossAggregation === undefined ? 'or' : toValue(options.lossAggregation),
    )
  })
  const qualityByNode = computed<Record<string, NodePingQualitySummary>>(() => Object.fromEntries(
    qualities.value.map(quality => [quality.uuid, quality]),
  ))

  async function loadQuality() {
    const sequence = ++loadSequence
    const currentNodes = toValue(nodes)
    const currentTasks = toValue(tasks)
    const entityIds = currentNodes.map(node => node.uuid).filter(Boolean)
    const enabled = options?.enabled === undefined || toValue(options.enabled)

    if (!enabled || !entityIds.length || !currentTasks.length) {
      metricSeries.value = []
      loading.value = false
      error.value = ''
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

      metricSeries.value = normalizeMetricSeriesList(result.series)
    }
    catch (cause) {
      if (sequence === loadSequence) {
        metricSeries.value = []
        error.value = cause instanceof Error ? cause.message : '7 日 Ping 统计加载失败'
      }
    }
    finally {
      if (sequence === loadSequence)
        loading.value = false
    }
  }

  const inputKey = computed(() => {
    const nodeKey = toValue(nodes).map(node => node.uuid).sort().join('|')
    const taskKey = toValue(tasks).map(task => `${task.id}:${task.name}`).sort().join('|')
    const enabled = options?.enabled === undefined || toValue(options.enabled)
    return `${enabled}:${nodeKey}::${taskKey}`
  })

  watch(inputKey, () => void loadQuality(), { immediate: true })

  return {
    loading: readonly(loading),
    error: readonly(error),
    qualities: readonly(qualities),
    qualityByNode,
    reload: loadQuality,
  }
}
