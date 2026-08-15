import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'

/** One real adapter route attempted by a model group. */
export interface FailoverTarget {
  provider: string
  model: string
}

/** One ordered model group. */
export interface ModelGroup {
  id: string
  targets: readonly FailoverTarget[]
  retryableCodes: readonly string[]
}

interface Attempt {
  group: ModelGroup
  targetIndex: number
}

/** Default errors that indicate another target may recover the request. */
export const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

function key(turn: number, step: number): string {
  return `${turn}/${step}`
}

/**
 * State for model-group routing. One attempt remains attached to a failed step
 * until its selected target succeeds, the group is exhausted, or its agent ends.
 */
export class FailoverRouter {
  private groups = new Map<string, ModelGroup>()
  private attempts = new WeakMap<Agent, Map<string, Attempt>>()

  /** Replace every configured group after validation. */
  setGroups(groups: readonly ModelGroup[]): void {
    const next = new Map<string, ModelGroup>()
    for (const group of groups) {
      if (group.id.length === 0) throw new Error('llm-failover: group id must be non-empty')
      if (next.has(group.id)) throw new Error(`llm-failover: duplicate group "${group.id}"`)
      if (group.targets.length < 2) throw new Error(`llm-failover: group "${group.id}" needs at least two targets`)
      const targets = group.targets.map((target) => {
        if (target.provider.length === 0 || target.model.length === 0) {
          throw new Error(`llm-failover: group "${group.id}" targets need provider and model`)
        }
        return Object.freeze({ provider: target.provider, model: target.model })
      })
      if (new Set(targets.map(target => `${target.provider}\u0000${target.model}`)).size !== targets.length) {
        throw new Error(`llm-failover: group "${group.id}" repeats a target`)
      }
      const retryableCodes = group.retryableCodes.length === 0 ? DEFAULT_RETRYABLE_CODES : group.retryableCodes
      if (retryableCodes.some(code => code.length === 0) || new Set(retryableCodes).size !== retryableCodes.length) {
        throw new Error(`llm-failover: group "${group.id}" has invalid retryableCodes`)
      }
      next.set(group.id, Object.freeze({
        id: group.id,
        targets: Object.freeze(targets),
        retryableCodes: Object.freeze([...retryableCodes]),
      }))
    }
    this.groups = next
  }

  /** Resolve the concrete route for one outgoing agent request. */
  route(agent: Agent, turn: number, step: number, config: LlmCallConfig): LlmCallConfig {
    const groupId = this.groups.has(config.provider) ? config.provider : undefined
    if (groupId === undefined) return config
    const group = this.groups.get(groupId)
    if (group === undefined) return config
    let entries = this.attempts.get(agent)
    if (entries === undefined) {
      entries = new Map()
      this.attempts.set(agent, entries)
    }
    const attempt = entries.get(key(turn, step)) ?? { group, targetIndex: 0 }
    if (attempt.group.id !== group.id) {
      throw new Error(`llm-failover: step ${turn}/${step} already uses group "${attempt.group.id}"`)
    }
    entries.set(key(turn, step), attempt)
    const target = attempt.group.targets[attempt.targetIndex]
    if (target === undefined) throw new Error(`llm-failover: group "${attempt.group.id}" has no selected target`)
    return { ...config, provider: target.provider, model: target.model }
  }

  /** Drop step routing state at a turn boundary. */
  finishTurn(agent: Agent, turn: number): void {
    const entries = this.attempts.get(agent)
    if (entries === undefined) return
    for (const entryKey of entries.keys()) {
      if (entryKey.startsWith(`${turn}/`)) entries.delete(entryKey)
    }
  }

  /** Move an eligible failed request to the next target, if any. */
  failover(agent: Agent, turn: number, step: number, failure: LlmFailure): {
    group: string
    from: FailoverTarget
    to: FailoverTarget
  } | undefined {
    const attempt = this.attempts.get(agent)?.get(key(turn, step))
    if (attempt === undefined || !attempt.group.retryableCodes.includes(failure.code)) return undefined
    const from = attempt.group.targets[attempt.targetIndex]
    const to = attempt.group.targets[attempt.targetIndex + 1]
    if (from === undefined || to === undefined) return undefined
    attempt.targetIndex += 1
    return { group: attempt.group.id, from, to }
  }
}
