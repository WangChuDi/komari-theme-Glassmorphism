export interface PingQualityMetricStats {
  avg: number | null
  p95: number | null
  p99: number | null
}

export interface PingQualityPeriodStats {
  latency: PingQualityMetricStats
  loss: PingQualityMetricStats
}

export interface PingQualityRow {
  key: string
  label: string
  peak: PingQualityPeriodStats
  offPeak: PingQualityPeriodStats
}

export interface NodePingQualitySummary {
  uuid: string
  name: string
  rows: PingQualityRow[]
}
