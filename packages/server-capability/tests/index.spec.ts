import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import Capability from '@cordisjs/plugin-capability'
import { afterEach, describe, expect, it } from 'vitest'
import * as ServerCapability from '@cordisjs/plugin-server-capability'

declare module '@cordisjs/plugin-capability' {
  namespace Capability {
    interface Session {
      identityId?: number
    }
  }
}

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Capability)
  await ctx.plugin(ServerCapability)
  await sleep()
  return { ctx, baseUrl: ctx.server.baseUrl }
}

async function teardown(ctx: Context) {
  ctx.registry.delete(Server)
  await sleep()
}

describe('@cordisjs/plugin-server-capability', () => {
  let ctx: Context
  let baseUrl: string

  afterEach(async () => {
    if (ctx) await teardown(ctx)
  })

  it('decorates req.session with no listeners (empty object)', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.server.get('/probe', async (req) => {
      return Response.json({ session: req.session, hasCap: typeof req.capability?.check === 'function' })
    })
    await sleep()
    const res = await fetch(`${baseUrl}/probe`)
    const body = await res.json() as any
    expect(body.session).to.deep.equal({})
    expect(body.hasCap).to.equal(true)
  })

  it('listeners populate the session before route dispatch', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.on('capability/build-session', ({ session }) => {
      session.capabilities = ['admin']
      session.userId = 7
    })
    ctx.server.get('/probe', async (req) => {
      return Response.json({ session: req.session })
    })
    await sleep()
    const body = await (await fetch(`${baseUrl}/probe`)).json() as any
    expect(body.session.capabilities).to.deep.equal(['admin'])
    expect(body.session.userId).to.equal(7)
  })

  it('multiple listeners cooperate, each filling a slice', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.on('capability/build-session', ({ session }) => { session.userId = 1 })
    ctx.on('capability/build-session', ({ session }) => { session.capabilities = ['x'] })
    ctx.server.get('/probe', async (req) => Response.json(req.session))
    await sleep()
    const body = await (await fetch(`${baseUrl}/probe`)).json() as any
    expect(body).to.deep.equal({ userId: 1, capabilities: ['x'] })
  })

  it('req.capability.check goes through the capability service', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.on('capability/build-session', ({ session }) => { session.capabilities = ['admin'] })
    ctx.server.get('/check/:name', async (req) => {
      return Response.json({ ok: await req.capability.check(req.params.name) })
    })
    await sleep()
    expect((await (await fetch(`${baseUrl}/check/admin`)).json() as any).ok).to.equal(true)
    expect((await (await fetch(`${baseUrl}/check/other`)).json() as any).ok).to.equal(false)
  })

  it('req.capability.assert resolves when granted', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.on('capability/build-session', ({ session }) => { session.capabilities = ['admin'] })
    ctx.server.get('/admin-only', async (req) => {
      await req.capability.assert('admin')
      return Response.json({ ok: true })
    })
    await sleep()
    const res = await fetch(`${baseUrl}/admin-only`)
    expect(res.status).to.equal(200)
    expect(await res.json()).to.deep.equal({ ok: true })
  })

  it('req.capability.assert throws CapabilityDenied → 403 JSON', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.server.get('/admin-only', async (req) => {
      await req.capability.assert('admin')
      return Response.json({ ok: true })
    })
    await sleep()
    const res = await fetch(`${baseUrl}/admin-only`)
    expect(res.status).to.equal(403)
    const body = await res.json() as any
    expect(body.error).to.equal('CAPABILITY_DENIED')
    expect(body.missing).to.deep.equal(['admin'])
  })

  it('req.capability.test ANDs multiple names', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.on('capability/build-session', ({ session }) => { session.capabilities = ['a', 'b'] })
    ctx.server.get('/multi', async (req) => {
      return Response.json({
        both: await req.capability.test('a', 'b'),
        partial: await req.capability.test('a', 'c'),
      })
    })
    await sleep()
    const body = await (await fetch(`${baseUrl}/multi`)).json() as any
    expect(body.both).to.equal(true)
    expect(body.partial).to.equal(false)
  })

  it('Bearer token → token:<key> capability in session', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.server.get('/probe', async (req) => Response.json(req.session))
    await sleep()
    const body = await (await fetch(`${baseUrl}/probe`, {
      headers: { Authorization: 'Bearer admin-key' },
    })).json() as any
    expect(body.capabilities).to.deep.equal(['token:admin-key'])
  })

  it('no Authorization header → no token capability', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.server.get('/probe', async (req) => Response.json(req.session))
    await sleep()
    const body = await (await fetch(`${baseUrl}/probe`)).json() as any
    expect(body).to.deep.equal({})
  })

  it('non-Bearer scheme ignored', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.server.get('/probe', async (req) => Response.json(req.session))
    await sleep()
    const body = await (await fetch(`${baseUrl}/probe`, {
      headers: { Authorization: 'Basic admin-key' },
    })).json() as any
    expect(body).to.deep.equal({})
  })

  it('token capability composes with other listeners', async () => {
    ({ ctx, baseUrl } = await setup())
    ctx.on('capability/build-session', ({ session }) => {
      session.capabilities = [...(session.capabilities ?? []), 'base']
    })
    ctx.server.get('/probe', async (req) => Response.json(req.session))
    await sleep()
    const body = await (await fetch(`${baseUrl}/probe`, {
      headers: { Authorization: 'Bearer admin-key' },
    })).json() as any
    expect(new Set(body.capabilities)).to.deep.equal(new Set(['token:admin-key', 'base']))
  })

  describe('auto-assert via Route.Options.capabilities', () => {
    it('grants access when all required caps are satisfied', async () => {
      ({ ctx, baseUrl } = await setup())
      ctx.on('capability/build-session', ({ session }) => { session.capabilities = ['admin'] })
      ctx.server.get('/auto', async () => Response.json({ ok: true }), {
        capabilities: ['admin'],
      })
      await sleep()
      const res = await fetch(`${baseUrl}/auto`)
      expect(res.status).to.equal(200)
      expect(await res.json()).to.deep.equal({ ok: true })
    })

    it('denies with 403 JSON when required caps are missing', async () => {
      ({ ctx, baseUrl } = await setup())
      let reached = false
      ctx.server.get('/auto', async () => {
        reached = true
        return Response.json({ ok: true })
      }, { capabilities: ['admin'] })
      await sleep()
      const res = await fetch(`${baseUrl}/auto`)
      expect(res.status).to.equal(403)
      const body = await res.json() as any
      expect(body.error).to.equal('CAPABILITY_DENIED')
      expect(body.missing).to.deep.equal(['admin'])
      expect(reached).to.equal(false)
    })

    it('no capabilities on route means no auto-assert', async () => {
      ({ ctx, baseUrl } = await setup())
      ctx.server.get('/open', async () => Response.json({ ok: true }))
      await sleep()
      const res = await fetch(`${baseUrl}/open`)
      expect(res.status).to.equal(200)
    })

    it('intercept.routes overrides per-route capabilities on same key', async () => {
      ({ ctx, baseUrl } = await setup())
      ctx.on('capability/build-session', ({ session }) => {
        session.capabilities = ['read']
      })
      const scoped = ctx.intercept('server', {
        routes: { 'GET /items': { capabilities: ['write'] } },
      })
      // route-side caps replaced by intercept's ['write']; session only has 'read'
      scoped.server.get('/items', async () => Response.json({ ok: true }), {
        capabilities: ['read'],
      })
      await sleep()

      const res = await fetch(`${baseUrl}/items`)
      expect(res.status).to.equal(403)
      expect((await res.json() as any).missing).to.deep.equal(['write'])
    })

    it('intercept-only capabilities also enforced', async () => {
      ({ ctx, baseUrl } = await setup())
      const scoped = ctx.intercept('server', {
        routes: { 'GET /locked': { capabilities: ['admin'] } },
      })
      scoped.server.get('/locked', async () => Response.json({ ok: true }))
      await sleep()
      const res = await fetch(`${baseUrl}/locked`)
      expect(res.status).to.equal(403)
    })
  })
})
