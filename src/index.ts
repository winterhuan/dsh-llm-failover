/** Configurable cross-model and cross-provider Agent Loop failover. */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'
import type {} from './types.ts'
import { DEFAULT_RETRYABLE_CODES, FailoverRouter } from './failover.ts'
import type { FailoverTarget, ModelGroup } from './failover.ts'

export { DEFAULT_RETRYABLE_CODES, FailoverRouter } from './failover.ts'
export type { FailoverTarget, ModelGroup } from './failover.ts'

export const name = 'llm-failover'
export const inject = ['agents']

/** Durable configuration for the model groups and the group currently used by new requests. */
export interface Config {
  /** Ordered failover groups, addressed by their stable id. */
  groups?: Array<{
    id: string
    targets: FailoverTarget[]
    retryableCodes?: string[]
  }>
  /** Group that routes Agent Loop conversation requests; omission preserves normal model selection. */
  activeGroup?: string
}

const targetSchema: z<FailoverTarget> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
})

export const Config: z<Config> = z.object({
  groups: z.array(z.object({
    id: z.string().required(),
    targets: z.array(targetSchema).required(),
    retryableCodes: z.array(z.string()),
  })),
  activeGroup: z.string(),
})

const SETTINGS_NAMESPACE = settingsNamespace('llm-failover')

function groupsOf(config: Config): ModelGroup[] {
  return (config.groups ?? []).map(group => ({
    id: group.id,
    targets: group.targets,
    retryableCodes: group.retryableCodes ?? DEFAULT_RETRYABLE_CODES,
  }))
}

function validateConfig(config: Config): void {
  const groups = groupsOf(config)
  const ids = new Set(groups.map(group => group.id))
  if (config.activeGroup !== undefined && !ids.has(config.activeGroup)) {
    throw new Error(`llm-failover: activeGroup "${config.activeGroup}" is not configured`)
  }
  const router = new FailoverRouter()
  router.setGroups(groups)
}

/**
 * Register the settings namespace and attach group routing to Agent Loop request
 * recovery. A group advances only after an earlier recovery listener delegates,
 * so provider-owned retries and compaction keep their existing precedence.
 */
export function apply(ctx: Context, entry: Config = {}): void {
  const router = new FailoverRouter()
  let current = (): Config => entry
  const refresh = (): void => {
    const config = current()
    validateConfig(config)
    router.setGroups(groupsOf(config))
  }
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, entry, {
    setSource(source) { current = source },
    onChange: refresh,
    validate: validateConfig,
  })
  refresh()

  ctx.on('agent/request', async (
    { agent, turn, step },
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    const selected = await next()
    const group = current().activeGroup
    return group === undefined ? selected : router.route(agent, turn, step, { ...selected, provider: group })
  })

  ctx.on('agent/request-error', async (
    { agent, turn, step, failure }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    const downstream = await next()
    if (downstream?.kind === 'retry') return downstream
    const switched = router.failover(agent, turn, step, failure as LlmFailure)
    if (switched === undefined) return downstream
    agent.session.append('llm/failover', { turn, step, ...switched, failure })
    return { kind: 'retry' }
  })
}
