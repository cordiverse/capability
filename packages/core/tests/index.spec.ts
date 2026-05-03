import { Context } from 'cordis'
import { expect } from 'chai'
import { Capability, createMatch } from '@cordisjs/plugin-capability'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Capability)
  return ctx
}

describe('@cordisjs/plugin-capability', () => {
  describe('createMatch', () => {
    it('matches a literal pattern', () => {
      const m = createMatch('admin')
      expect(m('admin')).to.deep.equal({})
      expect(m('user')).to.be.undefined
    })

    it('captures a single placeholder', () => {
      const m = createMatch('authority:(value)')
      expect(m('authority:5')).to.deep.equal({ value: '5' })
      expect(m('authority:')).to.be.undefined
      expect(m('admin')).to.be.undefined
    })

    it('captures multiple placeholders', () => {
      const m = createMatch('document:(id):edit')
      expect(m('document:42:edit')).to.deep.equal({ id: '42' })
      expect(m('document:42:read')).to.be.undefined
    })

    it('catch-all single name pattern', () => {
      const m = createMatch('(name)')
      expect(m('admin')).to.deep.equal({ name: 'admin' })
      expect(m('document:edit:42')).to.deep.equal({ name: 'document:edit:42' })
    })
  })

  describe('check / provide', () => {
    let ctx: Context

    beforeEach(async () => {
      ctx = await setup()
    })

    it('built-in: session.capabilities array grants matching name', async () => {
      expect(await ctx.capability.check('admin', { capabilities: ['admin'] })).to.equal(true)
      expect(await ctx.capability.check('admin', { capabilities: ['other'] })).to.equal(false)
      expect(await ctx.capability.check('admin', {})).to.equal(false)
    })

    it('provide a custom check', async () => {
      ctx.capability.provide('authority:(value)', ({ value }, session: any) => {
        return !!session.user?.authority && session.user.authority >= +value
      })
      expect(await ctx.capability.check('authority:3', { user: { authority: 5 } } as any)).to.equal(true)
      expect(await ctx.capability.check('authority:6', { user: { authority: 5 } } as any)).to.equal(false)
      expect(await ctx.capability.check('authority:1', {})).to.equal(false)
    })

    it('check is OR over all matching providers', async () => {
      ctx.capability.provide('admin', () => false)
      // built-in short-circuit: session.capabilities still grants
      expect(await ctx.capability.check('admin', { capabilities: ['admin'] })).to.equal(true)
    })

    it('check that throws is treated as false', async () => {
      ctx.capability.provide('boom', () => { throw new Error('nope') })
      expect(await ctx.capability.check('boom', {})).to.equal(false)
    })

    it('non-matching pattern returns undefined data, skipped', async () => {
      ctx.capability.provide('authority:(value)', () => true)
      expect(await ctx.capability.check('admin', {})).to.equal(false)
    })
  })

  describe('inherit / depend', () => {
    let ctx: Context

    beforeEach(async () => {
      ctx = await setup()
    })

    it('test passes when an inherits-parent is granted', async () => {
      // 'editor' inherits 'admin' — having 'admin' grants 'editor'
      ctx.capability.inherit('editor', ['admin'])
      expect(await ctx.capability.test('editor', { capabilities: ['admin'] })).to.equal(true)
      expect(await ctx.capability.test('editor', { capabilities: ['editor'] })).to.equal(true)
      expect(await ctx.capability.test('editor', { capabilities: ['other'] })).to.equal(false)
    })

    it('test fails when a depend is missing', async () => {
      // 'publish' depends on 'write' AND 'review' — to be granted publish,
      // the session must have publish itself AND write AND review.
      ctx.capability.depend('publish', ['write', 'review'])
      expect(await ctx.capability.test('publish', { capabilities: ['publish', 'write', 'review'] })).to.equal(true)
      expect(await ctx.capability.test('publish', { capabilities: ['publish', 'write'] })).to.equal(false)
      expect(await ctx.capability.test('publish', { capabilities: ['publish'] })).to.equal(false)
    })

    it('inherits via dynamic links', async () => {
      ctx.capability.inherit('document:(id):edit', () => ['document:any:edit'])
      expect(await ctx.capability.test('document:42:edit', { capabilities: ['document:any:edit'] })).to.equal(true)
    })
  })

  describe('list', () => {
    it('collects names from literal patterns', async () => {
      const ctx = await setup()
      ctx.capability.provide('admin', () => true)
      ctx.capability.provide('editor', () => true)
      const names = ctx.capability.list().sort()
      expect(names).to.include('admin')
      expect(names).to.include('editor')
    })

    it('uses explicit list() option for templated patterns', async () => {
      const ctx = await setup()
      ctx.capability.define('authority:(value)', {
        check: () => true,
        list: () => ['authority:0', 'authority:1', 'authority:2'],
      })
      const names = ctx.capability.list()
      expect(names).to.include('authority:0')
      expect(names).to.include('authority:2')
    })
  })

  describe('lifecycle', () => {
    it('disposes entries when registering plugin disposes', async () => {
      const ctx = await setup()
      const registrar = {
        inject: ['capability'],
        apply(c: Context) {
          c.capability.provide('temp', () => true)
        },
      }
      await ctx.plugin(registrar)
      await sleep()
      expect(await ctx.capability.check('temp', { capabilities: [] })).to.equal(true)
      ctx.registry.delete(registrar)
      await sleep()
      expect(await ctx.capability.check('temp', { capabilities: [] })).to.equal(false)
    })
  })
})
