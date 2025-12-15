import { describe, it, expect, mock } from 'bun:test'
import { A99 } from '../builder'
import { AgentVM } from '../runtime'
import { s } from 'tosijs-schema'

describe('Use Case: Optimization', () => {
  it('should memoize expensive operations within a run', async () => {
    // Logic: Expensive calc called twice with same key
    // memoize('key', [ calc(...) ])
    let calls = 0

    // Custom atom to track execution count
    const expensiveAtom = {
      op: 'expensive',
      inputSchema: s.any,
      create: (input: any) => ({ op: 'expensive', ...input }),
      exec: async (step: any, ctx: any) => {
        calls++
        ctx.state[step.result] = 'done'
      },
    }

    const customVM = new AgentVM({ expensive: expensiveAtom })
    const builder = A99.custom({ ...customVM['atoms'] })

    const logic = builder
      .memoize('myKey', (b) => b.step({ op: 'expensive' }).as('res1'))
      .memoize('myKey', (b) => b.step({ op: 'expensive' }).as('res2'))
      .return(s.object({}))

    await customVM.run(logic.toJSON(), {})

    // Should only execute once
    expect(calls).toBe(1)
  })

  it('should cache operations across runs using store capability', async () => {
    const caps = {
      store: {
        get: mock(async (key) => {
          if (key === 'cache:persistentKey')
            return { val: 'cachedValue', _exp: Date.now() + 10000 }
          return null
        }),
        set: mock(async () => {
          // noop
        }),
      },
    }

    const vm = new AgentVM()
    const logic = A99.take(s.object({}))
      .cache('persistentKey', (b) =>
        b
          .varSet({ key: 'res', value: 'computed' }) // Should not run if cached
          .as('res')
      )
      .as('result')
      .return(s.object({ result: s.string }))

    const result = await vm.run(
      logic.toJSON(),
      {},
      { capabilities: caps as any }
    )

    expect(result.result.result).toBe('cachedValue')
    // Set should not be called because it was a hit
    expect(caps.store.set).not.toHaveBeenCalled()
  })

  it('should compute and store if cache miss', async () => {
    const caps = {
      store: {
        get: mock(async () => null),
        set: mock(async () => {
          // noop
        }),
      },
    }

    const vm = new AgentVM()
    const logic = A99.take(s.object({}))
      .cache('missKey', (b) =>
        b
          .varSet({ key: 'res', value: 'computed' })
          .varSet({ key: 'result', value: 'computed' })
          .as('res')
      )
      .as('result')
      .return(s.object({ result: s.string }))

    const result = await vm.run(
      logic.toJSON(),
      {},
      { capabilities: caps as any }
    )

    expect(result.result.result).toBe('computed')
    expect(caps.store.set).toHaveBeenCalled()
  })

  it('should optimize recursive fibonacci with caching', async () => {
    // Shared store for recursion
    const store = new Map<string, any>()
    const caps = {
      store: {
        get: mock(async (key) => store.get(key)),
        set: mock(async (key, val) => {
          store.set(key, val)
        }),
      },
      agent: {
        run: async (id: string, input: any) => {
          if (id === 'fib') {
            // Recurse with same capabilities (shared store)
            const res = await vm.run(fibLogic.toJSON(), input, {
              capabilities: caps as any,
              fuel: 50000, // High fuel for recursion
            })
            return res.result
          }
          throw new Error('Unknown agent')
        },
      },
    }

    const vm = new AgentVM()

    const fibLogic = A99.take(s.object({ n: s.number }))
      .varSet({ key: 'n', value: A99.args('n') })
      .if(
        'n < 2',
        { n: 'n' },
        (b) => b.varSet({ key: 'result', value: 'n' }),
        (b) =>
          b
            .cache(
              'fib_{{n}}', // Dynamic key template? No, cache key is string. We need template first.
              (c) =>
                c
                  .mathCalc({ expr: 'n - 1', vars: { n: 'n' } })
                  .as('n1')
                  .agentRun({ agentId: 'fib', input: { n: 'n1' } })
                  .as('r1')
                  .mathCalc({ expr: 'n - 2', vars: { n: 'n' } })
                  .as('n2')
                  .agentRun({ agentId: 'fib', input: { n: 'n2' } })
                  .as('r2')
                  .mathCalc({
                    expr: 'r1.result + r2.result',
                    vars: { r1: 'r1', r2: 'r2' },
                  })
                  .as('result')
            )
            .as('result')
      )
      .return(s.object({ result: s.number }))

    // We need to construct the cache key dynamically.
    // The 'cache' atom takes `key: string`.
    // My previous fix `const k = resolveValue(key, ctx)` allows variable reference.
    // So we can compute the key into a variable first.

    const fibWithKey = A99.take(s.object({ n: s.number }))
      .varSet({ key: 'n', value: A99.args('n') })
      .if(
        'n < 2',
        { n: 'n' },
        (b) => b.varSet({ key: 'result', value: 'n' }),
        (b) =>
          b
            .template({ tmpl: 'fib_{{n}}', vars: { n: 'n' } })
            .as('cacheKey')
            .cache('cacheKey', (c) =>
              c
                .mathCalc({ expr: 'n - 1', vars: { n: 'n' } })
                .as('n1')
                .agentRun({ agentId: 'fib', input: { n: 'n1' } })
                .as('r1')
                .mathCalc({ expr: 'n - 2', vars: { n: 'n' } })
                .as('n2')
                .agentRun({ agentId: 'fib', input: { n: 'n2' } })
                .as('r2')
                .mathCalc({
                  expr: 'r1.result + r2.result',
                  vars: { r1: 'r1', r2: 'r2' },
                })
                .as('result')
            )
            .as('result')
      )
      .return(s.object({ result: s.number }))

    // Update mock to use correct logic
    caps.agent.run = async (id: string, input: any) => {
      if (id === 'fib') {
        const res = await vm.run(fibWithKey.toJSON(), input, {
          capabilities: caps as any,
          fuel: 50000,
        })
        return res.result
      }
      throw new Error('Unknown agent')
    }

    // Run 1: Warm cache
    // fib(5) = 5 (0,1,1,2,3,5) ? Wait: 0,1,1,2,3,5,8?
    // fib(0)=0, fib(1)=1, fib(2)=1, fib(3)=2, fib(4)=3, fib(5)=5.
    const run1 = await vm.run(
      fibWithKey.toJSON(),
      { n: 5 },
      { capabilities: caps as any }
    )
    expect(run1.result.result).toBe(5)
    const fuel1 = run1.fuelUsed

    // Run 2: Cached
    const run2 = await vm.run(
      fibWithKey.toJSON(),
      { n: 5 },
      { capabilities: caps as any }
    )
    expect(run2.result.result).toBe(5)
    const fuel2 = run2.fuelUsed

    console.log(`Fib(5) fuel: ${fuel1} vs ${fuel2}`)
    expect(fuel2).toBeLessThan(fuel1)

    // Run 3: Big Fib (should be linear-ish due to cache)
    // fib(20) without memo is expensive (2^20 calls). With memo it's ~20 calls.
    const runBig = await vm.run(
      fibWithKey.toJSON(),
      { n: 20 },
      { capabilities: caps as any, fuel: 100000 }
    )
    // fib(20) = 6765
    expect(runBig.result.result).toBe(6765)
  })
})
