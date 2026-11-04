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
    { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
    { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'ollama', name: 'Ollama (local)', base: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:0.5b' },
    { id: 'custom', name: 'Custom', base: '', model: '' }
  ];

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
    if (choice) {
      delta = (choice.delta && (choice.delta.content || '')) || (choice.message && choice.message.content) || '';
    }
    return { delta: delta, done: !!choice && (choice.finish_reason != null), usage: obj.usage || null };
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
  function postStream(url, headers, body, onLine, onEnd) {
    var id = 'r' + (++seq) + Date.now().toString(36);
    var finished = false;

    eventHandlers[id] = function (ev) {
      if (ev.type === 'line') onLine(ev.line);
      if (ev.type === 'error') { finished = true; delete eventHandlers[id]; onEnd({ ok: false, error: ev.message || 'network error' }); }
      if (ev.type === 'done') {
        if (finished) return;
        finished = true;
        delete eventHandlers[id];
        onEnd({ ok: true });
      }
    };

    var handle = {
      id: id,
      abort: function () {
        if (finished) return;
        finished = true;
        delete eventHandlers[id];
        try { if (GLOBAL.Native && GLOBAL.Native.abort) GLOBAL.Native.abort(id); } catch (e) { /* ignore */ }
        onEnd({ ok: false, aborted: true });
      }
    };

    if (GLOBAL.Native && GLOBAL.Native.post) {
      try {
        GLOBAL.Native.post(id, url, JSON.stringify(headers), JSON.stringify(body));
      } catch (e) {
        delete eventHandlers[id];
        onEnd({ ok: false, error: String(e && e.message || e) });
      }
      return handle;
    }

    // browser/node fallback (CORS permitting)
    var ctrl = new AbortController();
    handle.abort = function () {
      if (finished) return;
      finished = true;
      delete eventHandlers[id];
      ctrl.abort();
      onEnd({ ok: false, aborted: true });
    };

    fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            var msg = 'HTTP ' + res.status;
            try { msg += ': ' + (JSON.parse(t).error.message || ''); } catch (e) { /* plain */ }
            throw new Error(msg);
          });
        }
        if (!res.body || !res.body.getReader) {
          return res.text().then(function (t) {
            t.split('\n').forEach(onLine);
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
            parts.forEach(onLine);
            return pump();
          });
        }
        return pump();
      })
      .then(function () { if (!finished) { finished = true; delete eventHandlers[id]; onEnd({ ok: true }); } })
      .catch(function (err) {
        if (finished) return;
        finished = true;
        delete eventHandlers[id];
        onEnd({ ok: false, error: String(err && err.message || err) });
      });

    return handle;
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
  function send(text) {
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
    var gotAny = false;

    currentReq = postStream(
      trimSlash(settings.base) + '/chat/completions',
      {
        'Authorization': 'Bearer ' + settings.key,
        'Content-Type': 'application/json'
      },
      body,
      function (line) {
        var ev = parseStreamLine(line);
        if (!ev) return;
        if (ev.error) {
          hint(ev.error, true);
          return;
        }
        if (ev.delta) {
          gotAny = true;
          pendingText += ev.delta;
          paint();
        }
      },
      function (res) {
        var finalText = pendingText;
        currentReq = null;
        setBusy(false);

        if (!res.ok) {
          if (res.aborted) {
            hint('stopped');
          } else {
            hint(res.error || 'request failed', true);
          }
        }

        if (!finalText && res.ok) {
          finalText = '(empty response)';
        }

        if (finalText) {
          messages.push({ role: 'assistant', content: finalText });
          var idx = messages.length - 1;
          bubble.innerHTML = renderMarkdown(finalText);

          var meta = document.createElement('div');
          meta.className = 'meta';
          var t = document.createElement('span');
          var secs = ((Date.now() - started) / 1000).toFixed(1);
          t.textContent = nowTime() + ' · ' + secs + 's · ' + bytes(finalText.length);
          var copy = document.createElement('button');
          copy.textContent = 'copy';
          copy.onclick = function () {
            navigator.clipboard && navigator.clipboard.writeText(finalText);
            copy.textContent = 'copied';
            setTimeout(function () { copy.textContent = 'copy'; }, 1200);
          };
          var retry = document.createElement('button');
          retry.textContent = 'retry';
          retry.onclick = function () {
            messages = messages.slice(0, idx);
            resendLast();
          };
          meta.appendChild(t);
          meta.appendChild(copy);
          meta.appendChild(retry);
          bubble.parentNode.appendChild(meta);

          persistSession();
          scrollDown(true);
        } else {
          bubble.innerHTML = '<span style="color:var(--muted)">no response</span>';
        }
        if (gotAny) hint('');
      }
    );
  }

  function resendLast() {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        var text = messages[i].content;
        messages = messages.slice(0, i);
        rebuild();
        send(text);
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

    var url = base + '/models';
    var headers = key ? { 'Authorization': 'Bearer ' + key } : {};
    var done = false;
    var buf = '';

    postStream(url, headers, {}, function (line) {
      if (line) buf += line;
    }, function (res) {
      done = true;
      if (!res.ok) {
        status.textContent = 'Failed: ' + (res.error || 'error');
        status.className = 'note err';
        return;
      }
      try {
        var data = JSON.parse(buf);
        var list = data.data || data.models || [];
        var dl = $('model-list');
        dl.innerHTML = '';
        list.forEach(function (m) {
          var id = m.id || m.name;
          if (!id) return;
          var opt = document.createElement('option');
          opt.value = id;
          dl.appendChild(opt);
        });
        status.textContent = list.length + ' models mil gaye — model field me tap karo';
        status.className = 'note';
      } catch (e) {
        status.textContent = 'Parse error: ' + e.message;
        status.className = 'note err';
      }
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
    };

    $('btn-settings').onclick = openSettings;
    $('btn-model').onclick = function () {
      openSettings();
      setTimeout(function () { $('s-model').focus(); }, 120);
    };
    $('btn-menu').onclick = function () { renderChatList(); $('chats-wrap').classList.remove('hidden'); };
    $('btn-new').onclick = newChat;
    $('btn-load-models').onclick = loadModels;
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
        GLOBAL.open ? GLOBAL.open(a.href, '_blank') : (GLOBAL.location.href = a.href);
      }
    });
  }

  // ------------------------------------------------------------------- boot
  function boot() {
    $('btn-model').textContent = settings.model;
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
    module.exports = { parseStreamLine: parseStreamLine, renderMarkdown: renderMarkdown, buildPayload: buildPayload, settings: DEFAULTS, presets: PRESETS };
  }
})();
