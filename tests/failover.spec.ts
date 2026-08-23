import { describe, expect, it } from 'vitest'
import { FailoverRouter } from '../src/failover.ts'

const agent = {} as never

const config = {
  provider: 'fallback',
  model: 'ignored',
}

describe('FailoverRouter', () => {
  it('retries each target before advancing and only consumes eligible failures', () => {
    const router = new FailoverRouter()
    router.setGroups([{
      id: 'fallback',
      targets: [
        { provider: 'first', model: 'alpha', retryCount: 2 },
        { provider: 'first', model: 'beta', retryCount: 1 },
        { provider: 'second', model: 'gamma' },
      ],
      retryableCodes: ['RATE_LIMIT', 'TRANSPORT'],
    }])

    expect(router.route(agent, 1, 1, config)).toMatchObject({ provider: 'first', model: 'alpha' })
    expect(router.failover(agent, 1, 1, { message: 'bad key', code: 'AUTH' })).toBeUndefined()
    expect(router.failover(agent, 1, 1, { message: 'busy', code: 'RATE_LIMIT' })).toMatchObject({
      kind: 'retry', group: 'fallback', target: { provider: 'first', model: 'alpha' }, attempt: 1,
    })
    expect(router.failover(agent, 1, 1, { message: 'busy again', code: 'RATE_LIMIT' })).toMatchObject({
      kind: 'retry', group: 'fallback', target: { provider: 'first', model: 'alpha' }, attempt: 2,
    })
    expect(router.failover(agent, 1, 1, { message: 'still busy', code: 'RATE_LIMIT' })).toMatchObject({
      kind: 'switch', group: 'fallback',
      from: { provider: 'first', model: 'alpha' },
      to: { provider: 'first', model: 'beta' },
    })
    expect(router.route(agent, 1, 1, config)).toMatchObject({ provider: 'first', model: 'beta' })
    expect(router.failover(agent, 1, 1, { message: 'offline', code: 'TRANSPORT' })).toMatchObject({
      kind: 'retry', group: 'fallback', target: { provider: 'first', model: 'beta' }, attempt: 1,
    })
    expect(router.failover(agent, 1, 1, { message: 'offline again', code: 'TRANSPORT' })).toMatchObject({
      kind: 'switch', group: 'fallback',
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
    expect(() => router.setGroups([{ id: 'bad-retry', targets: [{ provider: 'p', model: 'm', retryCount: -1 }, { provider: 'q', model: 'n' }], retryableCodes: [] }]))
      .toThrow(/retryCount/)
  })

  it('treats an explicit empty error-code list as disabling failover', () => {
    const router = new FailoverRouter()
    router.setGroups([{
      id: 'disabled',
      targets: [{ provider: 'first', model: 'alpha' }, { provider: 'second', model: 'beta' }],
      retryableCodes: [],
    }])

    router.route(agent, 2, 1, config, 'disabled')
    expect(router.failover(agent, 2, 1, { message: 'busy', code: 'RATE_LIMIT' })).toBeUndefined()
  })

  it('keeps an in-flight step on its original group after configuration refresh', () => {
    const router = new FailoverRouter()
    router.setGroups([{
      id: 'fallback',
      targets: [{ provider: 'old', model: 'alpha' }, { provider: 'old', model: 'beta' }],
      retryableCodes: ['RATE_LIMIT'],
    }])

    expect(router.route(agent, 3, 1, config, 'fallback')).toMatchObject({ provider: 'old', model: 'alpha' })
    expect(router.failover(agent, 3, 1, { message: 'busy', code: 'RATE_LIMIT' })).toMatchObject({ kind: 'switch' })
    router.setGroups([{
      id: 'fallback',
      targets: [{ provider: 'new', model: 'gamma' }, { provider: 'new', model: 'delta' }],
      retryableCodes: ['RATE_LIMIT'],
    }])

    expect(router.route(agent, 3, 1, config, 'fallback')).toMatchObject({ provider: 'old', model: 'beta' })
    expect(router.route(agent, 3, 2, config, 'fallback')).toMatchObject({ provider: 'new', model: 'gamma' })
  })
})
