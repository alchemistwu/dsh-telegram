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
import { createSession, isConversationSession } from './sessions.ts'

export interface Config {
  token?: string
  allowedChatIds?: number[]
  workspacePath?: string
  model?: { provider?: string; model?: string }
}

interface PluginState {
  transport?: Transport
  bridge?: Bridge
}

export function apply(ctx: any, config: Config) {
  const logger = ctx.logger('telegram')
  const state: PluginState = {}

  // --- token resolution: config > env > .telegram-token file ---
  const token = config.token
    ?? process.env.TELEGRAM_BOT_TOKEN
    ?? readTokenFile()
  if (!token) {
    logger.warn('no bot token (config.token, TELEGRAM_BOT_TOKEN, or .telegram-token) — plugin inert')
    return
  }

  const allowed = new Set(config.allowedChatIds ?? [])
  const workspacePath = config.workspacePath ?? process.cwd()

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
        const svc = services()
        const list = svc.sessions?.list?.() ?? []
        const rows = list
          .filter((s: any) => isConversationSession({ origin: s.header?.origin, parentSession: s.header?.parentSession }))
          .slice(0, 15)
          .map((s: any) => {
            const bound = bridge.agentFor(chatId) === String(s.id) ? '▸' : '•'
            const title = s.title ?? s.header?.cwd?.split('/').pop() ?? String(s.id).slice(0, 18)
            return `${bound} ${title}  (${String(s.id).slice(0, 13)}…)`
          })
        await transport.send(chatId, rows.length ? rows.join('\n') : '(no sessions)')
        return true
      }
      case '/use': {
        const prefix = rest[0]
        if (!prefix) { await transport.send(chatId, 'usage: /use <session-id-prefix>'); return true }
        const list = ctx.get?.('sessions')?.list?.() ?? []
        const match = list.find((s: any) => String(s.id).startsWith(prefix))
        if (!match) { await transport.send(chatId, `no session matches "${prefix}"`); return true }
        bridge.bind(chatId, String(match.id))
        await transport.send(chatId, `🔀 Using session ${String(match.id).slice(0, 18)}…`)
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
        try { await agent?.abort?.() } catch { /* best effort */ }
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
    transport.stop()
  })

  void transport.start(async (chatId, text) => {
    if (!allowed.has(chatId)) {
      logger.warn(`rejected message from chat ${chatId} (not in allowedChatIds)`)
      return
    }
    try {
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
    const p = join(__dirname, '..', '.telegram-token')
    if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  } catch { /* fall through */ }
  return undefined
}
