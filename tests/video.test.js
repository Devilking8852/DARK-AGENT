/* Node tests for the Studio (talking-characters) renderer — pure helpers plus a
 * fake 2d context, so frame drawing is exercised without a browser.
 */
const assert = require('assert');
const path = require('path');

const V = require(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'video.js'));
const app = require(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'app.js'));

// -------------------------------------------------------------- parseScript
{
  const lines = V.parseScript('A: hello there\nB: hi\nplain line\n\n# comment');
  assert.strictEqual(lines.length, 3, 'blank lines and comments are skipped');
  assert.deepStrictEqual(lines[0], { who: 'A', text: 'hello there' });
  assert.deepStrictEqual(lines[1], { who: 'B', text: 'hi' });
  assert.strictEqual(lines[2].who, 'A', 'plain lines alternate');
  assert.deepStrictEqual(V.parseScript(''), []);
  assert.strictEqual(V.parseScript(Array(30).fill('x').join('\n')).length, 14, 'capped at 14 lines');
}

// -------------------------------------------------------------- buildTimeline
{
  const tl = V.buildTimeline(V.parseScript('A: one\nB: two'));
  assert.strictEqual(tl.items.length, 2);
  assert.strictEqual(tl.items[0].start, 0);
  assert.ok(tl.items[0].dur >= 2 && tl.items[0].dur <= 6, 'duration clamped');
  assert.ok(tl.items[1].start > tl.items[0].dur, 'second line starts after the first + gap');
  assert.ok(tl.total > tl.items[1].start, 'total covers the last line');

  const active = V.lineAt(tl, tl.items[1].start + 0.1);
  assert.strictEqual(active.who, 'B');
  assert.strictEqual(V.lineAt(tl, tl.total + 5), null, 'nothing after the end');
  assert.strictEqual(tl.items[0].dur, 2, 'short text still gets 2s');
  const long = V.buildTimeline([{ who: 'A', text: 'x'.repeat(200) }]);
  assert.strictEqual(long.items[0].dur, 6, 'long text does not exceed 6s');
}

// ------------------------------------------------------------------ wrapText
{
  const ctx = { measureText: (t) => ({ width: t.length * 10 }) };
  const lines = V.wrapText(ctx, 'aaa bbb ccc ddd', 70, 0);
  assert.deepStrictEqual(lines, ['aaa bbb', 'ccc ddd']);

  const clipped = V.wrapText(ctx, 'aaa bbb ccc ddd eee fff', 70, 2);
  assert.strictEqual(clipped.length, 2);
  assert.ok(clipped[1].endsWith('…'), 'clipped line is marked');

  assert.deepStrictEqual(V.wrapText(ctx, '', 100), []);
}

// ------------------------------------------------------------- frame drawing
function fakeCtx() {
  const calls = { fillText: [], fillRect: 0, stroke: 0, fill: 0 };
  const grad = { addColorStop() {} };
  const ctx = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    fillRect: () => { calls.fillRect++; },
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => { calls.fill++; },
    stroke: () => { calls.stroke++; },
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    fillText: (t) => { calls.fillText.push(String(t)); }
  };
  return ctx;
}

{
  const tl = V.buildTimeline(V.parseScript('A: hello mango\nB: hello cat'));
  const opts = { emojiA: '🥭', emojiB: '🐱', title: 'mango vs cat' };

  const ctx = fakeCtx();
  V.drawFrame(ctx, V.W, V.H, 0.2, tl, opts);

  const drawn = ctx.calls.fillText.join(' | ');
  assert.ok(drawn.includes('🥭'), 'character A drawn');
  assert.ok(drawn.includes('🐱'), 'character B drawn');
  assert.ok(drawn.includes('hello mango'), 'active line drawn');
  assert.ok(drawn.includes('MADE BY - @TEAMDARK_OWNER'), 'watermark drawn');
  assert.ok(drawn.includes('mango vs cat'), 'title drawn');
  assert.ok(ctx.calls.fill >= 4, 'glow + bubble + caption painted, got ' + ctx.calls.fill);

  // mid-clip: the second speaker is active and both lines are never shown at once
  const ctx2 = fakeCtx();
  const t2 = tl.items[1].start + 0.3;
  V.drawFrame(ctx2, V.W, V.H, t2, tl, opts);
  const drawn2 = ctx2.calls.fillText.join(' | ');
  assert.ok(drawn2.includes('hello cat'));
  assert.ok(!drawn2.includes('hello mango'), 'only the current line is shown');

  // past the end: still draws a valid frame (used as the last recorded frame)
  const ctx3 = fakeCtx();
  V.drawFrame(ctx3, V.W, V.H, tl.total + 1, tl, opts);
  assert.ok(ctx3.calls.fillText.length > 0);
}

// ------------------------------------------------------------ AI reply parsing
{
  const json = '```json\n{"title":"mango vs cat","lines":[{"who":"A","text":"hi"},{"who":"b","text":"yo"}]}\n```';
  const parsed = app.parseScriptJSON(json);
  assert.strictEqual(parsed.title, 'mango vs cat');
  assert.deepStrictEqual(parsed.lines, [{ who: 'A', text: 'hi' }, { who: 'B', text: 'yo' }]);

  assert.strictEqual(app.parseScriptJSON('not json at all'), null);
  assert.strictEqual(app.parseScriptJSON('{"title":"x","lines":[]}'), null, 'empty lines rejected');
  assert.strictEqual(app.parseScriptJSON('{"lines":"nope"}'), null);

  // string entries still work
  const alt = app.parseScriptJSON('{"lines":["one","two"]}');
  assert.deepStrictEqual(alt.lines.map((l) => l.who), ['A', 'B']);
  assert.deepStrictEqual(alt.lines.map((l) => l.text), ['one', 'two']);
}

console.log('✓ studio tests passed');
