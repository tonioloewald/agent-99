import { A99 } from './builder'
import { s } from 'tosijs-schema'

// 1. Basic Type Check
const chain = A99.take(s.object({ x: s.number }))

// Should allow core atoms
chain['math.calc']({
  expr: 'x * 2',
  vars: { x: 'args.x' },
})

chain['http.fetch']({
  url: 'https://example.com',
})

// Should allow chaining
chain['var.set']({ key: 'foo', value: 'bar' })['var.get']({ key: 'foo' })

// 2. Custom Atom Builder Inference
import { defineAtom } from './runtime'

const myAtom = defineAtom(
  'my.atom',
  s.object({ count: s.number }),
  s.number,
  async ({ count }) => count + 1
)

const customAtoms = { 'my.atom': myAtom }
const customBuilder = A99.custom(customAtoms)

// Should allow custom atom
customBuilder['my.atom']({ count: 1 })

// customBuilder['math.calc']({})