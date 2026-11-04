/* DARK AGENT — local credits (tokens)
 * Storage-backed ledger: 1000 on first run, 300 per day, ad/redeem bonuses.
 * NOTE: this is client-side only. Anyone can edit localStorage, so treat it as
 * a UX meter, not a security boundary. Real enforcement needs a server.
 */
(function () {
  'use strict';

  var GLOBAL = typeof window !== 'undefined' ? window : globalThis;
  var KEY = 'darkagent.credits.v1';
  var START_BALANCE = 1000;
  var DAILY = 300;
  var AD_REWARD = 50;
  var AD_COOLDOWN_MS = 60 * 60 * 1000;

  var CODES = {
    'TEAMDARK-30': 30,
    'DARKFRIEND-7': 7,
    'WELCOME-3': 3
  };

  var COST = { message: 1, web_round: 3 };

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

  function create(store, clock) {
    clock = clock || function () { return Date.now(); };

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
        createdAt: clock()
      };
    }

    function state() {
      var s = read();
      if (!s) s = write(fresh());
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

    function redeem(code) {
      var s = state();
      var c = String(code || '').trim().toUpperCase();
      var days = CODES[c];
      if (!days) return { ok: false, reason: 'bad-code', state: s };
      if (s.redeemed && s.redeemed.indexOf(c) !== -1) return { ok: false, reason: 'used', state: s };

      s.redeemed = s.redeemed || [];
      s.redeemed.push(c);
      var base = Math.max(clock(), s.premiumUntil || 0);
      s.premiumUntil = base + days * 24 * 60 * 60 * 1000;
      return { ok: true, days: days, state: write(s) };
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
      adReward: adReward,
      adReady: adReady,
      reset: function () { return write(fresh()); },
      COST: COST,
      CODES: CODES
    };
  }

  var api = create(localStore());
  GLOBAL.DarkCredits = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { create: create, dayStr: dayStr, memoryStore: memoryStore, KEY: KEY };
  }
})();
