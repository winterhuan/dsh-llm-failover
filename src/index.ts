/** Configurable cross-model and cross-provider Agent Loop failover. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from './types.ts'
import { DEFAULT_RETRYABLE_CODES, FailoverRouter } from './failover.ts'
import type { FailoverTarget, ModelGroup } from './failover.ts'

export { DEFAULT_RETRYABLE_CODES, FailoverRouter } from './failover.ts'
export type { FailoverTarget, ModelGroup } from './failover.ts'

export const name = 'llm-failover'
export const inject = ['agents', 'llm']

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
  retryCount: z.number().min(0).step(1).default(0),
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
const GROUP_PROVIDER = 'llm-failover'
const SETTINGS_ROUTE = '/api/llm-failover.settings'
const MAX_SETTINGS_BODY_BYTES = 64 * 1024

interface SettingsWriteRequest {
  value: Config
  expectedRevision?: number
}

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

class ModelGroupAdapter extends LlmAdapter {
  constructor(private readonly current: () => Config) {
    super()
  }

  override providerInfo(): { id: string; name: string } {
    return { id: GROUP_PROVIDER, name: '模型组' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(groupsOf(this.current()).map(group => ({
      provider: GROUP_PROVIDER,
      id: group.id,
      name: group.id,
      description: group.targets.map(target => `${target.provider}/${target.model}`).join(' → '),
    })))
  }

  override resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const group = groupsOf(this.current()).find(candidate => candidate.id === model)
    if (group === undefined) throw new Error(`llm-failover: model group "${model}" is not configured`)
    return Promise.resolve({ provider: GROUP_PROVIDER, id: group.id, name: group.id })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('llm-failover: model-group provider must be resolved before dispatch')
  }
}

function settingsView(ctx: Context): { value: Config; revision: number; writable: boolean } | undefined {
  const settings = ctx.get('settings')
  const descriptor = settings?.describe({ redactSecrets: true })
    .find(candidate => candidate.ns === SETTINGS_NAMESPACE)
  if (settings === undefined || descriptor === undefined) return undefined
  return { value: descriptor.value as Config, revision: descriptor.revision, writable: settings.writable }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readSettingsWrite(req: IncomingMessage): Promise<SettingsWriteRequest> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_SETTINGS_BODY_BYTES) throw new Error('request body exceeds 64 KiB')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.value !== 'object' || record.value === null || Array.isArray(record.value)) {
    throw new Error('value must be an object')
  }
  if (record.expectedRevision !== undefined
    && (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 0)) {
    throw new Error('expectedRevision must be a non-negative safe integer')
  }
  return {
    value: record.value as Config,
    ...(record.expectedRevision === undefined ? {} : { expectedRevision: record.expectedRevision as number }),
  }
}

function installWebSettingsRoute(ctx: Context): void {
  ctx.inject(['settings', 'webServer'], (sctx) => sctx.webServer.register({
    kind: 'exact',
    path: SETTINGS_ROUTE,
    async handler(req, res) {
      if (req.method === 'GET') {
        const view = settingsView(sctx)
        if (view === undefined) {
          sendJson(res, 503, { error: 'llm-failover settings are unavailable' })
          return
        }
        sendJson(res, 200, view)
        return
      }
      if (req.method !== 'PUT') {
        res.writeHead(405, { allow: 'GET, PUT' })
        res.end()
        return
      }
      try {
        const request = await readSettingsWrite(req)
        await sctx.settings.replace(SETTINGS_NAMESPACE, request.value, request.expectedRevision)
        const view = settingsView(sctx)
        if (view === undefined) throw new Error('llm-failover settings disappeared after the write')
        sendJson(res, 200, view)
      } catch (error) {
        sendJson(res, error instanceof SettingsConflictError ? 409 : 400, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }))
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
  installWebSettingsRoute(ctx)
  ctx.llm.registerAdapter([GROUP_PROVIDER], new ModelGroupAdapter(() => current()))
  refresh()

  ctx.on('agent/request', async (
    { agent, turn, step },
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    const selected = await next()
    const group = selected.provider === GROUP_PROVIDER ? selected.model : current().activeGroup
    return router.route(agent, turn, step, selected, group)
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    router.finishTurn(agent, turn)
  })

  ctx.on('agent/request-error', async (
    { agent, turn, step, failure }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    const downstream = await next()
    if (downstream?.kind === 'retry') return downstream
    const decision = router.failover(agent, turn, step, failure)
    if (decision === undefined) return downstream
    if (decision.kind === 'switch') {
      const { kind: _kind, ...switched } = decision
      agent.session.append('llm/failover', { turn, step, ...switched, failure })
    }
    return { kind: 'retry' }
  })
}
