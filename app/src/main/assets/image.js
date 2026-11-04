/* DARK AGENT — image editor
 * Canvas based: filters, rotate/flip, brush, text, PNG export.
 */
(function () {
  'use strict';

  var GLOBAL = typeof window !== 'undefined' ? window : globalThis;

  var img = null;
  var state = { rotate: 0, flipH: false, flipV: false, brightness: 100, contrast: 100, saturate: 100, blur: 0 };
  var strokes = [];
  var texts = [];
  var draft = null;
  var undoStack = [];
  var brush = { color: '#7c5cff', size: 6, on: false };

  function $(id) { return document.getElementById(id); }

  function hasImage() { return !!img; }

  function pushUndo() {
    undoStack.push(JSON.stringify({ state: state, strokes: strokes, texts: texts }));
    if (undoStack.length > 12) undoStack.shift();
  }

  function undo() {
    var last = undoStack.pop();
    if (!last) return false;
    var d = JSON.parse(last);
    state = d.state; strokes = d.strokes; texts = d.texts;
    syncInputs();
    render();
    return true;
  }

  function syncInputs() {
    $('i-bright').value = state.brightness;
    $('i-contrast').value = state.contrast;
    $('i-saturate').value = state.saturate;
    $('i-blur').value = state.blur;
  }

  function render() {
    var c = $('img-canvas');
    var ctx = c.getContext('2d');
    if (!img) return;

    var rot = ((state.rotate % 360) + 360) % 360;
    var swap = rot === 90 || rot === 270;
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;

    var maxSide = 1400;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);

    c.width = swap ? h : w;
    c.height = swap ? w : h;

    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.filter = 'brightness(' + state.brightness + '%) contrast(' + state.contrast +
      '%) saturate(' + state.saturate + '%) blur(' + state.blur + 'px)';
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(rot * Math.PI / 180);
    if (state.flipH) ctx.scale(-1, 1);
    if (state.flipV) ctx.scale(1, -1);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();

    ctx.filter = 'none';
    var all = draft ? strokes.concat([draft]) : strokes;
    for (var i = 0; i < all.length; i++) drawStroke(ctx, all[i], c.width, c.height);

    for (var t = 0; t < texts.length; t++) {
      var tx = texts[t];
      ctx.font = 'bold ' + Math.round(tx.size * c.height) + 'px system-ui, sans-serif';
      ctx.fillStyle = tx.color;
      ctx.textBaseline = 'top';
      ctx.fillText(tx.value, tx.x * c.width, tx.y * c.height);
    }
  }

  function drawStroke(ctx, stroke, W, H) {
    if (!stroke.points.length) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(1, stroke.size);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    var p0 = stroke.points[0];
    ctx.moveTo(p0.x * W, p0.y * H);
    for (var i = 1; i < stroke.points.length; i++) {
      var p = stroke.points[i];
      ctx.lineTo(p.x * W, p.y * H);
    }
    if (stroke.points.length === 1) ctx.lineTo(p0.x * W + 0.1, p0.y * H);
    ctx.stroke();
  }

  function pos(ev) {
    var c = $('img-canvas');
    var r = c.getBoundingClientRect();
    var x = (ev.clientX - r.left) / r.width;
    var y = (ev.clientY - r.top) / r.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  function loadFile(file) {
    if (!file) return;
    var url = URL.createObjectURL(file);
    var im = new Image();
    im.onload = function () {
      img = im;
      strokes = [];
      texts = [];
      undoStack = [];
      state = { rotate: 0, flipH: false, flipV: false, brightness: 100, contrast: 100, saturate: 100, blur: 0 };
      syncInputs();
      render();
      $('img-empty').classList.add('hidden');
      $('img-canvas').classList.remove('hidden');
      $('img-tools').classList.remove('hidden');
      URL.revokeObjectURL(url);
    };
    im.onerror = function () { alert('Image load nahi hui'); };
    im.src = url;
  }

  function save() {
    if (!img) return;
    var c = $('img-canvas');
    var data = c.toDataURL('image/png').split(',')[1];
    var name = 'darkagent-' + Date.now() + '.png';
    if (GLOBAL.Native && GLOBAL.Native.saveBase64) {
      try {
        var path = GLOBAL.Native.saveBase64(name, 'image/png', data);
        toast('saved: ' + path);
        return;
      } catch (e) { /* fall through */ }
    }
    var a = document.createElement('a');
    a.href = 'data:image/png;base64,' + data;
    a.download = name;
    a.click();
    toast('saved');
  }

  function toast(msg) {
    var el = $('img-status');
    if (!el) return;
    el.textContent = msg;
    setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 2500);
  }

  function wire() {
    if (!$('img-canvas')) return;

    $('img-pick').onchange = function () { loadFile(this.files && this.files[0]); };
    $('img-save').onclick = save;
    $('img-undo').onclick = function () { if (!undo()) toast('nothing to undo'); };

    $('img-rotate').onclick = function () {
      if (!img) return;
      pushUndo();
      state.rotate = (state.rotate + 90) % 360;
      render();
    };
    $('img-flip').onclick = function () {
      if (!img) return;
      pushUndo();
      state.flipH = !state.flipH;
      render();
    };
    $('img-flipv').onclick = function () {
      if (!img) return;
      pushUndo();
      state.flipV = !state.flipV;
      render();
    };

    ['bright', 'contrast', 'saturate', 'blur'].forEach(function (k) {
      var el = $('i-' + k);
      el.oninput = function () {
        state[k] = Number(el.value);
        render();
      };
      el.onchange = function () { pushUndo(); };
    });

    $('i-brush').oninput = function () { brush.size = Number(this.value); };

    $('i-brush-on').onclick = function () {
      brush.on = !brush.on;
      this.classList.toggle('on', brush.on);
      toast(brush.on ? 'brush on — canvas pe draw karo' : 'brush off');
    };

    $('img-text-add').onclick = function () {
      var input = $('img-text');
      var value = input.value.trim();
      if (!value || !img) return;
      pushUndo();
      texts.push({ value: value, x: 0.06, y: 0.06 + texts.length * 0.09, size: 0.05, color: '#ffffff' });
      input.value = '';
      render();
    };

    var c = $('img-canvas');
    function down(ev) {
      if (!img || !brush.on) return;
      ev.preventDefault();
      pushUndo();
      draft = { color: brush.color, size: brush.size, points: [pos(ev)] };
      render();
    }
    function move(ev) {
      if (!draft) return;
      ev.preventDefault();
      draft.points.push(pos(ev));
      render();
    }
    function up() {
      if (!draft) return;
      strokes.push(draft);
      draft = null;
      render();
    }

    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', up);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  GLOBAL.DarkImage = { hasImage: hasImage, render: render, loadFile: loadFile, save: save };
})();
