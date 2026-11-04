/* DARK AGENT — Studio (talking characters / Reels)
 *
 * Turns a short dialogue into a 9:16 animated clip:
 *   script -> timeline -> canvas frames -> MediaRecorder -> base64 -> Downloads
 *
 * No AI model runs here: the script comes from the chat model, this file only
 * draws and encodes. Pure helpers (parseScript / buildTimeline / wrapText)
 * are exported so they can be tested under node.
 */
(function () {
  'use strict';

  var GLOBAL = typeof window !== 'undefined' ? window : globalThis;

  var FPS = 30;
  var W = 720;
  var H = 1280;

  var EMOJIS = ['🍎', '🍌', '🍊', '🍇', '🥭', '🍓', '🍍', '🥝',
                '🐱', '🐶', '🐵', '🐸', '🦁', '🐼', '🐰', '🐯'];

  // ------------------------------------------------------------------ script
  /**
   * "A: hello" / "B: hi" / plain lines (alternating speakers).
   * @returns {Array<{who: 'A'|'B', text: string}>}
   */
  function parseScript(text) {
    var out = [];
    var flip = 0;
    String(text || '').split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (!line || line.charAt(0) === '#') return;

      var m = line.match(/^([ABab])\s*[:\-–]\s*(.+)$/);
      if (m) {
        out.push({ who: m[1].toUpperCase(), text: m[2].trim() });
      } else {
        out.push({ who: flip % 2 === 0 ? 'A' : 'B', text: line });
        flip++;
      }
    });
    return out.filter(function (l) { return l.text; }).slice(0, 14);
  }

  /** Each line gets a duration from its length; returns {items,total}. */
  function buildTimeline(lines, gap) {
    gap = gap === undefined ? 0.18 : gap;
    var items = [];
    var t = 0;

    (lines || []).forEach(function (l) {
      var dur = 1.5 + String(l.text || '').length * 0.055;
      dur = Math.max(2.0, Math.min(6.0, dur));
      items.push({ who: l.who || 'A', text: l.text || '', start: t, dur: dur });
      t += dur + gap;
    });

    return { items: items, total: Math.max(0.5, t) };
  }

  function lineAt(timeline, t) {
    var items = timeline.items;
    for (var i = 0; i < items.length; i++) {
      if (t >= items[i].start && t < items[i].start + items[i].dur) return items[i];
    }
    return null;
  }

  // ------------------------------------------------------------------ canvas
  function wrapText(ctx, text, maxWidth, maxLines) {
    var words = String(text || '').split(/\s+/);
    var lines = [];
    var cur = '';

    for (var i = 0; i < words.length; i++) {
      var next = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(next).width <= maxWidth || !cur) {
        cur = next;
      } else {
        lines.push(cur);
        cur = words[i];
      }
    }
    if (cur) lines.push(cur);

    if (maxLines && lines.length > maxLines) {
      var kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = kept[maxLines - 1].replace(/[.,;:!?]?$/, '') + '…';
      return kept;
    }
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function bg(ctx, w, h, t) {
    var g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#0b0d12');
    g.addColorStop(0.55, '#141827');
    g.addColorStop(1, '#1b1330');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // slow floating emoji wallpaper
    ctx.globalAlpha = 0.08;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = Math.round(w * 0.11) + 'px system-ui, sans-serif';
    for (var i = 0; i < 10; i++) {
      var x = ((i * 0.173 + 0.05) % 1) * w;
      var y = (((i * 0.311 + t * 0.012) % 1)) * h;
      ctx.fillText(EMOJIS[i % EMOJIS.length], x, y);
    }
    ctx.globalAlpha = 1;
  }

  function drawCharacter(ctx, w, h, emoji, side, active, t) {
    var bob = Math.sin(t * 3.2 + (side === 'A' ? 0 : 1.7)) * (active ? 10 : 4);
    var scale = active ? 1.14 : 0.98;
    var x = side === 'A' ? w * 0.26 : w * 0.74;
    var y = h * 0.60 + bob;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    // glow
    var glow = ctx.createRadialGradient(0, 0, 10, 0, 0, w * 0.17);
    glow.addColorStop(0, active ? 'rgba(124,92,255,0.40)' : 'rgba(124,92,255,0.14)');
    glow.addColorStop(1, 'rgba(124,92,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, w * 0.17, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = Math.round(w * 0.19) + 'px system-ui, "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji || '🙂', 0, 0);
    ctx.restore();
  }

  function drawBubble(ctx, w, h, text, side, prog) {
    var font = Math.round(w * 0.052);
    ctx.font = '600 ' + font + 'px system-ui, sans-serif';
    var maxW = w * 0.78;
    var lines = wrapText(ctx, text, maxW, 4);

    var padX = w * 0.045;
    var padY = w * 0.032;
    var lineH = font * 1.3;
    var boxW = 0;
    for (var i = 0; i < lines.length; i++) {
      boxW = Math.max(boxW, ctx.measureText(lines[i]).width);
    }
    boxW = Math.min(maxW, boxW) + padX * 2;
    var boxH = lines.length * lineH + padY * 2;

    var cx = side === 'A' ? w * 0.42 : w * 0.58;
    var x = Math.min(w * 0.94 - boxW, Math.max(w * 0.06, cx - boxW / 2));
    var y = h * 0.20;

    ctx.globalAlpha = Math.min(1, prog * 4);
    ctx.fillStyle = 'rgba(23,27,37,0.94)';
    ctx.strokeStyle = side === 'A' ? 'rgba(34,211,167,0.55)' : 'rgba(124,92,255,0.65)';
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, boxW, boxH, w * 0.035);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e7e9f3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (var j = 0; j < lines.length; j++) {
      ctx.fillText(lines[j], x + padX, y + padY + j * lineH);
    }
    ctx.globalAlpha = 1;
  }

  function drawCaption(ctx, w, h, text) {
    var font = Math.round(w * 0.048);
    ctx.font = '700 ' + font + 'px system-ui, sans-serif';
    var lines = wrapText(ctx, text, w * 0.86, 3);
    var lineH = font * 1.32;
    var boxH = lines.length * lineH + h * 0.035;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, w * 0.05, h * 0.845 - boxH / 2, w * 0.90, boxH, w * 0.03);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], w / 2, h * 0.845 - boxH / 2 + h * 0.0175 + lineH * (i + 0.5) - lineH / 2);
    }
  }

  /** Draw one frame of the clip. */
  function drawFrame(ctx, w, h, t, timeline, opts) {
    opts = opts || {};
    var active = lineAt(timeline, t);
    var prog = active ? Math.min(1, (t - active.start) / 0.35) : 0;
    var speaker = active ? active.who : null;

    bg(ctx, w, h, t);

    // title
    if (opts.title) {
      ctx.font = '800 ' + Math.round(w * 0.042) + 'px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(231,233,243,0.85)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(opts.title).slice(0, 32), w / 2, h * 0.045);
    }

    drawCharacter(ctx, w, h, opts.emojiA || '🍎', 'A', speaker === 'A', t);
    drawCharacter(ctx, w, h, opts.emojiB || '🐱', 'B', speaker === 'B', t);

    if (active) {
      drawBubble(ctx, w, h, active.text, active.who, prog);
      drawCaption(ctx, w, h, active.text);
    }

    // watermark
    ctx.font = '600 ' + Math.round(w * 0.024) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(139,147,167,0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('MADE BY - @TEAMDARK_OWNER', w / 2, h - h * 0.028);

    // progress
    var done = timeline.total ? Math.min(1, t / timeline.total) : 0;
    ctx.fillStyle = 'rgba(124,92,255,0.9)';
    ctx.fillRect(0, h - 6, w * done, 6);
  }

  function makeCanvas(w, h) {
    var c = GLOBAL.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function loop(canvas, timeline, opts, onTick, done) {
    var ctx = canvas.getContext('2d');
    var t0 = null;
    var id = 0;

    function frame(now) {
      if (t0 === null) t0 = now;
      var t = (now - t0) / 1000;

      if (t >= timeline.total) {
        drawFrame(ctx, canvas.width, canvas.height, timeline.total - 0.01, timeline, opts);
        if (onTick) onTick(1);
        if (done) done(null);
        return;
      }

      drawFrame(ctx, canvas.width, canvas.height, t, timeline, opts);
      if (onTick) onTick(t / timeline.total);
      id = GLOBAL.requestAnimationFrame(frame);
    }

    id = GLOBAL.requestAnimationFrame(frame);
    return { cancel: function () { GLOBAL.cancelAnimationFrame(id); } };
  }

  // ---------------------------------------------------------------- recorder
  function pickMime() {
    var candidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    if (!GLOBAL.MediaRecorder || !GLOBAL.MediaRecorder.isTypeSupported) return null;
    for (var i = 0; i < candidates.length; i++) {
      if (GLOBAL.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  /** Optional background beat coming from the Music tab's renderer. */
  function beatTrack(seconds) {
    var Music = GLOBAL.DarkMusic;
    var Ctx = GLOBAL.AudioContext || GLOBAL.webkitAudioContext;
    if (!Music || !Ctx) return null;

    try {
      var ac = new Ctx();
      var grid = Music.emptyGrid();
      [0, 4, 8, 12].forEach(function (i) { grid.kick[i] = 1; });
      [4, 12].forEach(function (i) { grid.snare[i] = 1; });
      [2, 6, 10, 14].forEach(function (i) { grid.hat[i] = 1; });
      [0, 3, 6, 9, 12].forEach(function (i) { grid.mel[i] = 2 + (i % 3); });

      var bar = Music.renderBar(92, grid);
      var need = Math.ceil((seconds * 22050) / bar.length) + 1;
      var samples = new Float32Array(bar.length * need);
      for (var b = 0; b < need; b++) samples.set(bar, b * bar.length);

      var buffer = ac.createBuffer(1, samples.length, 22050);
      if (buffer.copyToChannel) buffer.copyToChannel(samples, 0);
      else buffer.getChannelData(0).set(samples);

      var src = ac.createBufferSource();
      src.buffer = buffer;

      var gain = ac.createGain();
      gain.gain.value = 0.22;

      var dest = ac.createMediaStreamDestination();
      src.connect(gain);
      gain.connect(dest);

      src.start(0);
      return { stream: dest.stream, ctx: ac, source: src };
    } catch (e) {
      return null;
    }
  }

  function toBase64(blob, cb) {
    var reader = new GLOBAL.FileReader();
    reader.onload = function () {
      var s = String(reader.result || '');
      cb(null, s.indexOf(',') === -1 ? s : s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = function () { cb(new Error('read failed')); };
    reader.readAsDataURL(blob);
  }

  /**
   * Render + encode the clip in real time.
   * done(err, {b64, mime, ext, seconds})
   */
  function record(opts, onProgress, done) {
    if (!GLOBAL.MediaRecorder || !GLOBAL.HTMLCanvasElement ||
        !GLOBAL.HTMLCanvasElement.prototype.captureStream) {
      return done(new Error('is WebView me video export support nahi hai'));
    }

    var mime = pickMime();
    if (!mime) return done(new Error('koi video codec nahi mila'));

    var canvas = makeCanvas(W, H);
    var timeline = buildTimeline(opts.lines);
    var stream = canvas.captureStream(FPS);
    var music = null;

    if (opts.music) {
      music = beatTrack(timeline.total + 1);
      if (music) {
        var track = music.stream.getAudioTracks()[0];
        if (track) stream.addTrack(track);
      }
    }

    var chunks = [];
    var rec;
    try {
      rec = new GLOBAL.MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
    } catch (e) {
      return done(new Error('recorder start nahi hua: ' + e.message));
    }

    var finished = false;

    function cleanup() {
      try { if (music && music.ctx) music.ctx.close(); } catch (e) { /* ignore */ }
    }

    rec.ondataavailable = function (e) {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    rec.onerror = function (e) {
      if (finished) return;
      finished = true;
      cleanup();
      done(new Error('recording error: ' + (e.error || e.message || 'unknown')));
    };

    rec.onstop = function () {
      if (finished) return;
      finished = true;
      cleanup();

      var blob = new GLOBAL.Blob(chunks, { type: mime.split(';')[0] });
      if (!blob.size) return done(new Error('video khali raha'));

      toBase64(blob, function (err, b64) {
        if (err) return done(err);
        done(null, {
          b64: b64,
          mime: mime.split(';')[0],
          ext: mime.indexOf('mp4') !== -1 ? 'mp4' : 'webm',
          seconds: timeline.total
        });
      });
    };

    rec.start(250);
    var run = loop(canvas, timeline, opts, onProgress, function () {
      try { rec.stop(); } catch (e) { /* ignore */ }
    });

    return {
      cancel: function () {
        run.cancel();
        try { rec.stop(); } catch (e) { /* ignore */ }
      }
    };
  }

  /** Play the clip on an existing canvas (no encoding). */
  function preview(canvas, opts, onTick, done) {
    var timeline = buildTimeline(opts.lines);
    canvas.width = W;
    canvas.height = H;
    return loop(canvas, timeline, opts, onTick, done);
  }

  /** Save the current frame as PNG (fallback when video isn't supported). */
  function framePng(opts, at) {
    var canvas = makeCanvas(W, H);
    var ctx = canvas.getContext('2d');
    var timeline = buildTimeline(opts.lines);
    drawFrame(ctx, W, H, at === undefined ? timeline.total * 0.45 : at, timeline, opts);
    return canvas.toDataURL('image/png').split(',')[1];
  }

  var api = {
    W: W,
    H: H,
    EMOJIS: EMOJIS,
    parseScript: parseScript,
    buildTimeline: buildTimeline,
    lineAt: lineAt,
    wrapText: wrapText,
    drawFrame: drawFrame,
    record: record,
    preview: preview,
    framePng: framePng,
    pickMime: pickMime
  };

  GLOBAL.DarkVideo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
