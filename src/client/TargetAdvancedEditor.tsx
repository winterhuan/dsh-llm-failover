/**
 * Collapsible advanced editor inside one failover target row: the provider
 * route's retry policy and reasoning defaults, straight onto the adapter
 * profile via settings path ops. The draft is route-scoped — every target on
 * the same provider route shares it, and the UI says so.
 */

import type { ReactNode } from 'react'
import styles from './FailoverSettingsSection.module.css'
import type { FailoverSettingsKey } from './locales.ts'
import type {
  AdapterLayout, LevelDraft, ModelEffortsDraft, RouteAdvancedDraft,
} from './profile-settings.ts'
import { RETRY_DEFAULTS } from './profile-settings.ts'

type Translation = (key: FailoverSettingsKey, values?: { count?: number, index?: string }) => string

/** Props of {@link TargetAdvancedEditor}. */
export interface TargetAdvancedEditorProps {
  layout: AdapterLayout
  /** Whether the host settings namespaces were readable at all. */
  namespacesAvailable: boolean
  /** Target model id (drives the pi-ai per-model levels editor). */
  model: string
  /** Whether the target model has a `models` entry to edit (pi-ai). */
  modelInCatalog: boolean
  /** Current per-model levels draft (seeded from the stored entry on first open). */
  modelEfforts: ModelEffortsDraft | undefined
  onModelEffortsChange: (next: ModelEffortsDraft | undefined) => void
  /** Selectable levels for the pi-ai efforts map and default, schema-derived. */
  reasoningLevels: string[]
  /** Selectable DeepSeek profile efforts, schema-derived. */
  effortOptions: string[]
  draft: RouteAdvancedDraft
  errors: string[]
  disabled: boolean
  t: Translation
  onChange: (next: RouteAdvancedDraft) => void
}

function patchRetry(
  props: TargetAdvancedEditorProps,
  patch: Partial<RouteAdvancedDraft['retry']>,
): void {
  props.onChange({ ...props.draft, retry: { ...props.draft.retry, ...patch } })
}

function RetryPolicyEditor(props: TargetAdvancedEditorProps): ReactNode {
  const { draft, disabled, t } = props
  const retry = draft.retry
  const numericField = (
    key: 'maxRetries' | 'initialDelayMs' | 'maxDelayMs' | 'jitterRatio',
    label: string,
  ): ReactNode => (
    <label className={styles.advField}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={retry[key]}
        disabled={disabled}
        aria-label={label}
        onChange={event => patchRetry(props, { [key]: event.target.value })}
      />
    </label>
  )
  return (
    <div className={styles.advBlock}>
      <label className={styles.advToggle}>
        <input
          type="checkbox"
          checked={retry.enabled}
          disabled={disabled}
          aria-label={t('advRetryEnable')}
          onChange={event => patchRetry(props, { enabled: event.target.checked })}
        />
        {t('advRetryEnable')}
      </label>
      {retry.enabled && (
        <>
          <div className={styles.advModeRow} role="radiogroup" aria-label={t('advRetryMode')}>
            <label>
              <input
                type="radio"
                checked={retry.mode === 'normal'}
                disabled={disabled}
                onChange={() => patchRetry(props, { mode: 'normal' })}
              />
              {t('advModeNormal')}
            </label>
            <label>
              <input
                type="radio"
                checked={retry.mode === 'always'}
                disabled={disabled}
                onChange={() => patchRetry(props, { mode: 'always' })}
              />
              {t('advModeAlways')}
            </label>
          </div>
          {retry.mode === 'normal' && (
            <>
              {numericField('maxRetries', t('advMaxRetries'))}
              <div className={styles.advField}>
                <span>{t('advRetryableCodes')}</span>
                <div className={styles.advCodes}>
                  {retry.retryableCodes.map(code => (
                    <button
                      key={code}
                      type="button"
                      className={styles.advCodeChip}
                      disabled={disabled}
                      title={t('advCodeRemove')}
                      onClick={() => patchRetry(props, {
                        retryableCodes: retry.retryableCodes.filter(item => item !== code),
                      })}
                    >
                      {code}
                      <span aria-hidden="true"> ×</span>
                    </button>
                  ))}
                  <AddCodeControl
                    existing={retry.retryableCodes}
                    disabled={disabled}
                    t={t}
                    onAdd={(code) => patchRetry(props, { retryableCodes: [...retry.retryableCodes, code] })}
                  />
                </div>
              </div>
            </>
          )}
          <div className={styles.advBackoff}>
            {numericField('initialDelayMs', t('advInitialDelay'))}
            {numericField('maxDelayMs', t('advMaxDelay'))}
            {numericField('jitterRatio', t('advJitter'))}
          </div>
          <button
            type="button"
            className={styles.advDefaults}
            disabled={disabled}
            onClick={() => patchRetry(props, {
              mode: 'normal',
              maxRetries: String(RETRY_DEFAULTS.maxRetries),
              retryableCodes: [...RETRY_DEFAULTS.retryableCodes],
              initialDelayMs: String(RETRY_DEFAULTS.initialDelayMs),
              maxDelayMs: String(RETRY_DEFAULTS.maxDelayMs),
              jitterRatio: String(RETRY_DEFAULTS.jitterRatio),
            })}
          >
            {t('advRetryDefaults')}
          </button>
        </>
      )}
    </div>
  )
}

function AddCodeControl(props: {
  existing: string[]
  disabled: boolean
  t: Translation
  onAdd: (code: string) => void
}): ReactNode {
  const choices = RETRY_DEFAULTS.retryableCodes.filter(code => !props.existing.includes(code))
  return (
    <select
      className={styles.advCodeAdd}
      value=""
      disabled={props.disabled}
      aria-label={props.t('advCodeAdd')}
      onChange={(event) => {
        if (event.target.value !== '') props.onAdd(event.target.value)
      }}
    >
      <option value="">{props.t('advCodeAdd')}</option>
      {choices.map(code => <option key={code} value={code}>{code}</option>)}
    </select>
  )
}

function ReasoningEditor(props: TargetAdvancedEditorProps): ReactNode {
  const { layout, draft, disabled, t } = props
  if (layout === 'deepseek') {
    return (
      <div className={styles.advField}>
        <span>{t('advEffort')}</span>
        <select
          value={draft.reasoningEffort}
          disabled={disabled || props.effortOptions.length === 0}
          aria-label={t('advEffort')}
          onChange={event => props.onChange({ ...draft, reasoningEffort: event.target.value })}
        >
          <option value="">{t('advUnset')}</option>
          {props.effortOptions.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
    )
  }
  if (layout === 'pi-ai') {
    const efforts = props.modelEfforts
    const patchEfforts = props.onModelEffortsChange
    const patchLevel = (level: string, patch: Partial<LevelDraft>): void => {
      if (efforts === undefined) return
      patchEfforts({ ...efforts, levels: { ...efforts.levels, [level]: { ...efforts.levels[level], ...patch } as LevelDraft } })
    }
    return (
      <>
        <div className={styles.advField}>
          <span>{t('advReasoningDefault')}</span>
          <select
            value={draft.reasoning}
            disabled={disabled || props.reasoningLevels.length === 0}
            aria-label={t('advReasoningDefault')}
            onChange={event => props.onChange({ ...draft, reasoning: event.target.value })}
          >
            <option value="">{t('advUnset')}</option>
            {props.reasoningLevels.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        {!props.modelInCatalog
          ? null
          : efforts === undefined
            ? null
            : (
              <div className={styles.advBlock}>
                <label className={styles.advToggle}>
                  <input
                    type="checkbox"
                    checked={efforts.disabled}
                    disabled={disabled}
                    aria-label={t('advEffortsDisable')}
                    onChange={event => patchEfforts({ ...efforts, disabled: event.target.checked })}
                  />
                  {t('advEffortsDisable')}
                </label>
                {!efforts.disabled && props.reasoningLevels.map((level) => {
                  const entry = efforts.levels[level] ?? { enabled: false, spelling: '' }
                  return (
                    <div className={styles.advLevelRow} key={level}>
                      <label className={styles.advToggle}>
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          disabled={disabled}
                          aria-label={level}
                          onChange={event => patchLevel(level, { enabled: event.target.checked })}
                        />
                        {level}
                      </label>
                      {entry.enabled && (
                        <input
                          type="text"
                          className={styles.advSpelling}
                          value={entry.spelling}
                          placeholder={level}
                          disabled={disabled}
                          aria-label={`${props.model} ${level}`}
                          onChange={event => patchLevel(level, { spelling: event.target.value })}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
      </>
    )
  }
  return null
}

/** The advanced editor body for one target row. */
export function TargetAdvancedEditor(props: TargetAdvancedEditorProps): ReactNode {
  const { t } = props
  if (!props.namespacesAvailable) {
    return <p className={styles.advancedHint}>{t('advUnavailable')}</p>
  }
  if (props.layout === 'unknown') {
    return <p className={styles.advancedHint}>{t('advUnsupported')}</p>
  }
  return (
    <div className={styles.advanced}>
      <p className={styles.advancedHint}>{t('advShared')}</p>
      <RetryPolicyEditor {...props} />
      <ReasoningEditor {...props} />
      {props.layout === 'pi-ai' && props.model.length > 0 && !props.modelInCatalog && (
        <p className={styles.advancedHint}>{t('advModelNotInCatalog')}</p>
      )}
      {props.errors.length > 0 && (
        <ul className={styles.errorList} role="alert">
          {props.errors.map(code => <li key={code}>{t(`v_ADV_${code}` as FailoverSettingsKey)}</li>)}
        </ul>
      )}
    </div>
  )
}
