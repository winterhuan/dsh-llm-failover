import { describe, expect, it } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import {
  draftFromProfile, effortsFromModelEntry, getPathValue, hasPathValue, layoutOf, resolveEfforts,
  resolveRetryPolicy, routeOps, unionOptions, validateAdvanced,
} from '../src/client/profile-settings.ts'
import type { RouteAdvancedDraft } from '../src/client/profile-settings.ts'

describe('layoutOf', () => {
  it('maps the two known adapter namespaces and degrades others', () => {
    expect(layoutOf('llm-deepseek')).toBe('deepseek')
    expect(layoutOf('llm-pi-ai')).toBe('pi-ai')
    expect(layoutOf('other')).toBe('unknown')
    expect(layoutOf(undefined)).toBe('unknown')
  })
})

describe('raw schema envelope walk', () => {
  const serialized = Schema.object({
    reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
    providers: Schema.dict(Schema.object({
      reasoning: Schema.union(['minimal', 'low', 'medium', 'high']),
      models: Schema.array(Schema.object({ id: Schema.string().required() })),
    })),
  }).toJSON()

  it('reads union options at object paths', () => {
    expect(unionOptions(serialized, ['reasoningEffort'])).toEqual(['off', 'low', 'high', 'max'])
  })

  it('walks dict probes and arrays by index', () => {
    expect(unionOptions(serialized, ['providers', 'anything', 'reasoning'])).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('answers no options for missing or non-union nodes', () => {
    expect(unionOptions(serialized, ['absent'])).toEqual([])
    expect(unionOptions(serialized, ['providers', 'x', 'models'])).toEqual([])
    expect(unionOptions(undefined, ['reasoningEffort'])).toEqual([])
  })
})

describe('draft initialization', () => {
  it('reads an existing retry policy and effort defaults', () => {
    const draft = draftFromProfile({
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 100, maxDelayMs: 2_000, jitterRatio: 0.5 } },
      reasoningEffort: 'max',
      reasoning: 'high',
    })
    expect(draft.retry.enabled).toBe(true)
    expect(draft.retry.mode).toBe('always')
    expect(draft.retry.initialDelayMs).toBe('100')
    expect(draft.retry.jitterRatio).toBe('0.5')
    expect(draft.reasoningEffort).toBe('max')
    expect(draft.reasoning).toBe('high')
  })

  it('materializes defaults for an unconfigured profile', () => {
    const draft = draftFromProfile(undefined)
    expect(draft.retry.enabled).toBe(false)
    expect(draft.retry.mode).toBe('normal')
    expect(draft.retry.retryableCodes).toEqual(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
    expect(draft.reasoningEffort).toBe('')
    expect(draft.reasoning).toBe('')
  })

  it('seeds per-model efforts from a stored entry', () => {
    expect(effortsFromModelEntry({ id: 'm' }, ['minimal', 'high'])).toEqual({
      disabled: false,
      levels: { minimal: { enabled: false, spelling: '' }, high: { enabled: false, spelling: '' } },
    })
    expect(effortsFromModelEntry({ id: 'm', reasoningEfforts: false }, ['minimal', 'high'])?.disabled).toBe(true)
    expect(effortsFromModelEntry({ id: 'm', reasoningEfforts: { high: '2048' } }, ['minimal', 'high']))
      .toEqual({
        disabled: false,
        levels: { minimal: { enabled: false, spelling: '' }, high: { enabled: true, spelling: '2048' } },
      })
  })
})

function baseDraft(patch: Partial<RouteAdvancedDraft['retry']> = {}): RouteAdvancedDraft {
  return {
    retry: {
      enabled: true,
      mode: 'normal',
      maxRetries: '5',
      retryableCodes: ['RATE_LIMIT'],
      initialDelayMs: '500',
      maxDelayMs: '10000',
      jitterRatio: '0.1',
      ...patch,
    },
    reasoningEffort: '',
    reasoning: '',
    efforts: {},
  }
}

describe('validateAdvanced', () => {
  it('ignores a disabled retry policy entirely', () => {
    expect(validateAdvanced(baseDraft({ enabled: false, maxRetries: 'oops' }))).toEqual([])
  })

  it('rejects bad counts, code lists, delays, jitter', () => {
    expect(validateAdvanced(baseDraft({ maxRetries: '-1' }))).toEqual(['MAX_RETRIES'])
    expect(validateAdvanced(baseDraft({ retryableCodes: [] }))).toEqual(['CODES_EMPTY'])
    expect(validateAdvanced(baseDraft({ retryableCodes: ['A', 'A'] }))).toEqual(['CODES_DUPLICATE'])
    expect(validateAdvanced(baseDraft({ retryableCodes: [' '] }))).toEqual(['CODES_BLANK'])
    expect(validateAdvanced(baseDraft({ initialDelayMs: '0' }))).toEqual(['DELAY'])
    expect(validateAdvanced(baseDraft({ initialDelayMs: '2000', maxDelayMs: '1000' }))).toEqual(['DELAY_ORDER'])
    expect(validateAdvanced(baseDraft({ jitterRatio: '1.5' }))).toEqual(['JITTER'])
  })

  it('accepts a clean draft and the always mode without codes', () => {
    expect(validateAdvanced(baseDraft())).toEqual([])
    expect(validateAdvanced(baseDraft({ mode: 'always', retryableCodes: [] }))).toEqual([])
  })
})

describe('resolveRetryPolicy', () => {
  it('resolves normal mode with codes and backoff', () => {
    expect(resolveRetryPolicy(baseDraft().retry)).toEqual({
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['RATE_LIMIT'],
      backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    })
  })

  it('resolves always mode without normal-only fields', () => {
    expect(resolveRetryPolicy(baseDraft({ mode: 'always' }).retry)).toEqual({
      mode: 'always',
      backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    })
  })
})

describe('resolveEfforts', () => {
  it('maps the three stored spellings shapes', () => {
    expect(resolveEfforts({ disabled: true, levels: {} })).toBe(false)
    expect(resolveEfforts({ disabled: false, levels: { high: { enabled: true, spelling: '2048' } } })).toEqual({ high: '2048' })
    expect(resolveEfforts({ disabled: false, levels: { high: { enabled: false, spelling: '' } } })).toBeUndefined()
  })
})

describe('routeOps', () => {
  const path = ['providers', 'r1']

  it('emits nothing when the draft matches the stored profile', () => {
    const draft = baseDraft()
    draft.retry.enabled = false
    expect(routeOps({ layout: 'pi-ai', settingsPath: path, draft, effective: {}, user: undefined })).toEqual([])
  })

  it('sets an enabled retry policy and unsets a disabled one the user layer holds', () => {
    const draft = baseDraft()
    expect(routeOps({ layout: 'deepseek', settingsPath: [], draft, effective: {}, user: undefined })).toEqual([
      { op: 'set', path: ['retryPolicy'], value: resolveRetryPolicy(draft.retry) },
    ])
    const off = baseDraft({ enabled: false })
    expect(routeOps({
      layout: 'deepseek', settingsPath: [], draft: off,
      effective: { retryPolicy: { mode: 'always' } }, user: { retryPolicy: { mode: 'always' } },
    })).toEqual([{ op: 'unset', path: ['retryPolicy'] }])
  })

  it('skips a set when the resolved value already matches the effective one', () => {
    const draft = baseDraft()
    expect(routeOps({
      layout: 'deepseek', settingsPath: [], draft,
      effective: { retryPolicy: resolveRetryPolicy(draft.retry) }, user: {},
    })).toEqual([])
  })

  it('writes deepseek profile effort and unsets through the user layer', () => {
    const draft = { ...baseDraft({ enabled: false }), reasoningEffort: 'max' }
    expect(routeOps({ layout: 'deepseek', settingsPath: [], draft, effective: { reasoningEffort: 'high' }, user: undefined }))
      .toEqual([{ op: 'set', path: ['reasoningEffort'], value: 'max' }])
    const clearing = { ...baseDraft({ enabled: false }), reasoningEffort: '' }
    expect(routeOps({
      layout: 'deepseek', settingsPath: [], draft: clearing,
      effective: { reasoningEffort: 'high' }, user: { reasoningEffort: 'high' },
    })).toEqual([{ op: 'unset', path: ['reasoningEffort'] }])
  })

  it('rewrites the pi-ai models array when a per-model effort changes', () => {
    const draft = {
      ...baseDraft({ enabled: false }),
      efforts: { m1: { disabled: false, levels: { high: { enabled: true, spelling: '8192' } } } },
    }
    const effective = { models: [{ id: 'm1' }, { id: 'm2', name: 'other' }] }
    const ops = routeOps({ layout: 'pi-ai', settingsPath: path, draft, effective, user: {} })
    expect(ops).toEqual([{
      op: 'set',
      path: [...path, 'models'],
      value: [{ id: 'm1', reasoningEfforts: { high: '8192' } }, { id: 'm2', name: 'other' }],
    }])
  })

  it('drops a disabled-then-unchanged models array', () => {
    const draft = {
      ...baseDraft({ enabled: false }),
      efforts: { m1: { disabled: true, levels: {} } },
    }
    const effective = { models: [{ id: 'm1', reasoningEfforts: false }] }
    expect(routeOps({ layout: 'pi-ai', settingsPath: path, draft, effective, user: {} })).toEqual([])
  })
})

describe('path helpers', () => {
  it('reads and probes nested object/array values', () => {
    const value = { a: [{ b: 1 }] }
    expect(getPathValue(value, ['a', '0', 'b'])).toBe(1)
    expect(getPathValue(value, ['a', 'x'])).toBeUndefined()
    expect(hasPathValue(value, ['a', '0', 'b'])).toBe(true)
    expect(hasPathValue(value, ['a', '1'])).toBe(false)
    expect(hasPathValue(undefined, ['a'])).toBe(false)
  })
})
