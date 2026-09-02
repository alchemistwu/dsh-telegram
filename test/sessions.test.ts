/**
 * Session lifecycle tests — one per production incident from 2026-08-31.
 * Run: node --experimental-strip-types --test test/sessions.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoTitle, createSession, isConversationSession } from '../src/sessions.ts'

function fakeServices(overrides: any = {}) {
  const calls: any = { create: [], mounted: [], attached: [], renamed: [] }
  const svc = {
    agents: {
      create: async (args: any) => {
        calls.create.push(args)
        if (args.setup) await args.setup({ fakeAgentCtx: true })
        return { agent: { id: args.sessionId } }
      },
    },
    agentPresets: {
      defaultId: 'standard',
      resolve: async (id?: string) => ({ id: id ?? 'standard' }),
      mount: async (agentCtx: any, presetId: string) => { calls.mounted.push(presetId) },
    },
    sessionTitle: {
      rename: (session: any, title: string) => { calls.renamed.push(title); return { title } },
    },
    workspaceRegistry: {
      list: () => [{ path: '/work', attachSession: async (id: string) => { calls.attached.push(id) } }],
    },
    sessions: { get: (id: string) => ({ id }) },
    logger: () => {},
    ...overrides,
  }
  return { svc, calls }
}

test('rule 1: created agent joins the default preset', async () => {
  const { svc, calls } = fakeServices()
  await createSession(svc, '/work', {})
  assert.deepEqual(calls.mounted, ['standard'])
  assert.equal(calls.create[0].meta.agentPreset, 'standard')
})

test('rule 2: session attaches to the workspace matching cwd', async () => {
  const { svc, calls } = fakeServices()
  const { agentId } = await createSession(svc, '/work', {})
  assert.deepEqual(calls.attached, [agentId])
})

test('rule 3: telegram sessions are auto-titled with timestamp + hint', async () => {
  const { svc, calls } = fakeServices()
  await createSession(svc, '/work', { titleHint: 'fix the login bug' })
  assert.equal(calls.renamed.length, 1)
  assert.match(calls.renamed[0], /^TG \d{2}-\d{2} \d{2}:\d{2} fix the login bug$/)
})

test('autoTitle truncates long hints and collapses whitespace', () => {
  const title = autoTitle('a  very   long   message   that   keeps   going   and   going', new Date(2026, 8, 1, 9, 5))
  assert.equal(title, 'TG 09-01 09:05 a very long message that')
})

test('rule 4: subagent sessions are not conversations, web forks ARE', () => {
  // origin 'subagent' or delegationDepth > 0 → hidden (delegated tool runs)
  assert.equal(isConversationSession({ origin: 'subagent' }), false)
  assert.equal(isConversationSession({ delegationDepth: 1 }), false)
  // web "continue in new session" forks: parentSession + seedLength,
  // delegationDepth 0, no origin — the web sidebar shows them as normal
  // conversations, so /sessions must too (2026-09-01 incident: user's live
  // session was invisible)
  assert.equal(isConversationSession({ parentSession: 'session-x', delegationDepth: 0 }), true)
  assert.equal(isConversationSession({}), true)
})

test('preset resolve failure surfaces (no silent tool-less agent)', async () => {
  const { svc } = fakeServices({
    agentPresets: {
      resolve: async () => { throw new Error('preset "standard" not found') },
    },
  })
  await assert.rejects(() => createSession(svc, '/work', {}), /not found/)
})

test('workspace attach failure is non-fatal', async () => {
  const { svc } = fakeServices({
    workspaceRegistry: {
      list: () => [{ path: '/work', attachSession: async () => { throw new Error('store busy') } }],
    },
  })
  const { agentId } = await createSession(svc, '/work', {})
  assert.ok(agentId.startsWith('telegram-'))
})
