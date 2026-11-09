/* ============================================================
   app.js — SVG 编辑器交互层
   ============================================================ */
(function () {
  'use strict';
  const C = window.Core;
  if (!C) { alert('核心模块加载失败'); return; }
  const SVGNS = C.NS;
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  const clamp = C.clamp, num = C.num, fmt = C.fmt;

  /* ---------------- 全局状态 ---------------- */
  const state = {
    doc: C.normalizeDoc(C.demoDoc()),
    selection: [],
    tool: 'select',
    zoom: 1, panX: 0, panY: 0, viewW: 1200, viewH: 800,
    showGrid: true, snapGrid: true, lockRatio: false,
    history: [], historyIndex: -1,
    clipboard: null,
    drag: null,
    spaceDown: false,
    penPoints: [],
    pencilPoints: [],
    hoverId: null,
    lastPointer: { x: 0, y: 0 },
    pendingImage: null,
    editing: false, editStart: null
  };
  const DEFAULT_STYLE = C.defaultStyle('rect');
  const TOOL_NAMES = {
    select: '选择', pan: '平移', rect: '矩形', ellipse: '椭圆', line: '直线',
    arrow: '箭头', pen: '折线', pencil: '画笔', text: '文本', image: '图片'
  };

  const canvas = $('#canvas');
  const scene = $('#scene');
  const overlay = $('#overlay');
  const stage = $('#canvasStage');
  const pageBg = $('#pageBg');
  const pageShadow = $('#pageShadow');
  const gridOverlay = $('#gridOverlay');

  /* ---------------- 通用 UI ---------------- */
  let toastTimer = [];
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('#toastStack').appendChild(el);
    const t = setTimeout(() => { el.remove(); }, 2600);
    toastTimer.push(t);
  }
  function setHint(text) { $('#statusHint').textContent = text; }
  let tipTimer = null;
  function canvasTip(text, ms) {
    const el = $('#canvasTip');
    el.textContent = text; el.classList.add('show');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => el.classList.remove('show'), ms || 1600);
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in (attrs || {})) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ---------------- 视图 / 坐标 ---------------- */
  function viewBox() { return { x: state.panX, y: state.panY, w: state.viewW, h: state.viewH }; }
  // viewW / viewH 用「屏幕像素」表示：viewBox 与 stage 完全等比例，坐标换算简单可靠
  function setViewBox(v) {
    state.panX = v.x; state.panY = v.y; state.viewW = v.w; state.viewH = v.h;
    canvas.setAttribute('viewBox', [v.x, v.y, v.w, v.h].map(fmt).join(' '));
    const pct = Math.round(state.zoom * 100);
    $('#zoomLabel').textContent = pct + '%';
    $('#statusZoom').textContent = pct + '%';
    renderOverlay();
  }
  function stageSize() {
    const r = stage.getBoundingClientRect();
    return { w: r.width || 1000, h: r.height || 600, left: r.left, top: r.top };
  }
  function setZoom(z, center) {
    const s = stageSize();
    const v = viewBox();
    const c = center || { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    const nz = clamp(z, .1, 8);
    const nw = s.w / nz, nh = s.h / nz;
    const tx = (c.x - v.x) / v.w, ty = (c.y - v.y) / v.h;
    state.zoom = nz;
    setViewBox({ x: c.x - tx * nw, y: c.y - ty * nh, w: nw, h: nh });
  }
  function clientToSvg(ev) {
    const s = stageSize();
    return {
      x: state.panX + (ev.clientX - s.left) / state.zoom,
      y: state.panY + (ev.clientY - s.top) / state.zoom
    };
  }
  function svgToClient(p) {
    const s = stageSize();
    return { x: s.left + (p.x - state.panX) * state.zoom, y: s.top + (p.y - state.panY) * state.zoom };
  }
  function fitView() {
    const d = state.doc, s = stageSize();
    const z = Math.min((s.w - 56) / d.width, (s.h - 56) / d.height);
    const nz = clamp(z, .1, 8);
    state.zoom = nz;
    setViewBox({
      x: (d.width - s.w / nz) / 2, y: (d.height - s.h / nz) / 2,
      w: s.w / nz, h: s.h / nz
    });
  }
  function zoomAt(factor, center) { setZoom(state.zoom * factor, center); }
  function zoomTo100() {
    const v = viewBox();
    setZoom(1, { x: v.x + v.w / 2, y: v.y + v.h / 2 });
  }
  function snap(v, gridSize) {
    if (!state.snapGrid) return v;
    const g = gridSize || 10;
    return Math.round(v / g) * g;
  }
  function snapPoint(p, skipGrid) {
    // 吸附到画布关键点 + 网格
    let x = p.x, y = p.y;
    const d = state.doc;
    const guidesX = [0, d.width / 2, d.width], guidesY = [0, d.height / 2, d.height];
    if (state.selection.length) {
      const b = C.bboxOfNodes(state.selection);
      if (b) guidesX.push(b.x, b.x + b.w / 2, b.x + b.w);
      if (b) guidesY.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    const th = 6 / Math.max(state.zoom, .1);
    let bestX = null, bestY = null;
    for (const g of guidesX) if (Math.abs(x - g) < th) { bestX = g; break; }
    for (const g of guidesY) if (Math.abs(y - g) < th) { bestY = g; break; }
    if (!skipGrid) {
      if (bestX == null) x = snap(x, 10); else x = bestX;
      if (bestY == null) y = snap(y, 10); else y = bestY;
    } else { if (bestX != null) x = bestX; if (bestY != null) y = bestY; }
    return { x: x, y: y };
  }

  /* ---------------- 文档渲染 ---------------- */
  function renderScene() {
    scene.textContent = '';
    const frag = document.createDocumentFragment();
    for (const n of state.doc.nodes) {
      if (!n.visible) continue;
      const str = C.serializeElement(n, { editorIds: true });
      let node;
      try {
        const doc = new DOMParser().parseFromString(
          '<svg xmlns="' + SVGNS + '">' + str + '</svg>', 'image/svg+xml');
        const parsed = doc.documentElement.firstElementChild;
        node = document.importNode(parsed, true);
      } catch (e) {
        // 兜底：用 createElementNS 包裹（理论不会走到这里）
        node = document.createElementNS(SVGNS, 'g');
        node.setAttribute('data-id', n.id);
        node.innerHTML = str;
      }
      frag.appendChild(node);
    }
    scene.appendChild(frag);
    renderOverlay();
    renderLayers();
    renderInspector();
    updateStatus();
  }
  function renderPage() {
    const d = state.doc;
    [pageShadow, pageBg, gridOverlay].forEach(el => {
      el.setAttribute('width', d.width); el.setAttribute('height', d.height);
      el.setAttribute('x', 0); el.setAttribute('y', 0);
    });
    pageShadow.setAttribute('x', 6); pageShadow.setAttribute('y', 6);
    $('#sizeLabel').textContent = fmt(d.width) + ' × ' + fmt(d.height);
    pageBg.style.fill = d.transparent ? 'url(#checker)' : d.background;
    // 透明棋盘格
    let checker = $('#checker');
    if (!checker) {
      checker = svgEl('pattern', { id: 'checker', width: 16, height: 16, patternUnits: 'userSpaceOnUse' });
      checker.appendChild(svgEl('rect', { width: 16, height: 16, fill: '#ffffff' }));
      checker.appendChild(svgEl('rect', { width: 8, height: 8, fill: '#e9eef6' }));
      checker.appendChild(svgEl('rect', { x: 8, y: 8, width: 8, height: 8, fill: '#e9eef6' }));
      $('#canvasDefs').appendChild(checker);
    }
  }

  /* ---------------- 选中框与控制点 ---------------- */
  function handleSize() { return 8 / clamp(state.zoom, .15, 8); }
  function renderOverlay() {
    overlay.textContent = '';
    const sel = selectedNodes();
    if (!sel.length && !state.drag && !state.penPoints.length && !state.pencilPoints.length) return;
    const d = state.drag;
    if (d && d.type === 'marquee' && d.box) {
      const b = d.box;
      overlay.appendChild(svgEl('rect', { class: 'marquee', x: b.x, y: b.y, width: Math.max(0, b.w), height: Math.max(0, b.h) }));
    }
    if (d && d.type === 'draw' && d.preview) {
      const p = d.preview;
      let el = null;
      if (p.type === 'rect') el = svgEl('rect', { class: 'preview-shape', x: p.x, y: p.y, width: p.w, height: p.h, rx: p.rx || 0 });
      else if (p.type === 'ellipse') el = svgEl('ellipse', { class: 'preview-shape', cx: p.x + p.w / 2, cy: p.y + p.h / 2, rx: p.w / 2, ry: p.h / 2 });
      else if (p.type === 'line' || p.type === 'arrow') el = svgEl('line', { class: 'preview-shape', x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 });
      if (el) overlay.appendChild(el);
      // 尺寸标签
      const txt = (p.type === 'rect' || p.type === 'ellipse')
        ? fmt(Math.round(p.w)) + ' × ' + fmt(Math.round(p.h))
        : fmt(Math.round(Math.hypot(p.x2 - p.x1, p.y2 - p.y1)));
      const bx = (p.type === 'rect' || p.type === 'ellipse') ? p.x + p.w / 2 : (p.x1 + p.x2) / 2;
      const by = (p.type === 'rect' || p.type === 'ellipse') ? p.y + p.h + 18 / state.zoom : (p.y1 + p.y2) / 2 - 14 / state.zoom;
      const badge = svgEl('g', {});
      const tw = Math.max(56, txt.length * 7) / state.zoom;
      const th = 20 / state.zoom;
      badge.appendChild(svgEl('rect', { class: 'size-badge', x: bx - tw / 2, y: by - th / 2, width: tw, height: th, rx: 3 / state.zoom }));
      const t = svgEl('text', { class: 'size-text', x: bx, y: by });
      t.setAttribute('font-size', 11 / state.zoom);
      t.textContent = txt;
      badge.appendChild(t);
      overlay.appendChild(badge);
    }
    if (state.penPoints.length || state.pencilPoints.length) {
      const pts = state.penPoints.length ? state.penPoints : state.pencilPoints;
      const dstr = 'M' + pts.map(p => fmt(p.x) + ' ' + fmt(p.y)).join(' L');
      overlay.appendChild(svgEl('path', { class: 'pen-line', d: dstr }));
      pts.forEach((p, i) => overlay.appendChild(svgEl('circle', {
        class: 'pen-dot', cx: p.x, cy: p.y, r: (state.penPoints.length && i === 0 ? 5 : 3.5) / state.zoom
      })));
      if (state.penPoints.length && state.lastPointer) {
        overlay.appendChild(svgEl('line', {
          class: 'pen-line', x1: pts[pts.length - 1].x, y1: pts[pts.length - 1].y,
          x2: state.lastPointer.x, y2: state.lastPointer.y, 'stroke-dasharray': '4 3'
        }));
      }
    }
    if (!sel.length) return;

    // 每个对象虚线轮廓
    for (const n of sel) {
      const b = C.bbox(n, true);
      const r = svgEl('rect', { class: 'sel-outline', x: b.x, y: b.y, width: b.w, height: b.h });
      if (n.rotation && n.type !== 'group') {
        r.setAttribute('transform', 'rotate(' + fmt(n.rotation) + ' ' + fmt(C.center(n).x) + ' ' + fmt(C.center(n).y) + ')');
      }
      overlay.appendChild(r);
    }
    const box = C.bboxOfNodes(sel);
    if (!box) return;
    overlay.appendChild(svgEl('rect', { class: 'sel-frame', x: box.x, y: box.y, width: box.w, height: box.h }));
    const hs = handleSize();
    const handles = [
      ['nw', box.x, box.y], ['n', box.x + box.w / 2, box.y], ['ne', box.x + box.w, box.y],
      ['e', box.x + box.w, box.y + box.h / 2], ['se', box.x + box.w, box.y + box.h],
      ['s', box.x + box.w / 2, box.y + box.h], ['sw', box.x, box.y + box.h],
      ['w', box.x, box.y + box.h / 2]
    ];
    for (const [name, x, y] of handles) {
      const r = svgEl('rect', {
        class: 'handle handle-' + name, 'data-handle': name,
        x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, rx: hs * .16
      });
      overlay.appendChild(r);
    }
    const rotY = box.y - 26 / clamp(state.zoom, .15, 8);
    overlay.appendChild(svgEl('line', { class: 'rot-line', x1: box.x + box.w / 2, y1: box.y, x2: box.x + box.w / 2, y2: rotY }));
    overlay.appendChild(svgEl('circle', {
      class: 'handle-rot', 'data-handle': 'rot',
      cx: box.x + box.w / 2, cy: rotY, r: hs * .55
    }));
  }

  /* ---------------- 选择与历史 ---------------- */
  function selectedNodes() {
    return state.selection.map(id => {
      const f = C.findNode(state.doc.nodes, id);
      return f ? f.node : null;
    }).filter(Boolean);
  }
  function setSelection(ids) {
    state.selection = Array.from(new Set(ids.filter(id => !!C.findNode(state.doc.nodes, id))));
    renderScene();
  }
  function snapshot() { return JSON.stringify(state.doc); }
  function commit(label) {
    const s = snapshot();
    if (state.history[state.historyIndex] === s) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(s);
    if (state.history.length > 120) state.history.shift();
    state.historyIndex = state.history.length - 1;
    saveLocal();
    if (label) setHint(label);
  }
  function restore(s) {
    state.doc = C.normalizeDoc(JSON.parse(s));
    state.selection = state.selection.filter(id => !!C.findNode(state.doc.nodes, id));
    renderPage(); renderScene(); saveLocal();
  }
  function undo() {
    if (state.historyIndex <= 0) { toast('没有可撤销的操作'); return; }
    state.historyIndex--;
    restore(state.history[state.historyIndex]);
    toast('已撤销');
  }
  function redo() {
    if (state.historyIndex >= state.history.length - 1) { toast('没有可重做的操作'); return; }
    state.historyIndex++;
    restore(state.history[state.historyIndex]);
    toast('已重做');
  }
  function saveLocal() {
    try {
      localStorage.setItem('vector-studio-doc', JSON.stringify({ doc: state.doc, name: $('#docName').value }));
    } catch (e) { /* 忽略配额错误（例如大图片） */ }
  }
  function loadLocal() {
    try {
      const raw = localStorage.getItem('vector-studio-doc');
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !data.doc) return false;
      state.doc = C.normalizeDoc(data.doc);
      $('#docName').value = data.name || '未命名作品';
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- 属性面板 ---------------- */
  function currentStyle() {
    const sel = selectedNodes();
    if (!sel.length) return C.clone(DEFAULT_STYLE);
    const flat = [];
    C.eachNode(sel, n => { if (n.type !== 'group') flat.push(n); });
    if (!flat.length) return C.clone(DEFAULT_STYLE);
    return C.clone(flat[0].style);
  }
  function currentText() {
    const sel = selectedNodes().filter(n => n.type === 'text');
    return sel.length ? C.clone(sel[0].text) : C.defaultText();
  }
  let syncing = false;
  function renderInspector() {
    if (state.editing) { renderLayersSelection(); return; }
    syncing = true;
    const sel = selectedNodes();
    const box = sel.length ? C.bboxOfNodes(sel) : null;
    const one = sel.length === 1 ? sel[0] : null;
    const st = sel.length ? currentStyle() : C.clone(DEFAULT_STYLE);
    const t = currentText();
    const disabled = !sel.length;

    $('#selCount').textContent = sel.length === 0 ? '未选中' : (sel.length === 1 ? (one.name || C.nameOf(one.type)) : '已选 ' + sel.length + ' 项');
    setField('x', box ? C.round(box.x, 1) : 0, disabled);
    setField('y', box ? C.round(box.y, 1) : 0, disabled);
    setField('w', box ? C.round(box.w, 1) : 0, disabled);
    setField('h', box ? C.round(box.h, 1) : 0, disabled);
    setField('rotation', one ? C.round(one.rotation || 0, 1) : 0, disabled);
    setField('opacity', st.opacity == null ? 1 : C.round(st.opacity, 2), disabled);
    setField('fill', st.fill, disabled);
    setField('stroke', st.stroke, disabled);
    setField('strokeWidth', st.strokeWidth, disabled);
    setField('rx', C.round(num(st.rx, 0), 1), disabled);
    setField('linecap', st.linecap || 'butt', disabled);
    setField('arrow', st.arrow || 'none', disabled);
    setField('fontFamily', t.fontFamily, disabled);
    setField('fontSize', t.fontSize, disabled);
    setField('fontWeight', t.fontWeight, disabled);
    setField('fontStyle', t.fontStyle, disabled);
    setField('textAnchor', t.textAnchor, disabled);
    setField('pageW', state.doc.width, false);
    setField('pageH', state.doc.height, false);
    setField('background', state.doc.transparent ? 'none' : state.doc.background, false);
    setField('transparent', state.doc.transparent, false, true);
    const fc = $('[data-prop="fillColor"]'), sc = $('[data-prop="strokeColor"]'), bc = $('[data-prop="bgColor"]');
    fc.value = toHexInput(st.fill); sc.value = toHexInput(st.stroke);
    bc.value = toHexInput(state.doc.background);
    $('#chkLockRatio').checked = state.lockRatio;
    // 文本面板在非文本对象时仍可用于设置默认样式
    $$('[data-panel="appearance"] input, [data-panel="appearance"] select').forEach(el => { el.disabled = disabled; });
    $$('[data-panel="selection"] input').forEach(el => { el.disabled = disabled; });
    $$('[data-panel="text"] input, [data-panel="text"] select, [data-panel="text"] button').forEach(el => { el.disabled = disabled || !sel.some(n => n.type === 'text'); });
    $('#alignNote').textContent = sel.length >= 2 ? '已选 ' + sel.length + ' 个对象' : '选中 2 个以上对象';
    $$('.align-grid [data-align]').forEach(b => { b.disabled = sel.length < 2 && !['centerPage', 'distH', 'distV'].includes(b.dataset.align) ? true : false; });
    syncing = false;
    renderLayersSelection();
  }
  function setField(prop, value, disabled, isCheckbox) {
    const el = $('[data-prop="' + prop + '"]');
    if (!el) return;
    if (isCheckbox) el.checked = !!value; else el.value = value;
    if (disabled != null) el.disabled = disabled;
  }
  function toHexInput(v) {
    const h = C.cssColorToHex(v);
    return /^#[0-9a-f]{6}$/i.test(h) ? h : '#000000';
  }

  function applyStyleProp(key, value) {
    const sel = selectedNodes();
    if (!sel.length) { DEFAULT_STYLE[key] = value; return; }
    C.eachNode(sel, n => { if (n.type !== 'group') n.style[key] = value; });
    renderScene(); commit('已修改外观');
  }
  function applyTextProp(key, value) {
    const sel = selectedNodes().filter(n => n.type === 'text');
    if (!sel.length) return;
    sel.forEach(n => { n.text[key] = value; });
    renderScene(); commit('已修改文本');
  }
  function applyTransformProp(key, value) {
    const sel = selectedNodes();
    if (!sel.length) return;
    if (key === 'rotation') {
      for (const n of sel) n.rotation = value;
    } else if (key === 'opacity') {
      C.eachNode(sel, n => { if (n.type !== 'group') n.style.opacity = value; });
    } else if (key === 'x' || key === 'y') {
      const b = C.bboxOfNodes(sel);
      if (!b) return;
      const dx = key === 'x' ? value - b.x : 0, dy = key === 'y' ? value - b.y : 0;
      C.moveNodes(sel, dx, dy);
    } else if (key === 'w' || key === 'h') {
      const b = C.bboxOfNodes(sel);
      if (!b) return;
      let nw = key === 'w' ? value : b.w, nh = key === 'h' ? value : b.h;
      if (state.lockRatio) {
        if (key === 'w') nh = b.h * (nw / (b.w || 1)); else nw = b.w * (nh / (b.h || 1));
      }
      nw = Math.max(.1, nw); nh = Math.max(.1, nh);
      C.scaleNodes(sel, sel.map(C.clone), b, { x: b.x, y: b.y, w: nw, h: nh }, true);
    }
    renderScene(); commit('已修改变换');
  }

  /* ---------------- 图层列表 ---------------- */
  function renderLayers() {
    const list = $('#layerList');
    list.textContent = '';
    const nodes = state.doc.nodes;
    $('#layerCount').textContent = nodes.length + ' 个对象';
    if (!nodes.length) {
      const e = document.createElement('div');
      e.className = 'layer-empty'; e.textContent = '画布为空，试试画一个矩形吧';
      list.appendChild(e); return;
    }
    const iconFor = t => ({ rect: 'i-rect', ellipse: 'i-ellipse', line: 'i-line', arrow: 'i-arrow',
      polyline: 'i-pen', polygon: 'i-pen', pencil: 'i-pencil', text: 'i-text', image: 'i-image', group: 'i-group' })[t] || 'i-rect';
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const row = document.createElement('div');
      row.className = 'layer-item' + (state.selection.includes(n.id) ? ' selected' : '') + (!n.visible ? ' hidden-obj' : '');
      row.dataset.id = n.id;
      row.innerHTML =
        '<svg class="icon l-icon"><use href="#' + iconFor(n.type) + '"/></svg>' +
        '<span class="l-name"></span>' +
        '<button class="l-btn" data-laction="visible" title="显示 / 隐藏"><svg class="icon"><use href="#' + (n.visible ? 'i-eye' : 'i-eyeoff') + '"/></svg></button>' +
        '<button class="l-btn" data-laction="lock" title="锁定 / 解锁"><svg class="icon"><use href="#' + (n.locked ? 'i-lock' : 'i-unlock') + '"/></svg></button>';
      row.querySelector('.l-name').textContent = n.name || C.nameOf(n.type);
      list.appendChild(row);
    }
  }
  function renderLayersSelection() {
    $$('#layerList .layer-item').forEach(row => {
      row.classList.toggle('selected', state.selection.includes(row.dataset.id));
    });
  }

  function updateStatus() {
    const sel = selectedNodes();
    $('#statusTool').textContent = '工具：' + (TOOL_NAMES[state.tool] || state.tool);
    $('#statusSel').textContent = sel.length === 0 ? '未选中对象'
      : (sel.length === 1 ? '已选：' + (sel[0].name || C.nameOf(sel[0].type)) : '已选 ' + sel.length + ' 个对象');
  }

  /* ---------------- 工具 ---------------- */
  function setTool(tool) {
    if (state.penPoints.length) finishPen();
    state.tool = tool;
    $$('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    stage.className = 'canvas-stage tool-' + tool + (state.showGrid ? '' : ' grid-off');
    $('#statusTool').textContent = '工具：' + (TOOL_NAMES[tool] || tool);
    const tips = {
      rect: '拖动画出矩形 · Shift 正方形 · Alt 从中心', ellipse: '拖动画出椭圆 · Shift 正圆',
      line: '拖动画直线 · Shift 吸附 15°', arrow: '拖动画箭头 · Shift 吸附 15°',
      pen: '依次点击放置节点，双击 / 回车结束', pencil: '按住拖动自由绘制',
      text: '点击画布放置文本，随后可输入内容', image: '点击画布插入图片（或拖入图片文件）',
      pan: '拖动画布以平移', select: '点击选择 · 拖动移动 · 框选多选'
    };
    if (tips[tool]) setHint(tips[tool]);
  }
  function toggleGrid(on) {
    state.showGrid = on == null ? !state.showGrid : !!on;
    stage.classList.toggle('grid-off', !state.showGrid);
    $('#chkGrid').checked = state.showGrid;
  }

  /* ---------------- 创建 / 变换对象 ---------------- */
  function currentDrawStyle(type) {
    const s = C.defaultStyle(type);
    const cur = currentStyle();
    // 继承用户上次设置的填充、描边、线宽
    if (!state.selection.length) {
      for (const k of ['fill', 'stroke', 'strokeWidth', 'opacity', 'linecap', 'dash']) {
        if (DEFAULT_STYLE[k] !== undefined) s[k] = DEFAULT_STYLE[k];
      }
    } else {
      for (const k of ['fill', 'stroke', 'strokeWidth', 'opacity']) s[k] = cur[k];
    }
    if (C.LINE_TYPES.includes(type) || type === 'polyline' || type === 'pencil') {
      s.fill = 'none'; s.stroke = (cur.stroke && cur.stroke !== 'none' ? cur.stroke : '#243044');
    }
    if (type === 'text') { s.fill = '#243044'; s.stroke = 'none'; s.strokeWidth = 0; }
    return s;
  }
  function addNode(n, select) {
    state.doc.nodes.push(n);
    if (select !== false) state.selection = [n.id];
    renderScene(); commit('已创建' + C.nameOf(n.type));
    return n;
  }
  function createFromDraw(type, start, end, opts) {
    let x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
    let w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
    if (opts && opts.square) {
      const side = Math.max(w, h);
      x = start.x + (end.x < start.x ? -side : 0);
      y = start.y + (end.y < start.y ? -side : 0);
      w = side; h = side;
    }
    if (opts && opts.center) { x = start.x - w; y = start.y - h; w *= 2; h *= 2; }
    w = Math.max(w, type === 'line' || type === 'arrow' ? 0.1 : 2);
    h = Math.max(h, type === 'line' || type === 'arrow' ? 0.1 : 2);
    const n = C.create(type, { x: x, y: y, w: w, h: h }, { style: currentDrawStyle(type) });
    n.style.arrow = type === 'arrow' ? 'end' : 'none';
    if (C.LINE_TYPES.includes(type)) {
      n.dirX = end.x >= start.x ? 1 : -1;
      n.dirY = end.y >= start.y ? 1 : -1;
    }
    return n;
  }
  function finishPen(close) {
    const pts = state.penPoints.slice();
    state.penPoints = [];
    if (pts.length < 2) { renderOverlay(); return; }
    const b = C.boundsOfPoints(pts);
    const w = Math.max(b.w, 1), h = Math.max(b.h, 1);
    const n = C.create(close ? 'polygon' : 'polyline', { x: b.x, y: b.y, w: w, h: h }, {
      style: currentDrawStyle(close ? 'polygon' : 'polyline'),
      points: pts.map(p => [(p.x - b.x) / w, (p.y - b.y) / h])
    });
    if (close) n.style.fill = DEFAULT_STYLE.fill || '#4f8cff';
    state.doc.nodes.push(n);
    setSelection([n.id]);
    renderScene(); commit('已完成' + C.nameOf(n.type));
    setTool('select');
  }
  function finishPencil() {
    const pts = simplify(state.pencilPoints, 1.2 / state.zoom);
    state.pencilPoints = [];
    if (pts.length < 2) { renderOverlay(); return; }
    const b = C.boundsOfPoints(pts);
    const w = Math.max(b.w, 1), h = Math.max(b.h, 1);
    const n = C.create('pencil', { x: b.x, y: b.y, w: w, h: h }, {
      style: currentDrawStyle('pencil'), smooth: true,
      points: pts.map(p => [(p.x - b.x) / w, (p.y - b.y) / h])
    });
    state.doc.nodes.push(n);
    setSelection([n.id]);
    renderScene(); commit('已完成画笔');
    setTool('select');
  }
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      const a = out[out.length - 1], b = pts[i + 1];
      if (Math.hypot(p.x - a.x, p.y - a.y) >= tol || C.distToSegment(p, a, b) > tol * 0.8) out.push(p);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /* ---------------- 命令 ---------------- */
  function deleteSelection() {
    if (!state.selection.length) return;
    const ids = new Set(state.selection);
    state.doc.nodes = state.doc.nodes.filter(n => !ids.has(n.id));
    state.selection = [];
    renderScene(); commit('已删除对象');
  }
  function duplicateSelection() {
    const sel = selectedNodes();
    if (!sel.length) return;
    const copies = sel.map(n => {
      const c = C.clone(n);
      const reassign = x => { x.id = C.uid(x.type); if (x.type === 'group') (x.children || []).forEach(reassign); };
      reassign(c);
      c.x += 20; c.y += 20;
      if (c.type === 'group') for (const ch of (c.children || [])) { ch.x += 20; ch.y += 20; }
      return c;
    });
    state.doc.nodes.push(...copies);
    setSelection(copies.map(c => c.id));
    commit('已再制 ' + copies.length + ' 个对象');
  }
  function copySelection(cut) {
    const sel = selectedNodes();
    if (!sel.length) return;
    state.clipboard = sel.map(C.clone);
    if (cut) deleteSelection(); else toast('已复制 ' + sel.length + ' 个对象');
  }
  function pasteSelection() {
    if (!state.clipboard || !state.clipboard.length) return;
    const copies = state.clipboard.map(n => {
      const c = C.clone(n);
      const reassign = x => { x.id = C.uid(x.type); if (x.type === 'group') (x.children || []).forEach(reassign); };
      reassign(c);
      c.x += 20; c.y += 20;
      if (c.type === 'group') for (const ch of (c.children || [])) { ch.x += 20; ch.y += 20; }
      return c;
    });
    state.doc.nodes.push(...copies);
    setSelection(copies.map(c => c.id));
    commit('已粘贴');
  }
  function reorder(mode) {
    const sel = selectedNodes();
    if (!sel.length) return;
    const ids = new Set(state.selection);
    const picked = state.doc.nodes.filter(n => ids.has(n.id));
    let rest = state.doc.nodes.filter(n => !ids.has(n.id));
    if (mode === 'front') state.doc.nodes = rest.concat(picked);
    else if (mode === 'back') state.doc.nodes = picked.concat(rest);
    else if (mode === 'up') {
      const arr = state.doc.nodes;
      for (let i = arr.length - 2; i >= 0; i--) if (ids.has(arr[i].id) && !ids.has(arr[i + 1].id)) { const t = arr[i]; arr[i] = arr[i + 1]; arr[i + 1] = t; }
    } else if (mode === 'down') {
      const arr = state.doc.nodes;
      for (let i = 1; i < arr.length; i++) if (ids.has(arr[i].id) && !ids.has(arr[i - 1].id)) { const t = arr[i]; arr[i] = arr[i - 1]; arr[i - 1] = t; }
    }
    renderScene(); commit('已调整图层顺序');
  }
  function groupSelection() {
    const sel = selectedNodes();
    if (sel.length < 2) { toast('请至少选择 2 个对象'); return; }
    const ids = new Set(state.selection);
    const picked = state.doc.nodes.filter(n => ids.has(n.id));
    const rest = state.doc.nodes.filter(n => !ids.has(n.id));
    const box = C.bboxOfNodes(picked) || { x: 0, y: 0, w: 10, h: 10 };
    const g = C.create('group', box, { children: picked });
    g.name = '组合 (' + picked.length + ')';
    state.doc.nodes = rest.concat([g]);
    setSelection([g.id]);
    commit('已组合');
  }
  function ungroupSelection() {
    const groups = selectedNodes().filter(n => n.type === 'group');
    if (!groups.length) { toast('请先选择一个组合'); return; }
    const ids = new Set(groups.map(n => n.id));
    const out = [];
    for (const n of state.doc.nodes) {
      if (ids.has(n.id)) out.push(...(n.children || []).map(C.clone));
      else out.push(n);
    }
    state.doc.nodes = out;
    state.selection = [];
    renderScene(); commit('已取消组合');
  }
  function flipSelection(axis) {
    const sel = selectedNodes();
    if (!sel.length) return;
    // 收集所有叶子节点（组合内的子节点展开）
    const leaves = [];
    (function collect(n) { if (n.type === 'group') n.children.forEach(collect); else leaves.push(n); })(sel);
    const b = C.bboxOfNodes(leaves);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    for (const lf of leaves) {
      const cb = C.bbox(lf);
      if (axis === 'h') { lf.flipX = (lf.flipX || 1) * -1; lf.x = 2 * cx - cb.x - cb.w; }
      else { lf.flipY = (lf.flipY || 1) * -1; lf.y = 2 * cy - cb.y - cb.h; }
    }
    renderScene(); commit('已翻转');
  }
  function alignSelection(mode) {
    const sel = selectedNodes();
    if (!sel.length) return;
    const boxes = sel.map(n => C.bbox(n, true));
    const all = C.union(boxes);
    const d = state.doc;
    const pageBox = { x: 0, y: 0, w: d.width, h: d.height };
    const target = mode === 'centerPage' ? pageBox : all;
    if (['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom', 'centerPage'].includes(mode)) {
      sel.forEach((n, i) => {
        const b = boxes[i];
        let dx = 0, dy = 0;
        if (mode === 'left') dx = all.x - b.x;
        else if (mode === 'hcenter') dx = all.x + all.w / 2 - (b.x + b.w / 2);
        else if (mode === 'right') dx = all.x + all.w - (b.x + b.w);
        else if (mode === 'top') dy = all.y - b.y;
        else if (mode === 'vcenter') dy = all.y + all.h / 2 - (b.y + b.h / 2);
        else if (mode === 'bottom') dy = all.y + all.h - (b.y + b.h);
        else if (mode === 'centerPage') {
          dx = target.x + target.w / 2 - (b.x + b.w / 2);
          dy = target.y + target.h / 2 - (b.y + b.h / 2);
        }
        C.moveNodes([n], dx, dy);
      });
    } else if (mode === 'distH' || mode === 'distV') {
      if (sel.length < 3) { toast('分布至少需要 3 个对象'); return; }
      const order = sel.map((n, i) => ({ n: n, b: boxes[i] }))
        .sort((a, b) => mode === 'distH' ? a.b.x - b.b.x : a.b.y - b.b.y);
      const first = order[0].b, last = order[order.length - 1].b;
      const totalLen = mode === 'distH' ? (last.x + last.w - first.x) : (last.y + last.h - first.y);
      const sumSize = order.reduce((s, o) => s + (mode === 'distH' ? o.b.w : o.b.h), 0);
      const gap = (totalLen - sumSize) / (order.length - 1);
      let cur = mode === 'distH' ? first.x : first.y;
      for (const o of order) {
        const b = o.b;
        const delta = cur - (mode === 'distH' ? b.x : b.y);
        C.moveNodes([o.n], mode === 'distH' ? delta : 0, mode === 'distV' ? delta : 0);
        cur += (mode === 'distH' ? b.w : b.h) + gap;
      }
    }
    renderScene(); commit('已对齐');
  }

  /* ---------------- 文本编辑 ---------------- */
  let textEditTarget = null;
  function openTextEditor(node, fresh) {
    if (!node || node.type !== 'text') return;
    state.editing = true;
    state.editStart = snapshot();
    textEditTarget = node.id;
    const layer = $('#textEditLayer');
    const ta = $('#textEditInput');
    layer.hidden = false;
    ta.value = fresh ? '' : (node.text.content || '');
    const b = C.bbox(node, false);
    const p = svgToClient({ x: b.x, y: b.y });
    const r = stage.getBoundingClientRect();
    const k = state.zoom;
    layer.style.left = (p.x - r.left) + 'px';
    layer.style.top = (p.y - r.top) + 'px';
    layer.style.width = Math.max(160, b.w * k) + 'px';
    layer.style.height = Math.max(44, b.h * k) + 'px';
    ta.style.fontSize = Math.max(12, num(node.text.fontSize, 24) * k) + 'px';
    ta.style.fontFamily = node.text.fontFamily;
    ta.style.textAlign = node.text.textAnchor === 'middle' ? 'center' : (node.text.textAnchor === 'end' ? 'right' : 'left');
    setTimeout(() => { ta.focus(); ta.select(); }, 10);
  }
  function closeTextEditor(save) {
    const layer = $('#textEditLayer');
    if (layer.hidden) return;
    const ta = $('#textEditInput');
    if (save && textEditTarget) {
      const f = C.findNode(state.doc.nodes, textEditTarget);
      if (f && f.node.type === 'text') {
        f.node.text.content = ta.value;
        const lines = ta.value.split('\n');
        const fs = num(f.node.text.fontSize, 24);
        const maxChars = Math.max.apply(null, lines.map(l => l.length).concat([1]));
        f.node.w = Math.max(20, maxChars * fs * 0.62);
        f.node.h = Math.max(fs * 1.25, lines.length * fs * (num(f.node.text.lineHeight, 1.25)));
      }
    }
    layer.hidden = true;
    textEditTarget = null;
    state.editing = false;
    renderScene();
    if (state.editStart && state.editStart !== snapshot()) commit('已编辑文本');
    state.editStart = null;
  }

  /* ---------------- 文件 / 导入导出 ---------------- */
  function serialize(opts) {
    return C.serializeDoc(state.doc, Object.assign({ title: $('#docName').value || '未命名作品' }, opts || {}));
  }
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function safeName() {
    return ($('#docName').value || '未命名作品').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名作品';
  }
  function exportSvg() {
    download(safeName() + '.svg', serialize(), 'image/svg+xml;charset=utf-8');
    toast('SVG 已导出', 'success');
  }
  function exportPng() {
    const d = state.doc;
    const scale = 2;
    const svgText = serialize({ metadata: false });
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = function () {
      const cv = document.createElement('canvas');
      cv.width = Math.round(d.width * scale); cv.height = Math.round(d.height * scale);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      try {
        cv.toBlob(b => {
          if (!b) { toast('PNG 导出失败', 'error'); return; }
          const u = URL.createObjectURL(b);
          const a = document.createElement('a');
          a.href = u; a.download = safeName() + '.png';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 3000);
          toast('PNG 已导出（2×）', 'success');
        }, 'image/png');
      } catch (e) { toast('PNG 导出被浏览器阻止，请尝试导出 SVG', 'error'); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('PNG 导出失败：SVG 内含无法加载的资源', 'error'); };
    img.src = url;
  }
  function openSvgText(text, filename) {
    try {
      const res = C.parseDoc(text);
      state.doc = res.doc;
      state.selection = [];
      state.history = []; state.historyIndex = -1;
      if (filename) $('#docName').value = filename.replace(/\.svg$/i, '');
      renderPage(); renderScene(); commit('已打开' + (res.restored ? '（完整可编辑）' : '') + ' SVG');
      fitView();
      toast('导入成功：' + state.doc.nodes.length + ' 个对象' + (res.restored ? '（保留可编辑属性）' : ''), 'success');
      if (res.warnings && res.warnings.length) toast(res.warnings[0]);
    } catch (e) {
      toast('导入失败：' + e.message, 'error');
    }
  }
  function readImageAsNode(file, pos) {
    const reader = new FileReader();
    reader.onload = function () {
      const dataUrl = reader.result;
      const img = new Image();
      img.onload = function () {
        const maxW = Math.min(520, state.doc.width * 0.7);
        const k = Math.min(1, maxW / img.width);
        const w = img.width * k, h = img.height * k;
        const n = C.create('image', {
          x: pos ? pos.x - w / 2 : state.doc.width / 2 - w / 2,
          y: pos ? pos.y - h / 2 : state.doc.height / 2 - h / 2,
          w: w, h: h
        }, { href: dataUrl });
        n.name = file.name || '图片';
        addNode(n);
        setTool('select');
        toast('图片已插入', 'success');
      };
      img.onerror = function () { toast('图片读取失败', 'error'); };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }
  function newDocument() {
    if (state.doc.nodes.length && !confirm('新建空白画布？当前未导出的内容会被清空（可用撤销恢复）。')) return;
    state.doc = C.normalizeDoc({ width: 1200, height: 800, background: '#ffffff', transparent: false, nodes: [] });
    state.selection = [];
    $('#docName').value = '未命名作品';
    renderPage(); renderScene(); commit('已新建画布'); fitView();
  }

  /* ---------------- 代码弹窗 ---------------- */
  function openCodeModal() {
    $('#codeText').value = serialize();
    $('#codeMsg').textContent = '';
    $('#codeModal').hidden = false;
  }
  function applyCode() {
    let text = $('#codeText').value;
    // 剥离内嵌的完整模型元数据，否则 parseDoc 会直接还原旧模型而忽略用户编辑
    text = text.replace(/<metadata id="svg-editor-model">[\s\S]*?<\/metadata>/i, '');
    try {
      const res = C.parseDoc(text);
      state.doc = res.doc; state.selection = [];
      renderPage(); renderScene(); commit('已应用源码');
      $('#codeModal').hidden = true;
      toast('源码已应用到画布', 'success');
    } catch (e) {
      $('#codeMsg').textContent = '解析失败：' + e.message;
    }
  }

  /* ---------------- 指针交互 ---------------- */
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  function onPointerDown(ev) {
    if (ev.button === 2) return;
    if (!$('#textEditLayer').hidden) closeTextEditor(true);
    const p = clientToSvg(ev);
    state.lastPointer = { x: p.x, y: p.y };
    const panMode = state.spaceDown || state.tool === 'pan' || ev.button === 1;
    canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId);

    if (panMode) {
      state.drag = { type: 'pan', startClient: { x: ev.clientX, y: ev.clientY }, view: viewBox() };
      stage.classList.add('panning');
      return;
    }

    // 绘制工具
    if (C.SHAPE_TYPES.includes(state.tool) && state.tool !== 'pen') {
      if (state.tool === 'pencil') {
        state.pencilPoints = [snapPoint(p, true)];
        state.drag = { type: 'pencil', path: [state.pencilPoints[0]] };
        renderOverlay(); return;
      }
      if (state.tool === 'text') {
        const n = C.create('text', { x: p.x, y: p.y, w: 220, h: 44 }, { style: currentDrawStyle('text') });
        addNode(n);
        openTextEditor(n, true);
        setTool('select');
        return;
      }
      if (state.tool === 'image') {
        state.pendingImage = { pos: p };
        $('#fileImage').click();
        return;
      }
      const sp = snapPoint(p);
      state.drag = {
        type: 'draw', tool: state.tool, start: sp, current: sp,
        shift: ev.shiftKey, alt: ev.altKey, preview: null
      };
      renderOverlay(); return;
    }
    if (state.tool === 'pen') {
      const sp = snapPoint(p, true);
      // 点击首点附近则闭合
      if (state.penPoints.length >= 3 && Math.hypot(sp.x - state.penPoints[0].x, sp.y - state.penPoints[0].y) < 10 / state.zoom) {
        finishPen(true); return;
      }
      state.penPoints.push(sp);
      renderOverlay(); return;
    }

    // 选择工具：先看控制点
    const handle = ev.target.closest ? ev.target.closest('[data-handle]') : null;
    if (handle && state.selection.length) {
      const h = handle.dataset.handle;
      const sel = selectedNodes();
      const box = C.bboxOfNodes(sel);
      state.drag = {
        type: h === 'rot' ? 'rotate' : 'resize', handle: h,
        start: p, box: box, originals: sel.map(C.clone), selIds: sel.map(n => n.id),
        shift: ev.shiftKey, alt: ev.altKey
      };
      return;
    }
    // 命中对象
    let hit = null;
    const tolPx = 6;
    const tol = tolPx / Math.max(state.zoom, .1);
    for (let i = state.doc.nodes.length - 1; i >= 0; i--) {
      const n = state.doc.nodes[i];
      if (!n.visible || n.locked) continue;
      if (C.hitTest(n, p, tol)) { hit = n; break; }
    }
    if (hit) {
      if (ev.shiftKey) {
        const has = state.selection.includes(hit.id);
        state.selection = has ? state.selection.filter(id => id !== hit.id) : state.selection.concat([hit.id]);
      } else if (!state.selection.includes(hit.id)) {
        state.selection = [hit.id];
      }
      renderScene();
      if (state.selection.length) {
        const sel = selectedNodes().filter(n => !n.locked);
        if (sel.length) {
          state.drag = {
            type: 'move', start: p, originals: sel.map(C.clone), selIds: sel.map(n => n.id),
            didMove: false, shift: ev.shiftKey
          };
        }
      }
    } else {
      if (!ev.shiftKey) state.selection = [];
      state.drag = { type: 'marquee', start: p, box: { x: p.x, y: p.y, w: 0, h: 0 }, base: state.selection.slice() };
      renderScene();
    }
  }

  function onPointerMove(ev) {
    const p = clientToSvg(ev);
    state.lastPointer = { x: p.x, y: p.y };
    $('#statusPos').textContent = 'X ' + Math.round(p.x) + ' · Y ' + Math.round(p.y);
    const d = state.drag;
    if (!d) {
      if (state.penPoints.length) renderOverlay();
      return;
    }
    if (d.type === 'pan') {
      const v = d.view;
      setViewBox({
        x: v.x - (ev.clientX - d.startClient.x) / state.zoom,
        y: v.y - (ev.clientY - d.startClient.y) / state.zoom,
        w: v.w, h: v.h
      });
      return;
    }
    if (d.type === 'pencil') {
      const q = { x: p.x, y: p.y };
      const last = d.path[d.path.length - 1];
      if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1.5 / state.zoom) {
        d.path.push(q); state.pencilPoints = d.path; renderOverlay();
      }
      return;
    }
    if (d.type === 'draw') {
      let end = snapPoint(p);
      const shift = ev.shiftKey, alt = ev.altKey;
      if (shift && (d.tool === 'line' || d.tool === 'arrow')) {
        const dx = end.x - d.start.x, dy = end.y - d.start.y;
        const a = Math.atan2(dy, dx);
        const snapped = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        const len = Math.hypot(dx, dy);
        end = { x: d.start.x + Math.cos(snapped) * len, y: d.start.y + Math.sin(snapped) * len };
      }
      const square = shift && (d.tool === 'rect' || d.tool === 'ellipse');
      const tmp = createFromDraw(d.tool, d.start, end, { square: square, center: alt });
      d.preview = {
        type: d.tool, x: tmp.x, y: tmp.y, w: tmp.w, h: tmp.h,
        x1: C.lineEnds(tmp)[0].x, y1: C.lineEnds(tmp)[0].y,
        x2: C.lineEnds(tmp)[1].x, y2: C.lineEnds(tmp)[1].y
      };
      if (d.tool === 'line' || d.tool === 'arrow') {
        d.preview.x1 = alt ? d.start.x - (end.x - d.start.x) : d.start.x;
        d.preview.y1 = alt ? d.start.y - (end.y - d.start.y) : d.start.y;
        d.preview.x2 = end.x; d.preview.y2 = end.y;
      }
      renderOverlay(); return;
    }
    if (d.type === 'marquee') {
      d.box = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
      renderOverlay(); return;
    }
    if (d.type === 'move') {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      const ns = selectedNodes();
      if (ns.length && d.originals.length) {
        const origBox = C.bboxOfNodes(d.originals);
        if (state.snapGrid) {
          const cand = { x: origBox.x + dx, y: origBox.y + dy };
          const snapped = snapPoint(cand, true);
          if (Math.abs(snapped.x - cand.x) < 6 / state.zoom) dx += snapped.x - cand.x;
          if (Math.abs(snapped.y - cand.y) < 6 / state.zoom) dy += snapped.y - cand.y;
        }
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        d.originals.forEach((src, i) => { Object.assign(ns[i], C.clone(src)); });
        C.moveNodes(ns, dx, dy);
        if (Math.abs(dx) + Math.abs(dy) > .01) d.didMove = true;
        renderScene();
      }
      return;
    }
    if (d.type === 'resize') {
      resizeDrag(d, p, ev);
      return;
    }
    if (d.type === 'rotate') {
      const pivot = { x: d.box.x + d.box.w / 2, y: d.box.y + d.box.h / 2 };
      let a = Math.atan2(p.y - pivot.y, p.x - pivot.x) - Math.atan2(d.start.y - pivot.y, d.start.x - pivot.x);
      let degv = C.deg(a);
      if (ev.shiftKey) degv = Math.round(degv / 15) * 15;
      const ns = selectedNodes();
      C.setRotationAround(ns, d.originals, degv, pivot);
      renderScene();
      return;
    }
  }

  function resizeDrag(d, p, ev) {
    const h = d.handle, b = d.box;
    let L = b.x, T = b.y, R = b.x + b.w, B = b.y + b.h;
    let q = snapPoint(p, true);
    if (h.includes('w')) L = Math.min(q.x, R - 2);
    if (h.includes('e')) R = Math.max(q.x, L + 2);
    if (h.includes('n')) T = Math.min(q.y, B - 2);
    if (h.includes('s')) B = Math.max(q.y, T + 2);
    let nw = R - L, nh = B - T;
    const ratio = b.w / (b.h || 1);
    const locked = ev.shiftKey || state.lockRatio;
    if (locked && h.length === 2) {
      if (nw / (nh || 1) > ratio) { nw = nh * ratio; if (h.includes('w')) L = R - nw; }
      else { nh = nw / ratio; if (h.includes('n')) T = B - nh; }
    }
    if (ev.altKey && h.length === 2) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const oldW = b.w, oldH = b.h;
      nw = Math.abs(q.x - cx) * 2; nh = Math.abs(q.y - cy) * 2;
      if (locked) { const k = Math.max(nw / oldW, nh / oldH); nw = oldW * k; nh = oldH * k; }
      L = cx - nw / 2; T = cy - nh / 2;
    }
    const newBox = { x: L, y: T, w: Math.max(.1, nw), h: Math.max(.1, nh) };
    const ns = selectedNodes();
    C.scaleNodes(ns, d.originals, b, newBox, true);
    renderScene();
  }

  function onPointerUp(ev) {
    const d = state.drag;
    stage.classList.remove('panning');
    if (!d) return;
    state.drag = null;
    if (d.type === 'draw') {
      const p = clientToSvg(ev);
      let end = snapPoint(p);
      if (ev.shiftKey && (d.tool === 'line' || d.tool === 'arrow')) {
        const dx = end.x - d.start.x, dy = end.y - d.start.y;
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        const len = Math.hypot(dx, dy);
        end = { x: d.start.x + Math.cos(a) * len, y: d.start.y + Math.sin(a) * len };
      }
      const start = d.start;
      if ((d.tool === 'line' || d.tool === 'arrow') && ev.altKey) {
        start.x = d.start.x - (end.x - d.start.x);
        start.y = d.start.y - (end.y - d.start.y);
      }
      const n = createFromDraw(d.tool, start, end, {
        square: ev.shiftKey && (d.tool === 'rect' || d.tool === 'ellipse'),
        center: ev.altKey && (d.tool === 'rect' || d.tool === 'ellipse')
      });
      if (Math.abs(end.x - start.x) < 2 && Math.abs(end.y - start.y) < 2 && !C.LINE_TYPES.includes(d.tool)) {
        // 单击时放置默认尺寸
        n.x = start.x; n.y = start.y; n.w = 160; n.h = 100;
      }
      addNode(n);
      setTool('select');
    } else if (d.type === 'pencil') {
      finishPencil();
    } else if (d.type === 'marquee') {
      if (d.box && d.box.w > 3 && d.box.h > 3) {
        const ids = state.doc.nodes.filter(n => {
          if (!n.visible || n.locked) return false;
          const b = C.bbox(n, true);
          return b.x >= d.box.x && b.y >= d.box.y && b.x + b.w <= d.box.x + d.box.w && b.y + b.h <= d.box.y + d.box.h;
        }).map(n => n.id);
        state.selection = Array.from(new Set(d.base.concat(ids)));
      }
      renderOverlay(); renderScene();
    } else if (d.type === 'move') {
      if (d.didMove) commit('已移动对象');
      renderOverlay();
    } else if (d.type === 'resize' || d.type === 'rotate') {
      commit('已变换对象');
      renderOverlay();
    } else if (d.type === 'pan') {
      renderOverlay();
    }
  }

  function onDoubleClick(ev) {
    const p = clientToSvg(ev);
    if (state.tool === 'pen') { finishPen(false); return; }
    const targetEl = ev.target.closest ? ev.target.closest('[data-id]') : null;
    const id = targetEl && targetEl.getAttribute('data-id');
    if (id) {
      const f = C.findNode(state.doc.nodes, id);
      if (f && f.node.type === 'text') { setSelection([id]); openTextEditor(f.node, false); return; }
      if (f && f.node.type === 'group') { setSelection([id]); toast('已选中组合，可按 Ctrl+Shift+G 取消组合'); return; }
    }
    if (state.tool === 'select') { setTool('text'); }
  }

  function onWheel(ev) {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey || !ev.shiftKey) {
      const p = clientToSvg(ev);
      zoomAt(ev.deltaY < 0 ? 1.12 : 1 / 1.12, { x: p.x, y: p.y });
    } else {
      const v = viewBox();
      setViewBox({ x: v.x + ev.deltaY / state.zoom, y: v.y, w: v.w, h: v.h });
    }
    renderOverlay();
  }

  /* ---------------- 键盘 ---------------- */
  window.addEventListener('keydown', ev => {
    const tag = (ev.target.tagName || '').toLowerCase();
    const editing = tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target.isContentEditable;
    if ($('#textEditLayer').hidden === false) {
      if (ev.key === 'Escape') { ev.preventDefault(); closeTextEditor(false); }
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); closeTextEditor(true); }
      return;
    }
    if (ev.key === 'Escape') {
      if (state.penPoints.length) { state.penPoints = []; renderOverlay(); }
      else if (!$('#codeModal').hidden) $('#codeModal').hidden = true;
      else if (!$('#helpModal').hidden) $('#helpModal').hidden = true;
      else setSelection([]);
      return;
    }
    if (editing) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.code === 'Space') { state.spaceDown = true; stage.classList.add('tool-pan'); ev.preventDefault(); return; }
    if (mod) {
      const k = ev.key.toLowerCase();
      if (k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
      if (k === 'y') { ev.preventDefault(); redo(); return; }
      if (k === 'c') { ev.preventDefault(); copySelection(false); return; }
      if (k === 'x') { ev.preventDefault(); copySelection(true); return; }
      if (k === 'v') { ev.preventDefault(); pasteSelection(); return; }
      if (k === 'd') { ev.preventDefault(); duplicateSelection(); return; }
      if (k === 'a') { ev.preventDefault(); setSelection(state.doc.nodes.filter(n => n.visible).map(n => n.id)); return; }
      if (k === 'g') { ev.preventDefault(); ev.shiftKey ? ungroupSelection() : groupSelection(); return; }
      if (k === 's') { ev.preventDefault(); exportSvg(); return; }
      if (k === 'o') { ev.preventDefault(); $('#fileOpen').click(); return; }
      if (k === 'n') { ev.preventDefault(); newDocument(); return; }
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelection(); return; }
    if (ev.key.startsWith('Arrow')) {
      ev.preventDefault();
      const step = ev.shiftKey ? 10 : 1;
      const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
      const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      const sel = selectedNodes().filter(n => !n.locked);
      if (!sel.length) return;
      C.moveNodes(sel, dx, dy);
      renderScene(); commit('已微移对象');
      return;
    }
    if (ev.key === 'Enter' && state.penPoints.length) { ev.preventDefault(); finishPen(false); return; }
    const keys = { v: 'select', h: 'pan', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', p: 'pen', b: 'pencil', t: 'text', i: 'image' };
    const k = ev.key.toLowerCase();
    if (keys[k]) { setTool(keys[k]); return; }
    if (k === '0') fitView();
    if (k === '+' || k === '=') zoomAt(1.2);
    if (k === '-') zoomAt(1 / 1.2);
    if (k === 'g') { /* 单独 g 无操作，避免误触 */ }
  });
  window.addEventListener('keyup', ev => {
    if (ev.code === 'Space') {
      state.spaceDown = false;
      stage.className = 'canvas-stage tool-' + state.tool + (state.showGrid ? '' : ' grid-off');
    }
  });
  window.addEventListener('blur', () => {
    state.spaceDown = false;
    stage.className = 'canvas-stage tool-' + state.tool + (state.showGrid ? '' : ' grid-off');
  });

  /* ---------------- 事件绑定：按钮 ---------------- */
  document.addEventListener('click', ev => {
    const toolBtn = ev.target.closest('[data-tool]');
    if (toolBtn) { setTool(toolBtn.dataset.tool); return; }
    const alignBtn = ev.target.closest('[data-align]');
    if (alignBtn) { alignSelection(alignBtn.dataset.align); return; }
    const actionEl = ev.target.closest('[data-action]');
    if (!actionEl) return;
    const a = actionEl.dataset.action;
    const actions = {
      undo, redo, delete: deleteSelection, duplicate: duplicateSelection,
      group: groupSelection, ungroup: ungroupSelection,
      front: () => reorder('front'), back: () => reorder('back'),
      up: () => reorder('up'), down: () => reorder('down'),
      flipH: () => flipSelection('h'), flipV: () => flipSelection('v'),
      zoomIn: () => { zoomAt(1.2); renderOverlay(); },
      zoomOut: () => { zoomAt(1 / 1.2); renderOverlay(); },
      fit: fitView,
      toggleGrid: () => toggleGrid(),
      noFill: () => applyStyleProp('fill', 'none'),
      noStroke: () => { applyStyleProp('stroke', 'none'); applyStyleProp('strokeWidth', 0); },
      editText: () => { const t = selectedNodes().find(n => n.type === 'text'); if (t) openTextEditor(t, false); },
      centerPageAll: () => { setSelection(state.doc.nodes.map(n => n.id)); alignSelection('centerPage'); },
      clear: () => {
        if (!state.doc.nodes.length) return;
        if (confirm('清空画布上的所有对象？')) {
          state.doc.nodes = []; state.selection = [];
          renderScene(); commit('已清空画布');
        }
      },
      copyCode: () => {
        const text = serialize();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => toast('SVG 代码已复制', 'success'))
            .catch(() => { $('#codeText').value = text; $('#codeText').select(); document.execCommand('copy'); toast('SVG 代码已复制'); });
        } else {
          const ta = document.createElement('textarea'); ta.value = text;
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
          toast('SVG 代码已复制');
        }
      },
      exportPng, exportSvg,
      loadDemo: () => {
        state.doc = C.normalizeDoc(C.demoDoc()); state.selection = [];
        renderPage(); renderScene(); commit('已载入示例'); fitView();
      },
      applyCode,
      downloadFromCode: () => download(safeName() + '.svg', $('#codeText').value, 'image/svg+xml;charset=utf-8'),
      closeCode: () => { $('#codeModal').hidden = true; },
      closeHelp: () => { $('#helpModal').hidden = true; }
    };
    if (actions[a]) { ev.preventDefault(); actions[a](); }
  });

  $$('[data-prop]').forEach(el => {
    const prop = el.dataset.prop;
    const evName = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
    const commitName = el.type === 'range' ? 'change' : 'change';
    el.addEventListener(evName, () => {
      if (syncing) return;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (prop === 'fill' || prop === 'stroke' || prop === 'background') {
        const str = String(v).trim();
        if (!C.isValidColor(str)) { el.style.borderColor = 'var(--danger)'; return; }
        el.style.borderColor = '';
        if (prop === 'fill') { applyStyleProp('fill', str); $('[data-prop="fillColor"]').value = toHexInput(str); }
        else if (prop === 'stroke') { applyStyleProp('stroke', str); $('[data-prop="strokeColor"]').value = toHexInput(str); }
        else { state.doc.background = str; state.doc.transparent = str === 'none'; renderPage(); renderScene(); commit('已修改背景'); }
        return;
      }
      if (prop === 'fillColor') { applyStyleProp('fill', v); setField('fill', v); return; }
      if (prop === 'strokeColor') { applyStyleProp('stroke', v); setField('stroke', v); return; }
      if (prop === 'bgColor') {
        state.doc.background = v; state.doc.transparent = false;
        renderPage(); renderScene(); commit('已修改背景'); return;
      }
      if (prop === 'transparent') {
        state.doc.transparent = !!v; renderPage(); renderScene(); commit('已修改背景'); return;
      }
      if (prop === 'pageW' || prop === 'pageH') {
        const n = clamp(num(v, 1), 1, 10000);
        state.doc[prop === 'pageW' ? 'width' : 'height'] = n;
        renderPage(); renderScene(); commit('已修改画布尺寸'); return;
      }
      if (['x', 'y', 'w', 'h', 'rotation', 'opacity'].includes(prop)) { applyTransformProp(prop, num(v, 0)); return; }
      if (['strokeWidth', 'rx'].includes(prop)) { applyStyleProp(prop, Math.max(0, num(v, 0))); return; }
      if (['linecap', 'arrow'].includes(prop)) { applyStyleProp(prop, v); return; }
      if (['fontFamily', 'fontWeight', 'fontStyle', 'textAnchor'].includes(prop)) { applyTextProp(prop, v); return; }
      if (prop === 'fontSize') { applyTextProp(prop, Math.max(1, num(v, 16))); return; }
    });
    if (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'color') {
      el.addEventListener('change', () => { if (!syncing) renderInspector(); });
      el.addEventListener('blur', () => { if (!syncing) renderInspector(); });
    }
  });

  $('#chkLockRatio').addEventListener('change', e => { state.lockRatio = e.target.checked; });
  $('#chkGrid').addEventListener('change', e => toggleGrid(e.target.checked));
  $('#chkSnap').addEventListener('change', e => { state.snapGrid = e.target.checked; toast(e.target.checked ? '已开启吸附' : '已关闭吸附'); });
  $('#zoomLabel').addEventListener('click', zoomTo100);
  $('#btnNew').addEventListener('click', newDocument);
  $('#btnOpen').addEventListener('click', () => $('#fileOpen').click());
  $('#btnSave').addEventListener('click', exportSvg);
  $('#btnExportSvg').addEventListener('click', exportSvg);
  $('#btnExportPng').addEventListener('click', exportPng);
  $('#btnCode').addEventListener('click', openCodeModal);
  $('#btnHelp').addEventListener('click', () => { $('#helpModal').hidden = false; });
  $('#docName').addEventListener('change', saveLocal);
  $('#codeText').addEventListener('keydown', ev => {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const s = ev.target.selectionStart, e = ev.target.selectionEnd;
      ev.target.value = ev.target.value.slice(0, s) + '  ' + ev.target.value.slice(e);
      ev.target.selectionStart = ev.target.selectionEnd = s + 2;
    }
  });
  $$('.modal-backdrop').forEach(m => m.addEventListener('pointerdown', e => {
    if (e.target === m) m.hidden = true;
  }));
  $('#textEditInput').addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeTextEditor(false); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); closeTextEditor(true); }
  });
  stage.addEventListener('pointerdown', ev => {
    if (!$('#textEditLayer').hidden && !ev.target.closest('#textEditLayer')) closeTextEditor(true);
  }, true);

  /* ---------------- 文件读取 / 拖放 ---------------- */
  $('#fileOpen').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => openSvgText(String(r.result), f.name);
    r.readAsText(f, 'utf-8');
    e.target.value = '';
  });
  $('#fileImage').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    readImageAsNode(f, state.pendingImage && state.pendingImage.pos);
    state.pendingImage = null;
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach(t => stage.addEventListener(t, ev => {
    ev.preventDefault(); stage.classList.add('drop-active');
  }));
  ['dragleave', 'drop'].forEach(t => stage.addEventListener(t, ev => {
    ev.preventDefault();
    if (t === 'dragleave' && ev.target !== stage) return;
    stage.classList.remove('drop-active');
  }));
  stage.addEventListener('drop', ev => {
    const files = Array.from(ev.dataTransfer.files || []);
    if (!files.length) return;
    const p = clientToSvg(ev);
    const f = files[0];
    if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') {
      const r = new FileReader();
      r.onload = () => openSvgText(String(r.result), f.name);
      r.readAsText(f, 'utf-8');
    } else if (/^image\//.test(f.type)) {
      readImageAsNode(f, p);
    } else toast('仅支持 SVG 或图片文件', 'error');
  });

  /* ---------------- 色板 ---------------- */
  (function initSwatches() {
    const wrap = $('#swatches');
    C.PALETTE.forEach(color => {
      const b = document.createElement('button');
      b.className = 'swatch'; b.style.background = color; b.title = '设置填充：' + color;
      b.addEventListener('click', () => applyStyleProp('fill', color));
      b.addEventListener('contextmenu', e => { e.preventDefault(); applyStyleProp('stroke', color); toast('已设置描边：' + color); });
      wrap.appendChild(b);
    });
    const none = document.createElement('button');
    none.className = 'swatch'; none.title = '无填充';
    none.style.background = 'linear-gradient(135deg,#fff 45%,#e05260 46%,#e05260 54%,#fff 55%)';
    none.addEventListener('click', () => applyStyleProp('fill', 'none'));
    wrap.appendChild(none);
  })();

  /* ---------------- 启动 ---------------- */
  function boot() {
    loadLocal();
    renderPage();
    setTool('select');
    renderScene();
    commit();
    fitView();
    setTimeout(() => { fitView(); renderOverlay(); }, 60);
    window.addEventListener('resize', () => renderOverlay());
    setHint('就绪 · 按 H 查看完整快捷键说明，或点击右上角「帮助」');
  }
  boot();

  // 暴露少量调试接口
  window.__SVGEditor = { state, renderScene, serialize, openSvgText, setTool };
})();
