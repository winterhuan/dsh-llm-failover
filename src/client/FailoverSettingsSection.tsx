import { useEffect, useState } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './FailoverSettingsSection.module.css'

const NAMESPACE = 'llm-failover'

interface Target {
  provider: string
  model: string
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

/** Injected API dependency for the Settings section. */
export interface FailoverSettingsInjected {
  api: Pick<IApiClient, 'settings'>
}

/** Props supplied by the settings slot. */
type Props = PropsRuntime<'settings.section'> & PropsLocale<'settings.llmFailover'> & Partial<FailoverSettingsInjected>

interface DraftValue {
  groups: Group[]
  activeGroup: string | undefined
}

function emptyGroup(): Group {
  return { id: '', targets: [{ provider: '', model: '' }, { provider: '', model: '' }] }
}

function valueOf(view: SettingsNamespaceView): DraftValue {
  const raw = view.value as Partial<FormValue>
  return { groups: raw.groups ?? [], activeGroup: raw.activeGroup }
}

/** Edit ordered model groups in the host settings document. */
export function FailoverSettingsSection({ api, t }: Props) {
  const [view, setView] = useState<SettingsNamespaceView>()
  const [value, setValue] = useState<DraftValue>()
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'unavailable' | 'saved' | 'error'>('loading')
  const [error, setError] = useState<string>()

  const load = async (): Promise<void> => {
    if (api === undefined) return
    setStatus('loading')
    const response = await api.settings.describe({})
    if (!response.result.ok) throw new Error(response.result.error.message)
    const next = response.result.value.namespaces.find(item => item.ns === NAMESPACE)
    if (next === undefined) {
      setStatus('unavailable')
      return
    }
    setView(next)
    setValue(valueOf(next))
    setStatus('ready')
  }

  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    })
  }, [api])

  const save = async (): Promise<void> => {
    if (api === undefined || view === undefined || value === undefined) return
    setStatus('saving')
    setError(undefined)
    try {
      const response = await api.settings.mutate({
        ns: NAMESPACE,
        ops: [{ op: 'set', path: [], value: {
          groups: value.groups,
          ...(value.activeGroup === undefined ? {} : { activeGroup: value.activeGroup }),
        } }],
        expectedRevision: view.revision,
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      setView(response.result.value)
      setValue(valueOf(response.result.value))
      setStatus('saved')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }

  if (status === 'loading') return <p className={styles.placeholder}>{t('loading')}</p>
  if (status === 'unavailable') return <p className={styles.placeholder}>{t('unavailable')}</p>
  if (value === undefined) return <p className={styles.placeholder}>{error}</p>

  const updateGroup = (index: number, group: Group): void => setValue({
    ...value,
    groups: value.groups.map((item, itemIndex) => itemIndex === index ? group : item),
  })

  return (
    <section className={styles.page}>
      <h2>{t('title')}</h2>
      <p className={styles.description}>{t('description')}</p>
      {value.groups.map((group, groupIndex) => (
        <fieldset className={styles.group} key={`${groupIndex}-${group.id}`}>
          <div className={styles.groupHeader}>
            <label>
              {t('groupId')}
              <input value={group.id} onChange={event => updateGroup(groupIndex, { ...group, id: event.target.value })} />
            </label>
            <label className={styles.active}>
              <input
                type="radio"
                name="activeGroup"
                checked={value.activeGroup === group.id && group.id.length > 0}
                onChange={() => setValue({ ...value, activeGroup: group.id })}
              />
              {t('active')}
            </label>
            <button type="button" onClick={() => setValue({
              ...value,
              groups: value.groups.filter((_item, index) => index !== groupIndex),
              ...(value.activeGroup === group.id ? { activeGroup: undefined } : {}),
            })}>{t('remove')}</button>
          </div>
          <strong>{t('targets')}</strong>
          {group.targets.map((target, targetIndex) => (
            <div className={styles.target} key={targetIndex}>
              <input aria-label={t('provider')} placeholder={t('provider')} value={target.provider} onChange={event => updateGroup(groupIndex, {
                ...group,
                targets: group.targets.map((item, index) => index === targetIndex ? { ...item, provider: event.target.value } : item),
              })} />
              <input aria-label={t('model')} placeholder={t('model')} value={target.model} onChange={event => updateGroup(groupIndex, {
                ...group,
                targets: group.targets.map((item, index) => index === targetIndex ? { ...item, model: event.target.value } : item),
              })} />
              <button type="button" disabled={group.targets.length <= 2} onClick={() => updateGroup(groupIndex, {
                ...group,
                targets: group.targets.filter((_item, index) => index !== targetIndex),
              })}>{t('remove')}</button>
            </div>
          ))}
          <button type="button" onClick={() => updateGroup(groupIndex, {
            ...group,
            targets: [...group.targets, { provider: '', model: '' }],
          })}>{t('addTarget')}</button>
          <label className={styles.codes}>
            {t('codes')}
            <input value={group.retryableCodes?.join(', ') ?? ''} onChange={event => updateGroup(groupIndex, {
              ...group,
              retryableCodes: event.target.value.split(',').map(code => code.trim()).filter(Boolean),
            })} />
          </label>
        </fieldset>
      ))}
      <div className={styles.actions}>
        <button type="button" onClick={() => setValue({ ...value, groups: [...value.groups, emptyGroup()] })}>{t('addGroup')}</button>
        <button type="button" disabled={status === 'saving'} onClick={() => { void save() }}>{status === 'saving' ? t('saving') : t('save')}</button>
        {status === 'saved' && <span>{t('saved')}</span>}
      </div>
      {error !== undefined && <p role="alert" className={styles.error}>{error}</p>}
    </section>
  )
}
