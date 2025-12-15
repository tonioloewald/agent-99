import { s, type Infer, validate } from 'tosijs-schema'
import type { BaseNode } from './builder'

// --- Types ---

export type OpCode = string

export interface Capabilities {
  fetch?: (url: string, init?: any) => Promise<any>
  store?: {
    get: (key: string) => Promise<any>
    set: (key: string, value: any) => Promise<void>
    query?: (query: any) => Promise<any[]>
    vectorSearch?: (vector: number[]) => Promise<any[]>
  }
  llm?: {
    predict: (prompt: string, options?: any) => Promise<string>
    embed?: (text: string) => Promise<number[]>
  }
  [key: string]: any
}

export interface RuntimeContext {
  fuel: number
  args: Record<string, any>
  state: Record<string, any> // Current scope state
  capabilities: Capabilities
  resolver: (op: string) => Atom<any, any> | undefined
  output?: any
}

export type AtomExec = (step: any, ctx: RuntimeContext) => Promise<void>

export interface AtomDef {
  op: OpCode
  inputSchema: any
  outputSchema?: any
  exec: AtomExec
  docs?: string
  timeoutMs?: number
}

export interface Atom<I, O> extends AtomDef {
  create(input: I): I & { op: string }
}

export interface AtomOptions {
  docs?: string
  timeoutMs?: number
}

// --- Helpers ---

/**
 * Creates a child scope for the context.
 * Uses prototype inheritance so reads fall through to parent, but writes stay local.
 */
function createChildScope(ctx: RuntimeContext): RuntimeContext {
  return {
    ...ctx,
    state: Object.create(ctx.state),
  }
}

function resolveValue(val: any, ctx: RuntimeContext): any {
  if (val && typeof val === 'object' && val.$kind === 'arg') {
    return ctx.args[val.path]
  }
  if (typeof val === 'string') {
    if (val.startsWith('args.')) {
      return ctx.args[val.replace('args.', '')]
    }
    return ctx.state[val] ?? val
  }
  return val
}

// Safe Eval (Math & Logic)
function evaluateExpression(expr: string, vars: Record<string, any>): number {
  // Simple tokenizer for MVP
  const tokens = expr.match(
    new RegExp(
      '(\\d+(\\.\\d+)?)|([a-zA-Z_]\\w*)|(>=|<=|==|!=|[+\\-*/()><])',
      'g'
    )
  )
  if (!tokens) return 0

  const ops: string[] = []
  const values: number[] = []

  const precedence: Record<string, number> = {
    '*': 3, '/': 3,
    '+': 2, '-': 2,
    '>': 1, '<': 1, '>=': 1, '<=': 1, '==': 1, '!=': 1,
  }

  const applyOp = () => {
    const b = values.pop()
    const a = values.pop()
    const op = ops.pop()
    if (a === undefined || b === undefined || !op) throw new Error(`Expr: Invalid op`)

    switch (op) {
      case '+': values.push(a + b); break
      case '-': values.push(a - b); break
      case '*': values.push(a * b); break
      case '/': values.push(a / b); break
      case '>': values.push(a > b ? 1 : 0); break
      case '<': values.push(a < b ? 1 : 0); break
      case '>=': values.push(a >= b ? 1 : 0); break
      case '<=': values.push(a <= b ? 1 : 0); break
      case '==': values.push(a === b ? 1 : 0); break
      case '!=': values.push(a !== b ? 1 : 0); break
    }
  }

  for (const token of tokens) {
    if (!isNaN(parseFloat(token))) {
      values.push(parseFloat(token))
    } else if (token === '(') {
      ops.push(token)
    } else if (token === ')') {
      while (ops.length > 0 && ops[ops.length - 1] !== '(') applyOp()
      ops.pop()
    } else if (precedence[token]) {
      while (ops.length > 0 && ops[ops.length - 1] !== '(' && precedence[ops[ops.length - 1]] >= precedence[token]) {
        applyOp()
      }
      ops.push(token)
    } else {
      const val = Number(vars[token] ?? 0)
      values.push(isNaN(val) ? 0 : val)
    }
  }
  while (ops.length > 0) applyOp()
  return values[0] ?? 0
}

// --- Atom Factory ---

export function defineAtom<I extends Record<string, any>, O = any>(
  op: string,
  inputSchema: any, // s.Schema<I>
  outputSchema: any | undefined, // s.Schema<O>
  fn: (input: I, ctx: RuntimeContext) => Promise<O>,
  options: AtomOptions | string = {}
): Atom<I, O> {
  const { docs = '', timeoutMs = 1000 } =
    typeof options === 'string' ? { docs: options } : options

  const exec: AtomExec = async (step: any, ctx: RuntimeContext) => {
    // 1. Validation (Strip metadata before validation)
    const { op: _op, result: _res, ...inputData } = step
    if (inputSchema && !validate(inputSchema, inputData)) {
      // In production: detailed diagnostics
      throw new Error(`Atom '${op}' validation failed: ${JSON.stringify(inputData)}`)
    }

    // 2. Execution with Timeout
    let timer: any
    const execute = async () => fn(step as I, ctx)
    
    const result = timeoutMs > 0 
      ? await Promise.race([
          execute(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Atom '${op}' timed out`)), timeoutMs)
          })
        ]).finally(() => clearTimeout(timer))
      : await execute()

    // 3. Result
    if (step.result && result !== undefined) {
      ctx.state[step.result] = result
    }
  }

  return {
    op,
    inputSchema,
    outputSchema,
    exec,
    docs,
    timeoutMs,
    create: (input: I) => ({ op, ...input }),
  }
}

// --- Core Atoms ---

// 1. Flow
export const seq = defineAtom('seq', s.object({ steps: s.array(s.any) }), undefined, async ({ steps }, ctx) => {
  for (const step of steps) {
    if (ctx.fuel-- <= 0) throw new Error('Out of Fuel')
    if (ctx.output !== undefined) return // Return check
    const atom = ctx.resolver(step.op)
    if (!atom) throw new Error(`Unknown Atom: ${step.op}`)
    await atom.exec(step, ctx)
  }
}, { docs: 'Sequence', timeoutMs: 0 })

export const iff = defineAtom('if', s.object({ condition: s.string, vars: s.record(s.any), then: s.array(s.any), else: s.array(s.any).optional }), undefined, async (step, ctx) => {
  // Resolve vars from state if they are strings pointing to keys, or use literals
  const vars: Record<string, any> = {}
  for (const [k, v] of Object.entries(step.vars)) {
     vars[k] = resolveValue(v, ctx)
  }
  if (evaluateExpression(step.condition, vars) !== 0) {
    await seq.exec({ op: 'seq', steps: step.then } as any, ctx)
  } else if (step.else) {
    await seq.exec({ op: 'seq', steps: step.else } as any, ctx)
  }
}, { docs: 'If/Else', timeoutMs: 0 })

export const whileLoop = defineAtom('while', s.object({ condition: s.string, vars: s.record(s.any), body: s.array(s.any) }), undefined, async (step, ctx) => {
  while (true) {
    if (ctx.fuel <= 0) throw new Error('Out of Fuel')
    const vars: Record<string, any> = {}
    for (const [k, v] of Object.entries(step.vars)) vars[k] = resolveValue(v, ctx)
    
    if (evaluateExpression(step.condition, vars) === 0) break
    await seq.exec({ op: 'seq', steps: step.body } as any, ctx)
    if (ctx.output !== undefined) return
  }
}, { docs: 'While Loop', timeoutMs: 0 })

export const ret = defineAtom('return', undefined, s.any, async (step: any, ctx) => {
  const res: any = {}
  // If schema provided, extract subset of state. Else return null/void?
  // Current pattern: schema defines output shape matching state keys
  if (step.schema?.properties) {
    for (const key of Object.keys(step.schema.properties)) {
      res[key] = ctx.state[key]
    }
  }
  ctx.output = res
  return res
}, 'Return')

export const tryCatch = defineAtom('try', s.object({ try: s.array(s.any), catch: s.array(s.any).optional }), undefined, async (step, ctx) => {
  try {
    await seq.exec({ op: 'seq', steps: step.try } as any, ctx)
  } catch (e: any) {
    if (step.catch) {
      ctx.state['error'] = e.message || String(e)
      await seq.exec({ op: 'seq', steps: step.catch } as any, ctx)
    }
  }
}, { docs: 'Try/Catch', timeoutMs: 0 })

// 2. State
export const varSet = defineAtom('var.set', s.object({ key: s.string, value: s.any }), undefined, async ({ key, value }, ctx) => {
  // Value could be a reference? For now assumes literal or resolved by builder?
  // If we want dynamic set from another variable:
  // "value" property in AST usually carries the literal or special object. 
  // Builder usually resolves inputs.
  ctx.state[key] = value
}, 'Set Variable')

export const varGet = defineAtom('var.get', s.object({ key: s.string }), s.any, async ({ key }, ctx) => {
  return resolveValue(key, ctx)
}, 'Get Variable')

export const scope = defineAtom('scope', s.object({ steps: s.array(s.any) }), undefined, async ({ steps }, ctx) => {
  const scopedCtx = createChildScope(ctx)
  await seq.exec({ op: 'seq', steps } as any, scopedCtx)
  // Propagate output/return up
  if (scopedCtx.output !== undefined) ctx.output = scopedCtx.output
}, { docs: 'Create new scope', timeoutMs: 0 })

// 3. Logic (Basic boolean ops)
const binaryLogic = (op: string, fn: (a: any, b: any) => boolean) => 
  defineAtom(op, s.object({ a: s.any, b: s.any }), s.boolean, async ({ a, b }, ctx) => fn(a, b), 'Logic')

export const eq = binaryLogic('eq', (a, b) => a == b)
export const neq = binaryLogic('neq', (a, b) => a != b)
export const gt = binaryLogic('gt', (a, b) => a > b)
export const lt = binaryLogic('lt', (a, b) => a < b)
export const and = binaryLogic('and', (a, b) => !!(a && b))
export const or = binaryLogic('or', (a, b) => !!(a || b))
export const not = defineAtom('not', s.object({ value: s.any }), s.boolean, async ({ value }) => !value, 'Not')

// 4. Math
export const calc = defineAtom('math.calc', s.object({ expr: s.string, vars: s.record(s.any) }), s.number, async ({ expr, vars }, ctx) => {
  const resolved: Record<string, any> = {}
  for (const [k, v] of Object.entries(vars)) resolved[k] = resolveValue(v, ctx)
  return evaluateExpression(expr, resolved)
}, 'Math Calc')

// 5. List
export const map = defineAtom('map', s.object({ items: s.array(s.any), as: s.string, steps: s.array(s.any) }), s.array(s.any), async ({ items, as, steps }, ctx) => {
  const results = []
  for (const item of items) {
    const scopedCtx = createChildScope(ctx)
    scopedCtx.state[as] = item
    await seq.exec({ op: 'seq', steps } as any, scopedCtx)
    // Assume last step result is the map result? Or specific return? 
    // Agent99 pattern: result of last step is usually implicit return of block if captured?
    // For now, let's assume we capture a variable named 'result' from scope? 
    // Or simpler: map returns the state of the scope?
    // Let's rely on explicit 'result' variable in scope for now.
    results.push(scopedCtx.state['result'] ?? null)
  }
  return results
}, { docs: 'Map Array', timeoutMs: 0 })

export const push = defineAtom('push', s.object({ list: s.array(s.any), item: s.any }), s.array(s.any), async ({ list, item }) => {
  // Note: this mutates the list if it's a reference in state
  list.push(item)
  return list
}, 'Push to Array')

export const len = defineAtom('len', s.object({ list: s.any }), s.number, async ({ list }) => {
  return Array.isArray(list) || typeof list === 'string' ? list.length : 0
}, 'Length')

// 6. String
export const split = defineAtom('split', s.object({ str: s.string, sep: s.string }), s.array(s.string), async ({ str, sep }) => str.split(sep), 'Split String')
export const join = defineAtom('join', s.object({ list: s.array(s.string), sep: s.string }), s.string, async ({ list, sep }) => list.join(sep), 'Join String')
export const template = defineAtom('template', s.object({ tmpl: s.string, vars: s.record(s.any) }), s.string, async ({ tmpl, vars }: { tmpl: string, vars: Record<string, any> }) => {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => String(vars[key] ?? ''))
}, 'String Template')

// 7. Object
export const pick = defineAtom('pick', s.object({ obj: s.record(s.any), keys: s.array(s.string) }), s.record(s.any), async ({ obj, keys }: { obj: Record<string, any>, keys: string[] }) => {
  const res: any = {}
  keys.forEach((k: string) => res[k] = obj[k])
  return res
}, 'Pick Keys')

export const merge = defineAtom('merge', s.object({ a: s.record(s.any), b: s.record(s.any) }), s.record(s.any), async ({ a, b }) => ({ ...a, ...b }), 'Merge Objects')
export const keys = defineAtom('keys', s.object({ obj: s.record(s.any) }), s.array(s.string), async ({ obj }) => Object.keys(obj), 'Object Keys')

// 8. IO
export const fetch = defineAtom('http.fetch', s.object({ url: s.string, method: s.string.optional, headers: s.record(s.string).optional, body: s.any.optional }), s.any, async (step, ctx) => {
  if (!ctx.capabilities.fetch) throw new Error("Capability 'fetch' missing")
  return ctx.capabilities.fetch(step.url, { method: step.method, headers: step.headers, body: step.body })
}, 'HTTP Fetch')

// 9. Store
export const storeGet = defineAtom('store.get', s.object({ key: s.string }), s.any, async ({ key }, ctx) => ctx.capabilities.store?.get(key), 'Store Get')
export const storeSet = defineAtom('store.set', s.object({ key: s.string, value: s.any }), undefined, async ({ key, value }, ctx) => ctx.capabilities.store?.set(key, value), 'Store Set')
export const storeQuery = defineAtom('store.query', s.object({ query: s.any }), s.array(s.any), async ({ query }, ctx) => ctx.capabilities.store?.query?.(query) ?? [], 'Store Query')
export const vectorSearch = defineAtom('store.vectorSearch', s.object({ vector: s.array(s.number) }), s.array(s.any), async ({ vector }, ctx) => ctx.capabilities.store?.vectorSearch?.(vector) ?? [], 'Vector Search')

// 10. Agent
export const llmPredict = defineAtom('llm.predict', s.object({ prompt: s.string, options: s.any.optional }), s.string, async ({ prompt, options }, ctx) => {
  if (!ctx.capabilities.llm?.predict) throw new Error("Capability 'llm.predict' missing")
  return ctx.capabilities.llm.predict(prompt, options)
}, 'LLM Predict')

export const agentRun = defineAtom('agent.run', s.object({ agentId: s.string, input: s.any }), s.any, async ({ agentId, input }, ctx) => {
  // Recursive agent call? Needs capability or just running a sub-vm?
  // Stub for now.
  return { error: 'Not implemented' }
}, 'Run Sub-Agent')


// --- Exports ---

export const coreAtoms = {
  seq, if: iff, while: whileLoop, return: ret, try: tryCatch,
  'var.set': varSet, 'var.get': varGet, scope,
  eq, neq, gt, lt, and, or, not,
  'math.calc': calc,
  map, push, len,
  split, join, template,
  pick, merge, keys,
  'http.fetch': fetch,
  'store.get': storeGet, 'store.set': storeSet, 'store.query': storeQuery, 'store.vectorSearch': vectorSearch,
  'llm.predict': llmPredict, 'agent.run': agentRun
}

// --- VM ---

export class AgentVM {
  private atoms: Record<string, Atom<any, any>>

  constructor(customAtoms: Record<string, Atom<any, any>> = {}) {
    this.atoms = { ...coreAtoms, ...customAtoms }
  }

  resolve(op: string) {
    return this.atoms[op]
  }

  async run(ast: BaseNode, args: Record<string, any> = {}, options: { fuel?: number, capabilities?: Capabilities } = {}) {
    const ctx: RuntimeContext = {
      fuel: options.fuel ?? 1000,
      args,
      state: {},
      capabilities: options.capabilities ?? {},
      resolver: (op) => this.resolve(op),
      output: undefined
    }

    if (ast.op !== 'seq') throw new Error("Root AST must be 'seq'")
    
    // Boot
    await this.resolve('seq')?.exec(ast, ctx)
    return ctx.output
  }
}

// Global default instance for backward compatibility
export const VM = new AgentVM()