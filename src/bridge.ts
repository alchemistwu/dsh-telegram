/**
 * Bridge: chat ↔ session binding and the reply pipeline.
 *
 * Reply style (chosen 2026-09-01, "do less, be robust"):
 * - While the agent works: typing indicator + short progress events
 *   ("🔧 <tool>" on each tool call).
 * - When the turn completes: one final message with the full reply.
 * No editMessageText typewriter — Telegram edit rate limits make it fragile.
 *
 * NOTE: Node strip-only TS — no parameter properties, no enums.
 */

import type { Transport } from './transport.ts'

export interface BridgeDeps {
  transport: Transport
  agents: any
  logger: (msg: string, ...rest: unknown[]) => void
}

export class Bridge {
  private deps: BridgeDeps
  /** chatId → agentId. */
  private bindings = new Map<number, string>()
  /** agentId → chatId (reverse index). */
  private agentToChat = new Map<string, number>()
  /** agentIds currently mid-turn; progress events only for these. */
  private running = new Set<string>()

  constructor(deps: BridgeDeps) {
    this.deps = deps
  }

  bind(chatId: number, agentId: string): void {
    const previous = this.bindings.get(chatId)
    if (previous) this.agentToChat.delete(previous)
    this.bindings.set(chatId, agentId)
    this.agentToChat.set(agentId, chatId)
  }

  agentFor(chatId: number): string | undefined {
    return this.bindings.get(chatId)
  }

  chatFor(agentId: string): number | undefined {
    return this.agentToChat.get(agentId)
  }

  /**
   * Wire session events → telegram progress/final messages.
   * Called once from the plugin's apply(); returns a disposer.
   */
  attachEvents(ctx: any): () => void {
    const onEvent = (session: any, event: any) => {
      const agentId = String(session?.id ?? '')
      const chatId = this.chatFor(agentId)
      if (chatId === undefined) return
      const type = event?.type

      if (type === 'turn/start') {
        this.running.add(agentId)
        void this.deps.transport.sendTyping(chatId)
        return
      }
      // Verified event names (session/types.ts): 'tool/call' carries
      // { turn, step, callId, name, arguments } — 'tool/started' never existed.
      if (type === 'tool/call' && this.running.has(agentId)) {
        const name = event.data?.name ?? 'tool'
        void this.deps.transport.send(chatId, `🔧 ${name}`).catch(() => {})
        return
      }
      if (type === 'turn/end') {
        this.running.delete(agentId)
        const text = extractFinalText(session)
        if (text) {
          void this.deps.transport.send(chatId, text).catch((err) =>
            this.deps.logger('final send failed:', (err as Error).message))
        }
        return
      }
    }
    const disposer = ctx.on('session/event', onEvent)
    return typeof disposer === 'function' ? disposer : () => {}
  }

  /** Deliver one inbound telegram message to the bound agent. */
  async deliver(chatId: number, text: string): Promise<void> {
    const agentId = this.agentFor(chatId)
    if (!agentId) throw new Error('no session bound')
    const agent = this.deps.agents?.get(agentId)
    if (!agent) throw new Error('bound session is not live')
    // Agent-loop API (agent.prompt does not exist): followup(message) is
    // send(message, 'next-turn', wakeup=true) — a normal user turn.
    const message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
    if (typeof agent.followup === 'function') {
      agent.followup(message)
    } else if (typeof agent.send === 'function') {
      agent.send(message, 'next-turn', true)
    } else {
      throw new Error('agent exposes neither followup() nor send() — unsupported agent implementation')
    }
  }
}

/** Best-effort: last assistant text from the session's live message list. */
function extractFinalText(session: any): string | undefined {
  try {
    const messages = session?.deriveMessages?.() ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== 'assistant') continue
      const parts = Array.isArray(m.content) ? m.content : []
      const text = parts
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text ?? '')
        .join('\n')
        .trim()
      if (text) return text.slice(0, 4000)
    }
  } catch { /* fall through */ }
  return undefined
}
