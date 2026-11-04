/* DARK AGENT — music maker
 * 16-step drum + melody sequencer with WAV export (no dependencies).
 */
(function () {
  'use strict';

  var GLOBAL = typeof window !== 'undefined' ? window : globalThis;

  var STEPS = 16;
  var SR = 22050;
  var STORE = 'darkagent.beats.v1';

  var NOTES = [
    { label: '·', freq: 0 },
    { label: 'C4', freq: 261.63 },
    { label: 'E4', freq: 329.63 },
    { label: 'G4', freq: 392.0 },
    { label: 'A4', freq: 440.0 },
    { label: 'C5', freq: 523.25 }
  ];

  var TRACKS = ['kick', 'snare', 'hat', 'mel'];

  function emptyGrid() {
    var g = {};
    TRACKS.forEach(function (t) {
      g[t] = [];
      for (var i = 0; i < STEPS; i++) g[t].push(0);
    });
    return g;
  }

  var beat = { bpm: 96, grid: emptyGrid(), playing: false, step: 0 };

  function $(id) { return document.getElementById(id); }

  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && d.grid) {
        beat.grid = d.grid;
        beat.bpm = d.bpm || 96;
      }
    } catch (e) { /* ignore */ }
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ grid: beat.grid, bpm: beat.bpm })); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------- synthesis
  function hit(buf, startSec, kind, freq, gain) {
    var start = Math.floor(startSec * SR);
    var len = kind === 'kick' ? 0.22 : kind === 'snare' ? 0.14 : kind === 'hat' ? 0.05 : 0.32;
    var n = Math.floor(len * SR);
    var phase = 0;

    for (var i = 0; i < n; i++) {
      var idx = start + i;
      if (idx < 0 || idx >= buf.length) break;
      var t = i / SR;
      var env = Math.exp(-t / (kind === 'hat' ? 0.012 : kind === 'snare' ? 0.05 : kind === 'kick' ? 0.09 : 0.18));
      var s = 0;

      if (kind === 'kick') {
        var f = 45 + 110 * Math.exp(-t / 0.02);
        phase += (2 * Math.PI * f) / SR;
        s = Math.sin(phase) * env;
      } else if (kind === 'snare') {
        s = (Math.random() * 2 - 1) * env * 0.7 + Math.sin(2 * Math.PI * 180 * t) * env * 0.3;
      } else if (kind === 'hat') {
        s = (Math.random() * 2 - 1) * env * 0.5;
      } else {
        phase += (2 * Math.PI * freq) / SR;
        s = (Math.sin(phase) + 0.35 * Math.sin(phase * 2)) * env * 0.45;
      }

      buf[idx] += s * (gain === undefined ? 0.6 : gain);
    }
  }

  /** Render one bar of the grid into a mono Float32Array. */
  function renderBar(bpm, grid) {
    var stepDur = 60 / bpm / 4;
    var total = Math.ceil(STEPS * stepDur * SR) + Math.floor(0.4 * SR);
    var buf = new Float32Array(total);

    for (var i = 0; i < STEPS; i++) {
      var at = i * stepDur;
      if (grid.kick[i]) hit(buf, at, 'kick', 0, 0.85);
      if (grid.snare[i]) hit(buf, at, 'snare', 0, 0.5);
      if (grid.hat[i]) hit(buf, at, 'hat', 0, 0.35);
      var noteIdx = grid.mel[i];
      if (noteIdx) hit(buf, at, 'mel', NOTES[noteIdx % NOTES.length].freq, 0.45);
    }

    for (var k = 0; k < buf.length; k++) buf[k] = Math.max(-1, Math.min(1, buf[k]));
    return buf;
  }

  /** Render `bars` repetitions of the grid so the export is a usable loop. */
  function renderSong(bpm, grid, bars) {
    bars = bars || 4;
    var one = renderBar(bpm, grid);
    var out = new Float32Array(one.length * bars);
    for (var b = 0; b < bars; b++) out.set(one, b * one.length);
    return out;
  }

  /** 16-bit PCM mono WAV container. */
  function encodeWav(samples, sampleRate) {
    var n = samples.length;
    var bytes = 44 + n * 2;
    var buf = new ArrayBuffer(bytes);
    var view = new DataView(buf);

    function str(off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    }

    str(0, 'RIFF');
    view.setUint32(4, bytes - 8, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, n * 2, true);

    var off = 44;
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Uint8Array(buf);
  }

  function toBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  // ------------------------------------------------------------- playback
  var ac = null;
  var timer = null;
  var nextTime = 0;
  var playStep = 0;

  function scheduler() {
    var stepDur = 60 / beat.bpm / 4;
    while (nextTime < ac.currentTime + 0.12) {
      schedule(playStep, nextTime);
      nextTime += stepDur;
      playStep = (playStep + 1) % STEPS;
    }
  }

  function schedule(i, when) {
    var g = beat.grid;
    if (g.kick[i]) beep(when, 'kick', 0);
    if (g.snare[i]) beep(when, 'snare', 0);
    if (g.hat[i]) beep(when, 'hat', 0);
    if (g.mel[i]) beep(when, 'mel', NOTES[g.mel[i] % NOTES.length].freq);
    paintStep(i);
  }

  function beep(when, kind, freq) {
    var dur = kind === 'kick' ? 0.22 : kind === 'snare' ? 0.14 : kind === 'hat' ? 0.05 : 0.3;
    if (kind === 'mel') {
      var o = ac.createOscillator();
      var g = ac.createGain();
      o.type = 'triangle';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.35, when + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      o.connect(g);
      g.connect(ac.destination);
      o.start(when);
      o.stop(when + dur + 0.02);
      return;
    }

    var buffer = ac.createBuffer(1, Math.floor(SR * dur), SR);
    hit(buffer.getChannelData(0), 0, kind, 0, 0.9);
    var src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(ac.destination);
    src.start(when);
  }

  function paintStep(i) {
    var cells = document.querySelectorAll('.step-col');
    for (var k = 0; k < cells.length; k++) cells[k].classList.remove('now');
    var active = document.querySelectorAll('[data-step="' + i + '"]');
    for (var j = 0; j < active.length; j++) active[j].classList.add('now');
  }

  function start() {
    if (beat.playing) return;
    try {
      ac = ac || new (GLOBAL.AudioContext || GLOBAL.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
    } catch (e) {
      status('audio not available');
      return;
    }
    beat.playing = true;
    playStep = 0;
    nextTime = ac.currentTime + 0.06;
    timer = setInterval(scheduler, 25);
    $('btn-play').textContent = '■ Stop';
  }

  function stop() {
    beat.playing = false;
    if (timer) clearInterval(timer);
    timer = null;
    $('btn-play').textContent = '▶ Play';
    paintStep(-1);
  }

  function status(msg) {
    var el = $('music-status');
    if (!el) return;
    el.textContent = msg;
    setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 2600);
  }

  function exportWav() {
    var samples = renderSong(beat.bpm, beat.grid, 4);
    var bytes = encodeWav(samples, SR);
    var b64 = toBase64(bytes);
    var name = 'darkagent-beat-' + Date.now() + '.wav';

    if (GLOBAL.Native && GLOBAL.Native.saveBase64) {
      try {
        var path = GLOBAL.Native.saveBase64(name, 'audio/wav', b64);
        status('saved: ' + path);
        return;
      } catch (e) { /* fall through */ }
    }

    var a = document.createElement('a');
    a.href = 'data:audio/wav;base64,' + b64;
    a.download = name;
    a.click();
    status('saved ' + name);
  }

  // ------------------------------------------------------------------- UI
  function buildGrid() {
    var wrap = $('music-grid');
    if (!wrap) return;
    wrap.innerHTML = '';

    TRACKS.forEach(function (track) {
      var row = document.createElement('div');
      row.className = 'track';

      var label = document.createElement('span');
      label.className = 'track-label';
      label.textContent = track;
      row.appendChild(label);

      for (var i = 0; i < STEPS; i++) {
        (function (step) {
          var cell = document.createElement('button');
          cell.className = 'step step-col';
          cell.setAttribute('data-step', step);
          cell.setAttribute('data-track', track);
          if (step % 4 === 0) cell.classList.add('beat');

          function paint() {
            var v = beat.grid[track][step];
            cell.classList.toggle('on', !!v);
            cell.textContent = track === 'mel' ? NOTES[v % NOTES.length].label : '';
          }

          cell.onclick = function () {
            if (track === 'mel') {
              beat.grid.mel[step] = (beat.grid.mel[step] + 1) % NOTES.length;
            } else {
              beat.grid[track][step] = beat.grid[track][step] ? 0 : 1;
            }
            paint();
            save();
          };

          paint();
          row.appendChild(cell);
        })(i);
      }
      wrap.appendChild(row);
    });
  }

  function wire() {
    if (!$('music-grid')) return;
    load();
    buildGrid();

    $('btn-play').onclick = function () { beat.playing ? stop() : start(); };
    $('btn-clear').onclick = function () {
      beat.grid = emptyGrid();
      save();
      buildGrid();
      status('cleared');
    };
    $('btn-wav').onclick = exportWav;

    var bpm = $('music-bpm');
    bpm.value = beat.bpm;
    bpm.oninput = function () {
      beat.bpm = Number(this.value);
      $('bpm-label').textContent = beat.bpm + ' BPM';
      save();
    };
    $('bpm-label').textContent = beat.bpm + ' BPM';

    $('btn-demo').onclick = function () {
      var g = emptyGrid();
      [0, 4, 8, 12].forEach(function (i) { g.kick[i] = 1; });
      [4, 12].forEach(function (i) { g.snare[i] = 1; });
      [0, 2, 6, 10, 14].forEach(function (i) { g.hat[i] = 1; });
      [0, 3, 6, 8, 11, 14].forEach(function (i) { g.mel[i] = 2 + (i % 3); });
      beat.grid = g;
      save();
      buildGrid();
      status('demo beat loaded — Play dabao');
    };
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  var api = {
    renderBar: renderBar,
    renderSong: renderSong,
    encodeWav: encodeWav,
    toBase64: toBase64,
    NOTES: NOTES,
    TRACKS: TRACKS,
    emptyGrid: emptyGrid,
    stop: function () { if (beat.playing) stop(); },
    bpm: function () { return beat.bpm; },
    grid: function () { return beat.grid; }
  };
  GLOBAL.DarkMusic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
