// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Schema from '@deepseek-ai/schemastery'
import { FailoverSettingsSection } from '../src/client/FailoverSettingsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const configured = {
  groups: [{
    id: 'production',
    targets: [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', retryCount: 0 },
      { provider: 'gateway', model: 'gpt-4.1', retryCount: 0 },
    ],
  }],
  activeGroup: 'production',
}

function response(value: unknown, revision: number): Response {
  return new Response(JSON.stringify({ value, revision, writable: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Serialized namespace schemas mirroring the adapter profiles this page edits. */
const deepseekSchema = Schema.object({
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
}).toJSON()
const piAiSchema = Schema.object({
  providers: Schema.dict(Schema.object({
    reasoning: Schema.union(['minimal', 'low', 'medium', 'high']),
    models: Schema.array(Schema.object({ id: Schema.string().required() })),
  })),
}).toJSON()

function namespaces(mutateImpl?: (request: { ns: string, ops: unknown[] }) => unknown) {
  return {
    describe: vi.fn(() => Promise.resolve({
      result: {
        ok: true as const,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: [
            { ns: 'llm-deepseek', schema: deepseekSchema, value: { reasoningEffort: 'high' }, revision: 3 },
            {
              ns: 'llm-pi-ai',
              schema: piAiSchema,
              value: { providers: { gateway: { reasoning: 'low', models: [{ id: 'gpt-4.1' }] } } },
              user: { providers: { gateway: { reasoning: 'low' } } },
              revision: 9,
            },
          ],
        },
      },
    })),
    mutate: vi.fn((request: { ns: string, ops: unknown[] }) => Promise.resolve({
      result: mutateImpl?.(request) ?? { ok: true as const, value: { ns: request.ns, revision: 10, schema: {}, value: {} } },
    })),
  }
}

function api(settings = namespaces()) {
  return {
    llm: {
      providers: vi.fn(() => Promise.resolve({
        result: { ok: true as const, value: { providers: [
          { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
          { provider: 'gateway', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway'], active: true },
        ] } },
      })),
      models: vi.fn(() => Promise.resolve({
        result: { ok: true as const, value: { groups: [
          { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }] },
          { id: 'gateway', name: 'Gateway', models: [{ id: 'gpt-4.1', name: 'GPT 4.1' }] },
        ], failures: [] } },
      })),
    },
    settings,
  }
}

async function renderSection(mockApi = api()) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(configured, 1))))
  render(createElement(FailoverSettingsSection, { api: mockApi, t: (key: keyof typeof en) => en[key] } as never))
  await screen.findByDisplayValue('production')
  return mockApi
}

describe('FailoverSettingsSection target advanced editors', () => {
  it('writes a deepseek retry policy and effort through settings.mutate', async () => {
    const mockApi = await renderSection()
    const toggles = await screen.findAllByRole('button', { name: en.advToggle })
    fireEvent.click(toggles[0]!)

    expect(screen.getByText(en.advShared)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: en.advRetryEnable }))
    fireEvent.change(screen.getByLabelText(en.advMaxRetries), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(en.advEffort), { target: { value: 'max' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => expect(mockApi.settings.mutate).toHaveBeenCalled())
    const call = (mockApi.settings.mutate as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.ns).toBe('llm-deepseek')
    expect(call.expectedRevision).toBe(3)
    expect(call.ops).toContainEqual({
      op: 'set',
      path: ['retryPolicy'],
      value: {
        mode: 'normal',
        maxRetries: 3,
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
        backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
      },
    })
    expect(call.ops).toContainEqual({ op: 'set', path: ['reasoningEffort'], value: 'max' })
  })

  it('validates retry drafts before saving', async () => {
    const mockApi = await renderSection()
    fireEvent.click((await screen.findAllByRole('button', { name: en.advToggle }))[0]!)
    fireEvent.click(screen.getByRole('checkbox', { name: en.advRetryEnable }))
    fireEvent.change(screen.getByLabelText(en.advMaxRetries), { target: { value: '-1' } })
    expect(await screen.findByText(en.v_ADV_MAX_RETRIES)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(mockApi.settings.mutate).not.toHaveBeenCalled()
  })

  it('edits a pi-ai route default and per-model level mapping', async () => {
    const mockApi = await renderSection()
    fireEvent.click((await screen.findAllByRole('button', { name: en.advToggle }))[1]!)
    fireEvent.change(screen.getByLabelText(en.advReasoningDefault), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'high' }))
    fireEvent.change(screen.getByLabelText('gpt-4.1 high'), { target: { value: '8192' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => expect(mockApi.settings.mutate).toHaveBeenCalled())
    const call = (mockApi.settings.mutate as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.ns).toBe('llm-pi-ai')
    expect(call.ops).toContainEqual({ op: 'set', path: ['providers', 'gateway', 'reasoning'], value: 'high' })
    expect(call.ops).toContainEqual({
      op: 'set',
      path: ['providers', 'gateway', 'models'],
      value: [{ id: 'gpt-4.1', reasoningEfforts: { high: '8192' } }],
    })
  })

  it('reports a settings conflict and refreshes advanced data', async () => {
    const conflicting = namespaces(() => ({ ok: false as const, error: { code: 'settings-conflict', message: 'nope' } }))
    const mockApi = await renderSection(api(conflicting))
    fireEvent.click((await screen.findAllByRole('button', { name: en.advToggle }))[0]!)
    fireEvent.click(screen.getByRole('checkbox', { name: en.advRetryEnable }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(await screen.findByText(en.advConflict)).toBeTruthy()
    // The reload after the conflict re-reads the namespaces.
    expect(conflicting.describe).toHaveBeenCalledTimes(2)
  })

  it('degrades the advanced editor when settings are unreadable', async () => {
    const failing = {
      describe: vi.fn(() => Promise.reject(new Error('loopback only'))),
      mutate: vi.fn(),
    }
    await renderSection(api(failing))
    fireEvent.click((await screen.findAllByRole('button', { name: en.advToggle }))[0]!)
    await waitFor(() => expect(screen.getAllByText(en.advUnavailable).length).toBeGreaterThan(0))
  })
})
