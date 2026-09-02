/**
 * Sessions: the lifecycle rules we learned the hard way (2026-08-31,
 * four production incidents on xqicxx/dsh-telegram in one day):
 *
 * 1. ALWAYS join an agent preset — an agent published without one resolves
 *    tools against the empty global layer ("subagent has no permissions").
 * 2. ALWAYS attach to the workspace matching cwd — the web sidebar groups
 *    strictly by workspace membership, not cwd ("stuck in Ungrouped").
 * 3. ALWAYS title telegram-created sessions — untitled sessions fall back
 *    to the cwd basename and become indistinguishable ("a wall of 'work'").
 * 4. NEVER list subagent-origin sessions as conversation entries.
 *
 * Every rule has a test in test/sessions.test.ts.
 *
 * NOTE: Node strip-only TS — no parameter properties, no enums.
 */

export interface SessionCreateOptions {
  model?: { provider?: string; model?: string }
  titleHint?: string
}

/** Deps are structurally typed so tests inject fakes without cordis. */
export interface SessionServices {
  agents: any
  agentPresets?: any
  sessionTitle?: any
  workspaceRegistry?: any
  sessions?: any
  logger: (msg: string, ...rest: unknown[]) => void
}

export function autoTitle(titleHint?: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const preview = (titleHint ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
  return preview ? `TG ${stamp} ${preview}` : `TG ${stamp}`
}

export async function createSession(
  svc: SessionServices,
  cwd: string,
  options: SessionCreateOptions,
): Promise<{ agentId: string; title?: string }> {
  if (!svc.agents) throw new Error('agents service unavailable')

  // Rule 1: resolve + mount the default preset through the creation setup
  // hook. If the roster exists but resolve fails, surface the error — a
  // session without tools is worse than no session.
  let resolvedPreset: string | undefined
  let presetSetup: ((agentCtx: any) => Promise<void>) | undefined
  if (svc.agentPresets) {
    const resolve = svc.agentPresets.resolve?.bind(svc.agentPresets)
      ?? ((id?: string) => Promise.resolve({ id: id ?? svc.agentPresets.defaultId ?? 'default' }))
    resolvedPreset = (await resolve(undefined)).id
    const presetId = resolvedPreset
    presetSetup = async (agentCtx: any) => {
      await svc.agentPresets.mount(agentCtx, presetId)
    }
  }

  const sessionId = `telegram-${crypto.randomUUID()}`
  const handle = await svc.agents.create({
    sessionId,
    meta: {
      cwd,
      ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
    },
    agentOptions: {
      provider: options.model?.provider,
      model: options.model?.model,
    },
    setup: presetSetup,
  })
  const agentId = String(handle.agent.id)

  // Rule 3: title immediately. rename() requires the exact live Session
  // (it identity-checks against ctx.sessions); agent.session is that object
  // (verified: ReactLoopAgent constructor receives the store's Session).
  const title = autoTitle(options.titleHint)
  if (svc.sessionTitle) {
    try {
      const session = handle.agent.session ?? svc.sessions?.get?.(sessionId)
      svc.sessionTitle.rename(session, title)
    } catch (err) {
      svc.logger('auto-title failed (non-fatal):', (err as Error).message)
    }
  }

  // Rule 2: attach to the workspace whose path matches cwd.
  if (svc.workspaceRegistry) {
    try {
      const match = svc.workspaceRegistry.list().find((w: any) => String(w.path) === cwd)
      if (match) await match.attachSession(agentId)
    } catch (err) {
      svc.logger('workspace attach failed (non-fatal):', (err as Error).message)
    }
  }

  return { agentId, title }
}

/** Rule 4: filter a raw session roster down to conversation entries. */
export function isConversationSession(detail: { origin?: string; parentSession?: string; delegationDepth?: number }): boolean {
  // origin 'subagent' marks delegated tool sessions. parentSession ALONE is
  // not disqualifying: web "continue in new session" forks carry
  // parentSession + seedLength with delegationDepth 0 and no origin, and the
  // web sidebar shows them as normal conversations (2026-09-01: the user's
  // current session 'work' was invisible in /sessions because of this).
  if (detail.origin === 'subagent') return false
  if ((detail.delegationDepth ?? 0) > 0) return false
  return true
}
