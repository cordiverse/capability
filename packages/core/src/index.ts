import { Context, Service } from 'cordis'
import { Awaitable, remove } from 'cosmokit'

declare module 'cordis' {
  interface Context {
    capability: Capability
  }
}

export interface MatchResult<P extends string = string> {
  [key: string]: string
}

export type Matcher = (input: string) => MatchResult | undefined

const PLACEHOLDER = /\(([a-zA-Z_]\w*)\)/g
const REGEX_META = /[.*+?^${}|[\]\\]/g

function escapeRegex(s: string): string {
  return s.replace(REGEX_META, '\\$&')
}

export function createMatch(pattern: string): Matcher {
  const parts: string[] = []
  let last = 0
  PLACEHOLDER.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PLACEHOLDER.exec(pattern))) {
    parts.push(escapeRegex(pattern.slice(last, m.index)))
    parts.push(`(?<${m[1]}>.+)`)
    last = m.index + m[0].length
  }
  parts.push(escapeRegex(pattern.slice(last)))
  const regex = new RegExp('^' + parts.join('') + '$')
  return (input: string) => {
    const match = regex.exec(input)
    if (!match) return undefined
    return (match.groups ?? {}) as MatchResult
  }
}

export namespace Capability {
  export interface Session {
    capabilities?: string[]
    userId?: number
  }

  export type Links<P extends string> = string[] | ((data: MatchResult<P>) => string[] | undefined)
  export type Check<P extends string> = (data: MatchResult<P>, session: Partial<Session>) => Awaitable<boolean>

  export interface Options<P extends string = string> {
    list?: () => string[]
    check?: Check<P>
    inherits?: Links<P>
    depends?: Links<P>
  }

  export interface Entry extends Options {
    pattern: string
    match: Matcher
  }

  export interface Config {}
}

export class Capability extends Service {
  public store: Capability.Entry[] = []

  constructor(ctx: Context, public config: Capability.Config = {}) {
    super(ctx, 'capability')
  }

  define<P extends string>(pattern: P, options: Capability.Options<P>): () => void {
    const entry: Capability.Entry = {
      ...options as Capability.Options,
      pattern,
      match: createMatch(pattern),
    }
    if (!pattern.includes('(')) entry.list ||= () => [pattern]
    return this.ctx.effect(() => {
      this.store.push(entry)
      return () => remove(this.store, entry)
    }, `ctx.capability.define(${JSON.stringify(pattern)})`)
  }

  provide<P extends string>(pattern: P, check: Capability.Check<P>): () => void {
    return this.define(pattern, { check })
  }

  inherit<P extends string>(pattern: P, inherits: Capability.Links<P>): () => void {
    return this.define(pattern, { inherits })
  }

  depend<P extends string>(pattern: P, depends: Capability.Links<P>): () => void {
    return this.define(pattern, { depends })
  }

  list(): string[] {
    const result = new Set<string>()
    for (const { list } of this.store) {
      if (!list) continue
      for (const name of list()) result.add(name)
    }
    return [...result]
  }

  async check(name: string, session: Partial<Capability.Session>): Promise<boolean> {
    if (session.capabilities?.includes(name)) return true
    const results = await Promise.all(this.store.map(async ({ match, check }) => {
      if (!check) return false
      const data = match(name)
      if (!data) return false
      try {
        return await check(data, session)
      } catch (error) {
        return false
      }
    }))
    return results.some(Boolean)
  }

  subgraph(type: 'inherits' | 'depends', roots: Iterable<string>, result = new Set<string>()): Set<string> {
    const queue = [...roots]
    let name: string | undefined
    while ((name = queue.shift()) !== undefined) {
      if (result.has(name)) continue
      result.add(name)
      for (const entry of this.store) {
        const data = entry.match(name)
        if (!data) continue
        let links = entry[type]
        if (typeof links === 'function') links = links(data)
        if (Array.isArray(links)) queue.push(...links)
      }
    }
    return result
  }

  async test(
    names: string | Iterable<string>,
    session: Partial<Capability.Session> = {},
    cache: Map<string, Promise<boolean>> = new Map(),
  ): Promise<boolean> {
    if (typeof names === 'string') names = [names]
    for (const name of this.subgraph('depends', names)) {
      const parents = [...this.subgraph('inherits', [name])]
      const results = await Promise.all(parents.map((parent) => {
        let r = cache.get(parent)
        if (!r) {
          r = this.check(parent, session)
          cache.set(parent, r)
        }
        return r
      }))
      if (!results.some(Boolean)) return false
    }
    return true
  }
}

export default Capability
