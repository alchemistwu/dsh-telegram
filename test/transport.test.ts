/** MarkdownV2 converter tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toMarkdownV2 } from '../src/transport.ts'

test('bold, italic, inline code convert', () => {
  const out = toMarkdownV2('这是 **加粗** 和 _斜体_，还有 `code`')
  assert.match(out, /\*加粗\*/)
  assert.match(out, /_斜体_/)
  assert.match(out, /`code`/)
})

test('headers become bold lines', () => {
  assert.match(toMarkdownV2('## 标题'), /\*标题\*/)
})

test('fenced code blocks stay literal', () => {
  const out = toMarkdownV2('```typescript\nconst x = f(1, 2); // dots.parens\n```')
  assert.match(out, /```typescript\nconst x = f\(1, 2\); \/\/ dots\.parens\n```/)
})

test('reserved chars escape outside formatting', () => {
  const out = toMarkdownV2('version 1.5 - item (a)')
  assert.equal(out, 'version 1' + String.fromCharCode(92) + '.5 ' + String.fromCharCode(92) + '- item ' + String.fromCharCode(92) + '(a' + String.fromCharCode(92) + ')')
})

test('links render as V2 link entities', () => {
  const out = toMarkdownV2('[text](https://example.com/a.b)')
  assert.match(out, /\[text\]\(https:\/\/example\.com\/a\.b\)/)
})
