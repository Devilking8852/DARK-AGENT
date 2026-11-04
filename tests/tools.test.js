/* Node tests for the web tools (search parsing, html->text, tool calls). */
const assert = require('assert');
const path = require('path');

const T = require(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'tools.js'));

// ---------------------------------------------------------------- htmlToText
assert.strictEqual(T.htmlToText('<p>Hello <b>world</b></p>'), 'Hello world');
assert.ok(!T.htmlToText('<script>alert(1)</script><p>ok</p>').includes('alert'));
assert.ok(T.htmlToText('a<br>b').includes('\n'));
assert.strictEqual(T.htmlToText('A &amp; B'), 'A & B');
assert.strictEqual(T.htmlToText('&#39;x&#39;'), "'x'");

// ------------------------------------------------------------------- parseDdg
const ddgHtml = `
<table>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&rut=z" class='result-link'>Example <b>A</b></a></td></tr>
  <tr><td class='result-snippet'>Snippet for A &amp; more</td></tr>
  <tr><td><a href="https://plain.example/b" class="result-link">Plain B</a></td></tr>
  <tr><td class='result-snippet'>Snippet B</td></tr>
  <tr><td><a href="https://ads.example/" class="other">not a result</a></td></tr>
</table>`;

const parsed = T.parseDdg(ddgHtml);
assert.strictEqual(parsed.length, 2, 'only result-link anchors');
assert.strictEqual(parsed[0].url, 'https://example.com/a?x=1');
assert.strictEqual(parsed[0].title, 'Example A');
assert.strictEqual(parsed[0].snippet, 'Snippet for A & more');
assert.strictEqual(parsed[1].url, 'https://plain.example/b');

assert.deepStrictEqual(T.parseDdg(''), []);
assert.deepStrictEqual(T.parseDdg('<html>captcha</html>'), []);

// --------------------------------------------------------------- parseToolCalls
const calls = T.parseToolCalls({
  tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"lua 5.4"}' } },
    { id: 'c2', type: 'function', function: { name: 'open_url', arguments: 'not json' } },
    { id: 'c3', type: 'function', function: { arguments: '{}' } }
  ]
});
assert.strictEqual(calls.length, 2);
assert.deepStrictEqual(calls[0].args, { query: 'lua 5.4' });
assert.deepStrictEqual(calls[1].args, {});
assert.deepStrictEqual(T.parseToolCalls({}), []);

// ----------------------------------------------------------------- execute
function fakeGet(routes) {
  return function (url, cb) {
    for (const key of Object.keys(routes)) {
      if (url.indexOf(key) !== -1) return cb(null, routes[key]);
    }
    cb(new Error('no route: ' + url));
  };
}

T.execute('web_search', { query: 'lua' }, fakeGet({ 'duckduckgo': ddgHtml }), (err, content, sources) => {
  assert.ifError(err);
  assert.ok(content.includes('example.com/a'), content);
  assert.ok(content.includes('duckduckgo'), content);
  assert.strictEqual(sources.length, 2);
});

T.execute('open_url', { url: 'https://example.com/page' },
  fakeGet({ 'example.com/page': '<html><body><h1>Title</h1><p>Body text</p><script>x</script></body></html>' }),
  (err, content, sources) => {
    assert.ifError(err);
    assert.ok(content.includes('Body text'));
    assert.ok(!content.includes('<script>'));
    assert.strictEqual(sources[0].url, 'https://example.com/page');
  });

// fallback: DDG blocked -> wikipedia
T.execute('web_search', { query: 'lua' },
  fakeGet({
    'duckduckgo': '<html>anomaly</html>',
    'wikipedia.org': JSON.stringify({ query: { search: [{ title: 'Lua (programming language)', snippet: 'lightweight <span>language</span>' }] } })
  }),
  (err, content, sources) => {
    assert.ifError(err);
    assert.ok(content.includes('wikipedia'), content);
    assert.ok(content.includes('Lua (programming language)'));
    assert.strictEqual(sources.length, 1);
  });

// bad input
T.execute('open_url', { url: 'javascript:alert(1)' }, fakeGet({}), (err) => {
  assert.ok(err, 'non-http url must fail');
});

T.execute('nope', {}, fakeGet({}), (err) => {
  assert.ok(err, 'unknown tool must fail');
});

console.log('✓ tools tests passed');
