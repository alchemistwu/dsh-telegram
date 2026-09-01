/**
 * Transport: Telegram Bot API long-polling + audited send pipeline.
 *
 * Design rules (learned from xqicxx/dsh-telegram post-mortems):
 * - ONE polling loop, owned here, restart-safe via durable offset.
 * - No outbound message leaves without going through `send()` — one place
 *   for rate limiting, error logging, and HTML escaping decisions.
 * - Everything is idempotent: a restarted poll with a persisted offset
 *   re-delivers nothing.
 *
 * NOTE: Node strip-only TS — no parameter properties, no enums.
 */

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; is_bot?: boolean }
    chat: { id: number; type: string }
    text?: string
    date: number
  }
}

export interface TransportOptions {
  token: string
  /** Durable offset store; the plugin supplies profile-dir persistence. */
  readOffset: () => number | undefined
  writeOffset: (offset: number) => void
  logger: (msg: string, ...rest: unknown[]) => void
}

const API = 'https://api.telegram.org'

export class Transport {
  private opts: TransportOptions
  private running = false
  private abort: AbortController | undefined

  constructor(opts: TransportOptions) {
    this.opts = opts
  }

  private url(method: string): string {
    return `${API}/bot${this.opts.token}/${method}`
  }

  /** One audited send. Throws on permanent failure; retries 429 with backoff. */
  async send(chatId: number, text: string, tries = 3): Promise<void> {
    for (let attempt = 1; attempt <= tries; attempt++) {
      const res = await fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      })
      if (res.ok) return
      if (res.status === 429 && attempt < tries) {
        const body = await res.json().catch(() => ({}))
        const wait = ((body as any)?.parameters?.retry_after ?? 2) * 1000
        this.opts.logger(`send 429, retry in ${wait}ms`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      const body = await res.text().catch(() => '')
      throw new Error(`sendMessage ${res.status}: ${body.slice(0, 200)}`)
    }
  }

  /** Typing indicator; best-effort, never throws. */
  async sendTyping(chatId: number): Promise<void> {
    try {
      await fetch(this.url('sendChatAction'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      })
    } catch { /* cosmetic */ }
  }

  /**
   * Long-poll forever. Each update is ACKed (offset advanced + persisted)
   * BEFORE the handler runs, so a crash never re-delivers a message that
   * already produced a session side-effect.
   */
  async start(onMessage: (chatId: number, text: string) => Promise<void>): Promise<void> {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    let offset = this.opts.readOffset() ?? 0
    this.opts.logger(`polling started (offset=${offset})`)
    while (this.running) {
      try {
        const res = await fetch(this.url('getUpdates'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offset, timeout: 25, allowed_updates: ['message'] }),
          signal: this.abort.signal,
        })
        if (!res.ok) throw new Error(`getUpdates ${res.status}`)
        const data = await res.json() as { ok: boolean; result: TelegramUpdate[] }
        for (const upd of data.result) {
          offset = upd.update_id + 1
          this.opts.writeOffset(offset)
          const msg = upd.message
          if (!msg?.text || msg.from?.is_bot) continue
          await onMessage(msg.chat.id, msg.text)
        }
      } catch (err) {
        if (!this.running) break
        this.opts.logger('poll error, backing off 5s:', (err as Error).message)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  }

  stop(): void {
    this.running = false
    this.abort?.abort()
  }
}
