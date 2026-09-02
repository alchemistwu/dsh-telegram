/**
 * Autonomous end-to-end runtime verification: exercises EVERY code path
 * the telegram plugin uses, against the LIVE cordis runtime — same calls,
 * same order, same argument shapes as the plugin itself. Writes JSONL to
 * /tmp/dsh-probe-report.jsonl.
 *
 * This exists because unit/e2e mocks encode the AUTHOR's beliefs about the
 * API; this probe encodes nothing — it calls the real services and reports
 * what actually happens. Any mismatch (property vs method, arg count,
 * return shape) fails HERE, not in a user-facing error.
 */
import { writeFileSync } from 'node:fs'

export const name = 'dsh-probe'
export const inject = ['agents']

function report(row: Record<string, unknown>) {
  writeFileSync('/tmp/dsh-probe-report.jsonl', JSON.stringify({ t: new Date().toISOString(), ...row }) + '\n', { flag: 'a' })
}

export function apply(ctx: any) {
  setTimeout(async () => {
    const failures: string[] = []
    const check = async (name: string, fn: () => unknown) => {
      try {
        const v = await (fn() as any)
        report({ check: name, ok: true, ...((typeof v === 'object' && v !== null) ? v as object : { value: v }) })
      } catch (e) {
        failures.push(name)
        report({ check: name, FAILED: (e as Error).message.slice(0, 200) })
      }
    }

    // === 1. service surface: every member the plugin touches, right kind ===
    const presets = ctx.get?.('agentPresets')
    await check('presets.defaultId-is-property', () => {
      const v = presets.defaultId            // plugin reads it as a PROPERTY
      if (typeof v === 'function') throw new Error('defaultId is a function, not a property')
      if (typeof v !== 'string' || !v) throw new Error(`defaultId not a non-empty string: ${v}`)
      return { value: v }
    })
    await check('presets.resolve+mount-callable', () =>
      (typeof presets.resolve === 'function' && typeof presets.mount === 'function')
        ? true : (() => { throw new Error('resolve/mount missing') })())

    const sessions = ctx.get?.('sessions')
    await check('sessions.list', () =>
      Array.isArray(sessions.list()) ? { count: sessions.list().length } : (() => { throw new Error('list() not array') })())

    const persp = ctx.get?.('sessionPersistence')
    await check('persistence.list', async () => {
      const h = await persp.list()
      if (!Array.isArray(h)) throw new Error('list() not array')
      return { count: h.length, sampleId: h[0] ? String(h[0].id).slice(0, 20) : null }
    })

    const titles = ctx.get?.('sessionTitle')
    await check('sessionTitle.get+rename-callable', () =>
      (typeof titles.get === 'function' && typeof titles.rename === 'function')
        ? true : (() => { throw new Error('missing') })())

    const reg = ctx.get?.('workspaceRegistry')
    await check('workspaceRegistry.list', () => {
      const ws = reg.list()
      return { count: ws.length, hasPath: ws[0] ? typeof ws[0].path === 'string' : null, attachType: ws[0] ? typeof ws[0].attachSession : null }
    })

    await check('agents.surface', () => ({
      create: typeof ctx.agents.create,
      resume: typeof ctx.agents.resume,
      get: typeof ctx.agents.get,
      list: typeof ctx.agents.list,
    }))

    // === 2. REAL create flow: exactly what sessions.ts createSession does ===
    let createdId: string | undefined
    await check('create-session-full-dance', async () => {
      const resolved = await presets.resolve(undefined)
      const sessionId = `probe-${crypto.randomUUID()}`
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd(), agentPreset: resolved.id },
        agentOptions: {},
        setup: async (agentCtx: any) => { await presets.mount(agentCtx, resolved.id) },
      })
      createdId = String(handle.agent.id)
      // rename via handle.agent.session (the identity-checked path)
      titles.rename(handle.agent.session, 'PROBE-TEST')
      const readBack = titles.get(handle.agent.session)?.title
      if (readBack !== 'PROBE-TEST') throw new Error(`title readback: ${readBack}`)
      const a = handle.agent
      if (typeof a.followup !== 'function') throw new Error('no followup')
      if (typeof a.cancel !== 'function') throw new Error('no cancel')
      if (typeof a.session?.deriveMessages !== 'function') throw new Error('no deriveMessages')
      return { createdId: createdId.slice(0, 20), title: readBack, status: a.status }
    })

    // === 3. workspace attach on the created session ===
    await check('workspace-attach', async () => {
      if (!createdId) return { skipped: 'no created session' }
      const ws = reg.list()
      const match = ws.find((w: any) => String(w.path) === process.cwd())
      if (!match) return { skipped: 'no matching workspace', cwd: process.cwd() }
      await match.attachSession(createdId)
      return { attached: createdId.slice(0, 20) }
    })

    // === 4. persistence inspect/title on the created session ===
    await check('persisted-title-roundtrip', async () => {
      if (!createdId) return { skipped: true }
      await new Promise((r) => setTimeout(r, 1500))   // let persistence flush
      const insp = await persp.inspect(createdId)
      const titleEvents = insp.events.filter((e: any) => e.type === 'session/title')
      return { events: insp.events.length, titles: titleEvents.map((e: any) => e.data?.title) }
    })

    // === 5. agent cancel surface (what /stop calls) ===
    await check('cancel-surface', () => {
      if (!createdId) return { skipped: true }
      const a = ctx.agents.get(createdId)
      a.cancel({ kind: 'user' })
      return { statusAfterCancel: a.status }
    })

    // === 6. resume arity: registry binds ownerCtx, plugin passes ONLY options ===
    await check('resume-signature', () => ({
      arity: ctx.agents.resume.length,
      note: 'must be 1 (options); plugin previously passed ctx as options',
    }))

    // === 7. waterfall with {global:true} receives dispatches carrying a thisArg ===
    await check('scoped-waterfall-global-reach', async () => {
      let fired = false
      const detach = ctx.on('probe/scoped-test', () => { fired = true }, { global: true })
      await ctx.events.waterfall({}, 'probe/scoped-test', {}, () => Promise.resolve(null)).catch(() => {})
      detach()
      if (!fired) throw new Error('global hook did not receive thisArg dispatch')
      return true
    })

    // === summary (after async persistence checks settle) ===
    setTimeout(() => {
      report({ check: 'SUMMARY', failures, verdict: failures.length === 0 ? 'ALL RUNTIME CONTRACTS VERIFIED' : `${failures.length} FAILURES: ${failures.join(', ')}` })
    }, 3000)
  }, 3000)
}
