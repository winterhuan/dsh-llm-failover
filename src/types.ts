import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { FailoverTarget } from './failover.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of a model-group route change after a failed request. */
    'llm/failover': {
      turn: number
      step: number
      group: string
      from: FailoverTarget
      to: FailoverTarget
      failure: LlmFailure
    }
  }
}
