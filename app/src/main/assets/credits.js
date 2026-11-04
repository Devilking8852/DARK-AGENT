/* DARK AGENT — local credits (tokens) + redeem-code panel
 *
 * Storage-backed ledger: 1000 on first run, 300 per day, ad/redeem bonuses.
 *
 * NOTE: this is client-side only. Anyone can edit localStorage, so treat it as
 * a UX meter, not a security boundary. Real enforcement needs a server.
 *
 * Codes are signed with a key baked into the app, which keeps random guessing
 * out but cannot stop a determined reverse-engineer. Same story for the panel
 * PIN (stored as a SHA-256 hash, never as plain text).
 */
(function () {
  'use strict';

  var GLOBAL = typeof window !== 'undefined' ? window : globalThis;
  var KEY = 'darkagent.credits.v1';
  var START_BALANCE = 1000;
  var DAILY = 300;
  var AD_REWARD = 50;
  var AD_COOLDOWN_MS = 60 * 60 * 1000;

  // plan id -> duration / price (₹, India)
  var PLANS = [
    { id: 'M1', label: '1 month', days: 30, price: 89 },
    { id: 'M3', label: '3 months', days: 90, price: 150 },
    { id: 'M6', label: '6 months', days: 180, price: 350 },
    { id: 'Y1', label: '1 year', days: 365, price: 600 }
  ];

  var PLAN_BY_ID = {};
  PLANS.forEach(function (p) { PLAN_BY_ID[p.id] = p; });

  // legacy plain codes (kept so old builds / old slips still work)
  var CODES = {
    'TEAMDARK-30': 30,
    'DARKFRIEND-7': 7,
    'WELCOME-3': 3
  };

  var COST = { message: 1, web_round: 3 };

  // ------------------------------------------------------------- sha-256
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c < 0xd800 || c >= 0xe000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        i++;
        var c2 = str.charCodeAt(i);
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 63),
          0x80 | ((cp >> 6) & 63),
          0x80 | (cp & 63)
        );
      }
    }
    return out;
  }

  function rot(x, n) { return (x >>> n) | (x << (32 - n)); }

  function hex8(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  /** SHA-256 hex digest of a UTF-8 string. Small enough to ship in a WebView. */
  function sha256(str) {
    var bytes = utf8Bytes(String(str));
    var bitLen = bytes.length * 8;

    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(0, 0, 0, 0);
    bytes.push((bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);

    for (var off = 0; off < bytes.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = ((bytes[off + i * 4] << 24) |
                (bytes[off + i * 4 + 1] << 16) |
                (bytes[off + i * 4 + 2] << 8) |
                bytes[off + i * 4 + 3]) | 0;
      }
      for (i = 16; i < 64; i++) {
        var x = w[i - 15];
        var y = w[i - 2];
        var s0 = rot(x, 7) ^ rot(x, 18) ^ (x >>> 3);
        var s1 = rot(y, 17) ^ rot(y, 19) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      var a = H[0], b = H[1], c = H[2], d = H[3];
      var e = H[4], f = H[5], g = H[6], h = H[7];

      for (i = 0; i < 64; i++) {
        var S1 = rot(e, 6) ^ rot(e, 11) ^ rot(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rot(a, 2) ^ rot(a, 13) ^ rot(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;

        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }

      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    var out = '';
    for (var j = 0; j < 8; j++) out += hex8(H[j]);
    return out;
  }

  // ---------------------------------------------------------- code signing
  var SIGN_SECRET = 'DARKAGENT-s3ll-2026-7f4c1b9a';
  var PANEL_HASH = '7d0ccd59f6c08a56514e6f4cf2988c0e1225b8c201e69473e589a5a08ce46880';
  var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
  var CODE_RE = /^DA-(M1|M3|M6|Y1)-([2-9A-HJ-NP-Z]{5})-([0-9A-F]{5})$/;

  function sign(payload) {
    return sha256(SIGN_SECRET + '|' + payload + '|' + SIGN_SECRET).toUpperCase();
  }

  function randomChunk(rng) {
    var s = '';
    for (var i = 0; i < 5; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    return s;
  }

  function dayStr(ts) {
    var d = ts ? new Date(ts) : new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function memoryStore() {
    var data = {};
    return {
      get: function (k) { return data[k] || null; },
      set: function (k, v) { data[k] = v; }
    };
  }

  function localStore() {
    try {
      if (typeof localStorage === 'undefined') return memoryStore();
      localStorage.getItem(KEY);
      return {
        get: function (k) { return localStorage.getItem(k); },
        set: function (k, v) { localStorage.setItem(k, v); }
      };
    } catch (e) {
      return memoryStore();
    }
  }

  function create(store, clock, rng) {
    clock = clock || function () { return Date.now(); };
    rng = rng || Math.random;

    function read() {
      var raw = store.get(KEY);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }

    function write(state) {
      store.set(KEY, JSON.stringify(state));
      return state;
    }

    function fresh() {
      return {
        balance: START_BALANCE,
        totalEarned: START_BALANCE,
        totalSpent: 0,
        lastDaily: dayStr(clock()),
        premiumUntil: 0,
        lastAd: 0,
        createdAt: clock(),
        redeemed: [],
        gen: []
      };
    }

    function state() {
      var s = read();
      if (!s) s = write(fresh());
      if (!s.redeemed) s.redeemed = [];
      if (!s.gen) s.gen = [];
      return s;
    }

    function isPremium(s) {
      return (s || state()).premiumUntil > clock();
    }

    function claimDaily() {
      var s = state();
      var today = dayStr(clock());
      if (s.lastDaily === today) return { ok: false, reason: 'already-claimed', state: s };
      s.balance += DAILY;
      s.totalEarned += DAILY;
      s.lastDaily = today;
      return { ok: true, gained: DAILY, state: write(s) };
    }

    function spend(n) {
      var s = state();
      if (isPremium(s)) return { ok: true, free: true, state: s };
      n = Math.max(1, Number(n) || 1);
      if (s.balance < n) return { ok: false, reason: 'insufficient', need: n, state: s };
      s.balance -= n;
      s.totalSpent += n;
      return { ok: true, spent: n, state: write(s) };
    }

    function add(n, why) {
      var s = state();
      n = Math.max(1, Number(n) || 1);
      s.balance += n;
      s.totalEarned += n;
      if (why) s.lastReason = why;
      return write(s);
    }

    /** Accept legacy plain codes and signed `DA-<plan>-<rand>-<sig>` codes. */
    function readCode(input) {
      var c = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!c) return null;

      if (CODES[c]) return { code: c, days: CODES[c], kind: 'legacy', label: CODES[c] + ' days' };

      var m = c.match(CODE_RE);
      if (!m) return null;

      var plan = PLAN_BY_ID[m[1]];
      if (!plan) return null;
      if (sign(m[1] + '-' + m[2]).slice(0, 5) !== m[3]) return null;

      return { code: c, days: plan.days, kind: 'plan', plan: plan.id, label: plan.label };
    }

    function redeem(input) {
      var s = state();
      var parsed = readCode(input);

      if (!parsed) return { ok: false, reason: 'bad-code', state: s };
      if (s.redeemed.indexOf(parsed.code) !== -1) return { ok: false, reason: 'used', state: s };

      s.redeemed.push(parsed.code);
      var base = Math.max(clock(), s.premiumUntil || 0);
      s.premiumUntil = base + parsed.days * 24 * 60 * 60 * 1000;
      return {
        ok: true,
        days: parsed.days,
        label: parsed.label,
        plan: parsed.plan || null,
        state: write(s)
      };
    }

    function adReady() {
      var s = state();
      return clock() - (s.lastAd || 0) >= AD_COOLDOWN_MS;
    }

    function adReward() {
      var s = state();
      if (!adReady()) {
        var wait = Math.ceil((AD_COOLDOWN_MS - (clock() - s.lastAd)) / 60000);
        return { ok: false, reason: 'cooldown', minutes: wait, state: s };
      }
      s.balance += AD_REWARD;
      s.totalEarned += AD_REWARD;
      s.lastAd = clock();
      return { ok: true, gained: AD_REWARD, state: write(s) };
    }

    function premiumDaysLeft() {
      var s = state();
      var left = s.premiumUntil - clock();
      return left > 0 ? Math.ceil(left / 86400000) : 0;
    }

    // ------------------------------------------------------- owner panel
    function checkPin(pin) {
      return sha256(String(pin || '').trim()) === PANEL_HASH;
    }

    function generateCode(planId) {
      var plan = PLAN_BY_ID[planId];
      if (!plan) return { ok: false, reason: 'bad-plan' };

      var rand = randomChunk(rng);
      var payload = plan.id + '-' + rand;
      var code = 'DA-' + plan.id + '-' + rand + '-' + sign(payload).slice(0, 5);

      var s = state();
      s.gen.unshift({ code: code, plan: plan.id, days: plan.days, price: plan.price, at: clock() });
      if (s.gen.length > 60) s.gen.length = 60;
      write(s);

      return {
        ok: true,
        code: code,
        plan: plan.id,
        label: plan.label,
        days: plan.days,
        price: plan.price
      };
    }

    function generated() {
      var s = state();
      return s.gen.map(function (g) {
        return {
          code: g.code,
          plan: g.plan,
          days: g.days,
          price: g.price,
          at: g.at,
          usedHere: s.redeemed.indexOf(g.code) !== -1
        };
      });
    }

    function summary() {
      var s = state();
      return {
        balance: s.balance,
        premium: isPremium(s),
        premiumDays: premiumDaysLeft(),
        totalEarned: s.totalEarned,
        totalSpent: s.totalSpent,
        canClaimDaily: s.lastDaily !== dayStr(clock()),
        daily: DAILY,
        start: START_BALANCE,
        adReady: adReady(),
        adReward: AD_REWARD,
        cost: COST
      };
    }

    return {
      state: state,
      summary: summary,
      isPremium: function () { return isPremium(state()); },
      claimDaily: claimDaily,
      spend: spend,
      add: add,
      redeem: redeem,
      readCode: readCode,
      adReward: adReward,
      adReady: adReady,
      checkPin: checkPin,
      generateCode: generateCode,
      generated: generated,
      reset: function () { return write(fresh()); },
      COST: COST,
      CODES: CODES,
      PLANS: PLANS
    };
  }

  var api = create(localStore());
  GLOBAL.DarkCredits = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      create: create,
      dayStr: dayStr,
      memoryStore: memoryStore,
      sha256: sha256,
      sign: sign,
      PLANS: PLANS,
      KEY: KEY
    };
  }
})();
