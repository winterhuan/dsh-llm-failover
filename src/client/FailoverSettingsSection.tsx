import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigurableProviderView, IApiClient, ModelProviderGroup, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
  retryCount: number
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
  return { provider: '', model: '', retryCount: 0, draftId: nextDraftId() }
}

function emptyGroup(): DraftGroup {
  return {
    id: '',
    targets: [emptyTarget(), emptyTarget()],
    draftId: nextDraftId(),
  }
}

/** Take a settings view and return a draft with stable client-only ids and a numeric retryCount. */
function valueOf(view: SettingsView): DraftValue {
  return {
    groups: (view.value.groups ?? []).map(group => ({
      ...group,
      draftId: nextDraftId(),
      targets: group.targets.map(target => ({
        ...target,
        retryCount: target.retryCount ?? 0,
        draftId: nextDraftId(),
      })),
    })),
    activeGroup: view.value.activeGroup,
  }
}

/** Strip client-only fields and yield the runtime value submitted to the host. */
function valueToSave(value: DraftValue): FormValue {
  return {
    groups: value.groups.map(group => ({
      id: group.id,
      targets: group.targets.map(({ provider, model, retryCount }) => ({ provider, model, retryCount })),
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
    if (!Number.isSafeInteger(target.retryCount) || target.retryCount < 0) {
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

/** Top-level validation snapshot used to gate the Save button. */
function validateValue(value: DraftValue): { groupErrors: GroupErrors[]; ok: boolean } {
  const ids = new Set<string>()
  const groupErrors = value.groups.map(group => validateGroup(group, ids))
  const ok = groupErrors.every(group => group.id.length === 0 && group.targets.every(row => row.length === 0))
  return { groupErrors, ok }
}

function tValidationError(t: Translation, code: string): string {
  const key = `v_${code}` as FailoverSettingsKey
  const message = t(key)
  return message === key ? code : message
}

interface RetryableCodeSelectProps {
  group: Group
  label: string
  countLabel: (count: number) => string
  emptyLabel: string
  defaultsLabel: string
  clearLabel: string
  ariaHint: string
  onChange: (codes: string[]) => void
}

function RetryableCodeSelect({
  group, label, countLabel, emptyLabel, defaultsLabel, clearLabel, ariaHint, onChange,
}: RetryableCodeSelectProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = retryableCodes(group)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const summary = selected.length === 0 ? emptyLabel : countLabel(selected.length)

  return (
    <div className={styles.codes} ref={root}>
      <span className={styles.codesLabel} id="failover-codes-label">{label}</span>
      <button
        type="button"
        ref={trigger}
        className={styles.codeTrigger}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-describedby="failover-codes-hint"
        onClick={() => setOpen(prev => !prev)}
      >
        <span className={styles.codeTriggerText}>
          <strong>{summary}</strong>
          {selected.length > 0 && <small>{selected.join(', ')}</small>}
        </span>
        <span className={styles.chevron} aria-hidden="true" />
      </button>
      <span id="failover-codes-hint" className={styles.srOnly}>{ariaHint}</span>
      {open && (
        <div className={styles.codePopover} role="listbox" aria-multiselectable="true" aria-label={label}>
          <div className={styles.codeToolbar}>
            <button type="button" onClick={() => onChange([...DEFAULT_RETRYABLE_CODES])}>{defaultsLabel}</button>
            <button type="button" onClick={() => onChange([])}>{clearLabel}</button>
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
  const providersRef = useRef<ConfigurableProviderView[]>([])
  providersRef.current = providerViews
  const advancedDirtyRef = useRef(false)

  /**
   * Load the advanced (provider profile) data over `settings.describe`. The
   * call is loopback-only, like the page's own settings route; a rejection
   * degrades the advanced editors instead of failing the page.
   */
  const loadAdvanced = async (entries: ConfigurableProviderView[]): Promise<void> => {
    try {
      const described = await api.settings.describe({})
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
      setNamespaces(map)
      setAdvanced(drafts)
      setAdvancedBaseline(baselines)
    } catch (cause) {
      void cause
      setNamespaces(null)
    }
  }
  const loadAdvancedRef = useRef(loadAdvanced)
  loadAdvancedRef.current = loadAdvanced

  const load = async (): Promise<void> => {
    setStatus('loading')
    setError(undefined)
    const settingsResponse = await fetch(SETTINGS_ROUTE)
    if (settingsResponse.status === 404 || settingsResponse.status === 503) {
      setStatus('unavailable')
      return
    }
    const next = await readResponse(settingsResponse)
    const [providersResponse, modelsResponse] = await Promise.all([
      api.llm.providers({}),
      api.llm.models({}),
    ])
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
    await loadAdvanced(entries)
  }

  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    })
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

  const discard = (): void => {
    if (savedValue === undefined) return
    setValue(valueOf({ value: valueToSave(savedValue), revision: view?.revision ?? 0, writable: view?.writable ?? true }))
    setError(undefined)
    setStatus('ready')
  }

  if (status === 'loading') return <p className={styles.placeholder}>{t('loading')}</p>
  if (status === 'unavailable') return <p className={styles.placeholder}>{t('unavailable')}</p>
  if (value === undefined) return <p className={styles.placeholder}>{error}</p>

  const updateGroup = (index: number, group: DraftGroup): void => setValue({
    ...value,
    groups: value.groups.map((item, itemIndex) => itemIndex === index ? group : item),
  })

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

  const retryCountFromInput = (raw: string): number => {
    if (raw === '' || !INTEGER_RX.test(raw)) return 0
    return Math.max(0, Math.trunc(Number(raw)))
  }

  const empty = value.groups.length === 0

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h2>{t('title')}</h2>
          <p className={styles.description}>{t('description')}</p>
        </div>
        <div className={styles.statusArea} aria-live="polite">
          {status === 'saved' && !dirty && (
            <span className={`${styles.statusChip} ${styles.statusSaved}`}>{t('saved')}</span>
          )}
          {dirty && status !== 'saving' && (
            <span className={`${styles.statusChip} ${styles.statusDirty}`}>{t('unsaved')}</span>
          )}
          {status === 'saving' && (
            <span className={`${styles.statusChip} ${styles.statusSaving}`}>{t('saving')}</span>
          )}
          {view?.writable === false && (
            <span className={`${styles.statusChip} ${styles.statusReadOnly}`}>{t('readOnly')}</span>
          )}
        </div>
      </header>

      {empty ? (
        <div className={styles.empty} role="status">
          <p className={styles.emptyTitle}>{t('emptyTitle')}</p>
          <p className={styles.emptyDescription}>{t('emptyDescription')}</p>
          <button type="button" className={styles.primaryButton} onClick={addGroup}>{t('addGroup')}</button>
        </div>
      ) : (
        <div className={styles.groupList}>
          {value.groups.map((group, groupIndex) => {
            const errors = validation?.groupErrors[groupIndex] ?? { id: [], targets: [] }
            const isActive = value.activeGroup === group.id && group.id.length > 0
            const groupId = group.id.length === 0 ? t('newGroup') : group.id
            return (
              <fieldset
                className={styles.group}
                key={group.draftId}
                aria-invalid={errors.id.length > 0 ? 'true' : undefined}
              >
                <legend className={styles.groupLegend}>
                  <span className={styles.groupBadge} aria-hidden="true">{targetLabel(groupIndex)}</span>
                  <span className={styles.groupTitle}>{groupId}</span>
                </legend>
                <div className={styles.groupHeader}>
                  <label className={styles.groupIdRow}>
                    <span>{t('groupId')}</span>
                    <input
                      value={group.id}
                      aria-invalid={errors.id.length > 0 ? 'true' : undefined}
                      aria-describedby={errors.id.length > 0 ? `err-${group.draftId}` : undefined}
                      onChange={event => updateGroup(groupIndex, { ...group, id: event.target.value })}
                    />
                  </label>
                  <label className={styles.active}>
                    <input
                      type="radio"
                      name="activeGroup"
                      checked={isActive}
                      onChange={() => setActive(group.id)}
                    />
                    {t('active')}
                  </label>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => removeGroup(groupIndex)}
                  >
                    {t('removeGroup')}
                  </button>
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
                        <div className={styles.targetIndex} aria-hidden="true">{targetLabel(targetIndex)}</div>
                        <div className={styles.targetFields}>
                          <label className={styles.fieldProvider}>
                            <span>{t('provider')}</span>
                            <select
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
                            <span>{t('model')}</span>
                            <select
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
                          <label className={styles.retryCount}>
                            <span>{t('retryCount')}</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              value={target.retryCount}
                              aria-invalid={targetErr.includes('INVALID_RETRY_COUNT') ? 'true' : undefined}
                              onChange={event => updateTarget(groupIndex, targetIndex, {
                                retryCount: retryCountFromInput(event.target.value),
                              })}
                            />
                          </label>
                        </div>
                        <div className={styles.targetActions}>
                          <button
                            type="button"
                            className={styles.iconButton}
                            disabled={targetIndex === 0}
                            aria-label={t('moveTargetUp', { index: targetLabel(targetIndex) })}
                            title={t('moveTargetUp', { index: targetLabel(targetIndex) })}
                            onClick={() => moveTarget(groupIndex, targetIndex, -1)}
                          >
                            <span aria-hidden="true">↑</span>
                          </button>
                          <button
                            type="button"
                            className={styles.iconButton}
                            disabled={targetIndex === group.targets.length - 1}
                            aria-label={t('moveTargetDown', { index: targetLabel(targetIndex) })}
                            title={t('moveTargetDown', { index: targetLabel(targetIndex) })}
                            onClick={() => moveTarget(groupIndex, targetIndex, 1)}
                          >
                            <span aria-hidden="true">↓</span>
                          </button>
                          <button
                            type="button"
                            className={styles.dangerButton}
                            disabled={group.targets.length <= MIN_TARGETS}
                            title={t('removeTarget', { index: targetLabel(targetIndex) })}
                            onClick={() => removeTarget(groupIndex, targetIndex)}
                          >
                            {t('remove')}
                          </button>
                          {target.provider.length > 0 && (
                            <button
                              type="button"
                              className={styles.iconButton}
                              aria-expanded={expanded[target.draftId] === true}
                              aria-label={t('advToggle')}
                              title={t('advToggle')}
                              onClick={() => setExpanded(current => ({
                                ...current,
                                [target.draftId]: current[target.draftId] !== true,
                              }))}
                            >
                              <span aria-hidden="true">⚙</span>
                            </button>
                          )}
                        </div>
                        {targetErr.length > 0 && (
                          <ul className={`${styles.errorList} ${styles.targetErrorList}`} role="alert">
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
                  <button type="button" onClick={() => addTarget(groupIndex)}>{t('addTarget')}</button>
                </div>
                <RetryableCodeSelect
                  group={group}
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

      <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} onClick={addGroup}>
          {t('addGroup')}
        </button>
        <div className={styles.actionsRight}>
          {dirty && (
            <button
              type="button"
              disabled={status === 'saving'}
              onClick={() => { if (dirty) discard() }}
            >
              {t('discard')}
            </button>
          )}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canSave}
            onClick={() => { void save() }}
          >
            {status === 'saving' ? t('saving') : t('save')}
          </button>
        </div>
      </div>

      {error !== undefined && <p role="alert" className={styles.error}>{error}</p>}
    </section>
  )
}
