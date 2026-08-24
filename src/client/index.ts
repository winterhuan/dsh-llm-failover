import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { FailoverSettingsSection } from './FailoverSettingsSection.tsx'
import type { FailoverSettingsInjected } from './FailoverSettingsSection.tsx'
import { en, zh, type FailoverSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.llmFailover': FailoverSettingsKey
  }
}

/** Services required by this browser plugin. */
export const inject = ['slots', 'locale', 'connection', 'remote']

/** Register the Failover settings page and its host-backed editor. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('settings.llmFailover', { zh, en }), 'llm-failover: settings dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const injected = (): FailoverSettingsInjected => ({
    api: connection.api,
    onInvalidated: (listener) => {
      const disposers = [
        ctx.remote.$on('settings/document-updated', () => listener()),
        ctx.remote.$on('llm/adapters-updated', listener),
      ]
      return () => { for (const dispose of disposers) dispose() }
    },
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models-failover',
    order: 11,
    label: () => ctx.locale.bind('settings.llmFailover')('nav'),
    locale: 'settings.llmFailover',
    inject: injected,
  }, FailoverSettingsSection))
}
