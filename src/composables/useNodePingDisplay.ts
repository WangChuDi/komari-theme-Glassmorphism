import type { MaybeRefOrGetter } from 'vue'
import type { KnownPingNetworkFamily, PingTaskSelection } from '@/utils/pingNetwork'
import { computed, toValue } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'
import { isKnownPingNetworkFamily, KNOWN_PING_NETWORK_FAMILIES, PING_NETWORK_LABELS } from '@/utils/pingNetwork'

export type NodePingMetric = 'latency' | 'loss'

export interface NodePingBar {
  key: string
  className: string
  tooltip: string
}

interface UseNodePingDisplayOptions {
  enabled?: MaybeRefOrGetter<boolean>
  loadingDisplayText?: string
  emptyDisplayText?: string
  loadingPanelTooltipText?: Partial<Record<NodePingMetric, string>>
  emptyPanelTooltipText?: Partial<Record<NodePingMetric, string>>
  taskSelection?: MaybeRefOrGetter<PingTaskSelection | null | undefined>
}

export interface NodePingNetworkRow {
  key: KnownPingNetworkFamily
  label: string
  taskLabel: string
  latencyDisplay: string
  lossDisplay: string
  latencyToneClass: string
  lossToneClass: string
  tooltip: string
  hasData: boolean
  loading: boolean
}

const EMPTY_PING_BAR_COUNT = 20

function getLatencyToneClass(latency: number): string {
  if (latency <= 60)
    return 'bg-signal-1'
  if (latency <= 100)
    return 'bg-signal-2'
  if (latency <= 160)
    return 'bg-signal-3 ping-signal-pattern-2'
  if (latency <= 200)
    return 'bg-signal-4 ping-signal-pattern-3'
  return 'bg-signal-5 ping-signal-pattern-4'
}

function getLossToneClass(loss: number): string {
  if (loss <= 1)
    return 'bg-signal-1'
  if (loss <= 3)
    return 'bg-signal-2'
  if (loss <= 6)
    return 'bg-signal-3 ping-signal-pattern-2'
  if (loss <= 9)
    return 'bg-signal-4 ping-signal-pattern-3'
  return 'bg-signal-5 ping-signal-pattern-4'
}

export function useNodePingDisplay(
  uuid: MaybeRefOrGetter<string>,
  options: UseNodePingDisplayOptions = {},
) {
  const appStore = useAppStore()

  const pingStatsEnabled = computed(() => {
    if (appStore.publicSettings?.record_enabled === false)
      return false
    return appStore.publicSettings?.ping_record_preserve_time !== 0 && (toValue(options.enabled) ?? true)
  })

  const pingStatsHours = computed(() => {
    const preserveTime = appStore.publicSettings?.ping_record_preserve_time
    if (typeof preserveTime === 'number' && preserveTime > 0)
      return Math.min(preserveTime, 1)
    return 1
  })

  const defaultHomePingTaskSelection = computed<PingTaskSelection>(() => {
    const mode = appStore.homePingNetworkMode
    const selectedTaskId = isKnownPingNetworkFamily(mode)
      ? Number(appStore.homePingTaskSelections[mode])
      : Number.NaN

    return {
      mode,
      taskId: Number.isFinite(selectedTaskId) ? selectedTaskId : undefined,
      preferredKeywordsByFamily: appStore.homePingPreferredTaskKeywords,
    }
  })
  const homePingTaskSelection = computed<PingTaskSelection | null | undefined>(() => {
    return toValue(options.taskSelection) ?? defaultHomePingTaskSelection.value
  })

  const pingStats = useNodePingStats(uuid, {
    hours: pingStatsHours,
    enabled: pingStatsEnabled,
    taskSelection: homePingTaskSelection,
  })

  const pingScopeLabel = computed(() => pingStats.stats.value.taskLabel)

  function buildPingBars(metric: NodePingMetric): NodePingBar[] {
    const points = pingStats.history.value
    if (!points.length)
      return []

    const scope = pingScopeLabel.value
    return points.map((point, index) => {
      const value = point[metric]
      const metricLabel = metric === 'latency' ? '延迟' : '丢包'

      return {
        key: `${point.time}-${index}`,
        className: value === null
          ? 'bg-muted-foreground/15'
          : metric === 'latency'
            ? getLatencyToneClass(value)
            : getLossToneClass(value),
        tooltip: value === null
          ? `${formatDateTime(point.time, 'HH:mm:ss')}\n无采样数据`
          : metric === 'latency'
            ? `${formatDateTime(point.time, 'HH:mm:ss')}\n${scope ? `${scope} ` : ''}${metricLabel} ${Math.round(value)} ms`
            : `${formatDateTime(point.time, 'HH:mm:ss')}\n${scope ? `${scope} ` : ''}${metricLabel} ${value.toFixed(1)}%`,
      }
    })
  }

  function buildEmptyPingBars(metric: NodePingMetric): NodePingBar[] {
    const tooltip = pingStats.loading.value
      ? '加载中'
      : pingStats.error.value
        ? '加载失败'
        : !pingStatsEnabled.value
            ? '未启用记录'
            : metric === 'latency'
              ? '无采样数据'
              : '无采样数据'

    return Array.from({ length: EMPTY_PING_BAR_COUNT }, (_, index) => ({
      key: `${metric}-empty-${index}`,
      className: 'bg-muted-foreground/10',
      tooltip,
    }))
  }

  const latencyBars = computed(() => buildPingBars('latency'))
  const lossBars = computed(() => buildPingBars('loss'))
  const latencyRenderBars = computed(() => latencyBars.value.length ? latencyBars.value : buildEmptyPingBars('latency'))
  const lossRenderBars = computed(() => lossBars.value.length ? lossBars.value : buildEmptyPingBars('loss'))

  const latencyDisplay = computed(() => {
    if (pingStats.hasData.value)
      return `${Math.round(pingStats.avgLatency.value)} ms`
    if (pingStats.loading.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '-'
  })

  const lossDisplay = computed(() => {
    if (pingStats.hasData.value)
      return `${pingStats.avgLoss.value.toFixed(1)}%`
    if (pingStats.loading.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '-'
  })

  const latencyPanelTooltip = computed(() => {
    if (!pingStats.hasData.value) {
      if (pingStats.loading.value)
        return options.loadingPanelTooltipText?.latency ?? ''
      return options.emptyPanelTooltipText?.latency ?? ''
    }
    const scope = pingScopeLabel.value ? `${pingScopeLabel.value} · ` : ''
    return `${scope}平均延迟 ${Math.round(pingStats.avgLatency.value)} ms`
  })

  const lossPanelTooltip = computed(() => {
    if (!pingStats.hasData.value) {
      if (pingStats.loading.value)
        return options.loadingPanelTooltipText?.loss ?? ''
      return options.emptyPanelTooltipText?.loss ?? ''
    }

    const volatility = pingStats.avgVolatility.value > 0
      ? `，平均波动 ${pingStats.avgVolatility.value.toFixed(2)}`
      : ''
    const scope = pingScopeLabel.value ? `${pingScopeLabel.value} · ` : ''
    return `${scope}平均丢包 ${pingStats.avgLoss.value.toFixed(1)}%${volatility}`
  })

  return {
    pingStats,
    pingStatsEnabled,
    pingStatsHours,
    latencyRenderBars,
    lossRenderBars,
    latencyDisplay,
    lossDisplay,
    pingScopeLabel,
    latencyPanelTooltip,
    lossPanelTooltip,
  }
}

export function useNodePingMultiDisplay(
  uuid: MaybeRefOrGetter<string>,
  options: UseNodePingDisplayOptions = {},
) {
  const appStore = useAppStore()

  const networkDisplays = KNOWN_PING_NETWORK_FAMILIES.map((family) => {
    const taskSelection = computed<PingTaskSelection>(() => {
      const selectedTaskId = Number(appStore.homePingTaskSelections[family])
      return {
        mode: family,
        taskId: Number.isFinite(selectedTaskId) ? selectedTaskId : undefined,
        preferredKeywordsByFamily: appStore.homePingPreferredTaskKeywords,
      }
    })
    return {
      family,
      display: useNodePingDisplay(uuid, {
        ...options,
        taskSelection,
      }),
    }
  })

  const rows = computed<NodePingNetworkRow[]>(() => {
    const enabledFamilies = new Set(appStore.homePingMultiNetworkFamilies)

    return networkDisplays
      .filter(item => enabledFamilies.has(item.family))
      .map(({ family, display }): NodePingNetworkRow => {
        const networkLabel = PING_NETWORK_LABELS[family]
        const taskLabel = display.pingScopeLabel.value
        const hasData = display.pingStats.hasData.value
        const loading = display.pingStats.loading.value
        const latency = display.pingStats.avgLatency.value
        const loss = display.pingStats.avgLoss.value
        const scope = taskLabel && taskLabel !== networkLabel ? `${networkLabel} · ${taskLabel}` : networkLabel
        const tooltip = hasData
          ? `${scope}\n平均延迟 ${Math.round(latency)} ms\n平均丢包 ${loss.toFixed(1)}%`
          : loading
            ? `${scope}\n加载中`
            : `${scope}\n无采样数据`

        return {
          key: family,
          label: networkLabel,
          taskLabel,
          latencyDisplay: hasData
            ? `${Math.round(latency)} ms`
            : loading
              ? options.loadingDisplayText ?? '加载中'
              : options.emptyDisplayText ?? '-',
          lossDisplay: hasData
            ? `${loss.toFixed(1)}%`
            : loading
              ? options.loadingDisplayText ?? '加载中'
              : options.emptyDisplayText ?? '-',
          latencyToneClass: hasData ? getLatencyToneClass(latency) : 'bg-muted-foreground/15',
          lossToneClass: hasData ? getLossToneClass(loss) : 'bg-muted-foreground/15',
          tooltip,
          hasData,
          loading,
        }
      })
      .filter(row => !appStore.homePingMultiHideEmpty || row.hasData || row.loading)
  })

  const anyLoading = computed(() => networkDisplays.some(item => item.display.pingStats.loading.value))
  const hasAnyData = computed(() => rows.value.some(row => row.hasData))
  const emptyText = computed(() => {
    if (anyLoading.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '暂无线路'
  })

  return {
    rows,
    anyLoading,
    hasAnyData,
    emptyText,
  }
}
