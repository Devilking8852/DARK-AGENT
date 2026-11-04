/* Node smoke tests for the DARK AGENT core (no browser needed).
 * run: node tests/app.test.js
 */
const assert = require('assert');
const path = require('path');
const app = require(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'app.js'));

const { parseStreamLine, renderMarkdown, buildPayload } = app;

// --- SSE parsing
assert.deepStrictEqual(parseStreamLine(''), null);
assert.deepStrictEqual(parseStreamLine('data: [DONE]'), { done: true });
assert.deepStrictEqual(parseStreamLine('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}'),
  { delta: 'hi', done: false, usage: null });
assert.deepStrictEqual(parseStreamLine('{"choices":[{"message":{"content":"plain"}}]}'),
  { delta: 'plain', done: false, usage: null });
assert.ok(parseStreamLine('data: {"error":{"message":"bad key"}}').error === 'bad key');
assert.deepStrictEqual(parseStreamLine(': keep-alive'), null);
assert.deepStrictEqual(parseStreamLine('event: ping'), null);

// --- payload
const payload = buildPayload([{ role: 'user', content: 'hey' }], {
  model: 'm', temp: 0.2, max: 100, sys: 'be nice',
});
assert.strictEqual(payload.model, 'm');
assert.strictEqual(payload.temperature, 0.2);
assert.strictEqual(payload.max_tokens, 100);
assert.strictEqual(payload.stream, true);
assert.strictEqual(payload.messages[0].role, 'system');
assert.strictEqual(payload.messages[1].content, 'hey');

const noSys = buildPayload([{ role: 'user', content: 'x' }], { model: 'm', temp: 0, max: 1, sys: '' });
assert.strictEqual(noSys.messages.length, 1);

// --- markdown
assert.strictEqual(renderMarkdown('**bold**'), '<p><strong>bold</strong></p>');
assert.strictEqual(renderMarkdown('`x`'), '<p><code>x</code></p>');
assert.ok(renderMarkdown('# Title').includes('<h1>Title</h1>'));
assert.ok(renderMarkdown('- a\n- b').includes('<ul>'));
assert.ok(renderMarkdown('1. a\n2. b').includes('<ol>'));
assert.ok(renderMarkdown('```lua\nprint(1)\n```').includes('<pre><code data-lang="lua">print(1)</code></pre>'));

// escaping: no raw html injection
const evil = renderMarkdown('<img src=x onerror=alert(1)>');
assert.ok(!evil.includes('<img'), 'html must be escaped');
assert.ok(evil.includes('&lt;img'));

// code inside fences is escaped too
const fenced = renderMarkdown('```\n<script>alert(1)</script>\n```');
assert.ok(!fenced.includes('<script>'), 'script in fence must be escaped');

// javscript: links must not pass through
const js = renderMarkdown('[x](javascript:alert(1))');
assert.ok(!js.includes('href="javascript'), 'js url must not become a link');

console.log('✓ core tests passed');
