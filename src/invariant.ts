/** Package-owned durable failover-event invariant. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './types.ts'

export const name = 'llm-failover-invariant'
export const inject = ['invariants']

function validateEvent(session: Session, event: SessionEvent<'llm/failover'>, fail: InvariantFailure): void {
  const { turn, step, group, from, to, failure } = event.data
  if (!Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(step) || step < 1) {
    fail('llm/failover must name a positive safe turn and step')
  }
  if (group.length === 0) fail('llm/failover group must be non-empty')
  if (from.provider.length === 0 || from.model.length === 0
    || to.provider.length === 0 || to.model.length === 0) {
    fail('llm/failover routes must have non-empty provider and model')
  }
  if (from.provider === to.provider && from.model === to.model) {
    fail('llm/failover must advance to a different target')
  }
  if (failure.message.length === 0 || failure.code.length === 0) {
    fail('llm/failover failure must carry non-empty message and code')
  }
  const previous = session.events.findLast(item =>
    item.seq < event.seq && item.type === 'llm/failover' && item.data.turn === turn && item.data.step === step,
  )
  if (previous !== undefined && previous.type === 'llm/failover') {
    if (previous.data.to.provider !== from.provider || previous.data.to.model !== from.model) {
      fail('llm/failover must continue from the previously selected target')
    }
    if (previous.data.to.provider === to.provider && previous.data.to.model === to.model) {
      fail('llm/failover must not revisit the current target')
    }
  }
}

const install: InvariantInstaller = (ctx, fail) => {
  ctx.inject(['sessions'], (sessionsCtx) => {
    for (const session of sessionsCtx.sessions.list()) {
      for (const event of session.events) {
        if (event.type === 'llm/failover') validateEvent(session, event, fail)
      }
    }
    sessionsCtx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args as [Session, SessionEvent]
      if (event.type === 'llm/failover') validateEvent(session, event, fail)
    }, { global: true })
  })
}

/** Register the failover invariant. */
export function apply(ctx: Context): Promise<() => void> {
  return Promise.resolve(ctx.invariants.register('@winterhuan/dsh-llm-failover', install))
}
