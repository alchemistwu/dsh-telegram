/**
 * Questions: Telegram answerer for the `user-questions/request` waterfall.
 *
 * The problem (hit twice on 2026-08-31): an agent bound to a Telegram chat
 * calls ask_user_question; the only registered answerer lives in the web UI,
 * which nobody is watching — the tool call blocks forever.
 *
 * The fix: register an agent-scoped answerer that renders the question as a
 * Telegram message and suspends until the chat's next inbound text resolves
 * it. Numeric replies ("2") pick an option; anything else is a custom answer.
 * Multi-question requests are answered one at a time.
 *
 * NOTE: Node strip-only TS — no parameter properties, no enums.
 */

import type { Transport } from './transport.ts'

export interface QuestionItem {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

export interface QuestionRequest {
  questions: QuestionItem[]
  agent?: { id: string }
}

interface PendingQuestion {
  chatId: number
  question: QuestionItem
  resolve: (answer: { id: string; selected: string[]; custom?: string }) => void
}

export function formatQuestion(q: QuestionItem, index: number, total: number): string {
  const lines: string[] = []
  const prefix = total > 1 ? `(${index + 1}/${total}) ` : ''
  lines.push(`❓ ${prefix}${q.header ? `[${q.header}] ` : ''}${q.question}`)
  if (q.options?.length) {
    q.options.forEach((opt, i) => {
      lines.push(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
    })
    lines.push(q.multiSelect
      ? 'reply with numbers (e.g. "1,3") or type your own answer'
      : 'reply with a number or type your own answer')
  }
  return lines.join('\n')
}

export function parseAnswer(text: string, q: QuestionItem): { selected: string[]; custom?: string } {
  const trimmed = text.trim()
  if (q.options?.length) {
    const picks = trimmed.split(/[,\s]+/).map(s => parseInt(s, 10))
    if (picks.every(n => Number.isInteger(n) && n >= 1 && n <= q.options!.length)) {
      const selected = [...new Set(picks)].map(n => q.options![n - 1].label)
      if (selected.length > 0) return { selected }
    }
  }
  return { selected: [], custom: trimmed }
}

export class QuestionAnswerer {
  private transport: Transport
  private chatForAgent: (agentId: string) => number | undefined
  private logger: (msg: string, ...rest: unknown[]) => void
  /** chatId → pending resolver; the next inbound text from that chat answers. */
  private pending = new Map<number, PendingQuestion>()

  constructor(
    transport: Transport,
    chatForAgent: (agentId: string) => number | undefined,
    logger: (msg: string, ...rest: unknown[]) => void,
  ) {
    this.transport = transport
    this.chatForAgent = chatForAgent
    this.logger = logger
  }

  /** True when this chat's inbound text should be consumed as an answer. */
  hasPending(chatId: number): boolean {
    return this.pending.has(chatId)
  }

  /** Feed one inbound message; returns true when it resolved a question. */
  feed(chatId: number, text: string): boolean {
    const p = this.pending.get(chatId)
    if (!p) return false
    this.pending.delete(chatId)
    p.resolve({ id: p.question.id, ...parseAnswer(text, p.question) })
    return true
  }

  /**
   * The waterfall listener. Suspends until the human replies; MUST resolve
   * (never reject on timeout) so the agent turn unwinds cleanly.
   */
  tryAnswer = async (request: QuestionRequest, next: () => Promise<any>): Promise<any> => {
    const agentId = request.agent?.id
    const chatId = agentId === undefined ? undefined : this.chatForAgent(String(agentId))
    if (chatId === undefined) return next() // not a telegram-owned agent

    const answers: { id: string; selected: string[]; custom?: string }[] = []
    for (let i = 0; i < request.questions.length; i++) {
      const q = request.questions[i]
      await this.transport.send(chatId, formatQuestion(q, i, request.questions.length))
      const answer = await new Promise<{ id: string; selected: string[]; custom?: string }>((resolve) => {
        this.pending.set(chatId, { chatId, question: q, resolve })
      })
      answers.push(answer)
    }
    this.logger(`question answered by chat ${chatId}: ${JSON.stringify(answers).slice(0, 120)}`)
    return { answers }
  }
}
