import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Failover from '../src/index.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly entries: Record<string, Array<Error | string>>) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = this.entries[`${options.provider}:${options.model}`]
    const entry = script?.shift()
    if (entry === undefined) throw new Error('integration test script exhausted')
    if (entry instanceof Error) throw entry
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: entry }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: entry } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Agent Loop failover composition', () => {
  it('fails over between providers and persists the non-surface route event', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-llm-failover-'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Failover, {
      groups: [{
        id: 'fallback',
        targets: [
          { provider: 'primary', model: 'alpha', retryCount: 1 },
          { provider: 'secondary', model: 'beta', retryCount: 0 },
        ],
        retryableCodes: ['RATE_LIMIT'],
      }],
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    expect(ctx.llm.listProviders()).toContainEqual({ id: 'llm-failover', name: '模型组' })
    expect(await ctx.llm.listModels('llm-failover')).toEqual([{
      provider: 'llm-failover',
      id: 'fallback',
      name: 'fallback',
      description: 'primary/alpha → secondary/beta',
    }])

    const adapter = new ScriptedAdapter({
      'primary:alpha': [
        new LlmError('primary is busy', 'RATE_LIMIT', { status: 429 }),
        new LlmError('primary is still busy', 'RATE_LIMIT', { status: 429 }),
      ],
      'secondary:beta': ['recovered through failover'],
    })
    ctx.llm.registerAdapter(['primary', 'secondary'], adapter)

    const agent = ctx.agentLoop.create(SessionId('failover'), { provider: 'llm-failover', model: 'fallback' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['primary', 'alpha'],
      ['primary', 'alpha'],
      ['secondary', 'beta'],
    ])
    const failover = agent.session.events.find(event => event.type === 'llm/failover')
    expect(failover).toMatchObject({
      data: {
        group: 'fallback',
        from: { provider: 'primary', model: 'alpha' },
        to: { provider: 'secondary', model: 'beta' },
        failure: { code: 'RATE_LIMIT' },
      },
    })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered through failover' }],
    })

    await ctx.sessions.flush(agent.session)
    const loaded = await ctx.sessionPersistence.load(agent.session.id)
    expect(loaded.events.find(event => event.type === 'llm/failover')).toEqual(failover)
  })
})
