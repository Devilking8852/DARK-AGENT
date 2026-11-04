/* DARK AGENT — app logic
 * Runs inside the Android WebView shell (native HTTP bridge) but also works in a
 * normal browser (fetch fallback) so the core can be tested with node.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  var GLOBAL = typeof window !== 'undefined' ? window : globalThis;
  var STORE_SETTINGS = 'darkagent.settings.v1';
  var STORE_SESSIONS = 'darkagent.sessions.v1';

  var PRESETS = [
    { id: 'venice', name: 'Venice AI', base: 'https://api.venice.ai/api/v1', model: 'venice-uncensored-1-2' },
    { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'google/gemma-4-31b-it:free' },
    { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
    { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'ollama', name: 'Ollama (local)', base: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:0.5b' },
    { id: 'custom', name: 'Custom', base: '', model: '' }
  ];

  var TOOLS_API = GLOBAL.DarkTools || { TOOLS: [], parseToolCalls: function () { return []; } };
  var STORE_WEB = 'darkagent.web.v1';

  var DEFAULTS = {
    base: 'https://api.venice.ai/api/v1',
    key: '',
    model: 'venice-uncensored-1-2',
    sys: 'You are DARK AGENT, a precise and helpful assistant. Answer clearly, use markdown, and keep code complete.',
    temp: 0.7,
    max: 2048
  };

  var QUICK = ['Explain this error', 'Write a Lua script', 'Summarize a long text', 'Fix my code'];

  // ------------------------------------------------------------------- state
  var settings = loadSettings();
  var sessions = loadSessions();
  var currentId = null;
  var messages = [];
  var busy = false;
  var currentReq = null;
  var pendingText = '';
  var pendingNode = null;

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- storage
  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ }
  }

  function loadSettings() {
    var s = loadJSON(STORE_SETTINGS, {});
    var out = {};
    for (var k in DEFAULTS) out[k] = s[k] === undefined ? DEFAULTS[k] : s[k];
    return out;
  }

  function loadSessions() {
    var list = loadJSON(STORE_SESSIONS, []);
    return Array.isArray(list) ? list : [];
  }

  function persistSession() {
    if (!currentId && messages.length === 0) return;
    if (!currentId) currentId = 'c' + Date.now().toString(36);
    var title = (messages[0] && messages[0].content) || 'New chat';
    var entry = {
      id: currentId,
      title: title.slice(0, 60),
      updated: Date.now(),
      messages: messages
    };
    var idx = -1;
    for (var i = 0; i < sessions.length; i++) if (sessions[i].id === currentId) idx = i;
    if (idx >= 0) sessions[idx] = entry; else sessions.unshift(entry);
    sessions = sessions.slice(0, 60);
    saveJSON(STORE_SESSIONS, sessions);
  }

  // ------------------------------------------------------------------- utils
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function bytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function nowTime() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

  // --------------------------------------------------------------- markdown
  // Deliberately small: escape first, then re-allow a safe subset.
  function renderMarkdown(src) {
    var text = String(src == null ? '' : src);
    var blocks = [];

    // pull fenced code out before inline processing
    text = text.replace(/```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      var i = blocks.length;
      blocks.push('<pre><code data-lang="' + esc(lang) + '">' + esc(code.replace(/\n$/, '')) + '</code></pre>');
      return '\u0000B' + i + '\u0000';
    });

    text = esc(text);

    // inline code
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // bold / italic
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // links (http/https only)
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

    // headings, quotes, lists, paragraphs
    var lines = text.split('\n');
    var out = [];
    var listType = null;

    function closeList() {
      if (listType) { out.push('</' + listType + '>'); listType = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var h = line.match(/^(#{1,3})\s+(.*)$/);
      var ul = line.match(/^\s*[-*+]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      var q = line.match(/^&gt;\s?(.*)$/);

      if (/^\u0000B\d+\u0000$/.test(line.trim())) {
        closeList();
        out.push(blocks[Number(line.trim().replace(/\u0000B|\u0000/g, ''))]);
        continue;
      }
      if (!line.trim()) { closeList(); continue; }
      if (h) { closeList(); out.push('<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>'); continue; }
      if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + ul[1] + '</li>');
        continue;
      }
      if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + ol[1] + '</li>');
        continue;
      }
      if (q) { closeList(); out.push('<blockquote>' + q[1] + '</blockquote>'); continue; }
      closeList();
      out.push('<p>' + line + '</p>');
    }
    closeList();

    return out.join('\n');
  }

  // ------------------------------------------------------------------ SSE
  /** Parse one SSE line. Returns {done, delta, usage, error} or null. */
  function parseStreamLine(line) {
    if (!line) return null;
    var l = line.trim();
    if (!l || l.charAt(0) === ':') return null;
    if (l.indexOf('data:') === 0) l = l.slice(5).trim();
    if (l === '[DONE]') return { done: true };
    if (l.charAt(0) !== '{') return null;
    var obj;
    try { obj = JSON.parse(l); } catch (e) { return null; }
    if (obj.error) return { error: obj.error.message || String(obj.error) };

    var choice = (obj.choices && obj.choices[0]) || null;
    var delta = '';
    var reasoning = '';
    var finish = null;
    if (choice) {
      var d = choice.delta || choice.message || {};
      if (typeof d.content === 'string') delta = d.content;
      else if (Array.isArray(d.content)) {
        delta = d.content.map(function (part) { return part && part.text ? part.text : ''; }).join('');
      } else if (typeof choice.text === 'string') {
        delta = choice.text;
      }
      reasoning = d.reasoning_content || d.reasoning || '';
      finish = choice.finish_reason || null;
    }
    return { delta: delta, reasoning: reasoning, finish: finish, done: finish != null, usage: obj.usage || null };
  }

  function buildPayload(messages, opts) {
    var body = {
      model: opts.model,
      messages: messages,
      temperature: Number(opts.temp),
      max_tokens: Number(opts.max),
      stream: true
    };
    if (opts.sys) {
      body.messages = [{ role: 'system', content: opts.sys }].concat(messages.filter(function (m) { return m.role !== 'system'; }));
    }
    return body;
  }

  // ---------------------------------------------------------- http layer
  var eventHandlers = {};

  GLOBAL.__nativeEvent = function (raw) {
    var ev;
    try { ev = JSON.parse(raw); } catch (e) { return; }
    var h = eventHandlers[ev.id];
    if (h) h(ev);
  };

  var seq = 0;

  /** POST JSON and stream response lines. Returns {id, abort}. */
  /**
   * POST and stream response lines.
   * onEnd gets {ok, status, raw, error, aborted} so callers can show the real
   * provider error instead of a generic "empty response".
   */
  function postStream(url, headers, body, onLine, onEnd) {
    var id = 'r' + (++seq) + Date.now().toString(36);
    var finished = false;
    var raw = '';
    var status = 0;

    function close(result) {
      if (finished) return;
      finished = true;
      delete eventHandlers[id];
      onEnd(result);
    }

    eventHandlers[id] = function (ev) {
      if (ev.type === 'status') status = ev.status || 0;
      if (ev.type === 'line') {
        raw += ev.line + '\n';
        onLine(ev.line);
      }
      if (ev.type === 'error') {
        close({ ok: false, status: status, raw: raw, error: ev.message || 'network error' });
      }
      if (ev.type === 'done') {
        var ok = !status || status < 400;
        close({
          ok: ok,
          status: status,
          raw: raw,
          error: ok ? null : errorFromBody(raw, status)
        });
      }
    };

    var handle = {
      id: id,
      abort: function () {
        if (finished) return;
        finished = true;
        delete eventHandlers[id];
        try { if (GLOBAL.Native && GLOBAL.Native.abort) GLOBAL.Native.abort(id); } catch (e) { /* ignore */ }
        onEnd({ ok: false, aborted: true, status: status, raw: raw });
      }
    };

    if (GLOBAL.Native && GLOBAL.Native.post) {
      try {
        GLOBAL.Native.post(id, url, JSON.stringify(headers), JSON.stringify(body));
      } catch (e) {
        delete eventHandlers[id];
        onEnd({ ok: false, error: String(e && e.message || e), raw: raw, status: 0 });
      }
      return handle;
    }

    // browser/node fallback (CORS permitting)
    var ctrl = new AbortController();
    handle.abort = function () {
      ctrl.abort();
      if (finished) return;
      finished = true;
      delete eventHandlers[id];
      onEnd({ ok: false, aborted: true, status: status, raw: raw });
    };

    fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal })
      .then(function (res) {
        status = res.status;
        if (!res.ok) {
          return res.text().then(function (t) {
            raw = t;
            throw new Error(errorFromBody(t, res.status));
          });
        }
        if (!res.body || !res.body.getReader) {
          return res.text().then(function (t) {
            raw = t;
            t.split('\n').forEach(function (line) { onLine(line); });
          });
        }
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buf += dec.decode(r.value, { stream: true });
            var parts = buf.split('\n');
            buf = parts.pop();
            parts.forEach(function (line) { raw += line + '\n'; onLine(line); });
            return pump();
          });
        }
        return pump();
      })
      .then(function () { close({ ok: true, status: status, raw: raw }); })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          close({ ok: false, aborted: true, status: status, raw: raw });
          return;
        }
        close({ ok: false, status: status, raw: raw, error: String(err && err.message || err) });
      });

    return handle;
  }

  /** Turn a provider error body into "HTTP 402: message". */
  function errorFromBody(raw, status) {
    var out = 'HTTP ' + (status || '?');
    var text = String(raw || '').trim();
    if (!text) return out;
    try {
      var obj = JSON.parse(text);
      var e = obj.error || obj;
      var msg = e.message || e.detail || e.msg || (typeof e === 'string' ? e : '');
      if (msg) return out + ': ' + msg;
    } catch (err) { /* not json */ }
    return out + ': ' + text.replace(/\s+/g, ' ').slice(0, 180);
  }

  /**
   * Best-effort text extraction from a whole response body (covers providers
   * that ignore stream:true and return one JSON object).
   */
  function textFromBody(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';

    var lines = text.split('\n');
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim().replace(/^data:\s*/, '');
      if (!line || line === '[DONE]' || line.charAt(0) !== '{') continue;
      try {
        var obj = JSON.parse(line);
        var choice = (obj.choices && obj.choices[0]) || null;
        if (!choice) continue;
        var msg = choice.message || choice.delta || {};
        var t = msg.content || msg.reasoning_content || msg.reasoning || choice.text || '';
        if (typeof t === 'string' && t) return t;
      } catch (e) { /* try the next line */ }
    }

    try {
      var whole = JSON.parse(text);
      var c = (whole.choices && whole.choices[0]) || {};
      var m = c.message || c.delta || {};
      return m.content || m.reasoning_content || m.reasoning || c.text || '';
    } catch (e2) {
      return '';
    }
  }

  // ------------------------------------------------------------- rendering
  function chatEl() { return $('chat'); }

  function clearEmpty() {
    var e = $('empty');
    if (e && e.parentNode) e.parentNode.removeChild(e);
  }

  function scrollDown(force) {
    var el = chatEl();
    if (!el) return;
    var near = el.scrollHeight - el.scrollTop - el.clientHeight < 220;
    if (force || near) el.scrollTop = el.scrollHeight;
  }

  function addMessageEl(role, content) {
    clearEmpty();
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + role;

    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? 'YOU' : 'DA';

    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'user') {
      bubble.textContent = content;
    } else {
      bubble.innerHTML = renderMarkdown(content) || '<span class="cursor"></span>';
    }

    wrap.appendChild(who);
    wrap.appendChild(bubble);
    chatEl().appendChild(wrap);
    scrollDown(true);
    return bubble;
  }

  function setBusy(v) {
    busy = v;
    $('btn-send').classList.toggle('hidden', v);
    $('btn-stop').classList.toggle('hidden', !v);
    $('input').disabled = false;
  }

  function hint(text, isErr) {
    var el = $('hint');
    el.textContent = text || '';
    el.className = 'hint' + (isErr ? ' err' : '');
  }

  // ------------------------------------------------------------------- chat
  function sendStream(text) {
    if (busy) return;
    text = (text || '').trim();
    if (!text) return;
    if (!settings.key && !/localhost|127\.0\.0\.1/.test(settings.base)) {
      openSettings();
      hint('API key daalo pehle', true);
      return;
    }

    var input = $('input');
    input.value = '';
    input.style.height = 'auto';

    messages.push({ role: 'user', content: text });
    addMessageEl('user', text);
    persistSession();

    var bubble = addMessageEl('assistant', '');
    bubble.innerHTML = '<span class="cursor"></span>';

    pendingText = '';
    pendingNode = bubble;
    var raf = 0;

    function paint() {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        bubble.innerHTML = renderMarkdown(pendingText) + '<span class="cursor"></span>';
        scrollDown(false);
      });
    }

    setBusy(true);
    hint('');

    var opts = {
      model: settings.model,
      temp: settings.temp,
      max: settings.max,
      sys: settings.sys
    };
    var body = buildPayload(messages.filter(function (m) { return !m.pending; }), opts);
    var started = Date.now();
    var reasoningText = '';

    currentReq = postStream(
      chatURL(),
      authHeaders(),
      body,
      function (line) {
        var ev = parseStreamLine(line);
        if (!ev) return;
        if (ev.error) {
          hint(ev.error, true);
          return;
        }
        if (ev.reasoning) reasoningText += ev.reasoning;
        if (ev.delta) {
          pendingText += ev.delta;
          paint();
        }
      },
      function (res) {
        currentReq = null;
        setBusy(false);

        if (res.aborted) {
          hint('stopped');
          return;
        }

        if (!res.ok) {
          var msg = res.error || errorFromBody(res.raw, res.status);
          hint(msg, true);
          bubble.innerHTML = '<span style="color:var(--danger)">' + esc(msg) + '</span>' +
            '<div class="meta"><span>model id / credits / base URL check karo</span></div>';
          scrollDown(true);
          return;
        }

        var finalText = pendingText || reasoningText || textFromBody(res.raw);
        if (!finalText) {
          bubble.innerHTML = '<span style="color:var(--muted)">empty response — model ne kuch return nahi kiya</span>' +
            '<div class="meta"><span>maybe non-chat model, wrong id, or blocked</span></div>';
          hint('try another model', true);
          scrollDown(true);
          return;
        }

        messages.push({ role: 'assistant', content: finalText });
        bubble.innerHTML = renderMarkdown(finalText);
        attachMeta(bubble, started, finalText, messages.length - 1);
        persistSession();
        scrollDown(true);
        hint('');
      }
    );
  }

  // ------------------------------------------------------------ agent + tools
  function webEnabled() {
    try { return localStorage.getItem(STORE_WEB) === '1'; } catch (e) { return false; }
  }

  function setWebEnabled(on) {
    try { localStorage.setItem(STORE_WEB, on ? '1' : '0'); } catch (e) { /* ignore */ }
    var b = $('btn-web');
    if (b) b.classList.toggle('on', on);
  }

  function authHeaders() {
    return {
      'Authorization': 'Bearer ' + settings.key,
      'Content-Type': 'application/json'
    };
  }

  function chatURL() { return trimSlash(settings.base) + '/chat/completions'; }

  /** POST and collect the whole body (used for tool rounds / model lists). */
  function postJSON(url, headers, body, cb) {
    var buf = '';
    return postStream(url, headers, body, function (line) { buf += line; }, function (res) {
      if (!res.ok) return cb({ ok: false, error: res.aborted ? 'stopped' : (res.error || 'request failed') });
      try { cb({ ok: true, data: JSON.parse(buf) }); }
      catch (e) { cb({ ok: false, error: 'bad JSON: ' + e.message }); }
    });
  }

  /** GET a URL as text (native bridge first, fetch as fallback). */
  function httpGet(url, headers, cb) {
    if (typeof headers === 'function') { cb = headers; headers = {}; }
    var id = 'g' + (++seq) + Date.now().toString(36);
    var buf = '';
    var finished = false;

    function end(err, text) {
      if (finished) return;
      finished = true;
      delete eventHandlers[id];
      cb(err, text || '');
    }

    eventHandlers[id] = function (ev) {
      if (ev.type === 'line') buf += ev.line + '\n';
      if (ev.type === 'error') end(new Error(ev.message || 'network error'));
      if (ev.type === 'done') end(null, buf);
    };

    if (GLOBAL.Native && GLOBAL.Native.get) {
      try { GLOBAL.Native.get(id, url, JSON.stringify(headers || {})); } catch (e) { end(new Error(String(e))); }
      return;
    }

    fetch(url, { redirect: 'follow', headers: headers || {} })
      .then(function (r) { return r.text(); })
      .then(function (t) { end(null, t); })
      .catch(function (e) { end(new Error(String(e && e.message || e))); });
  }

  function toolPayload(convo) {
    var msgs = convo.filter(function (m) { return m.role !== 'system'; });
    if (settings.sys) msgs = [{ role: 'system', content: settings.sys }].concat(msgs);
    return {
      model: settings.model,
      messages: msgs,
      tools: TOOLS_API.TOOLS,
      tool_choice: 'auto',
      temperature: Number(settings.temp),
      max_tokens: Number(settings.max),
      stream: false
    };
  }

  function addSource(list, src) {
    if (!src || !src.url) return;
    for (var i = 0; i < list.length; i++) if (list[i].url === src.url) return;
    list.push(src);
  }

  function renderSources(sources) {
    if (!sources || !sources.length) return '';
    var html = '<div class="sources"><span class="sources-label">sources</span>';
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var label = (s.title || s.url).slice(0, 42);
      html += '<a class="source" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(label) + '</a>';
    }
    return html + '</div>';
  }

  function attachMeta(bubble, startedAt, content, msgIndex) {
    var meta = document.createElement('div');
    meta.className = 'meta';

    var t = document.createElement('span');
    var secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    t.textContent = nowTime() + ' · ' + secs + 's · ' + bytes(content.length);

    var copy = document.createElement('button');
    copy.textContent = 'copy';
    copy.onclick = function () {
      copyText(content, function (ok) {
        copy.textContent = ok ? 'copied' : 'copy fail';
        setTimeout(function () { copy.textContent = 'copy'; }, 1200);
      });
    };

    var retry = document.createElement('button');
    retry.textContent = 'retry';
    retry.onclick = function () {
      messages = messages.slice(0, msgIndex);
      resendLast();
    };

    meta.appendChild(t);
    meta.appendChild(copy);
    meta.appendChild(retry);
    bubble.parentNode.appendChild(meta);
  }

  function sendAgent(text) {
    if (busy) return;
    if (!settings.key && !/localhost|127\.0\.0\.1/.test(settings.base)) {
      openSettings();
      hint('API key daalo pehle', true);
      return;
    }

    var input = $('input');
    input.value = '';
    input.style.height = 'auto';

    messages.push({ role: 'user', content: text });
    addMessageEl('user', text);
    persistSession();

    var bubble = addMessageEl('assistant', '');
    bubble.innerHTML = '<span class="cursor"></span>';
    setBusy(true);
    hint('thinking…');

    var convo = messages.slice();
    var sources = [];
    var rounds = 0;
    var started = Date.now();
    var maxRounds = 4;

    function finish(content, err) {
      currentReq = null;
      setBusy(false);
      if (err && !content) {
        bubble.innerHTML = '<span style="color:var(--muted)">' + esc(err) + '</span>';
        hint(err, true);
        return;
      }
      if (!content) {
        bubble.innerHTML = '<span style="color:var(--muted)">no response</span>';
        return;
      }
      messages.push({ role: 'assistant', content: content });
      bubble.innerHTML = renderMarkdown(content) + renderSources(sources);
      attachMeta(bubble, started, content, messages.length - 1);
      persistSession();
      scrollDown(true);
      hint('');
    }

    function runTool(calls, i) {
      if (i >= calls.length) return step();
      var call = calls[i];
      if (!spendTokens(CREDITS ? CREDITS.COST.web_round : 3, true)) {
        return finish('', 'tokens khatam — web round ke liye 3 tokens chahiye');
      }
      hint(rounds > 1 ? 'reading…' : 'searching…');
      TOOLS_API.execute(call.name, call.args, httpGet, function (err, content, src) {
        for (var k = 0; k < (src || []).length; k++) addSource(sources, src[k]);
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: err ? ('error: ' + err.message) : content
        });
        runTool(calls, i + 1);
      });
    }

    function step() {
      if (rounds >= maxRounds) return finish('', 'tool limit reached');
      rounds++;
      hint(rounds === 1 ? 'thinking…' : 'writing…');
      currentReq = postJSON(chatURL(), authHeaders(), toolPayload(convo), function (res) {
        if (!res.ok) return finish('', res.error || 'request failed');
        var msg = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message;
        if (!msg) return finish('', 'empty response');

        var calls = TOOLS_API.parseToolCalls(msg);
        if (!calls.length) return finish(msg.content || msg.reasoning_content || msg.reasoning || '', null);

        convo.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
        runTool(calls, 0);
      });
    }

    step();
  }


  // ---------------------------------------------------------- tabs + tokens
  var CREDITS = GLOBAL.DarkCredits || null;
  var currentTab = 'chat';

  function refreshTokens() {
    if (!CREDITS) return;
    var s;
    try { s = CREDITS.summary(); } catch (e) { return; }

    var chip = $('token-count');
    if (chip) chip.textContent = s.premium ? '∞' : s.balance;
    var btn = $('btn-tokens');
    if (btn) btn.classList.toggle('premium', s.premium);

    if ($('cr-balance')) {
      $('cr-balance').textContent = s.balance;
      $('cr-premium').textContent = s.premium ? 'premium · ' + s.premiumDays + 'd left' : 'free plan';
      $('cr-stats').textContent = 'earned ' + s.totalEarned + ' · spent ' + s.totalSpent;
      $('cr-daily').disabled = !s.canClaimDaily;
      $('cr-daily-desc').textContent = s.canClaimDaily
        ? '+' + s.daily + ' tokens aaj'
        : 'aaj le liya — kal aana';
      $('cr-ad').disabled = !s.adReady;
      $('cr-ad-desc').textContent = s.adReady
        ? '+' + s.adReward + ' tokens · 1h cooldown'
        : 'cooldown — thodi der baad';
    }
  }

  /** Open a link in the system browser / Telegram app. */
  function openExternal(url) {
    if (GLOBAL.Native && GLOBAL.Native.openUrl) {
      try { GLOBAL.Native.openUrl(url); return; } catch (e) { /* fall through */ }
    }
    if (GLOBAL.open) GLOBAL.open(url, '_blank');
    else GLOBAL.location.href = url;
  }

  var TELEGRAM = 'https://t.me/TEAMDARK_OWNER';

  function buyURL(plan) {
    var text = 'Hi TEAMDARK_OWNER, mujhe DARK AGENT Premium chahiye — ' + plan +
      '. Payment kaise karun?';
    return TELEGRAM + '?text=' + encodeURIComponent(text);
  }

  function crMsg(text, err) {
    var el = $('cr-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'note small' + (err ? ' err' : '');
  }

  function spendTokens(n, quiet) {
    if (!CREDITS) return true;
    var res = CREDITS.spend(n);
    refreshTokens();
    if (res.ok) return true;
    if (!quiet) {
      switchTab('credits');
      hint('tokens khatam — daily reward lo ya ad dekho', true);
    }
    return false;
  }

  function switchTab(name) {
    currentTab = name;

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === name);
    }

    $('chat').classList.toggle('hidden', name !== 'chat');
    $('composer').classList.toggle('hidden', name !== 'chat');

    var panes = { image: 'view-image', music: 'view-music', credits: 'view-credits' };
    Object.keys(panes).forEach(function (k) {
      var el = $(panes[k]);
      if (el) el.classList.toggle('hidden', k !== name);
    });

    if (name === 'credits') refreshTokens();
  }

  var adTimer = null;

  function runAd() {
    if (!CREDITS) return;
    if (adTimer) return;

    if (!CREDITS.adReady()) {
      crMsg('ad cooldown chal raha hai — thodi der baad try karo', true);
      return;
    }

    var btn = $('cr-ad');
    var desc = $('cr-ad-desc');
    var left = 3;

    btn.disabled = true;
    desc.textContent = 'ad playing… ' + left + 's';

    adTimer = setInterval(function () {
      left--;
      if (left > 0) {
        desc.textContent = 'ad playing… ' + left + 's';
        return;
      }
      clearInterval(adTimer);
      adTimer = null;
      btn.disabled = false;
      var res = CREDITS.adReward();
      if (res.ok) crMsg('+' + res.gained + ' tokens mil gaye');
      refreshTokens();
    }, 1000);
  }

  function redeemCode() {
    if (!CREDITS) return;
    var input = $('cr-code');
    var res = CREDITS.redeem(input.value);
    if (res.ok) {
      input.value = '';
      crMsg('premium on — ' + res.days + ' din ke liye (' + res.label + ')');
    } else if (res.reason === 'used') {
      crMsg('ye code pehle use ho chuka hai', true);
    } else {
      crMsg('code galat hai', true);
    }
    refreshTokens();
  }


  /** Clipboard that also works on file:// (no secure-context clipboard API). */
  function copyText(text, done) {
    done = done || function () {};

    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
      return;
    }
    fallback();
  }

  // ------------------------------------------------------------ plan cards
  function renderPlans() {
    var wrap = $('plan-grid');
    if (!wrap || !CREDITS) return;
    wrap.innerHTML = '';

    CREDITS.PLANS.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'plan-card';

      var name = document.createElement('span');
      name.className = 'plan-name';
      name.textContent = p.label;

      var price = document.createElement('span');
      price.className = 'plan-price';
      price.textContent = '₹' + p.price;

      var days = document.createElement('span');
      days.className = 'plan-days';
      days.textContent = p.days + ' din';

      var buy = document.createElement('button');
      buy.className = 'btn sm primary buy-now';
      buy.textContent = 'Buy now';
      buy.onclick = function () {
        openExternal(buyURL(p.label + ' · ₹' + p.price));
      };

      card.appendChild(name);
      card.appendChild(price);
      card.appendChild(days);
      card.appendChild(buy);
      wrap.appendChild(card);
    });
  }

  // ------------------------------------------------------------ owner panel
  var panelUnlocked = false;
  var panelTaps = 0;

  function panelMsg(text, err) {
    var el = $('panel-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'note small' + (err ? ' err' : '');
  }

  function openPanel() {
    $('panel-wrap').classList.remove('hidden');
    $('panel-msg').textContent = '';

    if (panelUnlocked) {
      $('panel-pin-row').classList.add('hidden');
      $('panel-main').classList.remove('hidden');
      renderGenerated();
    } else {
      $('panel-pin-row').classList.remove('hidden');
      $('panel-main').classList.add('hidden');
      $('panel-pin').value = '';
    }
  }

  function unlockPanel() {
    if (!CREDITS.checkPin($('panel-pin').value)) {
      panelMsg('galat PIN', true);
      return;
    }
    panelUnlocked = true;
    $('panel-pin').value = '';
    openPanel();
  }

  function makeCode() {
    var res = CREDITS.generateCode($('panel-plan').value);
    if (!res.ok) {
      panelMsg('plan select karo', true);
      return;
    }
    $('panel-out').classList.remove('hidden');
    $('panel-code').value = res.code;
    panelMsg(res.label + ' · ₹' + res.price + ' · ' + res.days + ' din');
    renderGenerated();
  }

  function codeMessage(code) {
    var info = CREDITS.readCode(code);
    var label = info ? info.label : '';
    return 'DARK AGENT Premium\n' +
      (label ? 'Plan: ' + label + '\n' : '') +
      'Code: ' + code + '\n\n' +
      'Redeem: app → Credits → Redeem a code\n' +
      'MADE BY - @TEAMDARK_OWNER';
  }

  function renderGenerated() {
    var list = $('panel-list');
    if (!list) return;
    var items = CREDITS.generated();
    list.innerHTML = '';

    if (!items.length) {
      list.innerHTML = '<p class="note small">Abhi koi code nahi banaya.</p>';
      return;
    }

    items.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'code-row';

      var code = document.createElement('span');
      code.className = 'code-text';
      code.textContent = g.code + (g.usedHere ? ' ✓' : '');

      var meta = document.createElement('span');
      meta.className = 'code-meta';
      var plan = null;
      CREDITS.PLANS.forEach(function (p) { if (p.id === g.plan) plan = p; });
      meta.textContent = (plan ? plan.label : g.plan) + ' · ₹' + g.price;

      var copy = document.createElement('button');
      copy.className = 'btn sm';
      copy.textContent = 'Copy';
      copy.onclick = function () {
        copyText(codeMessage(g.code), function (ok) {
          panelMsg(ok ? 'copied' : 'copy fail — long-press karke copy karo', !ok);
        });
      };

      row.appendChild(code);
      row.appendChild(meta);
      row.appendChild(copy);
      list.appendChild(row);
    });
  }

  function wirePanel() {
    if (!$('panel-wrap')) return;

    var line = $('credit-line');
    if (line) {
      line.onclick = function () {
        panelTaps++;
        if (panelTaps >= 7) {
          panelTaps = 0;
          openPanel();
        }
      };
    }

    $('panel-unlock').onclick = unlockPanel;
    $('panel-pin').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); unlockPanel(); }
    });

    var sel = $('panel-plan');
    sel.innerHTML = '';
    CREDITS.PLANS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label + ' — ₹' + p.price + ' (' + p.days + ' din)';
      sel.appendChild(o);
    });

    $('panel-gen').onclick = makeCode;

    $('panel-copy').onclick = function () {
      copyText($('panel-code').value, function (ok) {
        panelMsg(ok ? 'copied' : 'copy fail — long-press karke copy karo', !ok);
      });
    };

    $('panel-copy-msg').onclick = function () {
      copyText(codeMessage($('panel-code').value), function (ok) {
        panelMsg(ok ? 'code + message copied' : 'copy fail', !ok);
      });
    };
  }

  function wireCredits() {
    if (!$('cr-daily')) return;

    $('cr-daily').onclick = function () {
      var res = CREDITS.claimDaily();
      if (res.ok) crMsg('+' + res.gained + ' tokens aa gaye');
      else crMsg('aaj ka reward le liya — kal aana', true);
      refreshTokens();
    };

    $('cr-ad').onclick = runAd;
    $('cr-redeem').onclick = redeemCode;

    Array.prototype.forEach.call(document.querySelectorAll('[data-buy]'), function (b) {
      b.onclick = function () { openExternal(buyURL(b.getAttribute('data-buy'))); };
    });
    $('cr-code').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); redeemCode(); }
    });
  }

  function send(text, opts) {
    text = (text || '').trim();
    if (busy || !text) return;
    opts = opts || {};
    if (!settings.key && !/localhost|127\.0\.0\.1/.test(settings.base)) {
      openSettings();
      hint('API key daalo pehle', true);
      return;
    }
    if (!opts.freeTokens && !spendTokens(CREDITS ? CREDITS.COST.message : 1)) return;
    if (webEnabled()) return sendAgent(text);
    return sendStream(text);
  }

  function resendLast() {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        var text = messages[i].content;
        messages = messages.slice(0, i);
        rebuild();
        send(text, { freeTokens: true });
        return;
      }
    }
  }

  function stop() {
    if (currentReq) currentReq.abort();
    currentReq = null;
  }

  function rebuild() {
    chatEl().innerHTML = '';
    messages.forEach(function (m) {
      if (m.role === 'system') return;
      addMessageEl(m.role, m.content);
    });
  }

  function newChat() {
    stop();
    currentId = null;
    messages = [];
    chatEl().innerHTML = '';
    var empty = document.createElement('section');
    empty.className = 'empty';
    empty.id = 'empty';
    empty.innerHTML =
      '<div class="empty-mark">◈</div>' +
      '<h1>DARK AGENT</h1>' +
      '<p>Naya chat. Kuch bhi poocho.</p>' +
      '<div class="quick" id="quick"></div>';
    chatEl().appendChild(empty);
    renderQuick();
    closeSheet('chats');
    hint('');
  }

  // ------------------------------------------------------------------ UI wiring
  function renderQuick() {
    var q = $('quick');
    if (!q) return;
    q.innerHTML = '';
    QUICK.forEach(function (text) {
      var b = document.createElement('button');
      b.textContent = text;
      b.onclick = function () { send(text); };
      q.appendChild(b);
    });
  }

  function openSettings() {
    $('s-base').value = settings.base;
    $('s-key').value = settings.key;
    $('s-model').value = settings.model;
    $('s-sys').value = settings.sys;
    $('s-temp').value = settings.temp;
    $('s-max').value = settings.max;
    $('s-status').textContent = '';
    $('settings-wrap').classList.remove('hidden');
  }

  function closeSheet(which) {
    $(which + '-wrap').classList.add('hidden');
  }

  function renderChatList() {
    var list = $('chat-list');
    list.innerHTML = '';
    if (!sessions.length) {
      list.innerHTML = '<p class="note">Koi saved chat nahi.</p>';
      return;
    }
    sessions.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'chat-item' + (s.id === currentId ? ' active' : '');

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.title || 'Chat';
      name.onclick = function () {
        currentId = s.id;
        messages = (s.messages || []).slice();
        rebuild();
        closeSheet('chats');
        hint('');
      };

      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.onclick = function () {
        sessions = sessions.filter(function (x) { return x.id !== s.id; });
        saveJSON(STORE_SESSIONS, sessions);
        if (currentId === s.id) newChat();
        renderChatList();
      };

      row.appendChild(name);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function loadModels() {
    var status = $('s-status');
    var base = trimSlash($('s-base').value);
    var key = $('s-key').value.trim();
    if (!base) { status.textContent = 'Base URL daalo pehle'; status.className = 'note err'; return; }
    status.textContent = 'Loading…';
    status.className = 'note';

    var headers = key ? { 'Authorization': 'Bearer ' + key } : {};

    httpGet(base + '/models', headers, function (err, body) {
      if (err) {
        status.textContent = 'Failed: ' + err.message;
        status.className = 'note err';
        return;
      }
      var list;
      try {
        var data = JSON.parse(body);
        list = data.data || data.models || [];
      } catch (e) {
        status.textContent = 'Parse error — check the base URL (needs /v1)';
        status.className = 'note err';
        return;
      }

      var dl = $('model-list');
      var sel = $('s-model-select');
      dl.innerHTML = '';
      sel.innerHTML = '';

      list.forEach(function (m) {
        var id = m.id || m.name;
        if (!id) return;
        var opt = document.createElement('option');
        opt.value = id;
        dl.appendChild(opt);
        var o2 = document.createElement('option');
        o2.value = id;
        o2.textContent = id;
        sel.appendChild(o2);
      });

      if (!list.length) {
        status.textContent = 'Koi model nahi mila (key / base URL check karo)';
        status.className = 'note err';
        return;
      }

      sel.classList.remove('hidden');
      if ($('s-model').value) sel.value = $('s-model').value;
      status.textContent = list.length + ' models — dropdown se pick karo';
      status.className = 'note';
    });
  }

  function wire() {
    // presets
    var sel = $('s-preset');
    PRESETS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.onchange = function () {
      var p = PRESETS.filter(function (x) { return x.id === sel.value; })[0];
      if (!p || !p.base) return;
      $('s-base').value = p.base;
      if (p.model) $('s-model').value = p.model;
      var sel2 = $('s-model-select');
      sel2.innerHTML = '';
      sel2.classList.add('hidden');
    };

    $('btn-settings').onclick = openSettings;
    $('btn-model').onclick = function () {
      openSettings();
      setTimeout(function () { $('s-model').focus(); }, 120);
    };
    $('btn-menu').onclick = function () { renderChatList(); $('chats-wrap').classList.remove('hidden'); };
    $('btn-new').onclick = newChat;
    $('btn-load-models').onclick = loadModels;
    $('s-model-select').onchange = function () {
      $('s-model').value = this.value;
    };
    $('btn-save').onclick = function () {
      settings.base = trimSlash($('s-base').value) || DEFAULTS.base;
      settings.key = $('s-key').value.trim();
      settings.model = $('s-model').value.trim() || DEFAULTS.model;
      settings.sys = $('s-sys').value.trim();
      settings.temp = Math.max(0, Math.min(2, Number($('s-temp').value) || DEFAULTS.temp));
      settings.max = Math.max(32, Number($('s-max').value) || DEFAULTS.max);
      saveJSON(STORE_SETTINGS, settings);
      $('btn-model').textContent = settings.model;
      closeSheet('settings');
      hint('saved');
      setTimeout(function () { hint(''); }, 1200);
    };

    document.querySelectorAll('[data-close]').forEach(function (el) {
      el.onclick = function () { closeSheet(el.getAttribute('data-close')); };
    });

    $('btn-web').onclick = function () {
      var on = !webEnabled();
      setWebEnabled(on);
      hint(on ? 'web tools on — model search karega' : 'web tools off');
      setTimeout(function () { hint(''); }, 1600);
    };
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.onclick = function () { switchTab(t.getAttribute('data-tab')); };
    });
    $('btn-tokens').onclick = function () { switchTab('credits'); };
    renderPlans();
    wireCredits();
    wirePanel();
    $('btn-send').onclick = function () { send($('input').value); };
    $('btn-stop').onclick = stop;

    var input = $('input');
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(132, input.scrollHeight) + 'px';
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(input.value);
      }
    });

    // links open in the system browser, not inside the app
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (a && a.href && a.target === '_blank') {
        e.preventDefault();
        openExternal(a.href);
      }
    });
  }

  // ------------------------------------------------------------------- boot
  function boot() {
    $('btn-model').textContent = settings.model;
    setWebEnabled(webEnabled());
    refreshTokens();
    wire();
    renderQuick();
    if (sessions.length && sessions[0].messages && sessions[0].messages.length) {
      currentId = sessions[0].id;
      messages = sessions[0].messages.slice();
      rebuild();
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  // test hooks (node)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseStreamLine: parseStreamLine,
      renderMarkdown: renderMarkdown,
      buildPayload: buildPayload,
      textFromBody: textFromBody,
      errorFromBody: errorFromBody,
      settings: DEFAULTS,
      presets: PRESETS
    };
  }
})();
