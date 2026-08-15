// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { FailoverSettingsSection } from '../src/client/FailoverSettingsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const configured = {
  groups: [{
    id: 'production',
    targets: [
      { provider: 'primary', model: 'alpha' },
      { provider: 'secondary', model: 'beta' },
    ],
    retryableCodes: ['RATE_LIMIT', 'TRANSPORT'],
  }],
  activeGroup: 'production',
}

function view(value: unknown, revision: number): SettingsNamespaceView {
  return {
    ns: 'llm-failover',
    schema: {},
    value,
    applies: 'live',
    secrets: [],
    revision,
  }
}

describe('FailoverSettingsSection', () => {
  it('loads and saves failover groups through the Host settings API', async () => {
    const describe = vi.fn(() => Promise.resolve({
      result: {
        ok: true as const,
        value: { writable: true, hasDocument: false, namespaces: [view(configured, 7)] },
      },
    }))
    const mutate = vi.fn(() => Promise.resolve({
      result: { ok: true as const, value: view(configured, 8) },
    }))
    const props = {
      api: { settings: { describe, mutate } },
      t: (key: keyof typeof en) => en[key],
    } as never

    render(createElement(FailoverSettingsSection, props))

    expect(await screen.findByDisplayValue('primary')).toBeTruthy()
    expect(screen.getByDisplayValue('beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'llm-failover',
        ops: [{ op: 'set', path: [], value: configured }],
        expectedRevision: 7,
      })
    })
    expect(await screen.findByText('Saved')).toBeTruthy()
  })
})
