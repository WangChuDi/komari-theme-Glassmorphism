import type { MaybeRefOrGetter } from 'vue'
import type { PingLatencyAggregation, PingLossAggregation, PingNetworkFamily, PingTaskMeta, PingTaskSelection } from '@/utils/pingNetwork'
import type { PingMetricTaskStats } from '@/utils/rpc'
import { useThrottleFn } from '@vueuse/core'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { PING_RECORD_MAX_COUNT } from '@/constants/load'
import { abortPingRecords, loadPingRecordsWithTasks } from '@/services/history.service'
import { loadPingMetricStats, queryMetrics } from '@/services/metrics.service'
import { isPingMetric, normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId, pingTaskName } from '@/utils/metricSeries'
import { aggregatePingLatencyValues, aggregatePingLossPercentages, createPingTaskMeta, getPingTaskSelectionCacheKey, normalizePingTaskId, resolvePingTaskSelection } from '@/utils/pingNetwork'

export interface NodePingHistoryPoint {
  time: string
  latency: number | null
  loss: number | null
}

export interface NodePingStatsState {
  avgLatency: number
  avgLoss: number
  avgVolatility: number
  history: NodePingHistoryPoint[]
  hasData: boolean
  taskLabel: string
  taskFamily: PingNetworkFamily | null
  taskIds: number[]
}

interface PingRecord {
  client: string
  task_id: number
  time: string
  value: number
}

interface MetricLossPoint {
  task_id: number
  time: string
  value: number
  count: number
}

function normalizeMaxCount(maxCount: number | null | undefined): number | undefined {
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || maxCount <= 0)
    return undefined
  return Math.floor(maxCount)
}

interface SharedPingRecordsState {
  recordsByClient: Map<string, PingRecord[]>
  source: 'metric' | 'legacy'
  tasks: PingTaskMeta[]
  metricStats?: PingMetricTaskStats[]
  metricLossPoints?: MetricLossPoint[]
}

interface SharedPingRecordsEntry {
  data: ReturnType<typeof shallowRef<SharedPingRecordsState | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  promise: Promise<void> | null
  refreshTimer: ReturnType<typeof setInterval> | null
  subscribers: number
  lastFetchedAt: number
}

const HISTORY_BUCKET_COUNT = 20
const CACHE_VERSION = 10
const CACHE_KEY_PREFIX = 'komari-theme-emerald:node-ping-stats'
const FULL_LOSS_EPSILON = 1e-6
const PING_RECORD_REFRESH_INTERVAL_MS = 60_000
const sharedPingRecordsCache = new Map<string, SharedPingRecordsEntry>()

interface TaskRecordSummary {
  total: number
  success: number
}

function createEmptyStats(): NodePingStatsState {
  return {
    avgLatency: 0,
    avgLoss: 0,
    avgVolatility: 0,
    history: [],
    hasData: false,
    taskLabel: '',
    taskFamily: null,
    taskIds: [],
  }
}

function average(values: number[]): number {
  if (!values.length)
    return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function weightedAverage(values: Array<{ value: number, weight: number }>): number {
  const weightedValues = values.filter(item => item.weight > 0)
  const totalWeight = weightedValues.reduce((sum, item) => sum + item.weight, 0)
  if (!totalWeight)
    return 0

  return weightedValues.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function summarizeTaskRecords(records: PingRecord[]): Map<number, TaskRecordSummary> {
  const summaries = new Map<number, TaskRecordSummary>()

  for (const record of records) {
    const summary = summaries.get(record.task_id) ?? { total: 0, success: 0 }
    summary.total += 1
    if (record.value >= 0) {
      summary.success += 1
    }
    summaries.set(record.task_id, summary)
  }

  return summaries
}

function getIncludedTaskIds(records: PingRecord[]): Set<number> {
  const recordSummaries = summarizeTaskRecords(records)

  return new Set(
    [...recordSummaries.entries()]
      .filter(([, summary]) => summary.total > 0)
      .map(([taskId]) => taskId),
  )
}

function getCacheKey(uuid: string, hours: number, maxCount: number | undefined, selectionKey: string): string {
  return `${CACHE_KEY_PREFIX}:${uuid}:${hours}:${maxCount ?? 'all'}:${selectionKey}`
}

function getSharedPingRecordsKey(hours: number, maxCount?: number, uuid?: string): string {
  return `${uuid?.trim() || 'all'}:${hours}:${maxCount ?? 'all'}`
}

function isValidHistoryPoint(value: unknown): value is NodePingHistoryPoint {
  if (!value || typeof value !== 'object')
    return false

  const point = value as Record<string, unknown>
  const latency = point.latency
  const loss = point.loss

  return typeof point.time === 'string'
    && (latency === null || typeof latency === 'number')
    && (loss === null || typeof loss === 'number')
}

function isValidStatsState(value: unknown): value is NodePingStatsState {
  if (!value || typeof value !== 'object')
    return false

  const state = value as Record<string, unknown>
  return typeof state.avgLatency === 'number'
    && typeof state.avgLoss === 'number'
    && typeof state.avgVolatility === 'number'
    && typeof state.hasData === 'boolean'
    && typeof state.taskLabel === 'string'
    && (state.taskFamily === null || typeof state.taskFamily === 'string')
    && Array.isArray(state.taskIds)
    && state.taskIds.every(taskId => typeof taskId === 'number')
    && Array.isArray(state.history)
    && state.history.every(isValidHistoryPoint)
}

function readStatsCache(uuid: string, hours: number, maxCount: number | undefined, selectionKey: string): NodePingStatsState | null {
  if (typeof window === 'undefined')
    return null

  try {
    const raw = window.localStorage.getItem(getCacheKey(uuid, hours, maxCount, selectionKey))
    if (!raw)
      return null

    const parsed = JSON.parse(raw) as { version?: number, stats?: unknown }
    if (parsed.version !== CACHE_VERSION || !isValidStatsState(parsed.stats))
      return null

    return parsed.stats
  }
  catch {
    return null
  }
}

function writeStatsCache(uuid: string, hours: number, maxCount: number | undefined, selectionKey: string, value: NodePingStatsState): void {
  if (typeof window === 'undefined')
    return

  try {
    window.localStorage.setItem(
      getCacheKey(uuid, hours, maxCount, selectionKey),
      JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        stats: value,
      }),
    )
  }
  catch {
  }
}

function createSharedPingRecordsEntry(): SharedPingRecordsEntry {
  return {
    data: shallowRef<SharedPingRecordsState | null>(null),
    loading: ref(false),
    error: ref<string | null>(null),
    promise: null,
    refreshTimer: null,
    subscribers: 0,
    lastFetchedAt: 0,
  }
}

function getSharedPingRecordsEntry(hours: number, maxCount?: number, uuid?: string): SharedPingRecordsEntry {
  const key = getSharedPingRecordsKey(hours, maxCount, uuid)
  const cachedEntry = sharedPingRecordsCache.get(key)
  if (cachedEntry)
    return cachedEntry

  const nextEntry = createSharedPingRecordsEntry()
  sharedPingRecordsCache.set(key, nextEntry)
  return nextEntry
}

function buildRecordsByClient(records: PingRecord[]): Map<string, PingRecord[]> {
  const grouped = new Map<string, PingRecord[]>()

  for (const record of records) {
    if (!record.client)
      continue

    const clientRecords = grouped.get(record.client) ?? []
    clientRecords.push(record)
    grouped.set(record.client, clientRecords)
  }

  for (const clientRecords of grouped.values()) {
    clientRecords.sort(
      (left, right) => new Date(left.time).getTime() - new Date(right.time).getTime(),
    )
  }

  return grouped
}

function buildMetricRecordsByClient(nodeUuid: string, stats: PingMetricTaskStats[], records: PingRecord[]): Map<string, PingRecord[]> {
  const grouped = buildRecordsByClient(records)
  if (grouped.size)
    return grouped

  const syntheticRecords = stats
    .filter(stat => stat.entity_id === nodeUuid && typeof stat.latest === 'number' && Number.isFinite(stat.latest))
    .map((stat): PingRecord => ({
      client: nodeUuid,
      task_id: normalizePingTaskId(stat.task_id),
      time: new Date().toISOString(),
      value: stat.latest!,
    }))

  return buildRecordsByClient(syntheticRecords)
}

function upsertTaskMeta(taskMap: Map<number, PingTaskMeta>, value: unknown, fallbackName = ''): void {
  const meta = createPingTaskMeta(value, fallbackName)
  if (!meta || taskMap.has(meta.id))
    return

  taskMap.set(meta.id, meta)
}

function buildFallbackTaskMetas(records: PingRecord[]): PingTaskMeta[] {
  const taskMap = new Map<number, PingTaskMeta>()
  for (const record of records) {
    upsertTaskMeta(taskMap, {
      id: record.task_id,
      name: `Task ${record.task_id}`,
    })
  }
  return [...taskMap.values()]
}

async function loadPingMetricRecords(nodeUuid: string, hours: number, maxCount?: number): Promise<SharedPingRecordsState | null> {
  const [statsResult, metricsResult] = await Promise.allSettled([
    loadPingMetricStats({ entity_id: nodeUuid, hours, max_points: maxCount }),
    queryMetrics({
      metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
      entity_id: nodeUuid,
      hours,
      downsample: true,
      fill_empty: true,
      max_points: maxCount,
      aggregation: 'avg',
    }),
  ])

  const stats = statsResult.status === 'fulfilled'
    ? (statsResult.value.stats ?? []).filter(stat => stat.entity_id === nodeUuid)
    : []
  const metricRecords: PingRecord[] = []
  const metricLossPoints: MetricLossPoint[] = []
  const metricLossTaskIds = new Set<number>()
  const taskMap = new Map<number, PingTaskMeta>()

  for (const stat of stats)
    upsertTaskMeta(taskMap, stat, stat.name?.trim() || `Task ${stat.task_id}`)

  if (metricsResult.status === 'fulfilled') {
    const seriesList = normalizeMetricSeriesList(metricsResult.value.series)
    for (const series of seriesList) {
      const taskId = normalizePingTaskId(pingTaskId(series))
      if (!Number.isFinite(taskId))
        continue
      upsertTaskMeta(taskMap, {
        ...series,
        task_id: pingTaskId(series),
        name: pingTaskName(series),
      }, pingTaskName(series) || `Task ${taskId}`)

      if (series.metric_key === PING_LOSS_METRIC) {
        for (const point of series.points) {
          if (!isFiniteNumber(point.value))
            continue

          metricLossPoints.push({
            task_id: taskId,
            time: point.time,
            value: point.value,
            count: isFiniteNumber(point.count) && point.count > 0 ? point.count : 1,
          })
          metricLossTaskIds.add(taskId)
        }
        continue
      }

      if (!isPingMetric(series))
        continue

      for (const point of series.points) {
        if (point.value === null)
          continue

        metricRecords.push({
          client: series.entity_id,
          task_id: taskId,
          time: point.time,
          value: point.value,
        })
      }
    }
  }

  const recordsByClient = buildMetricRecordsByClient(nodeUuid, stats, metricRecords)
  const exactLossTaskIds = new Set(
    stats
      .filter(stat => stat.total > 0 && !stat.loss_approximate && isFiniteNumber(stat.loss))
      .map(stat => normalizePingTaskId(stat.task_id)),
  )
  const hasCompleteLossSeries = exactLossTaskIds.size > 0
    && [...exactLossTaskIds].every(taskId => metricLossTaskIds.has(taskId))
  if (!hasCompleteLossSeries)
    return null

  return {
    recordsByClient,
    source: 'metric',
    tasks: [...taskMap.values()],
    metricStats: stats,
    metricLossPoints,
  }
}

async function loadSharedPingRecords(entry: SharedPingRecordsEntry, hours: number, maxCount?: number, nodeUuid?: string): Promise<void> {
  if (entry.promise)
    return entry.promise

  entry.loading.value = true
  entry.error.value = null

  entry.promise = (async () => {
    try {
      const metricState = nodeUuid ? await loadPingMetricRecords(nodeUuid, hours, maxCount).catch(() => null) : null
      if (metricState) {
        entry.data.value = metricState
      }
      else {
        const { records, tasks } = await loadPingRecordsWithTasks(hours, maxCount, nodeUuid)
        const taskMap = new Map<number, PingTaskMeta>()
        for (const task of tasks)
          upsertTaskMeta(taskMap, task, task.name || `Task ${task.id}`)
        for (const task of buildFallbackTaskMetas(records)) {
          if (!taskMap.has(task.id))
            taskMap.set(task.id, task)
        }
        entry.data.value = {
          recordsByClient: buildRecordsByClient(records),
          source: 'legacy',
          tasks: [...taskMap.values()],
        }
      }
      entry.lastFetchedAt = Date.now()
    }
    catch (err) {
      entry.error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
      throw err
    }
    finally {
      entry.loading.value = false
      entry.promise = null
    }
  })()

  return entry.promise
}

function startSharedPingRecordsRefresh(entry: SharedPingRecordsEntry, hours: number, maxCount?: number, uuid?: string): void {
  if (entry.refreshTimer)
    return

  entry.refreshTimer = setInterval(() => {
    void loadSharedPingRecords(entry, hours, maxCount, uuid).catch(() => {})
  }, PING_RECORD_REFRESH_INTERVAL_MS)
}

function stopSharedPingRecordsRefresh(entry: SharedPingRecordsEntry): void {
  if (!entry.refreshTimer)
    return

  clearInterval(entry.refreshTimer)
  entry.refreshTimer = null
}

function retainSharedPingRecordsEntry(hours: number, maxCount?: number, uuid?: string): () => void {
  const entry = getSharedPingRecordsEntry(hours, maxCount, uuid)
  entry.subscribers += 1
  startSharedPingRecordsRefresh(entry, hours, maxCount, uuid)

  let released = false
  return () => {
    if (released)
      return

    released = true
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers === 0) {
      stopSharedPingRecordsRefresh(entry)
      abortPingRecords(hours, maxCount, uuid)
    }
  }
}

function buildPingHistory(
  records: PingRecord[],
  metricLossPoints: MetricLossPoint[] | undefined,
  latencyAggregation: PingLatencyAggregation,
  lossAggregation: PingLossAggregation,
): NodePingHistoryPoint[] {
  const sortedRecords = records
    .map((record) => {
      const timestamp = new Date(record.time).getTime()
      return { ...record, timestamp }
    })
    .filter(record => Number.isFinite(record.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp)
  const sortedMetricLossPoints = (metricLossPoints ?? [])
    .map(point => ({ ...point, timestamp: new Date(point.time).getTime() }))
    .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value) && point.count > 0)
    .sort((left, right) => left.timestamp - right.timestamp)

  if (!sortedRecords.length && !sortedMetricLossPoints.length)
    return []

  const firstTime = Math.min(
    sortedRecords[0]?.timestamp ?? Number.POSITIVE_INFINITY,
    sortedMetricLossPoints[0]?.timestamp ?? Number.POSITIVE_INFINITY,
  )
  const lastTime = Math.max(
    sortedRecords.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY,
    sortedMetricLossPoints.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY,
  )
  const bucketCount = Math.min(HISTORY_BUCKET_COUNT, Math.max(sortedRecords.length, sortedMetricLossPoints.length))
  const bucketSize = Math.max(1, (lastTime - firstTime) / bucketCount)

  const history: NodePingHistoryPoint[] = []
  let recordIndex = 0
  let metricLossPointIndex = 0

  for (let index = 0; index < bucketCount; index++) {
    const startTime = firstTime + bucketSize * index
    const endTime = index === bucketCount - 1 ? lastTime + 1 : startTime + bucketSize
    const bucketByTask = new Map<number, {
      latency: number[]
      totalCount: number
      lostCount: number
      metricLossSum: number
      metricLossCount: number
    }>()

    const getTaskBucket = (taskId: number) => {
      const current = bucketByTask.get(taskId)
      if (current)
        return current
      const created = { latency: [], totalCount: 0, lostCount: 0, metricLossSum: 0, metricLossCount: 0 }
      bucketByTask.set(taskId, created)
      return created
    }

    while (recordIndex < sortedRecords.length) {
      const record = sortedRecords[recordIndex]
      if (!record || record.timestamp >= endTime)
        break

      if (record.timestamp >= startTime) {
        const taskBucket = getTaskBucket(record.task_id)
        taskBucket.totalCount += 1
        if (record.value >= 0)
          taskBucket.latency.push(record.value)
        else
          taskBucket.lostCount += 1
      }
      recordIndex += 1
    }

    while (metricLossPointIndex < sortedMetricLossPoints.length) {
      const point = sortedMetricLossPoints[metricLossPointIndex]
      if (!point || point.timestamp >= endTime)
        break

      if (point.timestamp >= startTime) {
        const taskBucket = getTaskBucket(point.task_id)
        taskBucket.metricLossSum += point.value * point.count
        taskBucket.metricLossCount += point.count
      }
      metricLossPointIndex += 1
    }

    const taskLatencies = Array.from(bucketByTask.values(), task => aggregatePingLatencyValues(task.latency, 'average'))
      .filter(isFiniteNumber)
    const taskLosses = Array.from(bucketByTask.values(), (task) => {
      if (metricLossPoints)
        return task.metricLossCount ? task.metricLossSum / task.metricLossCount * 100 : null
      return task.totalCount ? task.lostCount / task.totalCount * 100 : null
    })
      .filter(isFiniteNumber)

    history.push({
      time: new Date(startTime).toISOString(),
      latency: aggregatePingLatencyValues(taskLatencies, latencyAggregation),
      loss: aggregatePingLossPercentages(taskLosses, lossAggregation),
    })
  }

  return history
}

function getPercentile(values: number[], percentile: number): number | null {
  if (!values.length)
    return null

  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * percentile))
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lowerValue = sorted[lowerIndex]
  const upperValue = sorted[upperIndex]

  if (lowerValue === undefined || upperValue === undefined)
    return null
  if (lowerIndex === upperIndex)
    return lowerValue

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex)
}

function withTaskSelection(state: Omit<NodePingStatsState, 'taskLabel' | 'taskFamily' | 'taskIds'>, selection: ReturnType<typeof resolvePingTaskSelection>): NodePingStatsState {
  return {
    ...state,
    taskLabel: selection.label,
    taskFamily: selection.family,
    taskIds: selection.taskIds ? [...selection.taskIds] : [],
  }
}

function buildStats(
  records: PingRecord[],
  tasks: PingTaskMeta[],
  taskSelection?: PingTaskSelection | null,
  metricStats?: PingMetricTaskStats[],
  metricLossPoints?: MetricLossPoint[],
  latencyAggregation: PingLatencyAggregation = 'average',
  lossAggregation: PingLossAggregation = 'or',
): NodePingStatsState {
  const resolvedSelection = resolvePingTaskSelection(tasks, taskSelection)
  const selectedTaskIds = resolvedSelection.taskIds
  const selectedRecords = selectedTaskIds
    ? records.filter(record => selectedTaskIds.has(record.task_id))
    : records
  const selectedMetricStats = selectedTaskIds
    ? (metricStats ?? []).filter(stat => selectedTaskIds.has(normalizePingTaskId(stat.task_id)))
    : (metricStats ?? [])
  const selectedMetricLossPoints = selectedTaskIds
    ? (metricLossPoints ?? []).filter(point => selectedTaskIds.has(point.task_id))
    : metricLossPoints

  const statsWithSamples = selectedMetricStats.filter(stat => stat.total > 0)
  if (statsWithSamples.length) {
    const history = buildPingHistory(
      selectedRecords.filter(record => record.value >= 0),
      selectedMetricLossPoints,
      latencyAggregation,
      lossAggregation,
    )
    const latencyValues = statsWithSamples
      .flatMap(stat => stat.valid > 0 && isFiniteNumber(stat.avg)
        ? [{ value: stat.avg, weight: stat.valid }]
        : [])
    const latestLatencyValues = statsWithSamples
      .map(stat => stat.latest)
      .filter(isFiniteNumber)
    const lossValues = statsWithSamples
      .filter(stat => !stat.loss_approximate && isFiniteNumber(stat.loss))
      .map(stat => stat.loss)
    const volatilityValues = statsWithSamples
      .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p99_p50_ratio))
      .map(stat => ({ value: stat.p99_p50_ratio!, weight: stat.valid }))

    const avgLatency = latencyValues.length
      ? latencyAggregation === 'average'
        ? weightedAverage(latencyValues)
        : aggregatePingLatencyValues(latencyValues.map(item => item.value), latencyAggregation) ?? 0
      : aggregatePingLatencyValues(latestLatencyValues, latencyAggregation) ?? 0
    const avgLoss = aggregatePingLossPercentages(lossValues, lossAggregation) ?? 0

    return withTaskSelection({
      avgLatency,
      avgLoss,
      avgVolatility: weightedAverage(volatilityValues),
      history,
      hasData: true,
    }, resolvedSelection)
  }

  const includedTaskIds = getIncludedTaskIds(selectedRecords)

  if (!includedTaskIds.size)
    return withTaskSelection(createEmptyStats(), resolvedSelection)

  const filteredRecords = selectedRecords.filter(record => includedTaskIds.has(record.task_id))
  const history = buildPingHistory(filteredRecords, undefined, latencyAggregation, lossAggregation)
  const taskRecords = new Map<number, PingRecord[]>()

  for (const record of filteredRecords) {
    const currentRecords = taskRecords.get(record.task_id) ?? []
    currentRecords.push(record)
    taskRecords.set(record.task_id, currentRecords)
  }

  const latencyValues: number[] = []
  const taskLossValues: number[] = []
  const volatilityValues: number[] = []

  for (const recordsByTask of taskRecords.values()) {
    const validValues = recordsByTask
      .map(record => record.value)
      .filter(value => value >= 0)

    taskLossValues.push((recordsByTask.length - validValues.length) / recordsByTask.length * 100)

    if (!validValues.length)
      continue

    latencyValues.push(average(validValues))

    if (validValues.length > 1) {
      const p50 = getPercentile(validValues, 0.5)
      const p99 = getPercentile(validValues, 0.99)
      if (isFiniteNumber(p50) && isFiniteNumber(p99) && p50 > FULL_LOSS_EPSILON) {
        volatilityValues.push(p99 / p50)
      }
    }
  }

  const historyLatencyValues = history
    .map(point => point.latency)
    .filter(isFiniteNumber)
  const historyLossValues = history
    .map(point => point.loss)
    .filter(isFiniteNumber)

  const avgLatency = aggregatePingLatencyValues(
    latencyValues.length ? latencyValues : historyLatencyValues,
    latencyAggregation,
  ) ?? 0
  const avgLoss = aggregatePingLossPercentages(
    taskLossValues.length ? taskLossValues : historyLossValues,
    lossAggregation,
  ) ?? 0
  const avgVolatility = average(volatilityValues)
  const hasData = history.length > 0 || latencyValues.length > 0 || taskLossValues.length > 0

  return withTaskSelection({
    avgLatency,
    avgLoss,
    avgVolatility,
    history,
    hasData,
  }, resolvedSelection)
}

export function useNodePingStats(
  uuid: MaybeRefOrGetter<string>,
  options?: {
    hours?: MaybeRefOrGetter<number>
    enabled?: MaybeRefOrGetter<boolean>
    maxCount?: MaybeRefOrGetter<number | undefined>
    taskSelection?: MaybeRefOrGetter<PingTaskSelection | null | undefined>
    latencyAggregation?: MaybeRefOrGetter<PingLatencyAggregation>
    lossAggregation?: MaybeRefOrGetter<PingLossAggregation>
  },
) {
  const loading = ref(false)
  const error = ref<string | null>(null)

  const resolved = computed(() => {
    const hours = Math.max(1, Math.floor(toValue(options?.hours) ?? 24))
    const maxCount = normalizeMaxCount(toValue(options?.maxCount) ?? PING_RECORD_MAX_COUNT)
    return {
      uuid: toValue(uuid),
      hours,
      maxCount,
      cacheKey: getSharedPingRecordsKey(hours, maxCount, toValue(uuid)),
      enabled: toValue(options?.enabled) ?? true,
    }
  })
  const selection = computed(() => toValue(options?.taskSelection) ?? null)
  const latencyAggregation = computed(() => toValue(options?.latencyAggregation) ?? 'average')
  const lossAggregation = computed(() => toValue(options?.lossAggregation) ?? 'or')
  const selectionCacheKey = computed(() => [
    getPingTaskSelectionCacheKey(selection.value),
    latencyAggregation.value,
    lossAggregation.value,
  ].join(':'))

  let activeCacheKey: string | null = null
  let releaseSharedRecords: (() => void) | null = null

  function syncSharedRecordsSubscription(hours: number | null, maxCount?: number, uuid?: string): void {
    const cacheKey = hours === null ? null : getSharedPingRecordsKey(hours, maxCount, uuid)
    if (activeCacheKey === cacheKey)
      return

    releaseSharedRecords?.()
    releaseSharedRecords = null
    activeCacheKey = null

    if (hours === null)
      return

    releaseSharedRecords = retainSharedPingRecordsEntry(hours, maxCount, uuid)
    activeCacheKey = cacheKey
  }

  onScopeDispose(() => {
    syncSharedRecordsSubscription(null)
  })

  // stats 由共享 getRecords 结果派生；共享记录每分钟刷新一次后会自动重算。
  const stats = computed<NodePingStatsState>(() => {
    const { uuid: nodeUuid, hours, maxCount, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return createEmptyStats()

    // 通过 getSharedPingRecordsEntry 读取（不存在则创建），确保 computed 始终对
    // entry.data 这个 shallowRef 建立响应式依赖——即便首次加载尚未返回。
    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    const state = entry.data.value
    if (!state)
      return readStatsCache(nodeUuid, hours, maxCount, selectionCacheKey.value) ?? createEmptyStats()

    const records = state.recordsByClient.get(nodeUuid) ?? []
    return records.length || state.metricStats?.length
      ? buildStats(
          records,
          state.tasks,
          selection.value,
          state.metricStats,
          state.metricLossPoints,
          latencyAggregation.value,
          lossAggregation.value,
        )
      : createEmptyStats()
  })

  // 副作用：按需触发首次共享加载并维护 loading/error，不再命令式写入 stats。
  watch(
    resolved,
    async (next, _previous, onCleanup) => {
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })

      const { uuid: nodeUuid, hours, maxCount, enabled } = next
      if (!enabled || !nodeUuid.trim()) {
        syncSharedRecordsSubscription(null)
        loading.value = false
        error.value = null
        return
      }

      syncSharedRecordsSubscription(hours, maxCount, nodeUuid)
      const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
      const shouldLoadRecords = !entry.data.value
        || Date.now() - entry.lastFetchedAt >= PING_RECORD_REFRESH_INTERVAL_MS

      if (!shouldLoadRecords) {
        loading.value = false
        error.value = null
        return
      }

      const shouldShowLoading = !entry.data.value
      loading.value = shouldShowLoading
      error.value = null

      try {
        await loadSharedPingRecords(entry, hours, maxCount, nodeUuid)
      }
      catch (err) {
        if (!cancelled && shouldShowLoading)
          error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
      }
      finally {
        if (!cancelled)
          loading.value = false
      }
    },
    { immediate: true },
  )

  // 共享记录会定时刷新，节流回写 localStorage，避免多节点同时重算时密集写盘。
  const persistStats = useThrottleFn(
    (nodeUuid: string, hours: number, maxCount: number | undefined, selectionKey: string, value: NodePingStatsState) => {
      writeStatsCache(nodeUuid, hours, maxCount, selectionKey, value)
    },
    30_000,
    true,
    true,
  )

  watch(stats, (value) => {
    if (!value.hasData)
      return
    const { uuid: nodeUuid, hours, maxCount, enabled } = resolved.value
    if (enabled && nodeUuid.trim())
      persistStats(nodeUuid, hours, maxCount, selectionCacheKey.value, value)
  })

  return {
    stats,
    loading,
    error,
    history: computed(() => stats.value.history),
    avgLatency: computed(() => stats.value.avgLatency),
    avgLoss: computed(() => stats.value.avgLoss),
    avgVolatility: computed(() => stats.value.avgVolatility),
    hasData: computed(() => stats.value.hasData),
  }
}
