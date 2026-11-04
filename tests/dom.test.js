/* DOM smoke test — boots the real index.html in jsdom and clicks through the
 * tabs. Catches missing element ids / wiring mistakes that node unit tests miss.
 * Needs jsdom:  npm i --no-save jsdom
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.log('skip: jsdom not installed (npm i --no-save jsdom)');
  process.exit(0);
}

const root = path.join(__dirname, '..', 'app', 'src', 'main', 'assets');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'file:///android_asset/index.html',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

// pretend to be the Android bridge so external-link clicks are observable
const opened = [];
window.Native = { openUrl: (u) => opened.push(u) };

for (const f of ['tools.js', 'credits.js', 'image.js', 'music.js', 'app.js']) {
  window.eval(fs.readFileSync(path.join(root, f), 'utf8'));
}
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

const doc = window.document;
const $ = (id) => doc.getElementById(id);
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// ---------------------------------------------------------------- boot state
assert.strictEqual($('token-count').textContent, '1000', 'first run starts with 1000 tokens');
assert.ok(window.DarkCredits, 'DarkCredits api missing');
assert.ok(window.DarkImage && window.DarkMusic, 'editor apis missing');

// ------------------------------------------------------------------ tab switch
const clickTab = (name) => click(doc.querySelector('.tab[data-tab="' + name + '"]'));

const panes = ['view-image', 'view-music', 'view-credits', 'chat', 'composer'];
const shown = { image: ['view-image'], music: ['view-music'], credits: ['view-credits'], chat: ['chat', 'composer'] };

for (const tab of ['image', 'music', 'credits', 'chat']) {
  clickTab(tab);
  for (const id of panes) {
    const isHidden = $(id).classList.contains('hidden');
    assert.strictEqual(isHidden, shown[tab].indexOf(id) === -1, tab + ': #' + id + ' visibility');
  }
}

// --------------------------------------------------------------------- credits
clickTab('credits');
assert.strictEqual($('cr-balance').textContent, '1000');
assert.strictEqual($('cr-daily').disabled, true, 'daily is unavailable on the first day');

$('cr-code').value = 'TEAMDARK-30';
click($('cr-redeem'));
assert.strictEqual(window.DarkCredits.isPremium(), true, 'redeem grants premium');
assert.ok($('cr-premium').textContent.indexOf('premium') === 0);
assert.strictEqual($('token-count').textContent, '∞');

$('cr-code').value = 'nope';
click($('cr-redeem'));
assert.ok($('cr-msg').textContent.includes('galat'), 'bad code is rejected');

// --------------------------------------------------------------- buy -> telegram
const buy = doc.querySelectorAll('[data-buy]');
assert.strictEqual(buy.length, 2, 'monthly + yearly buy buttons');
click(buy[0]);
click(buy[1]);
assert.strictEqual(opened.length, 2, 'both buttons open an external link');
opened.forEach((u) => {
  assert.ok(u.startsWith('https://t.me/TEAMDARK_OWNER'), 'goes to the owner telegram, got ' + u);
  assert.ok(u.indexOf('text=') !== -1, 'prefilled message');
});
assert.ok(decodeURIComponent(opened[1]).includes('₹399'), 'yearly plan is in the message');

// ----------------------------------------------------------------------- music
clickTab('music');
assert.strictEqual(doc.querySelectorAll('.step').length, 64, '4 tracks × 16 steps');

const kick0 = doc.querySelector('.step[data-track="kick"][data-step="0"]');
click(kick0);
assert.ok(kick0.classList.contains('on'));
assert.strictEqual(window.DarkMusic.grid().kick[0], 1);

const mel0 = doc.querySelector('.step[data-track="mel"][data-step="0"]');
click(mel0);
assert.strictEqual(mel0.textContent, 'C4', 'melody label cycles');

click($('btn-demo'));
assert.strictEqual(window.DarkMusic.grid().kick.filter(Boolean).length, 4);
click($('btn-clear'));
assert.strictEqual(window.DarkMusic.grid().kick.filter(Boolean).length, 0);

// ----------------------------------------------------------------------- image
clickTab('image');
assert.strictEqual(typeof window.DarkImage.save, 'function');

assert.deepStrictEqual(errors, [], 'no runtime errors');
console.log('✓ DOM smoke test passed');
