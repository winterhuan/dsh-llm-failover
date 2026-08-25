import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigurableProviderView, IApiClient, ModelProviderGroup, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, Input, Pill,
  IconCheckOutline14, IconChevronDownOutline14, IconChevronUpOutline14,
  IconCloseOutline16, IconPlusOutline16,
  IconSettingsOutline16, IconTrashOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './FailoverSettingsSection.module.css'
import type { FailoverSettingsKey } from './locales.ts'
import { TargetAdvancedEditor } from './TargetAdvancedEditor.tsx'
import {
  draftFromProfile, effortsFromModelEntry, fingerprint, getPathValue, layoutOf, routeOps,
  unionOptions, validateAdvanced,
} from './profile-settings.ts'
import type { AdapterLayout, ModelEffortsDraft, RouteAdvancedDraft } from './profile-settings.ts'

const SETTINGS_ROUTE = '/api/llm-failover.settings'
const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] as const
const DEFAULT_DEFAULT_CODES: string[] = [...DEFAULT_RETRYABLE_CODES]
const MIN_TARGETS = 2
const INTEGER_RX = /^-?\d+$/

interface Target {
  provider: string
  model: string
  retryCount?: number
}

interface Group {
  id: string
  targets: Target[]
  retryableCodes?: string[]
}

interface FormValue {
  groups: Group[]
  activeGroup?: string
}

interface SettingsView {
  value: FormValue
  revision: number
  writable: boolean
}

interface ProviderOption {
  id: string
  name: string
}

/** Client-only draft that adds a stable id for React keying. */
interface DraftTarget extends Target {
  /** Raw input text; parsed at validation and save time. */
  retryCountText: string
  draftId: string
}

/** Client-only draft that adds a stable id for React keying. */
interface DraftGroup extends Group {
  targets: DraftTarget[]
  draftId: string
}

interface DraftValue {
  groups: DraftGroup[]
  activeGroup: string | undefined
}

/** Injected API dependency for provider and model catalogs, settings writes, and invalidations. */
export interface FailoverSettingsInjected {
  api: Pick<IApiClient, 'llm' | 'settings'>
  /**
   * Subscribe to host invalidations (`settings/document-updated`,
   * `llm/adapters-updated`); the page refreshes advanced data while clean.
   * @returns the disposer removing the listener.
   */
  onInvalidated?: (listener: () => void) => () => void
}

/** Props supplied by the settings slot. */
type Props = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.llmFailover'>
  & FailoverSettingsInjected

type Translation = (key: FailoverSettingsKey, values?: { count?: number, index?: string }) => string

let draftCounter = 0
function nextDraftId(): string {
  draftCounter = (draftCounter % Number.MAX_SAFE_INTEGER) + 1
  return `d${draftCounter.toString(36)}`
}

function emptyTarget(): DraftTarget {
  return { provider: '', model: '', retryCountText: '0', draftId: nextDraftId() }
}

function emptyGroup(): DraftGroup {
  return {
    id: '',
    targets: [emptyTarget(), emptyTarget()],
    draftId: nextDraftId(),
  }
}

/** Take a settings view and return a draft with stable client-only ids and raw retry-count text. */
function valueOf(view: SettingsView): DraftValue {
  return {
    groups: (view.value.groups ?? []).map(group => ({
      ...group,
      draftId: nextDraftId(),
      targets: group.targets.map(target => ({
        ...target,
        retryCountText: String(target.retryCount ?? 0),
        draftId: nextDraftId(),
      })),
    })),
    activeGroup: view.value.activeGroup,
  }
}

/** Parse one retry-count draft; `undefined` marks text the host would reject. */
function parseRetryCount(text: string): number | undefined {
  if (!INTEGER_RX.test(text)) return undefined
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

/** Strip client-only fields and yield the runtime value submitted to the host. */
function valueToSave(value: DraftValue): FormValue {
  return {
    groups: value.groups.map(group => ({
      id: group.id,
      targets: group.targets.map(({ provider, model, retryCountText }) => ({
        provider, model, retryCount: parseRetryCount(retryCountText) ?? 0,
      })),
      ...(group.retryableCodes === undefined ? {} : { retryableCodes: [...group.retryableCodes] }),
    })),
    ...(value.activeGroup === undefined ? {} : { activeGroup: value.activeGroup }),
  }
}

/** Deep-equality over the values we would submit, used to detect dirty state. */
function samePersisted(a: DraftValue, b: DraftValue): boolean {
  return JSON.stringify(valueToSave(a)) === JSON.stringify(valueToSave(b))
}

async function readResponse(response: Response): Promise<SettingsView> {
  const body = await response.json() as SettingsView | { error?: unknown }
  if (!response.ok) {
    const message = 'error' in body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as SettingsView
}

function optionLabel(id: string, name: string): string {
  return id === name ? id : `${name} (${id})`
}

function retryableCodes(group: Group): string[] {
  return group.retryableCodes ?? DEFAULT_DEFAULT_CODES
}

function retryableCodeOptions(group: Group): string[] {
  return [...new Set([...DEFAULT_RETRYABLE_CODES, ...retryableCodes(group)])]
}

/** Models available under one provider, preserving a stale selection so the dropdown still lists it. */
function modelOptions(
  groups: readonly ModelProviderGroup[],
  selectedProvider: string,
  selectedModel: string,
): Array<{ id: string; name: string }> {
  const models = groups.find(group => group.id === selectedProvider)?.models ?? []
  if (models.some(model => model.id === selectedModel) || selectedModel.length === 0) return models
  return [{ id: selectedModel, name: selectedModel }, ...models]
}

function targetLabel(index: number): string {
  return String(index + 1)
}

interface GroupErrors {
  id: string[]
  /** One error-code list per target, kept in order with the targets array. */
  targets: string[][]
}

/** Validate one draft group locally, mirroring the host rules that would reject a save. */
function validateGroup(group: DraftGroup, seenIds: Set<string>): GroupErrors {
  const idErrors: string[] = []
  const targetErrors: string[][] = group.targets.map(() => [])

  if (group.id.length === 0) {
    idErrors.push('INVALID_GROUP_ID')
  } else if (/^\s|\s$|\s{2,}/.test(group.id)) {
    idErrors.push('TRIMMED_GROUP_ID')
  } else if (seenIds.has(group.id)) {
    idErrors.push('DUPLICATE_GROUP_ID')
  }
  if (group.id.length > 0) seenIds.add(group.id)

  if (group.targets.length < MIN_TARGETS) {
    idErrors.push('TOO_FEW_TARGETS')
  }

  group.targets.forEach((target, index) => {
    if (target.provider.length === 0) targetErrors[index]!.push('EMPTY_PROVIDER')
    if (target.model.length === 0) targetErrors[index]!.push('EMPTY_MODEL')
    if (parseRetryCount(target.retryCountText) === undefined) {
      targetErrors[index]!.push('INVALID_RETRY_COUNT')
    }
  })

  const seenRoutes = new Set<string>()
  group.targets.forEach((target, index) => {
    if (target.provider.length === 0 || target.model.length === 0) return
    const key = `${target.provider}\u0000${target.model}`
    if (seenRoutes.has(key)) {
      if (!targetErrors[index]!.includes('DUPLICATE_TARGET')) targetErrors[index]!.push('DUPLICATE_TARGET')
    }
    seenRoutes.add(key)
  })

  return { id: idErrors, targets: targetErrors }
}

/**
 * Top-level validation snapshot used to gate the Save button. `topErrors`
 * carries document-wide rules such as a dangling active-group reference.
 */
function validateValue(value: DraftValue): { groupErrors: GroupErrors[]; topErrors: string[]; ok: boolean } {
  const ids = new Set<string>()
  const groupErrors = value.groups.map(group => validateGroup(group, ids))
  const topErrors: string[] = []
  // An empty id never anchors the reference: clearing an active group's name
  // dangles it just like a rename to a foreign id would.
  if (value.activeGroup !== undefined
    && !value.groups.some(group => group.id.length > 0 && group.id === value.activeGroup)) {
    topErrors.push('ACTIVE_GROUP_MISSING')
  }
  const ok = topErrors.length === 0
    && groupErrors.every(group => group.id.length === 0 && group.targets.every(row => row.length === 0))
  return { groupErrors, topErrors, ok }
}

function tValidationError(t: Translation, code: string): string {
  const key = `v_${code}` as FailoverSettingsKey
  const message = t(key)
  return message === key ? code : message
}

interface RetryableCodeSelectProps {
  group: DraftGroup
  /** Unique id stem (per draft group) for the label/hint aria wiring. */
  idStem: string
  label: string
  countLabel: (count: number) => string
  emptyLabel: string
  defaultsLabel: string
  clearLabel: string
  ariaHint: string
  onChange: (codes: string[]) => void
}

function RetryableCodeSelect({
  group, idStem, label, countLabel, emptyLabel, defaultsLabel, clearLabel, ariaHint, onChange,
}: RetryableCodeSelectProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = retryableCodes(group)

  useEffect(() => {
    if (!open) return
    // Both pointer event names: browsers fire pointerdown everywhere, and the
    // mousedown twin keeps synthetic jsdom events working.
    const close = (event: Event): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const summary = selected.length === 0 ? emptyLabel : countLabel(selected.length)

  return (
    <div className={styles.codes} ref={root}>
      <span className={styles.fieldLabel} id={`${idStem}-label`}>{label}</span>
      <button
        type="button"
        ref={trigger}
        className={styles.codesTrigger}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-describedby={`${idStem}-hint`}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className={styles.codesSummary}>
          <strong>{summary}</strong>
          {selected.length > 0 && <small>{selected.join(', ')}</small>}
        </span>
        <span className={styles.chevron} aria-hidden="true"><IconChevronDownOutline14 /></span>
      </button>
      <span id={`${idStem}-hint`} className={styles.srOnly}>{ariaHint}</span>
      {open && (
        <div className={styles.codePopover} role="listbox" aria-multiselectable="true" aria-label={label}>
          <div className={styles.codeToolbar}>
            <Button variant="ghost" size="sm" onClick={() => onChange([...DEFAULT_RETRYABLE_CODES])}>{defaultsLabel}</Button>
            <Button variant="ghost" size="sm" onClick={() => onChange([])}>{clearLabel}</Button>
          </div>
          <div className={styles.codeOptions}>
            {retryableCodeOptions(group).map(code => {
              const checked = selected.includes(code)
              return (
                <label className={styles.codeOption} key={code}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange(checked
                      ? selected.filter(item => item !== code)
                      : [...selected, code])}
                  />
                  <span>{code}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** One provider route whose stored retry policy still retries before the group may switch. */
interface RouteBudgetWarning {
  provider: string
  displayName: string
  ns: string
  path: string[]
  revision: number
  effective: Record<string, unknown>
}

/** Edit ordered model groups in the host settings document. */
export function FailoverSettingsSection({ api, t, onInvalidated }: Props) {
  const [view, setView] = useState<SettingsView | undefined>()
  const [value, setValue] = useState<DraftValue | undefined>()
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [providerViews, setProviderViews] = useState<ConfigurableProviderView[]>([])
  const [modelGroups, setModelGroups] = useState<ModelProviderGroup[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'unavailable' | 'saved' | 'error'>('loading')
  const [error, setError] = useState<string | undefined>()
  // null: the settings read failed (e.g. a non-loopback browser) — advanced
  // editors degrade to a hint; undefined: not yet answered.
  const [namespaces, setNamespaces] = useState<ReadonlyMap<string, SettingsNamespaceView> | null | undefined>(undefined)
  const [advanced, setAdvanced] = useState<Record<string, RouteAdvancedDraft>>({})
  const [advancedBaseline, setAdvancedBaseline] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [budgetDismissed, setBudgetDismissed] = useState(false)
  // Last loaded (or saved) advanced drafts; Discard restores them.
  const [advancedSaved, setAdvancedSaved] = useState<{
    drafts: Record<string, RouteAdvancedDraft>
    baselines: Record<string, string>
  } | undefined>(undefined)
  const providersRef = useRef<ConfigurableProviderView[]>([])
  providersRef.current = providerViews
  const advancedDirtyRef = useRef(false)
  const loadSeqRef = useRef(0)
  const loadAbortRef = useRef<AbortController | undefined>(undefined)

  /**
   * Load the advanced (provider profile) data over `settings.describe`. The
   * call is loopback-only, like the page's own settings route; a rejection
   * degrades the advanced editors instead of failing the page.
   */
  const loadAdvanced = async (entries: ConfigurableProviderView[], signal?: AbortSignal): Promise<void> => {
    try {
      const described = await api.settings.describe({}, signal)
      if (signal?.aborted) return
      if (!described.result.ok) {
        setNamespaces(null)
        return
      }
      const map = new Map(described.result.value.namespaces.map(item => [item.ns, item]))
      const drafts: Record<string, RouteAdvancedDraft> = {}
      const baselines: Record<string, string> = {}
      for (const entry of entries) {
        const namespace = map.get(entry.settingsNs)
        if (namespace === undefined) continue
        const draft = draftFromProfile(getPathValue(namespace.value, entry.settingsPath))
        drafts[entry.provider] = draft
        baselines[entry.provider] = fingerprint(draft)
      }
      if (signal?.aborted) return
      setNamespaces(map)
      setAdvanced(drafts)
      setAdvancedBaseline(baselines)
      setAdvancedSaved({ drafts: structuredClone(drafts), baselines })
    } catch (cause) {
      if (signal?.aborted) return
      void cause
      setNamespaces(null)
    }
  }
  const loadAdvancedRef = useRef(loadAdvanced)
  loadAdvancedRef.current = loadAdvanced

  /**
   * Load everything the page renders. Each run takes a sequence number and an
   * abort controller; a superseded or aborted run applies no state at all.
   */
  const load = async (): Promise<void> => {
    const seq = ++loadSeqRef.current
    const controller = new AbortController()
    loadAbortRef.current = controller
    const { signal } = controller
    setStatus('loading')
    setError(undefined)
    try {
      const settingsResponse = await fetch(SETTINGS_ROUTE, { signal })
      if (settingsResponse.status === 404 || settingsResponse.status === 503) {
        if (seq !== loadSeqRef.current || signal.aborted) return
        setStatus('unavailable')
        return
      }
      const next = await readResponse(settingsResponse)
      const [providersResponse, modelsResponse] = await Promise.all([
        api.llm.providers({}, signal),
        api.llm.models({}, signal),
      ])
      if (seq !== loadSeqRef.current || signal.aborted) return
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!modelsResponse.result.ok) throw new Error(modelsResponse.result.error.message)
      const entries = providersResponse.result.value.providers
      setProviders(entries
        .filter(provider => provider.active)
        .map(provider => ({ id: provider.provider, name: provider.displayName })))
      setProviderViews(entries)
      setModelGroups(modelsResponse.result.value.groups)
      setView(next)
      setValue(valueOf(next))
      setStatus('ready')
      await loadAdvancedRef.current(entries, signal)
    } catch (cause) {
      if (signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return
      if (seq !== loadSeqRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }

  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    })
    return () => {
      loadAbortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  // A pushed settings/adapters invalidation refreshes advanced data only
  // while no advanced edit would be clobbered.
  useEffect(() => {
    if (onInvalidated === undefined) return
    return onInvalidated(() => {
      if (advancedDirtyRef.current) return
      void loadAdvancedRef.current(providersRef.current)
    })
  }, [onInvalidated])

  const advancedDirty = useMemo(
    () => Object.entries(advanced).some(([provider, draft]) => fingerprint(draft) !== advancedBaseline[provider]),
    [advanced, advancedBaseline],
  )
  advancedDirtyRef.current = advancedDirty

  const advancedErrors = useMemo(() => {
    const errors: Record<string, string[]> = {}
    for (const [provider, draft] of Object.entries(advanced)) {
      const codes = validateAdvanced(draft)
      if (codes.length > 0) errors[provider] = codes
    }
    return errors
  }, [advanced])

  const savedValue = useMemo<DraftValue | undefined>(() => view === undefined ? undefined : valueOf(view), [view])
  const dirty = useMemo<boolean>(() => {
    if (savedValue === undefined || value === undefined) return false
    return !samePersisted(value, savedValue)
  }, [savedValue, value])
  const validation = useMemo(() => value === undefined ? null : validateValue(value), [value])
  const canSave = status === 'ready' && (dirty || advancedDirty)
    && (validation?.ok ?? false)
    && Object.keys(advancedErrors).length === 0
    && (view?.writable ?? false)

  /**
   * Routes referenced by the draft whose stored retry policy retries at the
   * provider level before this plugin can advance the group. A policy is
   * quiet only when normal-mode retries are explicitly zero.
   */
  const budgetWarnings = useMemo<RouteBudgetWarning[]>(() => {
    if (namespaces === undefined || namespaces === null || view?.writable === false || value === undefined) return []
    const referenced = new Set(value.groups.flatMap(group => group.targets.map(target => target.provider)))
    const warnings: RouteBudgetWarning[] = []
    for (const entry of providerViews) {
      if (!referenced.has(entry.provider)) continue
      if (layoutOf(entry.settingsNs) === 'unknown') continue
      const namespace = namespaces.get(entry.settingsNs)
      if (namespace === undefined) continue
      const path = [...entry.settingsPath, 'retryPolicy']
      const policy = getPathValue(namespace.value, path)
      const record = typeof policy === 'object' && policy !== null ? policy as Record<string, unknown> : undefined
      const quiet = record?.['mode'] === 'normal' && record['maxRetries'] === 0
      if (quiet) continue
      warnings.push({
        provider: entry.provider,
        displayName: entry.displayName,
        ns: entry.settingsNs,
        path,
        revision: namespace.revision,
        effective: record ?? {},
      })
    }
    return warnings
  }, [namespaces, providerViews, value, view])

  const save = async (): Promise<void> => {
    if (view === undefined || value === undefined) return
    if (validation !== null && !validation.ok) return
    setStatus('saving')
    setError(undefined)
    try {
      const groupDirty = savedValue !== undefined && !samePersisted(value, savedValue)
      if (groupDirty) {
        const response = await fetch(SETTINGS_ROUTE, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            value: valueToSave(value),
            expectedRevision: view.revision,
          }),
        })
        const next = await readResponse(response)
        setView(next)
        setValue(valueOf(next))
      }
      // Route profiles commit after the group document; a refused write stops
      // later routes and reports inline without rolling earlier commits back.
      for (const [provider, draft] of Object.entries(advanced)) {
        if (fingerprint(draft) === advancedBaseline[provider]) continue
        const entry = providerViews.find(item => item.provider === provider)
        if (entry === undefined || namespaces === undefined || namespaces === null) continue
        const namespace = namespaces.get(entry.settingsNs)
        const layout = layoutOf(entry.settingsNs)
        if (namespace === undefined || layout === 'unknown') continue
        const ops = routeOps({
          layout,
          settingsPath: entry.settingsPath,
          draft,
          effective: getPathValue(namespace.value, entry.settingsPath),
          user: getPathValue(namespace.user, entry.settingsPath),
        })
        if (ops.length === 0) continue
        const mutated = await api.settings.mutate({ ns: entry.settingsNs, ops, expectedRevision: namespace.revision })
        if (!mutated.result.ok) {
          setError(mutated.result.error.code === 'settings-conflict' ? t('advConflict') : mutated.result.error.message)
          setStatus('error')
          await loadAdvanced(providerViews)
          return
        }
      }
      await loadAdvanced(providerViews)
      setStatus('saved')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }

  /** Zero one warned route's provider-level retries through the standard mutate wire. */
  const alignRetryBudget = async (warning: RouteBudgetWarning): Promise<void> => {
    setError(undefined)
    try {
      const mutated = await api.settings.mutate({
        ns: warning.ns,
        ops: [{ op: 'set', path: warning.path, value: { ...warning.effective, mode: 'normal', maxRetries: 0 } }],
        expectedRevision: warning.revision,
      })
      if (!mutated.result.ok) {
        setError(mutated.result.error.code === 'settings-conflict' ? t('advConflict') : mutated.result.error.message)
        setStatus('error')
        await loadAdvanced(providerViews)
        return
      }
      await loadAdvanced(providerViews)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }

  const discard = (): void => {
    if (savedValue === undefined) return
    setValue(valueOf({ value: valueToSave(savedValue), revision: view?.revision ?? 0, writable: view?.writable ?? true }))
    setError(undefined)
    setStatus('ready')
    if (advancedSaved !== undefined) {
      setAdvanced(structuredClone(advancedSaved.drafts))
      setAdvancedBaseline({ ...advancedSaved.baselines })
    } else {
      void loadAdvancedRef.current(providersRef.current)
    }
  }

  if (status === 'loading') return <p className={styles.placeholder}>{t('loading')}</p>
  if (status === 'unavailable') return <p className={styles.placeholder}>{t('unavailable')}</p>
  if (value === undefined) return <p className={styles.placeholder}>{error}</p>

  const updateGroup = (index: number, group: DraftGroup): void => setValue({
    ...value,
    groups: value.groups.map((item, itemIndex) => itemIndex === index ? group : item),
  })

  /** Renaming follows the active-group reference so a rename never dangles it. */
  const renameGroup = (index: number, id: string): void => {
    const previousId = value.groups[index]!.id
    setValue({
      ...value,
      groups: value.groups.map((item, itemIndex) => itemIndex === index ? { ...item, id } : item),
      activeGroup: value.activeGroup === previousId ? id : value.activeGroup,
    })
  }

  const addGroup = (): void => setValue({ ...value, groups: [...value.groups, emptyGroup()] })

  const removeGroup = (index: number): void => {
    setValue(previous => {
      if (previous === undefined) return previous
      const removed = previous.groups[index]?.id
      return {
        groups: previous.groups.filter((_item, itemIndex) => itemIndex !== index),
        activeGroup: previous.activeGroup === removed ? undefined : previous.activeGroup,
      }
    })
  }

  const setActive = (id: string): void => setValue(previous =>
    previous === undefined ? previous : { ...previous, activeGroup: id })

  const resetModelForProvider = (groupIndex: number, targetIndex: number, provider: string): void => {
    const group = value.groups[groupIndex]!
    updateGroup(groupIndex, {
      ...group,
      targets: group.targets.map((item, itemIndex) =>
        itemIndex === targetIndex ? { ...item, provider, model: '' } : item,
      ),
    })
  }

  const updateTarget = (groupIndex: number, targetIndex: number, patch: Partial<DraftTarget>): void => {
    const group = value.groups[groupIndex]!
    updateGroup(groupIndex, {
      ...group,
      targets: group.targets.map((item, itemIndex) =>
        itemIndex === targetIndex ? { ...item, ...patch } : item,
      ),
    })
  }

  const addTarget = (groupIndex: number): void => {
    const group = value.groups[groupIndex]!
    updateGroup(groupIndex, { ...group, targets: [...group.targets, emptyTarget()] })
  }

  const removeTarget = (groupIndex: number, targetIndex: number): void => {
    const group = value.groups[groupIndex]!
    updateGroup(groupIndex, {
      ...group,
      targets: group.targets.filter((_item, itemIndex) => itemIndex !== targetIndex),
    })
  }

  const moveTarget = (groupIndex: number, targetIndex: number, delta: -1 | 1): void => {
    const group = value.groups[groupIndex]!
    const targets = [...group.targets]
    const next = targetIndex + delta
    if (next < 0 || next >= targets.length) return
    const [moved] = targets.splice(targetIndex, 1)
    if (moved !== undefined) targets.splice(next, 0, moved)
    updateGroup(groupIndex, { ...group, targets })
  }

  const empty = value.groups.length === 0

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>{t('title')}</h2>
          <p className={styles.intro}>{t('description')}</p>
        </div>
        <div className={styles.statusArea} aria-live="polite">
          {status === 'saved' && !dirty && (
            <Pill className={styles.statusSaved}><IconCheckOutline14 />{t('saved')}</Pill>
          )}
          {dirty && status !== 'saving' && (
            <Pill className={styles.statusDirty}>{t('unsaved')}</Pill>
          )}
          {status === 'saving' && (
            <Pill>{t('saving')}</Pill>
          )}
          {view?.writable === false && (
            <Pill>{t('readOnly')}</Pill>
          )}
        </div>
      </header>

      {empty ? (
        <div className={styles.empty} role="status">
          <p className={styles.emptyTitle}>{t('emptyTitle')}</p>
          <p className={styles.emptyDescription}>{t('emptyDescription')}</p>
          <Button variant="primary" icon={<IconPlusOutline16 />} onClick={addGroup}>{t('addGroup')}</Button>
        </div>
      ) : (
        <div className={styles.groupList}>
          {value.groups.map((group, groupIndex) => {
            const errors = validation?.groupErrors[groupIndex] ?? { id: [], targets: [] }
            const isActive = value.activeGroup === group.id && group.id.length > 0
            const groupId = group.id.length === 0 ? t('newGroup') : group.id
            return (
              <fieldset
                className={styles.groupCard}
                key={group.draftId}
                aria-invalid={errors.id.length > 0 ? 'true' : undefined}
              >
                <legend className={styles.groupLegend}>
                  <span className={styles.groupBadge} aria-hidden="true">{targetLabel(groupIndex)}</span>
                  <span className={styles.groupTitle}>{groupId}</span>
                </legend>
                <div className={styles.groupHeader}>
                  <label className={styles.groupIdRow}>
                    <span className={styles.fieldLabel}>{t('groupId')}</span>
                    <Input
                      value={group.id}
                      aria-invalid={errors.id.length > 0 ? 'true' : undefined}
                      aria-describedby={errors.id.length > 0 ? `err-${group.draftId}` : undefined}
                      onChange={event => renameGroup(groupIndex, event.target.value)}
                    />
                  </label>
                  <div className={styles.activeBlock}>
                    <label className={styles.active}>
                      <input
                        type="radio"
                        name="activeGroup"
                        checked={isActive}
                        onChange={() => setActive(group.id)}
                      />
                      {t('active')}
                    </label>
                    <p className={styles.activeHint}>{t('activeHint')}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.dangerButton}
                    onClick={() => removeGroup(groupIndex)}
                  >
                    <IconTrashOutline16 />
                    {t('removeGroup')}
                  </Button>
                </div>
                {errors.id.length > 0 && (
                  <ul className={styles.errorList} id={`err-${group.draftId}`} role="alert">
                    {errors.id.map(code => <li key={code}>{tValidationError(t, code)}</li>)}
                  </ul>
                )}

                <div className={styles.targetsHeading}>
                  <strong>{t('targets')}</strong>
                  <span className={styles.targetCount} aria-hidden="true">
                    {group.targets.length}
                  </span>
                </div>
                <ol className={styles.targetList}>
                  {group.targets.map((target, targetIndex) => {
                    const targetErr = errors.targets[targetIndex] ?? []
                    // The advanced editor reads its provider's route entry and
                    // namespace; a route without a resolvable namespace renders
                    // the unsupported hint instead of dead controls.
                    const routeEntry = providerViews.find(item => item.provider === target.provider)
                    const namespace = routeEntry === undefined || namespaces == null
                      ? undefined
                      : namespaces.get(routeEntry.settingsNs)
                    const settingsPath = routeEntry?.settingsPath ?? []
                    const layout: AdapterLayout = namespace === undefined || advanced[target.provider] === undefined
                      ? 'unknown'
                      : layoutOf(routeEntry?.settingsNs)
                    const advancedDraft = advanced[target.provider]
                    const reasoningLevels = layout === 'pi-ai' && namespace !== undefined
                      ? unionOptions(namespace.schema, [...settingsPath, 'reasoning'])
                      : []
                    const effortOptions = layout === 'deepseek' && namespace !== undefined
                      ? unionOptions(namespace.schema, [...settingsPath, 'reasoningEffort'])
                      : []
                    let modelInCatalog = false
                    let modelEfforts: ModelEffortsDraft | undefined
                    if (layout === 'pi-ai' && namespace !== undefined && advancedDraft !== undefined && target.model.length > 0) {
                      const models = getPathValue(namespace.value, [...settingsPath, 'models'])
                      const entry = Array.isArray(models)
                        ? models.find(item => typeof item === 'object' && item !== null
                          && (item as { id?: unknown }).id === target.model)
                        : undefined
                      modelInCatalog = entry !== undefined
                      modelEfforts = advancedDraft.efforts[target.model]
                        ?? effortsFromModelEntry(entry, reasoningLevels)
                    }
                    return (
                      <li className={styles.target} key={target.draftId}>
                        <div className={styles.targetTop}>
                          <div className={styles.targetFields}>
                            <label className={styles.fieldProvider}>
                              <span className={styles.fieldLabel}>{t('provider')}</span>
                              <select
                                className={styles.selectInput}
                                value={target.provider}
                                aria-invalid={targetErr.includes('EMPTY_PROVIDER') ? 'true' : undefined}
                                onChange={event => resetModelForProvider(groupIndex, targetIndex, event.target.value)}
                              >
                                <option value="">{t('selectProvider')}</option>
                                {providers.map(provider => (
                                  <option value={provider.id} key={provider.id}>
                                    {optionLabel(provider.id, provider.name)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className={styles.fieldModel}>
                              <span className={styles.fieldLabel}>{t('model')}</span>
                              <select
                                className={styles.selectInput}
                                value={target.model}
                                disabled={target.provider.length === 0}
                                aria-invalid={targetErr.includes('EMPTY_MODEL') ? 'true' : undefined}
                                onChange={event => updateTarget(groupIndex, targetIndex, { model: event.target.value })}
                              >
                                <option value="">{t('selectModel')}</option>
                                {modelOptions(modelGroups, target.provider, target.model).map(model => (
                                  <option value={model.id} key={model.id}>{optionLabel(model.id, model.name)}</option>
                                ))}
                              </select>
                            </label>
                            <label className={styles.retryField}>
                              <span className={styles.fieldLabel}>{t('retryCount')}</span>
                              <Input
                                type="number"
                                min="0"
                                step="1"
                                inputMode="numeric"
                                value={target.retryCountText}
                                aria-invalid={targetErr.includes('INVALID_RETRY_COUNT') ? 'true' : undefined}
                                onChange={event => updateTarget(groupIndex, targetIndex, {
                                  retryCountText: event.target.value,
                                })}
                              />
                            </label>
                          </div>
                          <div className={styles.targetActions}>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={styles.squareButton}
                              disabled={targetIndex === 0}
                              aria-label={t('moveTargetUp', { index: targetLabel(targetIndex) })}
                              title={t('moveTargetUp', { index: targetLabel(targetIndex) })}
                              onClick={() => moveTarget(groupIndex, targetIndex, -1)}
                            >
                              <IconChevronUpOutline14 />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={styles.squareButton}
                              disabled={targetIndex === group.targets.length - 1}
                              aria-label={t('moveTargetDown', { index: targetLabel(targetIndex) })}
                              title={t('moveTargetDown', { index: targetLabel(targetIndex) })}
                              onClick={() => moveTarget(groupIndex, targetIndex, 1)}
                            >
                              <IconChevronDownOutline14 />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={styles.dangerButton}
                              disabled={group.targets.length <= MIN_TARGETS}
                              title={t('removeTarget', { index: targetLabel(targetIndex) })}
                              onClick={() => removeTarget(groupIndex, targetIndex)}
                            >
                              <IconTrashOutline16 />
                              {t('remove')}
                            </Button>
                            {target.provider.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className={styles.squareButton}
                                aria-expanded={expanded[target.draftId] === true}
                                aria-label={t('advToggle')}
                                title={t('advToggle')}
                                onClick={() => setExpanded(current => ({
                                  ...current,
                                  [target.draftId]: current[target.draftId] !== true,
                                }))}
                              >
                                <IconSettingsOutline16 />
                              </Button>
                            )}
                          </div>
                        </div>
                        {targetErr.length > 0 && (
                          <ul className={styles.errorList} role="alert">
                            {targetErr.map(code => <li key={code}>{tValidationError(t, code)}</li>)}
                          </ul>
                        )}
                        {expanded[target.draftId] === true && target.provider.length > 0 && (
                          <TargetAdvancedEditor
                            layout={layout}
                            namespacesAvailable={namespaces !== null}
                            model={target.model}
                            modelInCatalog={modelInCatalog}
                            modelEfforts={modelEfforts}
                            reasoningLevels={reasoningLevels}
                            effortOptions={effortOptions}
                            draft={advancedDraft ?? draftFromProfile(undefined)}
                            errors={advancedErrors[target.provider] ?? []}
                            disabled={status === 'saving' || view?.writable === false}
                            t={t}
                            onModelEffortsChange={(next) => {
                              if (advancedDraft === undefined) return
                              setAdvanced((current) => {
                                const route = current[target.provider]
                                if (route === undefined) return current
                                const efforts = { ...route.efforts }
                                if (next === undefined) delete efforts[target.model]
                                else efforts[target.model] = next
                                return { ...current, [target.provider]: { ...route, efforts } }
                              })
                            }}
                            onChange={(next) => {
                              setAdvanced(current => ({ ...current, [target.provider]: next }))
                            }}
                          />
                        )}
                      </li>
                    )
                  })}
                </ol>
                <div className={styles.addTargetRow}>
                  <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => addTarget(groupIndex)}>
                    {t('addTarget')}
                  </Button>
                </div>
                <RetryableCodeSelect
                  group={group}
                  idStem={`failover-codes-${group.draftId}`}
                  label={t('codes')}
                  countLabel={count => t('codesSelected', { count })}
                  emptyLabel={t('noCodes')}
                  defaultsLabel={t('selectDefaults')}
                  clearLabel={t('clearCodes')}
                  ariaHint={t('codesHint')}
                  onChange={codes => updateGroup(groupIndex, { ...group, retryableCodes: codes })}
                />
              </fieldset>
            )
          })}
        </div>
      )}

      {budgetWarnings.length > 0 && !budgetDismissed && (
        <div className={styles.budgetWarning} role="note">
          <div className={styles.budgetWarningHead}>
            <IconWarningOutline16 />
            <p className={styles.advancedHint}>{t('budgetWarning')}</p>
          </div>
          <ul className={styles.budgetRoutes}>
            {budgetWarnings.map(warning => (
              <li className={styles.budgetRoute} key={warning.provider}>
                <span className={styles.budgetRouteName}>{optionLabel(warning.provider, warning.displayName)}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={status === 'saving'}
                  onClick={() => { void alignRetryBudget(warning) }}
                >
                  {t('budgetAlign')}
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            className={`${styles.squareButton} ${styles.budgetDismiss}`}
            aria-label={t('budgetDismiss')}
            title={t('budgetDismiss')}
            onClick={() => setBudgetDismissed(true)}
          >
            <IconCloseOutline16 />
          </Button>
        </div>
      )}

      {validation !== null && validation.topErrors.map(code => (
        <p key={code} role="alert" className={styles.error}>{tValidationError(t, code)}</p>
      ))}

      <div className={styles.actions}>
        <Button variant="ghost" icon={<IconPlusOutline16 />} onClick={addGroup}>
          {t('addGroup')}
        </Button>
        <div className={styles.actionsRight}>
          {(dirty || advancedDirty) && (
            <Button
              variant="outline"
              disabled={status === 'saving'}
              onClick={() => { discard() }}
            >
              {t('discard')}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={() => { void save() }}
          >
            {status === 'saving' ? t('saving') : t('save')}
          </Button>
        </div>
      </div>

      {error !== undefined && <p role="alert" className={styles.error}>{error}</p>}
    </section>
  )
}
