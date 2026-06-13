import { Context } from 'cordis'
import { Awaitable } from 'cosmokit'
import { Request } from '@cordisjs/plugin-server'
import type { Capability } from '@cordisjs/plugin-capability'

declare module 'cordis' {
  interface Events {
    'server/capability-session'(data: BuildSessionEvent): Awaitable<void>
  }
}

declare module '@cordisjs/plugin-server' {
  interface Request {
    session: Partial<Capability.Session>
    capability: CapabilityApi
  }

  namespace Route {
    interface Options {
      capabilities?: string[]
    }
  }
}

export interface BuildSessionEvent {
  req: Request
  session: Partial<Capability.Session>
}

export interface CapabilityApi {
  check(name: string): Promise<boolean>
  test(...names: string[]): Promise<boolean>
  assert(...names: string[]): Promise<void>
}

export class CapabilityDenied extends Error {
  public readonly status = 403
  public readonly code = 'CAPABILITY_DENIED'
  constructor(public readonly missing: string[] = []) {
    super('CAPABILITY_DENIED')
  }
}

export const name = 'server-capability'
export const inject = ['server', 'capability']

function extractBearer(header: string | null | undefined): string | undefined {
  if (!header) return
  const [type, token] = header.split(' ')
  if (type?.toLowerCase() === 'bearer' && token) return token
}

export function apply(ctx: Context) {
  ctx.server.use(async (req, res, next) => {
    const session: Partial<Capability.Session> = {}
    const token = extractBearer(req.headers.get('authorization'))
    if (token) session.capabilities = [`token:${token}`]
    await ctx.parallel('server/capability-session', { req, session })
    Object.assign(req, {
      session,
      capability: {
        check: (name: string) => ctx.capability.check(name, session),
        test: (...names: string[]) => ctx.capability.test(names, session),
        assert: async (...names: string[]) => {
          const ok = await ctx.capability.test(names, session)
          if (!ok) throw new CapabilityDenied(names)
        },
      } satisfies CapabilityApi,
    })
    try {
      await next()
    } catch (err) {
      if (err instanceof CapabilityDenied) {
        res.status = err.status
        res.headers.set('content-type', 'application/json')
        res.body = JSON.stringify({ error: err.code, missing: err.missing })
        return
      }
      throw err
    }
  })

  ctx.on('server/route-request', async (req, res, route, next) => {
    if (route.options.capabilities?.length) {
      await req.capability.assert(...route.options.capabilities)
    }
    return next()
  })
}
