import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import MemoryDriver from '@cordisjs/plugin-database-memory'
import Server from '@cordisjs/plugin-server'
import Capability from '@cordisjs/plugin-capability'
import * as ServerCapability from '@cordisjs/plugin-server-capability'
import Sso from '@cordisjs/plugin-sso'
import SsoCapability from '@cordisjs/plugin-sso-capability'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Database)
  await ctx.plugin(MemoryDriver)
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Capability)
  await ctx.plugin(ServerCapability)
  await ctx.plugin(Sso)
  await ctx.plugin(SsoCapability)
  await sleep()
  return { ctx, baseUrl: ctx.server.baseUrl }
}

async function teardown(ctx: Context) {
  ctx.registry.delete(Server)
  await sleep()
}

describe('@cordisjs/plugin-sso-capability', () => {
  let ctx: Context
  let baseUrl: string

  afterEach(async () => {
    if (ctx) await teardown(ctx)
  })

  describe('service API', () => {
    beforeEach(async () => {
      ({ ctx, baseUrl } = await setup())
    })

    it('grant/get/revoke roundtrip', async () => {
      const { user } = await ctx.sso.createUser('fake')
      await ctx.ssoCapability.grant(user.id, 'read:users')
      await ctx.ssoCapability.grant(user.id, 'write:users')
      expect(await ctx.ssoCapability.getCapabilities(user.id)).to.have.members(['read:users', 'write:users'])
      await ctx.ssoCapability.revoke(user.id, 'write:users')
      expect(await ctx.ssoCapability.getCapabilities(user.id)).to.deep.equal(['read:users'])
    })

    it('grant is idempotent (unique userId+name)', async () => {
      const { user } = await ctx.sso.createUser('fake')
      await ctx.ssoCapability.grant(user.id, 'admin')
      await ctx.ssoCapability.grant(user.id, 'admin')
      expect(await ctx.ssoCapability.getCapabilities(user.id)).to.deep.equal(['admin'])
    })

    it('setCapabilities computes diff', async () => {
      const { user } = await ctx.sso.createUser('fake')
      await ctx.ssoCapability.setCapabilities(user.id, ['a', 'b', 'c'])
      expect(await ctx.ssoCapability.getCapabilities(user.id)).to.have.members(['a', 'b', 'c'])
      await ctx.ssoCapability.setCapabilities(user.id, ['b', 'c', 'd'])
      expect(await ctx.ssoCapability.getCapabilities(user.id)).to.have.members(['b', 'c', 'd'])
    })
  })

  describe('HTTP build-session integration', () => {
    beforeEach(async () => {
      ({ ctx, baseUrl } = await setup())
    })

    it('valid SSO token → session.userId + session.capabilities', async () => {
      const { user, identityId } = await ctx.sso.createUser('fake')
      await ctx.ssoCapability.grant(user.id, 'admin')
      const token = await ctx.sso.createSession(user.id, identityId)
      ctx.server.get('/probe', async (req) => Response.json(req.session))
      await sleep()
      const body = await (await fetch(`${baseUrl}/probe`, {
        headers: { Authorization: `Bearer ${token}` },
      })).json() as any
      expect(body.userId).to.equal(user.id)
      expect(body.identityId).to.equal(identityId)
      expect(new Set(body.capabilities)).to.deep.equal(new Set([`token:${token}`, 'admin']))
    })

    it('no token → empty session', async () => {
      ctx.server.get('/probe', async (req) => Response.json(req.session))
      await sleep()
      const body = await (await fetch(`${baseUrl}/probe`)).json() as any
      expect(body).to.deep.equal({})
    })

    it('invalid token → only token capability, no sso-derived fields', async () => {
      ctx.server.get('/probe', async (req) => Response.json(req.session))
      await sleep()
      const body = await (await fetch(`${baseUrl}/probe`, {
        headers: { Authorization: 'Bearer nope' },
      })).json() as any
      expect(body).to.deep.equal({ capabilities: ['token:nope'] })
    })

    it('end-to-end: protected route with granted capability returns 200', async () => {
      const { user, identityId } = await ctx.sso.createUser('fake')
      await ctx.ssoCapability.grant(user.id, 'admin')
      const token = await ctx.sso.createSession(user.id, identityId)
      ctx.server.get('/guarded', async (req) => {
        await req.capability.assert('admin')
        return Response.json({ userId: req.session.userId })
      })
      await sleep()
      const res = await fetch(`${baseUrl}/guarded`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).to.equal(200)
      expect(await res.json()).to.deep.equal({ userId: user.id })
    })

    it('end-to-end: protected route without capability returns 403', async () => {
      const { user, identityId } = await ctx.sso.createUser('fake')
      // no grant
      const token = await ctx.sso.createSession(user.id, identityId)
      ctx.server.get('/guarded', async (req) => {
        await req.capability.assert('admin')
        return Response.json({ ok: true })
      })
      await sleep()
      const res = await fetch(`${baseUrl}/guarded`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).to.equal(403)
    })
  })
})
