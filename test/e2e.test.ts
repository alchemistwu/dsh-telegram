/**
 * End-to-end self-test: drive the REAL plugin apply() through a fake
 * Telegram network and a probe-shaped cordis ctx. Simulates the user
 * sending every command and plain messages, and asserts what the bot
 * would have sent back. No Desktop restart, no phone.
 *
 * Service shapes come from the live runtime probe report (2026-08-31):
 * - agents: list/get/resume, agent has followup/cancel/status/session
 * - sessions.list(): live-only, Session.header.{cwd,origin,parentSession}
 * - sessionPersistence.list(): SessionHeader[] (all persisted)
 * - sessionPersistence.inspect(id): { meta, events } — title from
 *   last 'session/title' event
 * - sessionTitle.get(session)?.title
 * - agentPresets: defaultId/resolve/mount
 * - workspaceRegistry: list/attachSession
 *
 * Run: node --experimental-strip-types --test test/e2e.test.ts
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.ts'

// ---------- fake telegram network ----------
interface SentMsg { chatId: number; text: string }

function makeNetwork() {
  const sent: SentMsg[] = []
  const queue: any[] = []           // pending getUpdates payloads
  let offset: number | undefined
  const fetchMock = async (url: string, init?: any) => {
    const method = url.split('/').pop()
    const body = init?.body ? JSON.parse(init.body) : {}
    if (method === 'getUpdates') {
      offset = body.offset ?? offset
      // yield to the macrotask queue first — a promise-only loop would
      // starve setImmediate and deadlock the test harness
      await new Promise((r) => setImmediate(r))
      const updates = queue.splice(0)
      return { ok: true, json: async () => ({ ok: true, result: updates }) } as any
    }
    if (method === 'sendMessage') {
      sent.push({ chatId: body.chat_id, text: body.text })
      return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) } as any
    }
    if (method === 'sendChatAction') {
      return { ok: true, json: async () => ({ ok: true, result: true }) } as any
    }
    throw new Error(`unexpected telegram method: ${method}`)
  }
  const pushMessage = (chatId: number, text: string, updateId: number) => {
    queue.push({
      update_id: updateId,
      message: { message_id: updateId, chat: { id: chatId }, text, date: 1788220000 },
    })
  }
  return { fetchMock, pushMessage, sent, getOffset: () => offset }
}

// ---------- probe-shaped cordis ctx ----------
function makeCtx(overrides: {
  persistedHeaders?: any[]
  inspections?: Record<string, any>
  liveSessions?: any[]
  agents?: Map<string, any>
}) {
  const agentMap = overrides.agents ?? new Map<string, any>()
  const ctx: any = {
    logger: (name: string) => {
      const f = () => {}
      f.info = f.warn = f.error = f.debug = () => {}
      return f
    },
    on: () => () => {},
    agents: {
      get: (id: string) => agentMap.get(id),
      list: () => [...agentMap.values()],
      create: async (opts: any) => {   // registry API: create(options) — one arg
        opts?.setup?.({ extend: () => ({}) }, () => {})
        const agent = {
          id: opts.sessionId,
          status: 'idle',
          session: { id: opts.sessionId, header: opts.meta, deriveMessages: () => [] },
          followup: (m: any) => { agent.lastMessage = m },
          cancel: (c: any) => { agent.cancelled = c },
          lastMessage: undefined as any,
          cancelled: undefined as any,
        }
        agentMap.set(opts.sessionId, agent)
        return { agent, dispose: async () => { agentMap.delete(opts.sessionId) } }
      },
      resume: async (opts: any) => {   // registry API: resume(options) — one arg
        opts?.setup?.({ extend: () => ({}) }, () => {})
        const h = (overrides.persistedHeaders ?? []).find((x) => String(x.id) === opts.resumeSessionId)
        const agent = {
          id: opts.resumeSessionId,
          status: 'idle',
          session: { id: opts.resumeSessionId, header: h?.meta ?? h, deriveMessages: () => [] },
          followup: (m: any) => { agent.lastMessage = m },
          cancel: () => {},
          lastMessage: undefined as any,
        }
        agentMap.set(opts.resumeSessionId, agent)
        return { agent, dispose: async () => { agentMap.delete(opts.resumeSessionId) } }
      },
    },
    _services: {
      sessions: { list: () => overrides.liveSessions ?? [], get: (id: string) => (overrides.liveSessions ?? []).find((s) => s.id === id) },
      sessionPersistence: {
        list: async () => overrides.persistedHeaders ?? [],
        inspect: async (id: string) => overrides.inspections?.[id] ?? { meta: {}, events: [] },
      },
      sessionTitle: {
        get: (s: any) => s?._title ? { title: s._title } : undefined,
        rename: (s: any, title: string) => { if (s) s._title = title },
      },
      agentPresets: {
        defaultId: 'standard',                    // PROPERTY (verified source)
        resolve: async (id?: string) => ({ id: id ?? 'standard' }),
        mount: async (_ctx: any, _id?: string) => ({ id: _id ?? 'standard' }),  // (agentCtx, id)
      },
      workspaceRegistry: {
        list: () => [],
        attachSession: () => {},
      },
    },
    get(name: string) { return (this._services as any)[name] },
  }
  return { ctx, agentMap }
}

// ---------- harness ----------
const CHAT = 5085950123
const TOKEN = 'test-token'

function boot(opts: Parameters<typeof makeCtx>[0] & { token?: string } = {}) {
  const net = makeNetwork()
  const { ctx, agentMap } = makeCtx(opts)
  const realFetch = globalThis.fetch
  globalThis.fetch = net.fetchMock as any
  process.env.TELEGRAM_BOT_TOKEN = opts.token ?? TOKEN
  const disposers: (() => void)[] = []
  // capture the dispose handler apply() registers, so tests can stop polling
  const origOn = ctx.on.bind(ctx)
  ctx.on = (event: string, cb: any) => {
    if (event === 'dispose') disposers.push(cb)
    return origOn(event, cb)
  }
  apply(ctx, {
    allowedChatIds: [CHAT],
    workspacePath: '/Users/junzhengwu/Documents/Deepseek Harness',
  })
  return {
    net, ctx, agentMap,
    async send(text: string, updateId: number) {
      net.pushMessage(CHAT, text, updateId)
      // let the poll loop + handler drain
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
    },
    restore() {
      for (const d of disposers) d()   // triggers transport.stop()
      globalThis.fetch = realFetch
      delete process.env.TELEGRAM_BOT_TOKEN
    },
  }
}

// ---------- tests ----------
test('plain message creates session (telegram- id) and delivers to agent', async () => {
  const h = boot()
  try {
    await h.send('hello world', 1)
    const agents = [...h.agentMap.values()]
    assert.equal(agents.length, 1)
    assert.ok(String(agents[0].id).startsWith('telegram-'), `id should be telegram-*, got ${agents[0].id}`)
    assert.equal(agents[0].lastMessage?.content?.[0]?.text, 'hello world')
    assert.equal(agents[0].lastMessage?.role, 'user')
  } finally { h.restore() }
})

test('/sessions lists persisted conversations, filters subagent origin', async () => {
  const h = boot({
    persistedHeaders: [
      { id: 'telegram-aaa111', origin: undefined, parentSession: undefined, cwd: '/x/Deepseek Harness' },
      { id: 'telegram-bbb222', origin: undefined, parentSession: undefined, cwd: '/x/Deepseek Harness' },
      { id: 'deadbeef-sub', origin: 'subagent', parentSession: 'telegram-aaa111', cwd: '/x' },
      { id: 'cafe33-fork', origin: undefined, parentSession: 'session-parent', cwd: '/x' },
    ],
    inspections: {
      'telegram-aaa111': { meta: {}, events: [{ type: 'session/title', data: { title: 'TG 09-01 chats' } }] },
    },
  })
  try {
    await h.send('/sessions', 2)
    const reply = h.net.sent.find((m) => m.chatId === CHAT)?.text ?? ''
    assert.match(reply, /TG 09-01 chats/)          // persisted title
    assert.match(reply, /telegram-bbb222|Deepseek Harness/) // second session shown
    assert.doesNotMatch(reply, /deadbeef/)         // subagent filtered
    assert.doesNotMatch(reply, /cafe33/)           // forked filtered
  } finally { h.restore() }
})

test('/use <number> picks from the last /sessions menu', async () => {
  const h = boot({
    persistedHeaders: [
      { id: 'telegram-aaa111', origin: undefined, parentSession: undefined, cwd: '/x' },
      { id: 'telegram-bbb222', origin: undefined, parentSession: undefined, cwd: '/x' },
    ],
    inspections: {
      'telegram-aaa111': { meta: {}, events: [{ type: 'session/title', data: { title: 'first chat' } }] },
      'telegram-bbb222': { meta: {}, events: [{ type: 'session/title', data: { title: 'second chat' } }] },
    },
  })
  try {
    await h.send('/sessions', 20)
    const menu = h.net.sent.at(-1)?.text ?? ''
    assert.match(menu, /1\. .*first chat|2\. .*second chat/s)
    await h.send('/use 2', 21)
    assert.ok(h.agentMap.has('telegram-bbb222'), 'row 2 should resume telegram-bbb222')
    assert.match(h.net.sent.at(-1)?.text ?? '', /second chat/)
    await h.send('hello again', 22)
    assert.equal(h.agentMap.get('telegram-bbb222')?.lastMessage?.content?.[0]?.text, 'hello again')
  } finally { h.restore() }
})

test('/use <title word> matches persisted titles', async () => {
  const h = boot({
    persistedHeaders: [
      { id: 'telegram-aaa111', origin: undefined, parentSession: undefined, cwd: '/x' },
      { id: 'telegram-bbb222', origin: undefined, parentSession: undefined, cwd: '/x' },
    ],
    inspections: {
      'telegram-aaa111': { meta: {}, events: [{ type: 'session/title', data: { title: 'TG deploy talk' } }] },
      'telegram-bbb222': { meta: {}, events: [{ type: 'session/title', data: { title: 'TG music picks' } }] },
    },
  })
  try {
    await h.send('/use music', 23)
    assert.ok(h.agentMap.has('telegram-bbb222'))
    await h.send('/use nonexistentword', 24)
    assert.match(h.net.sent.at(-1)?.text ?? '', /no session matches/)
  } finally { h.restore() }
})

test('/use resumes an offline persisted session and binds it', async () => {
  const h = boot({
    persistedHeaders: [
      { id: 'telegram-aaa111-old', origin: undefined, parentSession: undefined, cwd: '/x' },
    ],
  })
  try {
    await h.send('/use telegram-aaa111', 3)
    assert.ok(h.agentMap.has('telegram-aaa111-old'), 'session should be resumed into agents')
    const reply = h.net.sent.at(-1)?.text ?? ''
    assert.match(reply, /🔀/)
    // subsequent plain message goes to the resumed agent
    await h.send('continuing', 4)
    assert.equal(h.agentMap.get('telegram-aaa111-old')?.lastMessage?.content?.[0]?.text, 'continuing')
  } finally { h.restore() }
})

test('/new creates a fresh session and binds it', async () => {
  const h = boot()
  try {
    await h.send('first', 5)
    const first = [...h.agentMap.keys()][0]
    await h.send('/new second conversation', 6)
    const keys = [...h.agentMap.keys()]
    assert.equal(keys.length, 2)
    assert.notEqual(keys[1], first)
    const reply = h.net.sent.at(-1)?.text ?? ''
    assert.match(reply, /New session/)
    await h.send('after new', 7)
    assert.equal(h.agentMap.get(keys[1])?.lastMessage?.content?.[0]?.text, 'after new')
  } finally { h.restore() }
})

test('/status reports bound session status', async () => {
  const h = boot()
  try {
    await h.send('/status', 8)
    assert.match(h.net.sent.at(-1)?.text ?? '', /no session bound/)
    await h.send('hi', 9)
    await h.send('/status', 10)
    assert.match(h.net.sent.at(-1)?.text ?? '', /status: idle/)
  } finally { h.restore() }
})

test('/stop cancels the bound agent with user cause', async () => {
  const h = boot()
  try {
    await h.send('hi', 11)
    await h.send('/stop', 12)
    const agent = [...h.agentMap.values()][0] as any
    assert.deepEqual(agent.cancelled, { kind: 'user' })
    assert.match(h.net.sent.at(-1)?.text ?? '', /aborted/)
  } finally { h.restore() }
})

test('unknown command falls through to agent delivery', async () => {
  const h = boot()
  try {
    await h.send('/notacommand', 13)
    const agent = [...h.agentMap.values()][0] as any
    assert.equal(agent?.lastMessage?.content?.[0]?.text, '/notacommand')
  } finally { h.restore() }
})

test('rejected chat id is ignored silently', async () => {
  const h = boot()
  try {
    h.net.pushMessage(999999, 'intruder', 14)
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
    assert.equal(h.agentMap.size, 0)
    assert.equal(h.net.sent.filter((m) => m.chatId === 999999).length, 0)
  } finally { h.restore() }
})
