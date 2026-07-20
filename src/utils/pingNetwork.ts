export const KNOWN_PING_NETWORK_FAMILIES = ['telecom', 'unicom', 'mobile', 'education'] as const

export type KnownPingNetworkFamily = typeof KNOWN_PING_NETWORK_FAMILIES[number]
export type PingNetworkFamily = KnownPingNetworkFamily | 'other'
export type PingNetworkMode = 'auto' | 'all' | KnownPingNetworkFamily
export type PingLatencyAggregation = 'average' | 'max' | 'min'
export type PingLossAggregation = 'or' | 'and'

export interface PingTaskMeta {
  id: number
  rawId: string
  name: string
  family: PingNetworkFamily
  searchText: string
}

export interface PingTaskSelection {
  mode: PingNetworkMode
  taskId?: number
  includeAllTasks?: boolean
  preferredKeywordsByFamily?: Partial<Record<KnownPingNetworkFamily, string[]>>
}

export interface ResolvedPingTaskSelection {
  taskIds: Set<number> | null
  label: string
  family: PingNetworkFamily | null
}

export const PING_NETWORK_LABELS: Record<PingNetworkFamily, string> = {
  telecom: '电信',
  unicom: '联通',
  mobile: '移动',
  education: '教育网',
  other: '其他',
}

const PING_NETWORK_MODE_ALIASES: Record<string, PingNetworkMode> = {
  auto: 'auto',
  自动: 'auto',
  all: 'all',
  全部: 'all',
  any: 'all',
  telecom: 'telecom',
  ctcc: 'telecom',
  电信: 'telecom',
  中国电信: 'telecom',
  unicom: 'unicom',
  cucc: 'unicom',
  联通: 'unicom',
  中国联通: 'unicom',
  mobile: 'mobile',
  cmcc: 'mobile',
  移动: 'mobile',
  中国移动: 'mobile',
  education: 'education',
  edu: 'education',
  cernet: 'education',
  教育: 'education',
  教育网: 'education',
}

const PING_LATENCY_AGGREGATION_ALIASES: Record<string, PingLatencyAggregation> = {
  average: 'average',
  avg: 'average',
  mean: 'average',
  均值: 'average',
  平均: 'average',
  max: 'max',
  highest: 'max',
  最高: 'max',
  最大: 'max',
  min: 'min',
  lowest: 'min',
  最低: 'min',
  最小: 'min',
}

const PING_LOSS_AGGREGATION_ALIASES: Record<string, PingLossAggregation> = {
  or: 'or',
  any: 'or',
  或: 'or',
  任一: 'or',
  and: 'and',
  all: 'and',
  与: 'and',
  全部: 'and',
}

const NETWORK_KEYWORDS: Record<KnownPingNetworkFamily, string[]> = {
  education: ['教育网', '教育', 'cernet', 'edu.cn'],
  telecom: ['中国电信', '电信', 'ctcc', 'chinanet', 'china telecom', 'telecom', 'cn2', '163'],
  unicom: ['中国联通', '联通', 'cucc', 'china unicom', 'unicom', '9929'],
  mobile: ['中国移动', '移动', 'cmcc', 'china mobile', 'cmi', 'mobile'],
}

const PING_FAMILY_MATCH_ORDER: KnownPingNetworkFamily[] = ['education', 'telecom', 'unicom', 'mobile']
const KEYWORD_SEPARATOR_REGEX = /[\s,，;；|/]+/u
const PREFERENCE_LINE_SEPARATOR_REGEX = /[\r\n;；]+/u
const PREFERENCE_PAIR_SEPARATOR_REGEX = /[:=：]/u
const WHITESPACE_REGEX = /\s+/g

function stringifyTagValue(value: unknown): string {
  if (value === null || value === undefined)
    return ''
  if (typeof value === 'string')
    return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeTags(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value))
    return {}

  return {
    ...(isPlainRecord(value.tags) ? value.tags : {}),
    ...(isPlainRecord(value.tag) ? value.tag : {}),
    ...(isPlainRecord(value.labels) ? value.labels : {}),
  }
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(WHITESPACE_REGEX, '')
}

function includesKeyword(searchText: string, keyword: string): boolean {
  const normalizedKeyword = normalizeSearchText(keyword)
  return normalizedKeyword.length > 0 && searchText.includes(normalizedKeyword)
}

export function normalizePingNetworkMode(value: unknown, fallback: PingNetworkMode = 'auto'): PingNetworkMode {
  if (typeof value !== 'string')
    return fallback

  return PING_NETWORK_MODE_ALIASES[value.trim().toLowerCase()] ?? PING_NETWORK_MODE_ALIASES[value.trim()] ?? fallback
}

export function normalizePingLatencyAggregation(value: unknown, fallback: PingLatencyAggregation = 'average'): PingLatencyAggregation {
  if (typeof value !== 'string')
    return fallback
  return PING_LATENCY_AGGREGATION_ALIASES[value.trim().toLowerCase()] ?? PING_LATENCY_AGGREGATION_ALIASES[value.trim()] ?? fallback
}

export function normalizePingLossAggregation(value: unknown, fallback: PingLossAggregation = 'or'): PingLossAggregation {
  if (typeof value !== 'string')
    return fallback
  return PING_LOSS_AGGREGATION_ALIASES[value.trim().toLowerCase()] ?? PING_LOSS_AGGREGATION_ALIASES[value.trim()] ?? fallback
}

export function aggregatePingLatencyValues(values: number[], aggregation: PingLatencyAggregation): number | null {
  const finiteValues = values.filter(Number.isFinite)
  if (!finiteValues.length)
    return null
  if (aggregation === 'max')
    return Math.max(...finiteValues)
  if (aggregation === 'min')
    return Math.min(...finiteValues)
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
}

export function aggregatePingLossPercentages(values: number[], aggregation: PingLossAggregation): number | null {
  const ratios = values
    .filter(Number.isFinite)
    .map(value => Math.min(1, Math.max(0, value / 100)))
  if (!ratios.length)
    return null
  const combined = aggregation === 'and'
    ? ratios.reduce((result, ratio) => result * ratio, 1)
    : 1 - ratios.reduce((result, ratio) => result * (1 - ratio), 1)
  return combined * 100
}

export function isKnownPingNetworkFamily(value: unknown): value is KnownPingNetworkFamily {
  return typeof value === 'string' && (KNOWN_PING_NETWORK_FAMILIES as readonly string[]).includes(value)
}

export function normalizePingTaskId(taskId: string | number | null | undefined): number {
  const rawTaskId = stringifyTagValue(taskId).trim()
  if (!rawTaskId)
    return Number.NaN

  const numericTaskId = Number(rawTaskId)
  if (Number.isFinite(numericTaskId))
    return numericTaskId

  let hash = 0
  for (let index = 0; index < rawTaskId.length; index++)
    hash = (hash * 31 + rawTaskId.charCodeAt(index)) | 0
  return Math.abs(hash)
}

export function getPingTaskRawId(value: unknown): string {
  const record = isPlainRecord(value) ? value : {}
  const tags = mergeTags(value)
  return stringifyTagValue(record.task_id ?? record.id ?? tags.task_id ?? tags.task ?? tags.id).trim()
}

export function getPingTaskDisplayName(value: unknown, fallback = ''): string {
  const record = isPlainRecord(value) ? value : {}
  const tags = mergeTags(value)
  const name = stringifyTagValue(record.name ?? tags.task_name ?? tags.name ?? tags.task).trim()
  if (name)
    return name

  const rawId = getPingTaskRawId(value)
  return fallback || (rawId ? `Task ${rawId}` : '未知任务')
}

export function getPingTaskSearchText(value: unknown, fallbackName = ''): string {
  const record = isPlainRecord(value) ? value : {}
  const tags = mergeTags(value)
  const parts = [
    getPingTaskDisplayName(value, fallbackName),
    getPingTaskRawId(value),
    stringifyTagValue(record.type),
    ...Object.entries(tags).flatMap(([key, tagValue]) => [key, stringifyTagValue(tagValue)]),
  ]
  return normalizeSearchText(parts.filter(Boolean).join(' '))
}

export function classifyPingTask(value: unknown): PingNetworkFamily {
  const searchText = getPingTaskSearchText(value)

  for (const family of PING_FAMILY_MATCH_ORDER) {
    if (NETWORK_KEYWORDS[family].some(keyword => includesKeyword(searchText, keyword)))
      return family
  }

  return 'other'
}

export function createPingTaskMeta(value: unknown, fallbackName = ''): PingTaskMeta | null {
  const rawId = getPingTaskRawId(value)
  const id = normalizePingTaskId(rawId)
  if (!Number.isFinite(id))
    return null

  const name = getPingTaskDisplayName(value, fallbackName)
  const searchText = getPingTaskSearchText(value, name)
  return {
    id,
    rawId,
    name,
    family: classifyPingTask(value),
    searchText,
  }
}

export function parsePingTaskKeywords(rawValue: unknown): string[] {
  if (Array.isArray(rawValue)) {
    return rawValue
      .filter((item): item is string => typeof item === 'string')
      .flatMap(item => parsePingTaskKeywords(item))
  }

  if (typeof rawValue !== 'string')
    return []

  const seenKeywords = new Set<string>()
  const keywords: string[] = []
  for (const item of rawValue.split(KEYWORD_SEPARATOR_REGEX)) {
    const keyword = item.trim()
    const normalizedKeyword = normalizeSearchText(keyword)
    if (!keyword || seenKeywords.has(normalizedKeyword))
      continue
    seenKeywords.add(normalizedKeyword)
    keywords.push(keyword)
  }
  return keywords
}

export function parsePingTaskPreferenceText(rawValue: unknown): Partial<Record<KnownPingNetworkFamily, string[]>> {
  if (typeof rawValue !== 'string')
    return {}

  const preferences: Partial<Record<KnownPingNetworkFamily, string[]>> = {}

  for (const rawLine of rawValue.split(PREFERENCE_LINE_SEPARATOR_REGEX)) {
    const line = rawLine.trim()
    if (!line)
      continue

    const pairIndex = line.search(PREFERENCE_PAIR_SEPARATOR_REGEX)
    if (pairIndex <= 0)
      continue

    const family = normalizePingNetworkMode(line.slice(0, pairIndex), 'auto')
    if (!isKnownPingNetworkFamily(family))
      continue

    const keywords = parsePingTaskKeywords(line.slice(pairIndex + 1))
    if (!keywords.length)
      continue

    preferences[family] = [
      ...(preferences[family] ?? []),
      ...keywords,
    ]
  }

  return preferences
}

export function getPingTaskSelectionCacheKey(selection: PingTaskSelection | null | undefined): string {
  if (!selection)
    return 'all'

  const preferences = selection.preferredKeywordsByFamily ?? {}
  const preferenceKey = KNOWN_PING_NETWORK_FAMILIES
    .map(family => `${family}=${(preferences[family] ?? []).join(',')}`)
    .join('|')

  return [
    selection.mode,
    selection.taskId ?? 'auto',
    selection.includeAllTasks ? 'all-tasks' : 'preferred',
    preferenceKey,
  ].join(':')
}

function filterTasksByFamily(tasks: PingTaskMeta[], family: KnownPingNetworkFamily): PingTaskMeta[] {
  return tasks.filter(task => task.family === family)
}

function findPreferredTask(tasks: PingTaskMeta[], keywords: string[] | undefined): PingTaskMeta | null {
  if (!keywords?.length)
    return null

  return tasks.find(task =>
    keywords.some(keyword => includesKeyword(task.searchText, keyword)),
  ) ?? null
}

function resolveFamilySelection(
  family: KnownPingNetworkFamily,
  tasks: PingTaskMeta[],
  selection: PingTaskSelection,
): ResolvedPingTaskSelection | null {
  const familyTasks = filterTasksByFamily(tasks, family)
  if (!familyTasks.length)
    return null

  if (selection.includeAllTasks) {
    return {
      taskIds: new Set(familyTasks.map(task => task.id)),
      label: `${PING_NETWORK_LABELS[family]} · 所有`,
      family,
    }
  }

  const selectedTask = selection.taskId === undefined
    ? null
    : familyTasks.find(task => task.id === selection.taskId) ?? null
  const preferredTask = selectedTask ?? findPreferredTask(familyTasks, selection.preferredKeywordsByFamily?.[family])
  if (preferredTask) {
    return {
      taskIds: new Set([preferredTask.id]),
      label: preferredTask.name,
      family,
    }
  }

  return {
    taskIds: new Set(familyTasks.map(task => task.id)),
    label: PING_NETWORK_LABELS[family],
    family,
  }
}

export function resolvePingTaskSelection(tasks: PingTaskMeta[], selection?: PingTaskSelection | null): ResolvedPingTaskSelection {
  const mode = selection?.mode ?? 'all'
  if (!tasks.length || mode === 'all') {
    return {
      taskIds: null,
      label: mode === 'all' ? '全部线路' : '',
      family: null,
    }
  }

  if (isKnownPingNetworkFamily(mode)) {
    const resolved = resolveFamilySelection(mode, tasks, selection ?? { mode })
    if (resolved)
      return resolved

    return {
      taskIds: new Set<number>(),
      label: PING_NETWORK_LABELS[mode],
      family: mode,
    }
  }

  const preferences = selection?.preferredKeywordsByFamily ?? {}
  for (const family of KNOWN_PING_NETWORK_FAMILIES) {
    const preferredTask = findPreferredTask(filterTasksByFamily(tasks, family), preferences[family])
    if (preferredTask) {
      return {
        taskIds: new Set([preferredTask.id]),
        label: preferredTask.name,
        family,
      }
    }
  }

  const knownTasks = tasks.filter(task => task.family !== 'other')
  if (knownTasks.length) {
    const families = [...new Set(knownTasks.map(task => task.family))]
    return {
      taskIds: new Set(knownTasks.map(task => task.id)),
      label: families.length === 1 ? PING_NETWORK_LABELS[families[0]!] : '多网',
      family: families.length === 1 ? families[0]! : null,
    }
  }

  return {
    taskIds: null,
    label: '全部线路',
    family: null,
  }
}
