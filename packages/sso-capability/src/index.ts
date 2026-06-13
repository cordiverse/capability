import { Context, Inject, Service } from 'cordis'
import type {} from '@cordisjs/plugin-database'
import type {} from '@cordisjs/plugin-sso'
import type {} from '@cordisjs/plugin-server-capability'

declare module 'cordis' {
  interface Context {
    ssoCapability: SsoCapability
  }
}

declare module '@cordisjs/plugin-capability' {
  namespace Capability {
    interface Session {
      identityId?: number
    }
  }
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    'sso.capability': SsoCapabilityEntry
  }
}

export interface SsoCapabilityEntry {
  id: number
  userId: number
  name: string
  grantedAt: Date
}

function extractBearer(header: string | null | undefined): string | undefined {
  if (!header) return
  const [type, token] = header.split(' ')
  if (type?.toLowerCase() === 'bearer' && token) return token
}

@Inject('database')
@Inject('sso')
export class SsoCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ssoCapability')

    ctx.database.extend('sso.capability', {
      id: 'unsigned(8)',
      userId: 'unsigned(8)',
      name: 'string(255)',
      grantedAt: 'timestamp',
    }, {
      autoInc: true,
      unique: [['userId', 'name']],
      foreign: { userId: ['sso.user', 'id'] },
    })

    ctx.on('server/capability-session', async ({ req, session }) => {
      const token = extractBearer(req.headers.get('authorization'))
      if (!token) return
      const user = await ctx.sso.validateSession(token)
      if (!user) return
      const [ssoSession] = await ctx.database.get('sso.session', { token })
      session.userId = user.id
      if (ssoSession) session.identityId = ssoSession.identityId
      const capabilities = await this.getCapabilities(user.id)
      session.capabilities = [...(session.capabilities ?? []), ...capabilities]
    })
  }

  async grant(userId: number, name: string): Promise<void> {
    await this.ctx.database.upsert('sso.capability', [{
      userId,
      name,
      grantedAt: new Date(),
    }], ['userId', 'name'])
  }

  async revoke(userId: number, name: string): Promise<void> {
    await this.ctx.database.remove('sso.capability', { userId, name })
  }

  async getCapabilities(userId: number): Promise<string[]> {
    const rows = await this.ctx.database.get('sso.capability', { userId })
    return rows.map((row) => row.name)
  }

  async setCapabilities(userId: number, names: string[]): Promise<void> {
    const existing = await this.getCapabilities(userId)
    const existingSet = new Set(existing)
    const desiredSet = new Set(names)
    const toAdd = names.filter((n) => !existingSet.has(n))
    const toRemove = existing.filter((n) => !desiredSet.has(n))
    const now = new Date()
    if (toAdd.length) {
      await this.ctx.database.upsert('sso.capability',
        toAdd.map((name) => ({ userId, name, grantedAt: now })),
        ['userId', 'name'],
      )
    }
    for (const name of toRemove) {
      await this.ctx.database.remove('sso.capability', { userId, name })
    }
  }
}

export default SsoCapability
