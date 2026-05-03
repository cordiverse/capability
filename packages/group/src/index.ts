import { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@cordisjs/plugin-capability'

export interface GroupEntry {
  name: string
  members: string[]
}

export interface Config {
  groups: GroupEntry[]
}

export const name = 'capability-group'
export const inject = ['capability']

export const Config: z<Config> = z.object({
  groups: z.array(z.object({
    name: z.string().required(),
    members: z.array(String).default([]),
  })).default([]),
})

export function apply(ctx: Context, config: Config) {
  for (const { name, members } of config.groups) {
    for (const member of members) {
      ctx.capability.inherit(member, [name])
    }
  }
}
