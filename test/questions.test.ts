/**
 * Question answerer tests — the "agent blocks forever on Telegram" incident.
 * Run: node --experimental-strip-types --test test/questions.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuestionAnswerer, formatQuestion, parseAnswer } from '../src/questions.ts'

function fakeTransport() {
  const sent: { chatId: number; text: string }[] = []
  return {
    sent,
    send: async (chatId: number, text: string) => { sent.push({ chatId, text }) },
  } as any
}

const Q = {
  id: 'q1',
  question: 'which env?',
  header: 'Deploy',
  options: [
    { label: 'staging', description: 'safe' },
    { label: 'prod', description: 'careful' },
  ],
}

test('numeric reply selects the option label', () => {
  assert.deepEqual(parseAnswer('2', Q), { selected: ['prod'] })
  assert.deepEqual(parseAnswer('1', Q), { selected: ['staging'] })
})

test('multi-number reply selects multiple labels', () => {
  assert.deepEqual(parseAnswer('1,2', { ...Q, multiSelect: true }), { selected: ['staging', 'prod'] })
})

test('free text becomes a custom answer', () => {
  assert.deepEqual(parseAnswer('deploy to canary first', Q), { selected: [], custom: 'deploy to canary first' })
})

test('question renders with header, options, and instructions', () => {
  const text = formatQuestion(Q, 0, 1)
  assert.match(text, /❓/)
  assert.match(text, /\[Deploy\]/)
  assert.match(text, /1\. staging — safe/)
  assert.match(text, /2\. prod — careful/)
  assert.match(text, /reply with a number/)
})

test('agent without a telegram chat falls through to next answerer', async () => {
  const t = fakeTransport()
  const a = new QuestionAnswerer(t, () => undefined, () => {})
  let fellThrough = false
  await a.tryAnswer({ questions: [Q], agent: { id: 'x' } }, async () => { fellThrough = true; return { answers: [] } })
  assert.ok(fellThrough)
  assert.equal(t.sent.length, 0)
})

test('full roundtrip: question sent, inbound message resolves the tool call', async () => {
  const t = fakeTransport()
  const a = new QuestionAnswerer(t, (id) => id === 'agent-1' ? 42 : undefined, () => {})
  const pending = a.tryAnswer({ questions: [Q], agent: { id: 'agent-1' } }, async () => ({ answers: [] }))
  // question rendered to telegram
  await new Promise(r => setTimeout(r, 10))
  assert.equal(t.sent.length, 1)
  assert.match(t.sent[0].text, /which env/)
  // agent is now blocked; the chat's next message resolves it
  assert.ok(a.hasPending(42))
  assert.ok(a.feed(42, '2'))
  const result = await pending
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['prod'] }] })
})

test('multi-question requests are answered one at a time', async () => {
  const t = fakeTransport()
  const a = new QuestionAnswerer(t, () => 7, () => {})
  const q2 = { id: 'q2', question: 'any notes?' }
  const pending = a.tryAnswer({ questions: [Q, q2], agent: { id: 'agent-1' } }, async () => ({ answers: [] }))
  await new Promise(r => setTimeout(r, 10))
  a.feed(7, '1')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(t.sent.length, 2) // second question rendered after first answer
  a.feed(7, 'ship it')
  const result = await pending
  assert.deepEqual(result, { answers: [
    { id: 'q1', selected: ['staging'] },
    { id: 'q2', selected: [], custom: 'ship it' },
  ] })
})
