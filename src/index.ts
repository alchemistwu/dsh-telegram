/**
 * dsh-telegram — minimal, robust Telegram bridge for DeepSeek Harness.
 *
 * Scope (deliberately small):
 * - long-poll one bot, route messages to per-chat sessions
 * - auto-create sessions with preset joined, workspace attached, title set
 * - commands: /new /sessions /use <id-prefix> /status /stop
 * - replies: typing + tool progress events + one final message per turn
 *
 * Explicitly NOT in scope (the xqicxx plugin's 20-feature sprawl):
 * cards, media, goals UI, workspace management, skills browser, compaction
 * approval, live-feed typewriter, multi-lane queues.
 *
 * Config (cordis.patch.yml):
 *   config:
 *     token: 123456:ABC...            # or TELEGRAM_BOT_TOKEN env / .telegram-token file
 *     allowedChatIds: [5085950123]    # empty = deny all (fail closed)
 *     workspacePath: /abs/path        # cwd for auto-created sessions
 *     model: { provider: modal, model: zai-org/GLM-5.3-Flash }   # optional
 *
 * NOTE: Node strip-only TS — no parameter properties, no enums.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Transport } from './transport.ts'
import { Bridge } from './bridge.ts'
import { QuestionAnswerer } from './questions.ts'
import { createSession, isConversationSession } from './sessions.ts'

export interface Config {
  token?: string
  allowedChatIds?: number[]
  workspacePath?: string
  model?: { provider?: string; model?: string }
}

/**
 * Service dependencies consumed by the cordis loader: without declaring
 * these, `ctx.agents` throws `cannot get property "agents" without inject`
 * inside apply (2026-08-31 boot failure). Only `agents` is required; the
 * optional services (agentPresets/sessionTitle/workspaceRegistry/sessions)
 * are read through ctx.get(), which never consults inject.
 */
export const inject = ['agents']

/** Cordis function-plugin name. */
export const name = 'telegram'

interface PluginState {
  transport?: Transport
  bridge?: Bridge
}

export function apply(ctx: any, config?: Config) {
  const logger = ctx.logger('telegram')
  // cordis calls apply(ctx, undefined) when the patch row carries no config —
  // cfg must never be dereferenced before this line (2026-08-31 boot failure).
  const cfg = config ?? {}
  const state: PluginState = {}
  // chatId → session ids of the last /sessions menu, for "/use <number>".
  const sessionMenu = new Map<number, string[]>()

  // --- token resolution: config > env > .telegram-token file ---
  const token = cfg.token
    ?? process.env.TELEGRAM_BOT_TOKEN
    ?? readTokenFile()
  if (!token) {
    logger.warn('no bot token (config.token, TELEGRAM_BOT_TOKEN, or .telegram-token) — plugin inert')
    return
  }

  const allowed = new Set(cfg.allowedChatIds ?? [])
  const workspacePath = cfg.workspacePath ?? process.cwd()

  // --- durable offset store (profile state dir) ---
  const stateDir = join(process.env.HOME ?? '.', '.dsh', 'profiles', 'desktop', 'state')
  const offsetFile = join(stateDir, 'telegram-offset.json')

  const transport = new Transport({
    token,
    readOffset: () => {
      try { return JSON.parse(readFileSync(offsetFile, 'utf8')).offset } catch { return undefined }
    },
    writeOffset: (offset) => {
      try {
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(offsetFile, JSON.stringify({ offset }))
      } catch (err) { logger.warn('offset persist failed:', (err as Error).message) }
    },
    logger: (msg, ...rest) => logger.info(msg, ...rest),
  })

  const bridge = new Bridge({
    transport,
    agents: ctx.agents,
    logger: (msg, ...rest) => logger.warn(msg, ...rest),
  })
  state.transport = transport
  state.bridge = bridge

  // --- ask_user_question answerer: without this, an agent asking a
  // question on a telegram-bound session blocks forever (the only other
  // answerer lives in the web UI nobody is watching) ---
  const answerer = new QuestionAnswerer(
    transport,
    (agentId) => bridge.chatFor(agentId),
    (msg, ...rest) => logger.info(msg, ...rest),
  )
  const detachQuestions = ctx.on('user-questions/request', answerer.tryAnswer)

  // --- commands ---
  async function ensureSession(chatId: number, titleHint?: string): Promise<string> {
    const existing = bridge.agentFor(chatId)
    if (existing && ctx.agents?.get(existing)) return existing
    const { agentId } = await createSession(services(), workspacePath, {
      model: config.model,
      titleHint,
    })
    bridge.bind(chatId, agentId)
    return agentId
  }

  function services() {
    return {
      agents: ctx.agents,
      agentPresets: ctx.get?.('agentPresets'),
      sessionTitle: ctx.get?.('sessionTitle'),
      workspaceRegistry: ctx.get?.('workspaceRegistry'),
      sessions: ctx.get?.('sessions'),
      sessionPersistence: ctx.get?.('sessionPersistence'),
      logger: (msg: string, ...rest: unknown[]) => logger.warn(msg, ...rest),
    }
  }

  async function handleCommand(chatId: number, text: string): Promise<boolean> {
    const [cmd, ...rest] = text.split(/\s+/)
    switch (cmd) {
      case '/new': {
        const { agentId, title } = await createSession(services(), workspacePath, {
          model: config.model,
          titleHint: rest.join(' ') || undefined,
        })
        bridge.bind(chatId, agentId)
        await transport.send(chatId, `✨ New session: ${title ?? agentId}`)
        return true
      }
      case '/sessions': {
        // Verified via runtime probe (2026-08-31): sessions.list() returns
        // only LIVE sessions (in-memory store) — telegram sessions from
        // previous boots don't appear until resumed. The complete durable
        // source is sessionPersistence.list() → SessionHeader[].
        const svc = services()
        const headers = await svc.sessionPersistence?.list?.() ?? []
        const live = svc.sessions
        const titles = svc.sessionTitle
        // Numbered for phone typing: /use 2 selects row 2 of this listing.
        const convos: any[] = headers.filter((h: any) =>
          isConversationSession({ origin: h.origin, parentSession: h.parentSession }))
        sessionMenu.set(chatId, convos.slice(0, 15).map((h: any) => String(h.id)))
        const rows: string[] = []
        let n = 0
        for (const h of convos) {
          n++
          const id = String(h.id)
          const bound = bridge.agentFor(chatId) === id ? '▸' : `${n}.`
          let title: string | undefined
          const liveSession = live?.get?.(h.id)
          if (liveSession) {
            title = titles?.get?.(liveSession)?.title
          } else {
            title = await persistedTitle(svc, h.id)
          }
          const fallback = h.cwd?.split('/').pop() ?? id.slice(0, 18)
          rows.push(`${bound} ${title ?? fallback}`)
          if (rows.length >= 15) break
        }
        await transport.send(chatId, rows.length
          ? rows.join('\n') + '\n\n/use <编号或标题词> 切换'
          : '(no sessions)')
        return true
      }
      case '/use': {
        const query = rest.join(' ').trim()
        if (!query) { await transport.send(chatId, 'usage: /use <编号|标题词|id前缀>（编号见 /sessions）'); return true }
        const svc = services()
        // 1) number from the last /sessions menu shown to this chat
        let id: string | undefined
        const menu = sessionMenu.get(chatId)
        if (/^\d+$/.test(query) && menu) {
          id = menu[Number(query) - 1]
        }
        // 2) id prefix or 3) title word, against persisted conversations
        if (!id) {
          const headers = await svc.sessionPersistence?.list?.() ?? []
          const convos = headers.filter((h: any) =>
            isConversationSession({ origin: h.origin, parentSession: h.parentSession }))
          const byPrefix = convos.find((h: any) => String(h.id).startsWith(query))
          if (byPrefix) {
            id = String(byPrefix.id)
          } else {
            const q = query.toLowerCase()
            for (const h of convos) {
              const title = await persistedTitle(svc, h.id) ?? ''
              if (title.toLowerCase().includes(q)) { id = String(h.id); break }
            }
          }
        }
        if (!id) { await transport.send(chatId, `no session matches "${query}"`); return true }
        // Live already? bind directly. Otherwise resume through the registry
        // (verified: registry resume(options) — one arg; ownerCtx is bound
        // internally. Preset must mount in setup, same as create).
        if (!ctx.agents?.get?.(id)) {
          await ctx.agents.resume({
            resumeSessionId: id,
            agentOptions: cfg.model ? { model: cfg.model } : undefined,
            setup: (agentCtx: any, commit: any) => {
              const presets = ctx.get?.('agentPresets')
              const presetId = presets?.defaultId?.()
              const preset = presetId ? presets.resolve?.(presetId) : undefined
              if (preset) presets.mount?.(agentCtx, preset)
              commit?.()
            },
          })
        }
        bridge.bind(chatId, id)
        const title = await persistedTitle(svc, id)
        await transport.send(chatId, `🔀 ${title ?? id.slice(0, 18)}`)
        return true
      }
      case '/status': {
        const agentId = bridge.agentFor(chatId)
        const agent = agentId ? ctx.agents?.get(agentId) : undefined
        await transport.send(chatId, agent
          ? `session ${agentId.slice(0, 18)}… — status: ${agent.status ?? 'unknown'}`
          : 'no session bound — send any message to create one')
        return true
      }
      case '/stop': {
        const agentId = bridge.agentFor(chatId)
        const agent = agentId ? ctx.agents?.get(agentId) : undefined
        // Verified (agent-loop agent.ts:143): the cancel API is
        // agent.cancel(cause) — there is no agent.abort.
        try { agent?.cancel?.({ kind: 'user' }) } catch { /* best effort */ }
        await transport.send(chatId, '⏹ aborted')
        return true
      }
      default:
        return false
    }
  }

  // --- inbound pipeline ---
  const detachEvents = bridge.attachEvents(ctx)
  ctx.on('dispose', () => {
    detachEvents()
    detachQuestions()
    transport.stop()
  })

  void transport.start(async (chatId, text) => {
    if (!allowed.has(chatId)) {
      logger.warn(`rejected message from chat ${chatId} (not in allowedChatIds)`)
      return
    }
    try {
      // A pending ask_user_question consumes this message as its answer.
      if (answerer.feed(chatId, text)) return
      if (text.startsWith('/') && await handleCommand(chatId, text)) return
      await ensureSession(chatId, text)
      await bridge.deliver(chatId, text)
    } catch (err) {
      logger.warn('inbound handling failed:', (err as Error).message)
      await transport.send(chatId, `❌ ${(err as Error).message.slice(0, 300)}`).catch(() => {})
    }
  }).catch((err) => logger.error('polling died:', (err as Error).message))

  logger.info(`telegram bridge live (chats: ${[...allowed].join(', ') || 'NONE'})`)
}

function readTokenFile(): string | undefined {
  try {
    const p = join(new URL('..', import.meta.url).pathname, '.telegram-token')
    if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  } catch { /* fall through */ }
  return undefined
}

/**
 * Title of a persisted, non-live session: last 'session/title' event in the
 * stored log (verified event type: session-title/src/index.ts:76, data shape
 * SessionTitleEventData { title, messageSeqs, source }). Returns undefined on
 * any failure — callers fall back to cwd basename.
 */
async function persistedTitle(svc: any, sessionId: string): Promise<string | undefined> {
  try {
    const insp = await svc.sessionPersistence?.inspect?.(sessionId)
    const events = insp?.events ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'session/title' && typeof e.data?.title === 'string') return e.data.title
    }
  } catch { /* non-fatal */ }
  return undefined
}
