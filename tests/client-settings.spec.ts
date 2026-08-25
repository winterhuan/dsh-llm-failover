// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      { provider: 'primary', model: 'alpha', retryCount: 2 },
      { provider: 'primary', model: 'omega', retryCount: 0 },
    ],
    retryableCodes: ['RATE_LIMIT', 'TRANSPORT'],
  }],
  activeGroup: 'production',
}

function response(value: unknown, revision: number): Response {
  return new Response(JSON.stringify({ value, revision, writable: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function api() {
  return {
    llm: {
      providers: vi.fn(() => Promise.resolve({
        result: { ok: true as const, value: { providers: [
          { provider: 'primary', displayName: 'Primary', settingsNs: '', settingsPath: [], active: true },
          { provider: 'secondary', displayName: 'Secondary', settingsNs: '', settingsPath: [], active: true },
          { provider: 'dormant', displayName: 'Dormant', settingsNs: '', settingsPath: [], active: false },
        ] } },
      })),
      models: vi.fn(() => Promise.resolve({
        result: { ok: true as const, value: { groups: [
          { id: 'primary', name: 'Primary', models: [{ id: 'alpha', name: 'Alpha' }, { id: 'omega', name: 'Omega' }] },
          { id: 'secondary', name: 'Secondary', models: [{ id: 'beta', name: 'Beta' }] },
        ], failures: [] } },
      })),
    },
  }
}

describe('FailoverSettingsSection', () => {
  it('loads provider/model choices and saves per-target retry counts', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(configured, 7))
      .mockResolvedValueOnce(response(configured, 8))
    vi.stubGlobal('fetch', fetch)
    const props = { api: api(), t: (key: keyof typeof en) => en[key] } as never

    render(createElement(FailoverSettingsSection, props))

    // Both targets start under the primary provider; the first row renders first.
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Primary (primary)')).toHaveLength(2)
    })
    const groupId = screen.getByDisplayValue('production')
    groupId.focus()
    fireEvent.change(groupId, { target: { value: 'production-a' } })
    expect(document.activeElement).toBe(groupId)
    fireEvent.change(groupId, { target: { value: 'production-ab' } })
    expect(document.activeElement).toBe(groupId)
    expect(screen.queryByRole('option', { name: 'Dormant (dormant)' })).toBeNull()
    // Editing the provider on the first target resets its model, so it starts empty.
    fireEvent.change(screen.getAllByDisplayValue('Primary (primary)')[0]!, { target: { value: 'secondary' } })
    expect(screen.getByDisplayValue('Secondary (secondary)')).toBeTruthy()
    expect(screen.getAllByDisplayValue(en.selectModel)).toHaveLength(1)
    fireEvent.change(screen.getAllByDisplayValue(en.selectModel)[0]!, { target: { value: 'beta' } })
    // The clean draft is dirty, so the status chip announces that and Save is enabled.
    expect(await screen.findByText(en.unsaved)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const expected = {
      ...configured,
      groups: [{
        ...configured.groups[0],
        id: 'production-ab',
        targets: [
          { provider: 'secondary', model: 'beta', retryCount: 2 },
          configured.groups[0]!.targets[1],
        ],
      }],
      // Renaming a group carries the active-group reference with it instead
      // of leaving it dangling on the old id.
      activeGroup: 'production-ab',
    }
    await waitFor(() => {
      expect(fetch).toHaveBeenNthCalledWith(2, '/api/llm-failover.settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: expected, expectedRevision: 7 }),
      })
    })
    expect(await screen.findByText('Saved')).toBeTruthy()
  })

  it('shows default retryable codes and updates them through the dropdown', async () => {
    const withoutCodes = {
      ...configured,
      groups: [{ ...configured.groups[0], retryableCodes: undefined }],
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(withoutCodes, 2))))

    const t = (key: keyof typeof en, values?: { count?: number }) => en[key].replace('{count}', String(values?.count ?? ''))
    render(createElement(FailoverSettingsSection, { api: api(), t } as never))

    expect(await screen.findByText('5 selected')).toBeTruthy()
    expect(screen.getByText('EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT')).toBeTruthy()
    const trigger = screen.getByRole('button', { name: /5 selected/ })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const rateLimit = screen.getByRole('checkbox', { name: 'RATE_LIMIT' }) as HTMLInputElement
    expect(rateLimit.checked).toBe(true)
    fireEvent.click(rateLimit)
    expect(rateLimit.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText(en.noCodes)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use defaults' }))
    expect(screen.getByText('5 selected')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the retryable-code dropdown on Escape and restores focus to the trigger', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(configured, 2))))

    const t = (key: keyof typeof en, values?: { count?: number }) => en[key].replace('{count}', String(values?.count ?? ''))
    render(createElement(FailoverSettingsSection, { api: api(), t } as never))

    const trigger = await screen.findByRole('button', { name: /2 selected/ })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('reports unavailable before requesting the provider catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 404 }))))
    const hostApi = api()

    render(createElement(FailoverSettingsSection, { api: hostApi, t: (key: keyof typeof en) => en[key] } as never))

    expect(await screen.findByText(en.unavailable)).toBeTruthy()
    expect(hostApi.llm.providers).not.toHaveBeenCalled()
    expect(hostApi.llm.models).not.toHaveBeenCalled()
  })

  it('keeps Save disabled while the draft is clean and re-enables after an edit', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(configured, 1))))
    const props = { api: api(), t: (key: keyof typeof en) => en[key] } as never
    render(createElement(FailoverSettingsSection, props))

    // The clean draft keeps the Save control disabled; no unsaved indicator yet.
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Primary (primary)')).toHaveLength(2)
    })
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect(screen.getByRole('button', { name: en.save }).disabled).toBe(true)

    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '5' } })
    await screen.findByText(en.unsaved)
    expect(screen.getByRole('button', { name: en.save }).disabled).toBe(false)
  })

  it('discards local edits and returns to the clean saved snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(configured, 1))))
    const props = { api: api(), t: (key: keyof typeof en) => en[key] } as never
    render(createElement(FailoverSettingsSection, props))

    await screen.findByDisplayValue('2')
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '7' } })
    const discard = await screen.findByRole('button', { name: en.discard })
    fireEvent.click(discard)

    // The retry count returns to the persisted value and the draft is clean again.
    expect(screen.getByDisplayValue('2')).toBeTruthy()
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect(screen.queryByRole('button', { name: en.discard })).toBeNull()
  })

  it('blocks Save and surfaces inline validation when the group id is cleared', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(configured, 1))))
    const props = { api: api(), t: (key: keyof typeof en) => en[key] } as never
    render(createElement(FailoverSettingsSection, props))

    const groupId = await screen.findByDisplayValue('production')
    fireEvent.change(groupId, { target: { value: '' } })
    await screen.findByText(en.v_INVALID_GROUP_ID)
    expect(screen.getByRole('button', { name: en.save }).disabled).toBe(true)
  })

  it('reorders targets with the up/down buttons', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(configured, 3))))
    const props = { api: api(), t: (key: keyof typeof en, values?: { index?: string }) =>
      en[key].replace('{index}', String(values?.index ?? '')) } as never
    render(createElement(FailoverSettingsSection, props))

    await screen.findByDisplayValue('Alpha (alpha)')
    // Target rows are numbered 1 and 2. Moving target 2 up should swap them.
    fireEvent.click(screen.getByRole('button', { name: /Move target 2 up/ }))

    // After the swap, the first row now lists omega and the second lists alpha.
    expect(screen.getAllByDisplayValue('Primary (primary)')).toHaveLength(2)
    expect(screen.getByDisplayValue('Omega (omega)')).toBeTruthy()
    expect(screen.getByDisplayValue('Alpha (alpha)')).toBeTruthy()
  })
})

describe('FailoverSettingsSection draft safety', () => {
  it('flags a dangling active-group reference and blocks Save', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(configured, 1))))
    const props = { api: api(), t: (key: keyof typeof en) => en[key] } as never
    render(createElement(FailoverSettingsSection, props))

    // Clearing the active group's id dangles the reference; the rename follows
    // it to '', which anchors nothing, so the document-wide rule fires.
    const groupId = await screen.findByDisplayValue('production')
    fireEvent.change(groupId, { target: { value: '' } })

    expect(await screen.findByText(en.v_ACTIVE_GROUP_MISSING)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('discards advanced-only edits back to the loaded baseline', async () => {
    const settings = {
      describe: vi.fn(() => Promise.resolve({
        result: {
          ok: true as const,
          value: {
            writable: true,
            hasDocument: true,
            namespaces: [
              { ns: 'llm-deepseek', schema: {}, value: { reasoningEffort: 'high' }, revision: 3 },
            ],
          },
        },
      })),
      mutate: vi.fn(),
    }
    const hostApi = api()
    // The advanced editor only mounts for a resolvable adapter layout, so the
    // primary route needs its real settings address here.
    hostApi.llm.providers = vi.fn(() => Promise.resolve({
      result: { ok: true as const, value: { providers: [
        { provider: 'primary', displayName: 'Primary', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
        { provider: 'secondary', displayName: 'Secondary', settingsNs: '', settingsPath: [], active: true },
        { provider: 'dormant', displayName: 'Dormant', settingsNs: '', settingsPath: [], active: false },
      ] } },
    }))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(configured, 1))))
    const props = { api: { ...hostApi, settings }, t: (key: keyof typeof en) => en[key] } as never
    render(createElement(FailoverSettingsSection, props))

    const toggle = (await screen.findAllByRole('button', { name: en.advToggle }))[0]!
    fireEvent.click(toggle)
    // An advanced edit alone surfaces Discard even though the group document
    // is clean.
    fireEvent.click(screen.getByRole('checkbox', { name: en.advRetryEnable }))
    const discard = await screen.findByRole('button', { name: en.discard })
    fireEvent.click(discard)

    expect(screen.queryByRole('checkbox', { name: en.advRetryEnable })).toBeNull()
    expect(screen.queryByRole('button', { name: en.discard })).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('gives every retryable-code dropdown unique label and hint ids', async () => {
    const twoGroups = {
      groups: [
        { ...configured.groups[0]! },
        { id: 'standby', targets: [
          { provider: 'secondary', model: 'beta', retryCount: 0 },
          { provider: 'primary', model: 'alpha', retryCount: 0 },
        ] },
      ],
      activeGroup: 'production',
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(twoGroups, 1))))
    const props = { api: api(), t: (key: keyof typeof en) => en[key] } as never
    render(createElement(FailoverSettingsSection, props))

    await screen.findByDisplayValue('production')
    const wired = [...document.querySelectorAll('[id^="failover-codes-"]')]
      .map(node => node.id)
    expect(wired.length).toBeGreaterThanOrEqual(4)
    expect(new Set(wired).size).toBe(wired.length)
  })

  it('aborts the in-flight load when the section unmounts', async () => {
    let captured: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>(() => {
      captured = init?.signal
    })))
    const props = { api: api(), t: (key: keyof typeof en) => en[key] } as never
    const rendered = render(createElement(FailoverSettingsSection, props))

    await waitFor(() => expect(captured).toBeDefined())
    rendered.unmount()
    expect(captured!.aborted).toBe(true)
  })
})
