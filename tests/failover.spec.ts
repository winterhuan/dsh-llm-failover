import { describe, expect, it } from 'vitest'
import { FailoverRouter } from '../src/failover.ts'

const agent = {} as never

const config = {
  provider: 'fallback',
  model: 'ignored',
}

describe('FailoverRouter', () => {
  it('routes in order and advances only for eligible failures', () => {
    const router = new FailoverRouter()
    router.setGroups([{
      id: 'fallback',
      targets: [
        { provider: 'first', model: 'alpha' },
        { provider: 'first', model: 'beta' },
        { provider: 'second', model: 'gamma' },
      ],
      retryableCodes: ['RATE_LIMIT', 'TRANSPORT'],
    }])

    expect(router.route(agent, 1, 1, config)).toMatchObject({ provider: 'first', model: 'alpha' })
    expect(router.failover(agent, 1, 1, { message: 'bad key', code: 'AUTH' })).toBeUndefined()
    expect(router.route(agent, 1, 1, config)).toMatchObject({ provider: 'first', model: 'alpha' })
    expect(router.failover(agent, 1, 1, { message: 'busy', code: 'RATE_LIMIT' })).toEqual({
      group: 'fallback',
      from: { provider: 'first', model: 'alpha' },
      to: { provider: 'first', model: 'beta' },
    })
    expect(router.route(agent, 1, 1, config)).toMatchObject({ provider: 'first', model: 'beta' })
    expect(router.failover(agent, 1, 1, { message: 'offline', code: 'TRANSPORT' })).toEqual({
      group: 'fallback',
      from: { provider: 'first', model: 'beta' },
      to: { provider: 'second', model: 'gamma' },
    })
    expect(router.route(agent, 1, 1, config)).toMatchObject({ provider: 'second', model: 'gamma' })
    expect(router.failover(agent, 1, 1, { message: 'still offline', code: 'TRANSPORT' })).toBeUndefined()
  })

  it('rejects malformed groups at configuration time', () => {
    const router = new FailoverRouter()
    expect(() => router.setGroups([{ id: 'only-one', targets: [{ provider: 'p', model: 'm' }], retryableCodes: [] }]))
      .toThrow(/at least two targets/)
    expect(() => router.setGroups([{ id: 'duplicates', targets: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }], retryableCodes: [] }]))
      .toThrow(/repeats a target/)
  })
})
