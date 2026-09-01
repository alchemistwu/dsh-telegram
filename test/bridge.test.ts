/**
 * Bridge deliver tests — the "agent.prompt is not a function" incident:
 * the agent-loop API is followup()/send(), and deliver must use it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../src/bridge.ts'

function fakeDeps(agent: any) {
  return {
    transport: { send: async () => {}, sendTyping: async () => {} } as any,
    agents: { get: (id: string) => (id === 'a1' ? agent : undefined) },
    logger: () => {},
  }
}

test('deliver uses followup() when available', async () => {
  const calls: any[] = []
  const agent = { id: 'a1', followup: (m: any) => calls.push(['followup', m]) }
  const b = new Bridge(fakeDeps(agent))
  b.bind(42, 'a1')
  await b.deliver(42, 'hello')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'followup')
  assert.equal(calls[0][1].role, 'user')
  assert.deepEqual(calls[0][1].content, [{ type: 'text', text: 'hello' }])
  assert.equal(calls[0][1].source.kind, 'user')
  assert.ok(calls[0][1].id)
})

test('deliver falls back to send(message, next-turn, true)', async () => {
  const calls: any[] = []
  const agent = { id: 'a1', send: (...a: any[]) => calls.push(a) }
  const b = new Bridge(fakeDeps(agent))
  b.bind(42, 'a1')
  await b.deliver(42, 'hi')
  assert.deepEqual([calls[0][1], calls[0][2]], ['next-turn', true])
})

test('deliver throws honestly when agent has neither method', async () => {
  const b = new Bridge(fakeDeps({ id: 'a1' }))
  b.bind(42, 'a1')
  await assert.rejects(() => b.deliver(42, 'x'), /neither followup/)
})

test('deliver throws when chat unbound or agent not live', async () => {
  const b = new Bridge(fakeDeps(undefined))
  await assert.rejects(() => b.deliver(42, 'x'), /no session bound/)
  b.bind(42, 'a1')
  await assert.rejects(() => b.deliver(42, 'x'), /not live/)
})
