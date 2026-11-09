/* ============================================================
   core.js — SVG 编辑器数据模型 / 几何 / 序列化 / 解析
   纯逻辑层，不依赖界面状态
   ============================================================ */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['#4f8cff', '#7b5cf5', '#f0508a', '#ff8a3d', '#f7c325', '#28c39a',
                   '#38bdf8', '#e05260', '#243044', '#ffffff'];
  const SHAPE_TYPES = ['rect', 'ellipse', 'line', 'arrow', 'polyline', 'polygon', 'pencil', 'text', 'image'];
  const PATH_TYPES = ['polyline', 'polygon', 'pencil'];
  const LINE_TYPES = ['line', 'arrow'];

  let _seq = 0;
  function uid(prefix) {
    _seq += 1;
    return (prefix || 'n') + '_' + Date.now().toString(36) + '_' + _seq.toString(36);
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : (d || 0); }
  function fmt(n) {
    if (!Number.isFinite(n)) return '0';
    return String(Math.round(n * 1000) / 1000);
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function round(v, p) { const m = Math.pow(10, p || 0); return Math.round(v * m) / m; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function deg(r) { return r * 180 / Math.PI; }
  function rad(d) { return d * Math.PI / 180; }
  function rotatePoint(p, angle, c) {
    if (!angle) return { x: p.x, y: p.y };
    const a = rad(angle), co = Math.cos(a), si = Math.sin(a);
    const dx = p.x - c.x, dy = p.y - c.y;
    return { x: c.x + dx * co - dy * si, y: c.y + dx * si + dy * co };
  }

  /* ---------------------- 样式默认值 ---------------------- */
  function defaultStyle(type) {
    const lineLike = LINE_TYPES.includes(type) || type === 'polyline' || type === 'pencil';
    const s = {
      fill: lineLike ? 'none' : '#4f8cff',
      stroke: lineLike ? '#243044' : '#1d2433',
      strokeWidth: lineLike ? 2.5 : 2,
      opacity: 1,
      linecap: 'round',
      linejoin: 'round',
      dash: '',
      arrow: type === 'arrow' ? 'end' : 'none',
      rx: 0,
      fillRule: 'nonzero'
    };
    if (type === 'text') { s.fill = '#243044'; s.stroke = 'none'; s.strokeWidth = 0; }
    if (type === 'image') { s.fill = 'none'; s.stroke = 'none'; s.strokeWidth = 0; }
    if (type === 'polygon') { s.stroke = '#1d2433'; }
    return s;
  }

  function defaultText() {
    return {
      content: '双击编辑文本', fontFamily: 'sans-serif', fontSize: 32,
      fontWeight: '400', fontStyle: 'normal', textAnchor: 'start', lineHeight: 1.25,
      baseline: 'alphabetic'
    };
  }

  /* ---------------------- 创建图元 ---------------------- */
  function create(type, box, opts) {
    box = box || {};
    opts = opts || {};
    const x = num(box.x, 0), y = num(box.y, 0);
    const w = Math.max(0.1, num(box.w, 120)), h = Math.max(0.1, num(box.h, 80));
    const n = {
      id: uid(type), type: type, name: nameOf(type),
      visible: true, locked: false,
      x: x, y: y, w: w, h: h, rotation: 0, flipX: 1, flipY: 1,
      style: defaultStyle(type)
    };
    if (PATH_TYPES.includes(type)) {
      n.points = opts.points || [];
      n.smooth = opts.smooth !== undefined ? !!opts.smooth : (type === 'pencil');
      n.closed = type === 'polygon';
      if (type === 'polygon') n.style.fill = '#4f8cff';
    }
    if (LINE_TYPES.includes(type)) { n.dirX = 1; n.dirY = 1; }
    if (type === 'text') n.text = Object.assign(defaultText(), opts.text || {});
    if (type === 'image') n.href = opts.href || '';
    if (type === 'group') { n.children = opts.children || []; n.style = null; }
    if (opts.style) Object.assign(n.style || (n.style = defaultStyle(type)), opts.style);
    if (opts.name) n.name = opts.name;
    return n;
  }

  function nameOf(type) {
    return ({
      rect: '矩形', ellipse: '椭圆', line: '直线', arrow: '箭头',
      polyline: '折线', polygon: '多边形', pencil: '画笔', text: '文本',
      image: '图片', group: '组合'
    })[type] || '对象';
  }

  /* ---------------------- 几何 ---------------------- */
  function center(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

  function nodeTransform(n) {
    // 组合本身不额外套 transform：子节点已携带绝对坐标与自身旋转，
    // 避免「父级变换 + 子级位移」被重复应用。
    if (n.type === 'group') return '';
    // 导入保留的原始路径已是世界坐标，不再套节点变换（否则重复应用）
    if (n.rawPath) return '';
    const c = center(n);
    const parts = [];
    if (n.rotation || n.flipX !== 1 || n.flipY !== 1) {
      parts.push('translate(' + fmt(c.x) + ' ' + fmt(c.y) + ')');
      if (n.rotation) parts.push('rotate(' + fmt(n.rotation) + ')');
      if (n.flipX !== 1 || n.flipY !== 1) parts.push('scale(' + fmt(n.flipX) + ' ' + fmt(n.flipY) + ')');
      parts.push('translate(' + fmt(-c.x) + ' ' + fmt(-c.y) + ')');
      return parts.join(' ');
    }
    return '';
  }

  function toLocal(p, n) {
    const c = center(n);
    let q = rotatePoint(p, -(n.rotation || 0), c);
    if (n.flipX !== 1) q.x = c.x - (q.x - c.x);
    if (n.flipY !== 1) q.y = c.y - (q.y - c.y);
    return q;
  }
  function toWorld(p, n) {
    const c = center(n);
    let q = { x: p.x, y: p.y };
    if (n.flipX !== 1) q.x = c.x - (q.x - c.x);
    if (n.flipY !== 1) q.y = c.y - (q.y - c.y);
    return rotatePoint(q, n.rotation || 0, c);
  }

  // 不含旋转的局部框
  function localBox(n) { return { x: n.x, y: n.y, w: n.w, h: n.h }; }

  // 含旋转的世界包围盒
  function bbox(n, includeRotation) {
    // 组合的包围盒 = 所有子元素包围盒的并集；组合自身不额外旋转。
    if (n.type === 'group' && n.children && n.children.length) {
      return union(n.children.map(c => bbox(c, true))) || { x: n.x, y: n.y, w: n.w, h: n.h };
    }
    const b = { x: n.x, y: n.y, w: n.w, h: n.h };
    if (includeRotation === false || !n.rotation) return b;
    const pts = corners(b).map(p => rotatePoint(p, n.rotation, center(n)));
    return boundsOfPoints(pts);
  }
  function corners(b) {
    return [
      { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }
    ];
  }
  function boundsOfPoints(pts) {
    if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  function union(boxes) {
    boxes = boxes.filter(Boolean);
    if (!boxes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    boxes.forEach(b => {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  function bboxOfNodes(nodes) { return union(nodes.map(n => bbox(n, true))); }

  function distToSegment(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
    t = clamp(t, 0, 1);
    const dx = p.x - (a.x + t * vx), dy = p.y - (a.y + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  }
  function pointInPolygon(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function absPoints(n) {
    return (n.points || []).map(p => ({ x: n.x + p[0] * n.w, y: n.y + p[1] * n.h }));
  }
  function lineEnds(n) {
    const dx = n.dirX || 1, dy = n.dirY || 1;
    return [
      { x: n.x + (dx > 0 ? 0 : n.w), y: n.y + (dy > 0 ? 0 : n.h) },
      { x: n.x + (dx > 0 ? n.w : 0), y: n.y + (dy > 0 ? n.h : 0) }
    ];
  }

  function hitTest(n, worldPt, tolerance) {
    if (!n.visible) return false;
    const tol = tolerance == null ? 5 : tolerance;
    const p = toLocal(worldPt, n);
    if (n.type === 'group') {
      return (n.children || []).some(c => hitTest(c, worldPt, tol));
    }
    const b = localBox(n);
    const pad = Math.max(tol, (n.style.strokeWidth || 0) / 2 + tol);
    if (p.x < b.x - pad || p.x > b.x + b.w + pad || p.y < b.y - pad || p.y > b.y + b.h + pad) return false;
    if (n.type === 'ellipse') {
      const rx = Math.max(b.w / 2 + pad, 1), ry = Math.max(b.h / 2 + pad, 1);
      const dx = (p.x - (b.x + b.w / 2)) / rx, dy = (p.y - (b.y + b.h / 2)) / ry;
      return dx * dx + dy * dy <= 1.05;
    }
    if (LINE_TYPES.includes(n.type)) {
      const e = lineEnds(n);
      return distToSegment(p, e[0], e[1]) <= pad + 3;
    }
    if (PATH_TYPES.includes(n.type)) {
      const pts = absPoints(n);
      if (pts.length < 2) return false;
      if ((n.closed || n.type === 'polygon') && n.style.fill && n.style.fill !== 'none' && pointInPolygon(p, pts)) return true;
      for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= pad + 2) return true;
      if (n.closed || n.type === 'polygon') {
        if (distToSegment(p, pts[pts.length - 1], pts[0]) <= pad + 2) return true;
      }
      return false;
    }
    // rect / text / image
    return true;
  }

  /* ---------------------- 变换操作 ---------------------- */
  function eachNode(nodes, fn) {
    for (const n of nodes) {
      fn(n);
      if (n.type === 'group' && n.children) eachNode(n.children, fn);
    }
  }
  function moveNodes(nodes, dx, dy) {
    for (const n of nodes) {
      n.x += dx; n.y += dy;
      if (n.type === 'group') for (const c of (n.children || [])) { c.x += dx; c.y += dy; }
    }
  }
  function scaleNodeGeom(n, sx, sy, oldX, oldY, newX, newY, scaleText) {
    n.x = newX + (n.x - oldX) * sx;
    n.y = newY + (n.y - oldY) * sy;
    n.w = Math.max(0.1, n.w * sx);
    n.h = Math.max(0.1, n.h * sy);
    if (n.type === 'text' && scaleText && n.text) {
      n.text.fontSize = Math.max(1, n.text.fontSize * Math.min(Math.abs(sx), Math.abs(sy)));
    }
    if (n.type === 'group' && n.children) {
      for (const c of n.children) scaleNodeGeom(c, sx, sy, oldX, oldY, newX, newY, scaleText);
    }
  }
  function scaleNodes(nodes, originals, oldBox, newBox, scaleText) {
    const sx = oldBox.w ? newBox.w / oldBox.w : 1;
    const sy = oldBox.h ? newBox.h / oldBox.h : 1;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], src = originals[i];
      Object.assign(n, clone(src));
      scaleNodeGeom(n, sx, sy, oldBox.x, oldBox.y, newBox.x, newBox.y, scaleText);
    }
  }
  function setRotationAround(nodes, originals, angle, pivot) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], src = originals[i];
      Object.assign(n, clone(src));
      if (n.type === 'group' && n.children && n.children.length) {
        // nodeTransform 对 group 返回 ''，需把旋转烘焙到每个子叶子节点
        for (const ch of n.children) {
          const cc = { x: ch.x + ch.w / 2, y: ch.y + ch.h / 2 };
          const np = rotatePoint(cc, angle, pivot);
          ch.x += np.x - cc.x; ch.y += np.y - cc.y;
          ch.rotation = (ch.rotation || 0) + angle;
        }
      } else {
        // 旋转时把每个顶层对象的中心绕枢轴旋转，整体保持刚性
        const c = { x: src.x + src.w / 2, y: src.y + src.h / 2 };
        const np = rotatePoint(c, angle, pivot);
        n.x += np.x - c.x; n.y += np.y - c.y;
        n.rotation = (src.rotation || 0) + angle;
      }
    }
  }

  /* ---------------------- 查找 ---------------------- */
  function findNode(nodes, id, parent) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return { node: nodes[i], parent: parent || null, index: i, list: nodes };
      if (nodes[i].type === 'group') {
        const r = findNode(nodes[i].children || [], id, nodes[i]);
        if (r) return r;
      }
    }
    return null;
  }
  function descendants(n) {
    if (n.type !== 'group') return [n];
    return (n.children || []).reduce((a, c) => a.concat(descendants(c)), [n]);
  }

  /* ---------------------- SVG 序列化 ---------------------- */
  function styleAttrs(s) {
    if (!s) return '';
    let out = '';
    out += ' fill="' + esc(s.fill || 'none') + '"';
    out += ' stroke="' + esc(s.stroke || 'none') + '"';
    out += ' stroke-width="' + fmt(num(s.strokeWidth, 0)) + '"';
    if (s.fillRule && s.fillRule !== 'nonzero') out += ' fill-rule="' + esc(s.fillRule) + '"';
    if (num(s.opacity, 1) !== 1) out += ' opacity="' + fmt(s.opacity) + '"';
    if (s.linecap) out += ' stroke-linecap="' + esc(s.linecap) + '"';
    if (s.linejoin) out += ' stroke-linejoin="' + esc(s.linejoin) + '"';
    if (s.dash) out += ' stroke-dasharray="' + esc(s.dash) + '"';
    return out;
  }

  function arrowHead(tip, from, size, color) {
    const a = Math.atan2(tip.y - from.y, tip.x - from.x);
    const half = size * 0.42;
    const p1 = { x: tip.x - size * Math.cos(a) + half * Math.sin(a), y: tip.y - size * Math.sin(a) - half * Math.cos(a) };
    const p2 = { x: tip.x - size * Math.cos(a) - half * Math.sin(a), y: tip.y - size * Math.sin(a) + half * Math.cos(a) };
    return '<polygon points="' + [tip, p1, p2].map(p => fmt(p.x) + ',' + fmt(p.y)).join(' ') +
      '" fill="' + esc(color) + '" stroke="none"/>';
  }

  function pathFromPoints(pts, smooth) {
    if (!pts.length) return '';
    if (!smooth || pts.length < 3) return 'M' + pts.map(p => fmt(p.x) + ' ' + fmt(p.y)).join(' L');
    let d = 'M' + fmt(pts[0].x) + ' ' + fmt(pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ' Q' + fmt(pts[i].x) + ' ' + fmt(pts[i].y) + ' ' + fmt(mx) + ' ' + fmt(my);
    }
    const last = pts[pts.length - 1];
    d += ' L' + fmt(last.x) + ' ' + fmt(last.y);
    return d;
  }

  function serializeElement(n, opts) {
    if (!n.visible) return '';
    opts = opts || {};
    const tf = nodeTransform(n);
    const idAttr = opts.editorIds ? ' data-id="' + esc(n.id) + '"' : '';
    const gOpen = tf
      ? '<g' + idAttr + ' transform="' + esc(tf) + '">'
      : '<g' + idAttr + '>';
    let body = '';
    const s = n.style || defaultStyle(n.type);
    const sa = styleAttrs(s);
    const b = localBox(n);

    switch (n.type) {
      case 'rect':
        body = '<rect x="' + fmt(b.x) + '" y="' + fmt(b.y) + '" width="' + fmt(b.w) + '" height="' + fmt(b.h) +
          '"' + (num(s.rx, 0) > 0 ? ' rx="' + fmt(s.rx) + '" ry="' + fmt(s.rx) + '"' : '') + sa + '/>';
        break;
      case 'ellipse':
        body = '<ellipse cx="' + fmt(b.x + b.w / 2) + '" cy="' + fmt(b.y + b.h / 2) +
          '" rx="' + fmt(b.w / 2) + '" ry="' + fmt(b.h / 2) + '"' + sa + '/>';
        break;
      case 'line':
      case 'arrow': {
        const e = lineEnds(n);
        body = '<line x1="' + fmt(e[0].x) + '" y1="' + fmt(e[0].y) + '" x2="' + fmt(e[1].x) +
          '" y2="' + fmt(e[1].y) + '"' + sa + '/>';
        const size = Math.max(9, num(s.strokeWidth, 2) * 4);
        const color = (s.stroke && s.stroke !== 'none') ? s.stroke : '#243044';
        if (s.arrow === 'end' || s.arrow === 'both') body += arrowHead(e[1], e[0], size, color);
        if (s.arrow === 'start' || s.arrow === 'both') body += arrowHead(e[0], e[1], size, color);
        break;
      }
      case 'polyline':
      case 'pencil': {
        if (n.rawPath) {
          // 导入保留的原始路径（世界坐标），直接输出，避免二次采样变形
          body = '<path d="' + esc(n.rawPath) + '"' + sa + '/>';
          break;
        }
        const pts = absPoints(n);
        body = '<path d="' + esc(pathFromPoints(pts, n.smooth)) + '"' + sa + '/>';
        break;
      }
      case 'polygon': {
        const pts = absPoints(n);
        body = '<polygon points="' + pts.map(p => fmt(p.x) + ',' + fmt(p.y)).join(' ') + '"' + sa + '/>';
        break;
      }
      case 'text': {
        const t = n.text || defaultText();
        const fs2 = num(t.fontSize, 32);
        const baseline = t.baseline || 'alphabetic';
        const lines = String(t.content == null ? '' : t.content).split('\n');
        const anchorX = t.textAnchor === 'middle' ? b.x + b.w / 2 : (t.textAnchor === 'end' ? b.x + b.w : b.x);
        // central/middle 表示 y 为文字中心；否则 y 为包围盒顶部（按基线近似）
        const firstY = (baseline === 'central' || baseline === 'middle' || baseline === 'mathematical')
          ? b.y + b.h / 2
          : b.y + fs2 * 0.82;
        const dy = fs2 * num(t.lineHeight, 1.25);
        let tspan = '';
        lines.forEach((ln, i) => {
          tspan += '<tspan x="' + fmt(anchorX) + '" y="' + fmt(firstY + i * dy) + '">' + esc(ln || ' ') + '</tspan>';
        });
        const dbAttr = (baseline && baseline !== 'alphabetic' && baseline !== 'auto') ? ' dominant-baseline="' + esc(baseline) + '"' : '';
        body = '<text x="' + fmt(anchorX) + '" y="' + fmt(firstY) + '"' + sa + dbAttr +
          ' font-family="' + esc(t.fontFamily) + '" font-size="' + fmt(fs2) +
          '" font-weight="' + esc(t.fontWeight) + '" font-style="' + esc(t.fontStyle) +
          '" text-anchor="' + esc(t.textAnchor) + '" xml:space="preserve">' + tspan + '</text>';
        break;
      }
      case 'image':
        body = '<image x="' + fmt(b.x) + '" y="' + fmt(b.y) + '" width="' + fmt(b.w) + '" height="' + fmt(b.h) +
          '" preserveAspectRatio="xMidYMid meet" href="' + esc(n.href || '') + '"/>';
        break;
      case 'group':
        body = (n.children || []).map(c => serializeElement(c, opts)).join('');
        break;
      default:
        body = '';
    }
    return gOpen + body + '</g>';
  }

  function serializeDoc(doc, opts) {
    opts = opts || {};
    opts.editorIds = opts.editorIds !== false;
    const W = num(doc.width, 1200), H = num(doc.height, 800);
    let out = '<svg xmlns="' + NS + '" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(W) +
      '" height="' + fmt(H) + '" viewBox="0 0 ' + fmt(W) + ' ' + fmt(H) + '">\n';
    if (opts.title) out += '  <title>' + esc(opts.title) + '</title>\n';
    if (!doc.transparent && doc.background && doc.background !== 'none') {
      out += '  <rect width="' + fmt(W) + '" height="' + fmt(H) + '" fill="' + esc(doc.background) + '"/>\n';
    }
    if (opts.metadata !== false) {
      const model = clone(doc);
      out += '  <metadata id="svg-editor-model" data-app="VectorStudio" data-version="1"><![CDATA[' +
        JSON.stringify(model).replace(/]]>/g, ']] >') + ']]></metadata>\n';
    }
    out += '  <g id="scene-content">\n';
    (doc.nodes || []).forEach(n => { out += '    ' + serializeElement(n, opts) + '\n'; });
    out += '  </g>\n</svg>';
    return out;
  }

  // 从 d 中析出坐标点（用于计算包围盒，仅处理绝对命令 M L H V C S Q T 与 Z，
  // 相对命令先转为世界坐标已在 transformD 中完成，这里统一按绝对解析）
  function dPoints(d) {
    const pts = [];
    const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
    let mt, cmd = '', args = [], ni = 0, cx = 0, cy = 0;
    const push = (x, y) => pts.push({ x, y });
    const flush = () => {
      const a = args; args = []; ni = 0;
      const C = (i) => { push(a[i], a[i + 1]); cx = a[i]; cy = a[i + 1]; };
      switch (cmd) {
        case 'M': case 'L': C(0); break;
        case 'm': case 'l': cx += a[0]; cy += a[1]; push(cx, cy); break;
        case 'H': case 'h': cx = a[0]; push(cx, cy); break;
        case 'V': case 'v': cy = a[0]; push(cx, cy); break;
        case 'C': case 'S': case 'Q': case 'T': C((cmd === 'Q' || cmd === 'T') ? 2 : 4); break;
        case 'c': case 's': case 'q': case 't': { const o = (cmd === 'q' || cmd === 't') ? 2 : 4; cx += a[o]; cy += a[o + 1]; push(cx, cy); break; }
        case 'A': case 'a': cx = a[5]; cy = a[6]; push(cx, cy); break;
        case 'Z': case 'z': break;
      }
    };
    while ((mt = re.exec(d)) !== null) {
      if (mt[1]) { if (cmd && ni) flush(); cmd = mt[1]; ni = 0; }
      else { args.push(parseFloat(mt[2])); ni++; if (((cmd === 'A' || cmd === 'a') && ni === 7) || ni === consumes(cmd) * 2) flush(); }
    }
    if (cmd && ni) flush();
    return pts.length ? pts : [{ x: 0, y: 0 }];
  }

  /* ---------------------- 颜色工具 ---------------------- */
  function cssColorToHex(c) {
    if (!c) return '#000000';
    c = String(c).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(c)) return c;
    const m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (m) {
      const h = v => Math.round(clamp(parseFloat(v), 0, 255)).toString(16).padStart(2, '0');
      return '#' + h(m[1]) + h(m[2]) + h(m[3]);
    }
    return c;
  }
  function isValidColor(v) {
    v = String(v || '').trim();
    if (!v || v === 'none' || v === 'transparent' || v === 'currentColor') return true;
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return true;
    if (/^(rgb|rgba|hsl|hsla)\(/i.test(v)) return true;
    return /^[a-z]+$/i.test(v);
  }

  /* ---------------------- SVG 解析 ---------------------- */
  function sanitize(root) {
    const blocked = ['script', 'foreignobject', 'iframe', 'object', 'embed', 'animate', 'set', 'handler'];
    const all = Array.from(root.querySelectorAll('*'));
    for (const el of all) {
      const tag = (el.localName || '').toLowerCase();
      if (blocked.includes(tag)) { if (el.parentNode) el.parentNode.removeChild(el); continue; }
      for (const at of Array.from(el.attributes)) {
        const an = at.name.toLowerCase();
        if (an.startsWith('on') || (an === 'href' || an === 'xlink:href') && /^\s*javascript:/i.test(at.value)) {
          el.removeAttribute(at.name);
        }
      }
    }
  }

  let _offscreen = null;
  function offscreenSvg(W, H) {
    if (!_offscreen) {
      const s = document.createElementNS(NS, 'svg');
      s.setAttribute('xmlns', NS);
      // 关键：离屏 SVG 必须用真实像素尺寸（与 viewBox 一致），
      // 不能用 1px 把内容缩放到不可度量；否则 <text> 的 getBBox / getComputedTextLength
      // 会退化为 0，导致导入的文字包围盒变成 1x1。用 visibility:hidden 隐藏但不影响度量。
      s.style.cssText = 'position:absolute;left:-100000px;top:0;overflow:visible;visibility:hidden;pointer-events:none;';
      document.body.appendChild(s);
      _offscreen = s;
    }
    _offscreen.setAttribute('width', W);
    _offscreen.setAttribute('height', H);
    _offscreen.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    while (_offscreen.firstChild) _offscreen.removeChild(_offscreen.firstChild);
    return _offscreen;
  }

  function parseMatrix(el) {
    let m = [1, 0, 0, 1, 0, 0];
    const t = el.getAttribute('transform');
    if (!t) return m;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    let match;
    while ((match = re.exec(t))) {
      const a = match[2].trim().split(/[\s,]+/).filter(s => s !== '').map(Number);
      let s = [1, 0, 0, 1, 0, 0];
      if (match[1] === 'matrix' && a.length >= 6) s = a.slice(0, 6);
      else if (match[1] === 'translate') s = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
      else if (match[1] === 'scale') s = [a[0], 0, 0, (a.length > 1 ? a[1] : a[0]), 0, 0];
      else if (match[1] === 'rotate') {
        const r = rad(a[0] || 0), co = Math.cos(r), si = Math.sin(r);
        s = [co, si, -si, co, 0, 0];
        if (a.length >= 3) {
          s[4] = a[1] - (a[1] * co - a[2] * si);
          s[5] = a[2] - (a[1] * si + a[2] * co);
        }
      } else if (match[1] === 'skewX') s = [1, 0, Math.tan(rad(a[0] || 0)), 1, 0, 0];
      else if (match[1] === 'skewY') s = [1, Math.tan(rad(a[0] || 0)), 0, 1, 0, 0];
      const o = [s[0] * m[0] + s[2] * m[1], s[1] * m[0] + s[3] * m[1],
                 s[0] * m[2] + s[2] * m[3], s[1] * m[2] + s[3] * m[3],
                 s[0] * m[4] + s[2] * m[5] + s[4], s[1] * m[4] + s[3] * m[5] + s[5]];
      m = o;
    }
    return m;
  }
  function applyMat(m, p) {
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
  }

  function computedStyleOf(el) {
    let c;
    try { c = window.getComputedStyle(el); } catch (e) { c = null; }
    const get = (k, d) => {
      const cv = c && c.getPropertyValue ? c.getPropertyValue(k) : (c && c[k]);
      return (cv && cv !== 'none' && cv !== '') ? cv : (el.getAttribute(k) || d);
    };
    return {
      fill: cssColorToHex(get('fill', '#000000')),
      stroke: cssColorToHex(get('stroke', 'none')),
      strokeWidth: num(get('stroke-width', '1'), 1),
      opacity: num(get('opacity', '1'), 1),
      linecap: get('stroke-linecap', 'butt'),
      linejoin: get('stroke-linejoin', 'miter'),
      dash: get('stroke-dasharray', 'none') === 'none' ? '' : get('stroke-dasharray', ''),
      rx: 0,
      fillRule: get('fill-rule', 'nonzero')
    };
  }

  function samplePath(el, m) {
    let pts = [];
    const d = el.getAttribute('d') || '';
    try {
      const len = el.getTotalLength ? el.getTotalLength() : 0;
      if (len > 0 && Number.isFinite(len)) {
        const steps = clamp(Math.ceil(len / 3), 16, 2000);
        for (let i = 0; i <= steps; i++) pts.push(applyMat(m, el.getPointAtLength(len * i / steps)));
        return pts;
      }
    } catch (e) { /* fallthrough */ }
    // 退化方案：抽取 d 中的坐标对
    const nums = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push(applyMat(m, { x: nums[i], y: nums[i + 1] }));
    return pts;
  }

  // 把 path 的 d 经过仿射矩阵 m 烘焙坐标后原样保留（保留超精细路径，不重采样）。
  // 支持 M/L/H/V/C/S/Q/T/A 及其相对命令与 Z；返回世界坐标的 d 字符串。
  function transformD(d, m) {
    if (!d) return '';
    const T = applyMat.bind(null, m);
    const out = [];
    let cx = 0, cy = 0, sx = 0, sy = 0, cmd = '';
    const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
    let mt, args = [], ni = 0;
    const flush = () => {
      const a = args; args = []; ni = 0;
      const P = (i) => T({ x: a[i], y: a[i + 1] });
      switch (cmd) {
        case 'M': { const p = P(0); out.push('M' + fmt(p.x) + ' ' + fmt(p.y)); cx = sx = p.x; cy = sy = p.y; break; }
        case 'm': { const p = T({ x: cx + a[0], y: cy + a[1] }); out.push('m' + fmt(p.x - cx) + ' ' + fmt(p.y - cy)); cx = sx = p.x; cy = sy = p.y; break; }
        case 'L': { const p = P(0); out.push('L' + fmt(p.x) + ' ' + fmt(p.y)); cx = sx = p.x; cy = sy = p.y; break; }
        case 'l': { const p = T({ x: cx + a[0], y: cy + a[1] }); out.push('l' + fmt(p.x - cx) + ' ' + fmt(p.y - cy)); cx = p.x; cy = p.y; break; }
        case 'H': { const p = T({ x: a[0], y: cy }); out.push('L' + fmt(p.x) + ' ' + fmt(p.y)); cx = p.x; break; }
        case 'h': { const p = T({ x: cx + a[0], y: cy }); out.push('L' + fmt(p.x) + ' ' + fmt(p.y)); cx = p.x; break; }
        case 'V': { const p = T({ x: cx, y: a[0] }); out.push('L' + fmt(p.x) + ' ' + fmt(p.y)); cy = p.y; break; }
        case 'v': { const p = T({ x: cx, y: cy + a[0] }); out.push('L' + fmt(p.x) + ' ' + fmt(p.y)); cy = p.y; break; }
        case 'C': { const p0 = P(0), p1 = P(2), p2 = P(4); out.push('C' + fmt(p0.x) + ' ' + fmt(p0.y) + ' ' + fmt(p1.x) + ' ' + fmt(p1.y) + ' ' + fmt(p2.x) + ' ' + fmt(p2.y)); cx = sx = p2.x; cy = sy = p2.y; break; }
        case 'c': { const p0 = T({ x: cx + a[0], y: cy + a[1] }), p1 = T({ x: cx + a[2], y: cy + a[3] }), p2 = T({ x: cx + a[4], y: cy + a[5] }); out.push('c' + fmt(p0.x - cx) + ' ' + fmt(p0.y - cy) + ' ' + fmt(p1.x - cx) + ' ' + fmt(p1.y - cy) + ' ' + fmt(p2.x - cx) + ' ' + fmt(p2.y - cy)); cx = p2.x; cy = p2.y; break; }
        case 'S': { const p1 = P(0), p2 = P(2); out.push('S' + fmt(p1.x) + ' ' + fmt(p1.y) + ' ' + fmt(p2.x) + ' ' + fmt(p2.y)); cx = sx = p2.x; cy = sy = p2.y; break; }
        case 's': { const p1 = T({ x: cx + a[0], y: cy + a[1] }), p2 = T({ x: cx + a[2], y: cy + a[3] }); out.push('s' + fmt(p1.x - cx) + ' ' + fmt(p1.y - cy) + ' ' + fmt(p2.x - cx) + ' ' + fmt(p2.y - cy)); cx = p2.x; cy = p2.y; break; }
        case 'Q': { const p1 = P(0), p2 = P(2); out.push('Q' + fmt(p1.x) + ' ' + fmt(p1.y) + ' ' + fmt(p2.x) + ' ' + fmt(p2.y)); cx = sx = p2.x; cy = sy = p2.y; break; }
        case 'q': { const p1 = T({ x: cx + a[0], y: cy + a[1] }), p2 = T({ x: cx + a[2], y: cy + a[3] }); out.push('q' + fmt(p1.x - cx) + ' ' + fmt(p1.y - cy) + ' ' + fmt(p2.x - cx) + ' ' + fmt(p2.y - cy)); cx = p2.x; cy = p2.y; break; }
        case 'T': { const p2 = P(0); out.push('T' + fmt(p2.x) + ' ' + fmt(p2.y)); cx = sx = p2.x; cy = sy = p2.y; break; }
        case 't': { const p2 = T({ x: cx + a[0], y: cy + a[1] }); out.push('t' + fmt(p2.x - cx) + ' ' + fmt(p2.y - cy)); cx = p2.x; cy = p2.y; break; }
        case 'A': {
          const p = T({ x: a[5], y: a[6] });
          out.push('A' + fmt(a[0]) + ' ' + fmt(a[1]) + ' ' + fmt(a[2]) + ' ' + (a[3] ? 1 : 0) + ' ' + (a[4] ? 1 : 0) + ' ' + fmt(p.x) + ' ' + fmt(p.y));
          cx = sx = p.x; cy = sy = p.y; break;
        }
        case 'a': {
          const p = T({ x: cx + a[5], y: cy + a[6] });
          out.push('a' + fmt(a[0]) + ' ' + fmt(a[1]) + ' ' + fmt(a[2]) + ' ' + (a[3] ? 1 : 0) + ' ' + (a[4] ? 1 : 0) + ' ' + fmt(p.x - cx) + ' ' + fmt(p.y - cy));
          cx = p.x; cy = p.y; break;
        }
        case 'Z': case 'z': out.push('Z'); cx = sx; cy = sy; break;
      }
    };
    while ((mt = re.exec(d)) !== null) {
      if (mt[1]) { if (cmd && ni) flush(); cmd = mt[1]; ni = 0; }
      else { args.push(parseFloat(mt[2])); ni++; if (cmd === 'A' || cmd === 'a') { if (ni === 7) flush(); } else if (ni === (consumes(cmd) * 2)) flush(); }
    }
    if (cmd && ni) flush();
    return out.join(' ');
  }
  function consumes(cmd) {
    switch (cmd) {
      case 'M': case 'm': case 'L': case 'l': case 'T': case 't': return 1;
      case 'H': case 'h': case 'V': case 'v': return 1;
      case 'C': case 'c': case 'S': case 's': case 'Q': case 'q': return 3;
      case 'A': case 'a': return 3;
      default: return 1;
    }
  }

  function parseElement(el, parentMat) {
    const tag = (el.localName || '').toLowerCase();
    const m = multiplyMat(parentMat, parseMatrix(el));
    const skip = ['defs', 'clippath', 'mask', 'pattern', 'metadata', 'title', 'desc', 'style', 'symbol', 'marker', 'filter', 'lineargradient', 'radialgradient', 'stop'];
    if (skip.includes(tag)) return null;
    if (tag === 'g') {
      const kids = [];
      for (const ch of Array.from(el.children)) {
        const r = parseElement(ch, m);
        if (r) kids.push(r);
      }
      if (!kids.length) return null;
      const b = bboxOfNodes(kids) || { x: 0, y: 0, w: 10, h: 10 };
      const g = create('group', b, { children: kids });
      g.name = el.getAttribute('data-name') || el.getAttribute('id') || '组合';
      return g;
    }

    let local = null, node = null;
    const st = computedStyleOf(el);
    try { local = el.getBBox(); } catch (e) { local = null; }
    if (!local) return null;
    const c0 = corners({ x: local.x, y: local.y, w: local.width, h: local.height }).map(p => applyMat(m, p));
    const rot = Math.abs(m[1]) + Math.abs(m[2]) > 1e-9 ? deg(Math.atan2(m[1], m[0])) : 0;
    const cc = { x: (c0[0].x + c0[1].x + c0[2].x + c0[3].x) / 4, y: (c0[0].y + c0[1].y + c0[2].y + c0[3].y) / 4 };
    const flat = rot ? c0.map(p => rotatePoint(p, -rot, cc)) : c0;
    const box = boundsOfPoints(flat);
    if (box.w < 0.01 || box.h < 0.01) { box.w = Math.max(box.w, 1); box.h = Math.max(box.h, 1); }

    const base = { x: box.x, y: box.y, w: box.w, h: box.h };
    const mk = (type, opts) => {
      const n = create(type, base, opts || {});
      n.rotation = round(rot, 2);
      if (st) n.style = Object.assign(n.style, {
        fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth,
        opacity: st.opacity, linecap: st.linecap, linejoin: st.linejoin, dash: st.dash,
        fillRule: st.fillRule
      });
      return n;
    };

    if (tag === 'rect') {
      node = mk('rect');
      node.style.rx = num(el.getAttribute('rx'), 0) * (Math.abs(m[0]) || 1);
    } else if (tag === 'circle' || tag === 'ellipse') {
      node = mk('ellipse');
    } else if (tag === 'line') {
      const p1 = applyMat(m, { x: num(el.getAttribute('x1')), y: num(el.getAttribute('y1')) });
      const p2 = applyMat(m, { x: num(el.getAttribute('x2')), y: num(el.getAttribute('y2')) });
      node = mk('line');
      node.w = Math.max(1, Math.abs(p2.x - p1.x));
      node.h = Math.max(1, Math.abs(p2.y - p1.y));
      node.dirX = p2.x >= p1.x ? 1 : -1;
      node.dirY = p2.y >= p1.y ? 1 : -1;
      node.x = Math.min(p1.x, p2.x); node.y = Math.min(p1.y, p2.y);
      node.rotation = 0;
      if (el.getAttribute('marker-end')) node.style.arrow = 'end';
      if (el.getAttribute('marker-start')) node.style.arrow = 'start';
    } else if (tag === 'polyline' || tag === 'polygon') {
      const raw = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter(v => !isNaN(v));
      const world = [];
      for (let i = 0; i + 1 < raw.length; i += 2) world.push(applyMat(m, { x: raw[i], y: raw[i + 1] }));
      const wb = boundsOfPoints(world);
      node = mk(tag === 'polygon' ? 'polygon' : 'polyline');
      node.x = wb.x; node.y = wb.y;
      node.w = Math.max(wb.w, 1); node.h = Math.max(wb.h, 1);
      node.points = world.map(p => [node.w ? (p.x - wb.x) / node.w : 0, node.h ? (p.y - wb.y) / node.h : 0]);
      node.rotation = 0;
    } else if (tag === 'path') {
      // 保留原始 d（经仿射矩阵烘焙为世界坐标），不重采样，以 100% 还原精细路径
      const raw = transformD(el.getAttribute('d') || '', m);
      const world = raw ? dPoints(raw) : samplePath(el, m);
      if (world.length < 2) return null;
      const wb = boundsOfPoints(world);
      node = mk('pencil', { smooth: false });
      node.x = wb.x; node.y = wb.y;
      node.w = Math.max(wb.w, 1); node.h = Math.max(wb.h, 1);
      node.points = world.map(p => [node.w ? (p.x - wb.x) / node.w : 0, node.h ? (p.y - wb.y) / node.h : 0]);
      node.rotation = 0;
      if (raw) node.rawPath = raw; // 导出时直接复用原始 d，避免二次采样变形
      node.style.fill = (st.fill === 'none' || st.fill === 'rgba(0, 0, 0, 0)') ? 'none' : st.fill;
      node.style.fillRule = st.fillRule || 'nonzero';
    } else if (tag === 'text' || tag === 'tspan') {
      node = mk('text');
      const t = node.text;
      t.content = (el.textContent || '').trim();
      let cs = null; try { cs = window.getComputedStyle(el); } catch (e) {}
      t.fontFamily = (cs && cs.fontFamily) || el.getAttribute('font-family') || 'sans-serif';
      t.fontSize = num((cs && cs.fontSize) || el.getAttribute('font-size'), 16);
      t.fontWeight = (cs && cs.fontWeight) || el.getAttribute('font-weight') || '400';
      t.fontStyle = (cs && cs.fontStyle) || 'normal';
      t.textAnchor = (cs && cs.textAnchor) || el.getAttribute('text-anchor') || 'start';
      t.baseline = (cs && cs.dominantBaseline) || el.getAttribute('dominant-baseline') || 'alphabetic';
      node.style.fill = st.fill === '#000000' ? '#243044' : st.fill;
      node.style.stroke = 'none'; node.style.strokeWidth = 0;
      node.rotation = 0;
      // getBBox 的 y 是基线以上，微调为包围盒顶部
      node.y = box.y;
    } else if (tag === 'image') {
      node = mk('image');
      node.href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      node.rotation = 0;
    } else {
      return null;
    }
    node.name = el.getAttribute('data-name') || el.getAttribute('id') || nameOf(node.type);
    return node;
  }
  function multiplyMat(parent, own) {
    const p = parent || [1, 0, 0, 1, 0, 0], o = own;
    return [
      p[0] * o[0] + p[2] * o[1], p[1] * o[0] + p[3] * o[1],
      p[0] * o[2] + p[2] * o[3], p[1] * o[2] + p[3] * o[3],
      p[0] * o[4] + p[2] * o[5] + p[4], p[1] * o[4] + p[3] * o[5] + p[5]
    ];
  }

  function parseDoc(svgText) {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(String(svgText), 'image/svg+xml');
    const err = parsed.querySelector('parsererror');
    if (err || !parsed.documentElement || parsed.documentElement.localName.toLowerCase() !== 'svg') {
      throw new Error('不是有效的 SVG 文件');
    }
    const root = parsed.documentElement;
    sanitize(root);

    // 元数据还原（编辑器自身导出的文件）
    const meta = root.querySelector('metadata#svg-editor-model');
    if (meta) {
      try {
        const model = JSON.parse((meta.textContent || '').trim());
        if (model && Array.isArray(model.nodes)) {
          normalizeDoc(model);
          return { doc: model, restored: true, warnings: [] };
        }
      } catch (e) { /* 继续按标准 SVG 解析 */ }
    }

    const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    let W = num(root.getAttribute('width'), 0), H = num(root.getAttribute('height'), 0);
    if (vb.length === 4 && vb.every(Number.isFinite)) {
      if (!W) W = vb[2]; if (!H) H = vb[3];
    }
    W = W || 1200; H = H || 800;
    const doc = { width: W, height: H, background: '#ffffff', transparent: true, nodes: [] };

    const off = offscreenSvg(W, H);
    const warnings = [];
    const children = Array.from(root.children).filter(el => {
      const t = (el.localName || '').toLowerCase();
      return !['defs', 'metadata', 'title', 'desc', 'style'].includes(t);
    });
    for (const el of children) {
      try {
        const imp = document.importNode(el, true);
        off.appendChild(imp);
      } catch (e) { warnings.push('跳过一个无法导入的元素'); }
    }
    // 重新遍历（导入后的节点才能取 getBBox / getCTM）
    for (const el of Array.from(off.children)) {
      const tag = (el.localName || '').toLowerCase();
      if (tag === 'rect' && el.getAttribute('width') == null && el.getAttribute('height') == null) {
        // 可能的背景矩形
      }
      const n = parseElement(el, [1, 0, 0, 1, 0, 0]);
      if (n) doc.nodes.push(n);
      else if (!['defs', 'metadata', 'title', 'desc', 'style'].includes(tag)) warnings.push('已跳过 <' + tag + '>');
    }
    // 识别纯背景矩形
    if (doc.nodes.length && doc.nodes[0].type === 'rect') {
      const b = doc.nodes[0];
      const full = Math.abs(b.x) < 1 && Math.abs(b.y) < 1 && Math.abs(b.w - W) < 1 && Math.abs(b.h - H) < 1;
      const noStroke = !b.style.stroke || b.style.stroke === 'none' || b.style.strokeWidth === 0;
      if (full && noStroke) {
        if (b.style.fill && b.style.fill !== 'none') doc.background = b.style.fill;
        doc.transparent = !b.style.fill || b.style.fill === 'none';
        doc.nodes.shift();
      }
    }
    normalizeDoc(doc);
    return { doc: doc, restored: false, warnings: warnings };
  }

  function normalizeDoc(doc) {
    doc.width = num(doc.width, 1200);
    doc.height = num(doc.height, 800);
    doc.background = doc.background || '#ffffff';
    doc.transparent = !!doc.transparent;
    doc.nodes = (doc.nodes || []).filter(Boolean);
    eachNode(doc.nodes, n => {
      n.id = n.id || uid(n.type);
      n.visible = n.visible !== false;
      n.locked = !!n.locked;
      n.rotation = num(n.rotation, 0);
      n.flipX = n.flipX === -1 ? -1 : 1;
      n.flipY = n.flipY === -1 ? -1 : 1;
      n.x = num(n.x, 0); n.y = num(n.y, 0);
      n.w = Math.max(0.1, num(n.w, 10)); n.h = Math.max(0.1, num(n.h, 10));
      if (n.type !== 'group' && !n.style) n.style = defaultStyle(n.type);
      if (n.type === 'text' && !n.text) n.text = defaultText();
      if (PATH_TYPES.includes(n.type) && !Array.isArray(n.points)) n.points = [];
      if (n.type === 'group' && !Array.isArray(n.children)) n.children = [];
    });
    return doc;
  }

  /* ---------------------- 示例文档 ---------------------- */
  function demoDoc() {
    const d = { width: 1200, height: 800, background: '#ffffff', transparent: false, nodes: [] };
    const add = n => { d.nodes.push(n); return n; };

    add(create('rect', { x: 80, y: 70, w: 1040, h: 660 }, {
      name: '背景卡片', style: { fill: '#f2f6ff', stroke: '#dce7ff', strokeWidth: 2, rx: 28 }
    }));
    add(create('ellipse', { x: 770, y: 150, w: 240, h: 240 }, {
      name: '装饰圆', style: { fill: '#4f8cff', stroke: 'none', strokeWidth: 0, opacity: 0.14 }
    }));
    add(create('ellipse', { x: 860, y: 250, w: 170, h: 170 }, {
      name: '渐变圆', style: { fill: '#7b5cf5', stroke: 'none', strokeWidth: 0, opacity: 0.9 }
    }));
    add(create('rect', { x: 150, y: 190, w: 120, h: 120 }, {
      name: '圆角方块', style: { fill: '#ff8a3d', stroke: '#e56b1c', strokeWidth: 2, rx: 24 }
    }));
    const star = create('polygon', { x: 830, y: 450, w: 240, h: 230 }, {
      name: '五角星', style: { fill: '#f7c325', stroke: '#d8a412', strokeWidth: 2 }
    });
    star.points = [0.5, 0, 0.62, 0.36, 1, 0.38, 0.7, 0.62, 0.8, 1, 0.5, 0.78, 0.2, 1, 0.3, 0.62, 0, 0.38, 0.38, 0.36]
      .reduce((a, v, i) => { if (i % 2 === 0) a.push([v, 0]); else a[a.length - 1][1] = v; return a; }, []);
    add(star);
    add(create('text', { x: 150, y: 370, w: 520, h: 52 }, {
      name: '标题', text: { content: '用 SVG 画出你的想法', fontFamily: 'sans-serif', fontSize: 40, fontWeight: '700' },
      style: { fill: '#1b2940', stroke: 'none', strokeWidth: 0 }
    }));
    add(create('text', { x: 150, y: 438, w: 500, h: 62 }, {
      name: '说明文字', text: { content: '选择、绘制、变换与导出。\n所有操作都在浏览器本地完成。', fontFamily: 'sans-serif', fontSize: 19, fontWeight: '400', lineHeight: 1.55 },
      style: { fill: '#5b6b83', stroke: 'none', strokeWidth: 0 }
    }));
    add(create('rect', { x: 150, y: 555, w: 176, h: 56 }, {
      name: '按钮', style: { fill: '#3f7ef7', stroke: 'none', strokeWidth: 0, rx: 12 }
    }));
    add(create('text', { x: 196, y: 571, w: 84, h: 30 }, {
      name: '按钮文字', text: { content: '开始创作', fontFamily: 'sans-serif', fontSize: 21, fontWeight: '600' },
      style: { fill: '#ffffff', stroke: 'none', strokeWidth: 0 }
    }));
    const arr = create('arrow', { x: 380, y: 575, w: 250, h: 0.1 }, {
      name: '指示箭头', style: { stroke: '#28c39a', strokeWidth: 4, arrow: 'end', fill: 'none' }
    });
    arr.dirY = 1; add(arr);
    add(create('rect', { x: 660, y: 545, w: 170, h: 76 }, {
      name: '小卡片', style: { fill: '#ffffff', stroke: '#28c39a', strokeWidth: 2, rx: 14 }
    }));
    add(create('text', { x: 692, y: 566, w: 110, h: 34 }, {
      name: '卡片文字', text: { content: 'Export SVG', fontFamily: 'monospace', fontSize: 19, fontWeight: '600' },
      style: { fill: '#28c39a', stroke: 'none', strokeWidth: 0 }
    }));
    return d;
  }

  global.Core = {
    NS, PALETTE, SHAPE_TYPES, PATH_TYPES, LINE_TYPES,
    uid, clone, num, fmt, clamp, round, esc, deg, rad, rotatePoint,
    defaultStyle, defaultText, create, nameOf,
    center, nodeTransform, toLocal, toWorld, localBox, bbox, corners, boundsOfPoints, union, bboxOfNodes,
    distToSegment, pointInPolygon, absPoints, lineEnds, hitTest,
    eachNode, moveNodes, scaleNodeGeom, scaleNodes, setRotationAround,
    findNode, descendants,
    styleAttrs, arrowHead, pathFromPoints, serializeElement, serializeDoc,
    cssColorToHex, isValidColor, parseDoc, normalizeDoc, demoDoc
  };
})(window);
