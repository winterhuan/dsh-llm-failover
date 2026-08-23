import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'

/** One real adapter route attempted by a model group. */
export interface FailoverTarget {
  provider: string
  model: string
  /** Additional attempts on this target before advancing to the next target. */
  retryCount?: number
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
  retriesUsed: number
}

/** Decision after one eligible target failure. */
export type FailoverDecision =
  | { kind: 'retry'; group: string; target: FailoverTarget; attempt: number }
  | { kind: 'switch'; group: string; from: FailoverTarget; to: FailoverTarget }

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
        const retryCount = target.retryCount ?? 0
        if (!Number.isSafeInteger(retryCount) || retryCount < 0) {
          throw new Error(`llm-failover: group "${group.id}" target retryCount must be a non-negative safe integer`)
        }
        return Object.freeze({ provider: target.provider, model: target.model, retryCount })
      })
      if (new Set(targets.map(target => `${target.provider}\u0000${target.model}`)).size !== targets.length) {
        throw new Error(`llm-failover: group "${group.id}" repeats a target`)
      }
      const retryableCodes = group.retryableCodes
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
  route(agent: Agent, turn: number, step: number, config: LlmCallConfig, selectedGroup?: string): LlmCallConfig {
    let entries = this.attempts.get(agent)
    const existing = entries?.get(key(turn, step))
    if (existing !== undefined) {
      const target = existing.group.targets[existing.targetIndex]
      if (target === undefined) throw new Error(`llm-failover: group "${existing.group.id}" has no selected target`)
      return { ...config, provider: target.provider, model: target.model }
    }
    const groupId = selectedGroup ?? (this.groups.has(config.provider) ? config.provider : undefined)
    if (groupId === undefined) return config
    const group = this.groups.get(groupId)
    if (group === undefined) return config
    if (entries === undefined) {
      entries = new Map()
      this.attempts.set(agent, entries)
    }
    const attempt = { group, targetIndex: 0, retriesUsed: 0 }
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

  /** Retry the current target or advance after one eligible failure. */
  failover(agent: Agent, turn: number, step: number, failure: LlmFailure): FailoverDecision | undefined {
    const attempt = this.attempts.get(agent)?.get(key(turn, step))
    if (attempt === undefined || !attempt.group.retryableCodes.includes(failure.code)) return undefined
    const from = attempt.group.targets[attempt.targetIndex]
    if (from === undefined) return undefined
    const retryCount = from.retryCount ?? 0
    if (attempt.retriesUsed < retryCount) {
      attempt.retriesUsed += 1
      return { kind: 'retry', group: attempt.group.id, target: from, attempt: attempt.retriesUsed }
    }
    const to = attempt.group.targets[attempt.targetIndex + 1]
    if (to === undefined) return undefined
    attempt.targetIndex += 1
    attempt.retriesUsed = 0
    return { kind: 'switch', group: attempt.group.id, from, to }
  }
}
