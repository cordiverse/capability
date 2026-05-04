import { Context } from 'cordis'
import Capability from '@cordisjs/plugin-capability'
import * as CapabilityGroup from '@cordisjs/plugin-capability-group'
import { expect } from 'chai'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function setup(groups: CapabilityGroup.Config['groups'] = []) {
  const ctx = new Context()
  await ctx.plugin(Capability)
  await ctx.plugin(CapabilityGroup, { groups })
  await sleep()
  return ctx
}

describe('@cordisjs/plugin-capability-group', () => {
  it('granting group name transitively grants a member', async () => {
    const ctx = await setup([{ name: 'admin', members: ['read:users', 'write:users'] }])
    expect(await ctx.capability.test('read:users', { capabilities: ['admin'] })).to.equal(true)
    expect(await ctx.capability.test('write:users', { capabilities: ['admin'] })).to.equal(true)
    expect(await ctx.capability.test('read:users', { capabilities: ['other'] })).to.equal(false)
  })

  it('templated members work via pattern matching', async () => {
    // 'document:(id):read' inherits 'reader' — having 'reader' grants any document read.
    const ctx = await setup([{ name: 'reader', members: ['document:(id):read'] }])
    expect(await ctx.capability.test('document:42:read', { capabilities: ['reader'] })).to.equal(true)
    expect(await ctx.capability.test('document:42:write', { capabilities: ['reader'] })).to.equal(false)
  })

  it('multiple groups: a member in two groups is granted by either', async () => {
    const ctx = await setup([
      { name: 'editor', members: ['write:docs'] },
      { name: 'admin', members: ['write:docs', 'write:users'] },
    ])
    expect(await ctx.capability.test('write:docs', { capabilities: ['editor'] })).to.equal(true)
    expect(await ctx.capability.test('write:docs', { capabilities: ['admin'] })).to.equal(true)
    expect(await ctx.capability.test('write:users', { capabilities: ['editor'] })).to.equal(false)
    expect(await ctx.capability.test('write:users', { capabilities: ['admin'] })).to.equal(true)
  })

  it('disposes cleanly: inherits are removed on plugin disposal', async () => {
    const ctx = await setup([{ name: 'admin', members: ['read:users'] }])
    expect(await ctx.capability.test('read:users', { capabilities: ['admin'] })).to.equal(true)
    ctx.registry.delete(CapabilityGroup)
    await sleep()
    expect(await ctx.capability.test('read:users', { capabilities: ['admin'] })).to.equal(false)
    expect(await ctx.capability.test('read:users', { capabilities: ['read:users'] })).to.equal(true)
  })
})
