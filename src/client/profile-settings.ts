/**
 * Per-route adapter profile advanced settings: drafts, schema-derived option
 * reads, validation, and minimal `settings.mutate` path ops. Every field
 * edited here is an existing adapter `Config` member — the failover page
 * writes `llm-deepseek` profiles at the section root and `llm-pi-ai` profiles
 * under `providers.<route>`; unknown namespaces render a hint instead.
 */

import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** Adapter families this page knows how to edit. */
export type AdapterLayout = 'deepseek' | 'pi-ai' | 'unknown'

/** Select the curated layout by owning settings namespace. */
export function layoutOf(ns: string | undefined): AdapterLayout {
  if (ns === 'llm-deepseek') return 'deepseek'
  if (ns === 'llm-pi-ai') return 'pi-ai'
  return 'unknown'
}

/** Schemastery's built-in retry-policy defaults, surfaced as placeholders and 「恢复默认」. */
export const RETRY_DEFAULTS = {
  maxRetries: 5,
  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
} as const

/** Upper delay bound shared with the host policy (`MAX_TIMER_DELAY_MS`). */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Editable retry-policy draft; numeric fields stay raw strings until validated. */
export interface RetryPolicyDraft {
  enabled: boolean
  mode: 'normal' | 'always'
  maxRetries: string
  retryableCodes: string[]
  initialDelayMs: string
  maxDelayMs: string
  jitterRatio: string
}

/** One reasoning level's wire spelling; `enabled` materials the map key. */
export interface LevelDraft {
  enabled: boolean
  spelling: string
}

/** Per-model offered-levels draft (pi-ai `models[].reasoningEfforts`). */
export interface ModelEffortsDraft {
  /** `true` stores `false` for the model's reasoningEfforts. */
  disabled: boolean
  levels: Record<string, LevelDraft>
}

/** Advanced draft for one provider route, shared across every target on that route. */
export interface RouteAdvancedDraft {
  retry: RetryPolicyDraft
  /** DeepSeek profile `reasoningEffort`; '' means unset. */
  reasoningEffort: string
  /** pi-ai profile default `reasoning`; '' means unset. */
  reasoning: string
  /** pi-ai per-model offered-levels edits, keyed by target model id. */
  efforts: Record<string, ModelEffortsDraft>
}

// ---------------------------------------------------------------------------
// Minimal nested-value helpers (objects and arrays; paths are strings).

export function getPathValue(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function hasPathValue(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return true
  const parent = getPathValue(value, path.slice(0, -1))
  return typeof parent === 'object' && parent !== null && path[path.length - 1]! in (parent as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Raw schemastery envelope walking (refs-keyed node table, no rehydration).

interface SerializedNode {
  type?: string
  value?: unknown
  list?: number[]
  dict?: Record<string, number>
  inner?: number
}

interface SerializedEnvelope {
  uid: number
  refs: Record<string, SerializedNode>
}

function nodeAt(envelope: SerializedEnvelope, path: readonly string[]): SerializedNode | undefined {
  let node: SerializedNode | undefined = envelope.refs[String(envelope.uid)]
  for (const key of path) {
    if (node === undefined) return undefined
    if (node.type === 'object' && node.dict !== undefined) {
      const next = node.dict[key]
      node = next === undefined ? undefined : envelope.refs[String(next)]
    } else if (node.type === 'dict' && node.inner !== undefined) {
      node = envelope.refs[String(node.inner)]
    } else if (node.type === 'array' && node.inner !== undefined && /^\d+$/.test(key)) {
      node = envelope.refs[String(node.inner)]
    } else {
      return undefined
    }
  }
  return node
}

/**
 * Read the string choices of a union at `path` inside a namespace schema.
 * Missing nodes or non-union shapes answer an empty list, and the page hides
 * the control rather than inventing options.
 */
export function unionOptions(namespaceSchema: unknown, path: readonly string[]): string[] {
  if (typeof namespaceSchema !== 'object' || namespaceSchema === null) return []
  const envelope = namespaceSchema as SerializedEnvelope
  const node = nodeAt(envelope, path)
  if (node?.type !== 'union' || node.list === undefined) return []
  return node.list
    .map(uid => envelope.refs[String(uid)]?.value)
    .filter((value): value is string => typeof value === 'string')
}

// ---------------------------------------------------------------------------
// Draft initialization from the redacted resolved profile value.

function retryDraftFrom(raw: unknown): RetryPolicyDraft {
  const policy = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
  const backoff = typeof policy?.['backoff'] === 'object' && policy['backoff'] !== null
    ? policy['backoff'] as Record<string, unknown>
    : undefined
  const num = (value: unknown, fallback: number): string =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : String(fallback)
  return {
    enabled: policy !== undefined,
    mode: policy?.['mode'] === 'always' ? 'always' : 'normal',
    maxRetries: typeof policy?.['maxRetries'] === 'number' ? String(policy['maxRetries']) : String(RETRY_DEFAULTS.maxRetries),
    retryableCodes: Array.isArray(policy?.['retryableCodes'])
      ? (policy['retryableCodes'] as unknown[]).filter((code): code is string => typeof code === 'string')
      : [...RETRY_DEFAULTS.retryableCodes],
    initialDelayMs: num(backoff?.['initialDelayMs'], RETRY_DEFAULTS.initialDelayMs),
    maxDelayMs: num(backoff?.['maxDelayMs'], RETRY_DEFAULTS.maxDelayMs),
    jitterRatio: num(backoff?.['jitterRatio'], RETRY_DEFAULTS.jitterRatio),
  }
}

/** Build the shared advanced draft for one route from its effective profile value. */
export function draftFromProfile(effective: unknown): RouteAdvancedDraft {
  const profile = typeof effective === 'object' && effective !== null ? effective as Record<string, unknown> : {}
  return {
    retry: retryDraftFrom(profile['retryPolicy']),
    reasoningEffort: typeof profile['reasoningEffort'] === 'string' ? profile['reasoningEffort'] : '',
    reasoning: typeof profile['reasoning'] === 'string' ? profile['reasoning'] : '',
    efforts: {},
  }
}

/**
 * Build the per-model levels draft from a pi-ai `models` entry. `levelsOrder`
 * names every offerable level; a present map key starts enabled.
 */
export function effortsFromModelEntry(entry: unknown, levelsOrder: readonly string[]): ModelEffortsDraft | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const raw = (entry as Record<string, unknown>)['reasoningEfforts']
  if (raw === undefined) {
    return { disabled: false, levels: Object.fromEntries(levelsOrder.map(level => [level, { enabled: false, spelling: '' }])) }
  }
  if (raw === false) {
    return { disabled: true, levels: Object.fromEntries(levelsOrder.map(level => [level, { enabled: false, spelling: '' }])) }
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const map = raw as Record<string, unknown>
  const levels: Record<string, LevelDraft> = {}
  for (const level of levelsOrder) {
    const present = level in map
    const spelling = map[level]
    levels[level] = { enabled: present, spelling: present && typeof spelling === 'string' ? spelling : '' }
  }
  return { disabled: false, levels }
}

// ---------------------------------------------------------------------------
// Validation (client mirror of the host retry-policy rules).

/** Validation codes translated through the `v_ADV_*` locale keys. */
export type AdvancedError = 'MAX_RETRIES' | 'CODES_EMPTY' | 'CODES_DUPLICATE' | 'CODES_BLANK' | 'DELAY' | 'DELAY_ORDER' | 'JITTER'

const INTEGER_RX = /^-?\d+$/

function delayPair(raw: string): { value: number } | { error: true } {
  if (!/^\d+(\.\d+)?$/.test(raw)) return { error: true }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) return { error: true }
  return { value }
}

export function validateAdvanced(draft: RouteAdvancedDraft): AdvancedError[] {
  if (!draft.retry.enabled) return []
  const errors: AdvancedError[] = []
  const retry = draft.retry
  if (retry.mode === 'normal') {
    if (!INTEGER_RX.test(retry.maxRetries) || Number(retry.maxRetries) < 0 || !Number.isSafeInteger(Number(retry.maxRetries))) {
      errors.push('MAX_RETRIES')
    }
    if (retry.retryableCodes.length === 0) errors.push('CODES_EMPTY')
    if (new Set(retry.retryableCodes).size !== retry.retryableCodes.length) errors.push('CODES_DUPLICATE')
    if (retry.retryableCodes.some(code => code.trim().length === 0)) errors.push('CODES_BLANK')
  }
  const initial = delayPair(retry.initialDelayMs)
  const max = delayPair(retry.maxDelayMs)
  if ('error' in initial || 'error' in max) {
    errors.push('DELAY')
  } else if (initial.value > max.value) {
    errors.push('DELAY_ORDER')
  }
  const jitter = Number(retry.jitterRatio)
  if (!/^\d+(\.\d+)?$/.test(retry.jitterRatio) || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    errors.push('JITTER')
  }
  return errors
}

/** Resolve a validated retry draft into the stored retryPolicy value. */
export function resolveRetryPolicy(draft: RetryPolicyDraft): Record<string, unknown> {
  const backoff = {
    initialDelayMs: Number(draft.initialDelayMs),
    maxDelayMs: Number(draft.maxDelayMs),
    jitterRatio: Number(draft.jitterRatio),
  }
  return draft.mode === 'normal'
    ? { mode: 'normal', maxRetries: Number(draft.maxRetries), retryableCodes: [...draft.retryableCodes], backoff }
    : { mode: 'always', backoff }
}

// ---------------------------------------------------------------------------
// Draft → minimal path ops against the stored user section.

/**
 * Resolve the stored per-model reasoningEfforts value from a levels draft.
 * Returns `false`, a spelling map, or `undefined` (remove the key).
 */
export function resolveEfforts(draft: ModelEffortsDraft): false | Record<string, string> | undefined {
  if (draft.disabled) return false
  const map: Record<string, string> = {}
  for (const [level, levelDraft] of Object.entries(draft.levels)) {
    if (levelDraft.enabled) map[level] = levelDraft.spelling
  }
  return Object.keys(map).length > 0 ? map : undefined
}

export interface RouteOpsInput {
  layout: 'deepseek' | 'pi-ai'
  /** Path from the namespace section root to this route's profile. */
  settingsPath: readonly string[]
  draft: RouteAdvancedDraft
  /** Redacted resolved profile value (schema defaults → base → user). */
  effective: unknown
  /** Raw user-layer profile subtree, when one exists. */
  user: unknown
}

function setOrUnset(
  ops: SettingsPathOpView[],
  path: string[],
  next: unknown,
  effectiveRaw: unknown,
  userHas: boolean,
): void {
  if (next === undefined) {
    if (userHas) ops.push({ op: 'unset', path })
    return
  }
  if (effectiveRaw === undefined || JSON.stringify(effectiveRaw) !== JSON.stringify(next)) {
    ops.push({ op: 'set', path, value: next })
  }
}

/**
 * Build the minimal path ops carrying a route draft over the stored profile.
 * An empty result means the draft matches the stored state.
 */
export function routeOps(input: RouteOpsInput): SettingsPathOpView[] {
  const { settingsPath, draft, effective, user } = input
  const ops: SettingsPathOpView[] = []
  const userHas = (key: string): boolean => hasPathValue(user, [key])

  if (draft.retry.enabled) {
    const resolved = resolveRetryPolicy(draft.retry)
    setOrUnset(ops, [...settingsPath, 'retryPolicy'], resolved, getPathValue(effective, ['retryPolicy']), userHas('retryPolicy'))
  } else {
    setOrUnset(ops, [...settingsPath, 'retryPolicy'], undefined, undefined, userHas('retryPolicy'))
  }

  if (input.layout === 'deepseek') {
    setOrUnset(ops, [...settingsPath, 'reasoningEffort'],
      draft.reasoningEffort === '' ? undefined : draft.reasoningEffort,
      getPathValue(effective, ['reasoningEffort']), userHas('reasoningEffort'))
  }

  if (input.layout === 'pi-ai') {
    setOrUnset(ops, [...settingsPath, 'reasoning'],
      draft.reasoning === '' ? undefined : draft.reasoning,
      getPathValue(effective, ['reasoning']), userHas('reasoning'))

    const models = getPathValue(effective, ['models'])
    if (Array.isArray(models) && Object.keys(draft.efforts).length > 0) {
      let changed = false
      const nextModels = (models as unknown[]).map((entry) => {
        if (typeof entry !== 'object' || entry === null) return entry
        const record = entry as Record<string, unknown>
        const modelId = record['id']
        if (typeof modelId !== 'string' || draft.efforts[modelId] === undefined) return entry
        const resolved = resolveEfforts(draft.efforts[modelId]!)
        const current = record['reasoningEfforts']
        if (JSON.stringify(current ?? undefined) === JSON.stringify(resolved ?? undefined)) return entry
        changed = true
        const next = { ...record }
        if (resolved === undefined) delete next['reasoningEfforts']
        else next['reasoningEfforts'] = resolved
        return next
      })
      if (changed) ops.push({ op: 'set', path: [...settingsPath, 'models'], value: nextModels })
    }
  }

  return ops
}

/** A loaded namespace pair used by the page for one route's reads and writes. */
export interface RouteNamespace {
  ns: string
  settingsPath: string[]
  namespace: SettingsNamespaceView
}

/** Stable JSON fingerprint for dirty tracking of an advanced draft. */
export function fingerprint(draft: RouteAdvancedDraft): string {
  return JSON.stringify(draft)
}
