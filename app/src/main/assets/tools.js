/* DARK AGENT — web tools
 * Pure helpers + tool definitions. Kept free of UI so it can run under node.
 * The caller supplies `get(url, callback)` — the Android bridge or fetch.
 */
(function () {
  'use strict';

  var GLOBAL = typeof window !== 'undefined' ? window : globalThis;

  var MAX_PAGE = 6000;
  var MAX_RESULTS = 6;

  // ------------------------------------------------------------------ html
  var ENTITIES = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
    '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”'
  };

  function decodeEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/&[a-z#0-9]+;/gi, function (m) { return ENTITIES[m] !== undefined ? ENTITIES[m] : m; });
  }

  /** Strip a HTML document down to readable text. */
  function htmlToText(html) {
    if (!html) return '';
    var s = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);
    return s
      .replace(/[ \t\u00a0\u200b]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Pull result title/url/snippet out of lite.duckduckgo.com markup. */
  function parseDdg(html) {
    var out = [];
    if (!html) return out;

    var snippets = [];
    var sre = /<td[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
    var sm;
    while ((sm = sre.exec(html))) snippets.push(htmlToText(sm[1]));

    var re = /<a([^>]*)>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      var attrs = m[1];
      if (attrs.indexOf('result-link') === -1) continue;
      var href = (attrs.match(/href="([^"]+)"/) || attrs.match(/href='([^']+)'/) || [])[1];
      if (!href) continue;
      var title = htmlToText(m[2]);
      if (!title) continue;
      out.push({ title: title, url: unwrapDdg(href), snippet: snippets[out.length] || '' });
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }

  /** DDG wraps outbound links in /l/?uddg=<encoded>. */
  function unwrapDdg(url) {
    var u = String(url);
    if (u.indexOf('uddg=') === -1) return u.indexOf('//') === 0 ? 'https:' + u : u;
    var m = u.match(/[?&]uddg=([^&]+)/);
    if (!m) return u;
    try { return decodeURIComponent(m[1]); } catch (e) { return u; }
  }

  // -------------------------------------------------------------- tool calls
  /** Normalise assistant tool_calls into [{id,name,args}] (drops broken ones). */
  function parseToolCalls(message) {
    var calls = (message && message.tool_calls) || [];
    var out = [];
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      var fn = (c && c.function) || {};
      var args = {};
      try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch (e) { args = {}; }
      if (!fn.name) continue;
      out.push({ id: c.id || ('call_' + i), name: fn.name, args: args });
    }
    return out;
  }

  var TOOLS = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the public web. Use for current facts, news, prices, versions, docs. Returns ranked results with title, url and snippet.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'search query' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_url',
        description: 'Fetch one URL and return its readable text (truncated). Use after web_search to read a promising result.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'absolute http(s) url' } },
          required: ['url']
        }
      }
    }
  ];

  // ---------------------------------------------------------------- execution
  function cap(text, n) {
    text = String(text || '');
    return text.length > n ? text.slice(0, n) + '\n…[truncated]' : text;
  }

  function searchDdg(query, get, done) {
    var url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
    get(url, function (err, html) {
      var results = err ? [] : parseDdg(html);
      if (results.length) return done(null, results, 'duckduckgo');
      searchWiki(query, get, done);
    });
  }

  function searchWiki(query, get, done) {
    var url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=5&srsearch=' +
      encodeURIComponent(query);
    get(url, function (err, body) {
      if (err) return done(err);
      var results = [];
      try {
        var data = typeof body === 'string' ? JSON.parse(body) : body;
        var hits = (data.query && data.query.search) || [];
        hits.forEach(function (h) {
          results.push({
            title: h.title,
            url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')),
            snippet: htmlToText(h.snippet || '')
          });
        });
      } catch (e) { /* fallthrough */ }
      if (!results.length) return done(null, [], 'none');
      done(null, results, 'wikipedia');
    });
  }

  function formatResults(results) {
    if (!results.length) return 'No results.';
    var lines = [];
    results.forEach(function (r, i) {
      lines.push((i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snippet ? '\n   ' + r.snippet : ''));
    });
    return cap(lines.join('\n\n'), 4500);
  }

  /**
   * Run one tool call.
   * @param {string} name
   * @param {object} args
   * @param {function(string, function(Error|null, string))} get
   * @param {function(Error|null, string, Array)} done  (content for the model, sources for the UI)
   */
  function execute(name, args, get, done) {
    if (name === 'web_search') {
      var q = String((args && args.query) || '').trim();
      if (!q) return done(new Error('empty query'), '', []);
      return searchDdg(q, get, function (err, results, engine) {
        if (err) return done(err, '', []);
        done(null, 'search: ' + q + ' (' + engine + ')\n\n' + formatResults(results), results);
      });
    }

    if (name === 'open_url') {
      var url = String((args && args.url) || '').trim();
      if (!/^https?:\/\//i.test(url)) return done(new Error('bad url'), '', []);
      return get(url, function (err, html) {
        if (err) return done(err, '', []);
        var text = cap(htmlToText(html), MAX_PAGE);
        done(null, 'url: ' + url + '\n\n' + text, [{ title: url, url: url, snippet: '' }]);
      });
    }

    done(new Error('unknown tool: ' + name), '', []);
  }

  var api = {
    TOOLS: TOOLS,
    htmlToText: htmlToText,
    parseDdg: parseDdg,
    unwrapDdg: unwrapDdg,
    parseToolCalls: parseToolCalls,
    execute: execute,
    formatResults: formatResults
  };

  GLOBAL.DarkTools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
