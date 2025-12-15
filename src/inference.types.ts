import { A99 } from './builder'
import { s } from 'tosijs-schema'

// 1. Basic Type Check
const chain = A99.take(s.object({ x: s.number }))

// Should allow core atoms
chain.mathCalc({
  expr: 'x * 2',
  vars: { x: 'args.x' },
})

chain.httpFetch({
  url: 'https://example.com',
})

// Should allow chaining
chain.varSet({ key: 'foo', value: 'bar' }).varGet({ key: 'foo' })

// 2. Custom Atom Builder Inference
import { defineAtom } from './runtime'

const myAtom = defineAtom(
  'myAtom',
  s.object({ count: s.number }),
  s.number,
  async ({ count }) => count + 1
)

const customAtoms = { myAtom }
const customBuilder = A99.custom(customAtoms)

// Should allow custom atom
customBuilder.myAtom({ count: 1 })

// customBuilder.mathCalc({})
