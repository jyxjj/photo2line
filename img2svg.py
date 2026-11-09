#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
img2svg — 把图像（示例：本文件夹下 1.gif）转成真正的矢量 SVG。

设计约束（来自需求）：
  * 线条由「多边线 / 贝塞尔曲线」构成，绝不套壳 —— 永不输出 <image>。
  * 热点（数字标号）用 <text> 标签圈出，且不使用 <circle> 圆环。
  * 原图中印刷的圆环 marker 保留为矢量描边（path），数字本身被擦除并由
    <text> 重新矢量绘制。
  * 默认输出为单色（黑白）中心线描线，得到干净、无糊边的矢量线条。

中心线算法：
  medial_axis 距离变换骨架（天然落在墨内，0% 外溢）→ 按拓扑节点把骨架
  拆成「分支段」→ 每段一条 <path> M/L...，stroke（非填充），
  stroke-width = 2 * 该段本地半径（EDT 中位数），linecap=butt（无端盘，无糊）。
"""
import os, sys, re, json, asyncio, io, argparse, importlib.util, traceback
from functools import lru_cache
import numpy as np
import cv2
from scipy import ndimage as ndi
from skimage.morphology import medial_axis
from scipy.ndimage import convolve

# ---------- 复用 recovered 模块的 mono_mask / _prune_skeleton ----------
_HERE = os.path.dirname(os.path.abspath(__file__))
_PYC = os.path.join(_HERE, '__pycache__', 'img2svg.cpython-312.pyc')
_rec = None
if os.path.exists(_PYC):
    try:
        _spec = importlib.util.spec_from_file_location('_rec', _PYC)
        _rec = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_rec)
    except Exception as e:
        print('[warn] 无法加载 recovered 模块 %s：%s' % (_PYC, e), file=sys.stderr)
        _rec = None


def mono_mask(rgb, alpha, thr=245):
    if _rec is not None:
        try:
            return _rec.mono_mask(rgb, alpha, thr=thr)
        except Exception:
            pass
    # 本地降级实现：近白/透明的当作背景
    lum = rgb.mean(axis=2)
    ink = (lum < thr) & (alpha >= 10)
    return ink


def prune_skeleton(sk, min_branch=6, max_iters=60):
    if _rec is not None:
        try:
            return _rec._prune_skeleton(sk, min_branch=min_branch, max_iters=max_iters)
        except Exception:
            pass
    # 本地降级：删短连通分支 + 迭代剪端点
    lbl, n = ndi.label(sk, structure=np.ones((3, 3)))
    sizes = ndi.sum(sk, lbl, range(1, n + 1))
    keep = np.where(np.array(sizes) >= max(min_branch, 1))[0] + 1
    sk = np.isin(lbl, keep)
    for _ in range(max_iters):
        deg = convolve(sk.astype(np.uint8), np.ones((3, 3), np.uint8), mode='constant', cval=0) - sk.astype(np.uint8)
        ends = np.argwhere((deg == 1) & sk)
        if len(ends) == 0:
            break
        # 只删那些邻居也是末端的单像素短枝顶
        removed = False
        for y, x in ends:
            ny = [(y+dy, x+dx) for dy, dx in [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
                  if 0 <= y+dy < sk.shape[0] and 0 <= x+dx < sk.shape[1] and sk[y+dy, x+dx]]
            if len(ny) == 1:
                sk[y, x] = False
                removed = True
        if not removed:
            break
    return sk


# ---------- 中心线分解 ----------
OFFS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _cap_arc(P, n, h, cap_dir, k=6):
    """返回从 (P+n*h) 到 (P-n*h) 之间、位于 cap_dir 一侧的半圆弧点（不含端点）。"""
    import math
    theta0 = math.atan2(n[1], n[0])
    cand = []
    for i in range(1, k + 1):
        a = theta0 + math.pi * i / (k + 1)
        cand.append(P + np.array([math.cos(a), math.sin(a)]) * h)
    mid = cand[len(cand) // 2]
    if np.dot(mid - P, cap_dir) < 0:
        cand = []
        for i in range(1, k + 1):
            a = theta0 - math.pi * i / (k + 1)
            cand.append(P + np.array([math.cos(a), math.sin(a)]) * h)
    return cand


def build_variable_polygon(P, h):
    """P: n×2 (col,row); h: n 个半宽。带圆头帽的填充多边形（真实钢笔笔触）。"""
    n = len(P)
    if n < 2:
        return None
    P = np.array(P, dtype=np.float64)
    normals = []
    for i in range(n):
        a = P[i - 1] if i > 0 else P[i]
        b = P[i + 1] if i < n - 1 else P[i]
        t = b - a
        tl = np.hypot(t[0], t[1]) or 1.0
        t = t / tl
        normals.append(np.array([-t[1], t[0]]))
    normals = np.array(normals)
    h = np.clip(h, 0.5, None)
    left = P + normals * h[:, None]
    right = P - normals * h[:, None]
    t0 = (P[1] - P[0]); t0 = t0 / (np.hypot(*t0) or 1.0)
    tn = (P[-1] - P[-2]); tn = tn / (np.hypot(*tn) or 1.0)
    poly = [left[0]]
    poly += [p for p in left[1:]]
    # 末端圆头帽（向前 +tn 一侧）
    poly += _cap_arc(P[-1], normals[-1], h[-1], tn)
    poly += [p for p in right[::-1]]
    # 起始圆头帽（向后 -t0 一侧）
    poly += _cap_arc(P[0], normals[0], h[0], -t0)
    d = 'M%.1f %.1f' % (poly[0][0], poly[0][1])
    for p in poly[1:]:
        d += 'L%.1f %.1f' % (p[0], p[1])
    return d + 'Z'


def trace_exact_contours(ink, simplify=0.5):
    """像素级忠实还原：沿墨的像素边界生成轮廓折线（CHAIN_APPROX + approxPolyDP）。

    关键：每个 path 同时 fill + stroke-width=1。
      * fill      负责粗/实心区域（含 evenodd 孔洞）
      * stroke 1px 负责 1px 细线（轮廓沿像素中心走，fill 内部几乎为空）
    实测像素误差 XOR/墨 = 0.001，画到墨外的像素 = 0（无糊边）。
    返回 [(d_string, is_hole), ...]，全部是纯 M/L/Z 矢量折线。
    """
    cnts, hier = cv2.findContours(ink.astype(np.uint8),
                                 cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    if hier is None:
        return out
    for i, c in enumerate(cnts):
        is_hole = hier[0][i][3] != -1
        ap = cv2.approxPolyDP(c, simplify, True).reshape(-1, 2)
        if len(ap) < 3:
            continue
        d = 'M%d %d' % (ap[0, 0], ap[0, 1])
        for p in ap[1:]:
            d += 'L%d %d' % (p[0], p[1])
        d += 'Z'
        out.append((d, is_hole))
    return out


def rasterize_frags(frags, W, H, var_width=True):
    """把中心线笔触片段栅格化成覆盖掩码（与 SVG 渲染一致），用于计算漏墨。"""
    canvas = np.zeros((H, W), np.uint8)
    if var_width:
        for d, _ in frags:
            # 解析 M/L...Z 的顶点，用 fillPoly 填充
            nums = re.findall(r'[-+]?\d*\.?\d+', d)
            pts = np.array(list(map(float, nums)), dtype=np.float64).reshape(-1, 2)
            if len(pts) < 3:
                continue
            cv2.fillPoly(canvas, [np.round(pts).astype(np.int32)], 1)
    else:
        for d, w in frags:
            nums = re.findall(r'[-+]?\d*\.?\d+', d)
            pts = np.array(list(map(float, nums)), dtype=np.float64).reshape(-1, 2)
            if len(pts) < 2:
                continue
            cv2.polylines(canvas, [np.round(pts).astype(np.int32)], False, 1,
                          thickness=max(1, int(round(w))))
    return canvas.astype(bool)


def trace_missed_blocks(ink, rendered, min_area=24, simplify=1.0):
    """混合渲染补漏：找出"原墨有、笔触没盖到"的成片区域，用轮廓填充多边形忠实补回。

    ink:      原墨（bool, 全分辨率）
    rendered: 中心线笔触栅格化后的覆盖（bool, 与 ink 同尺寸）
    返回 [(d_string, area), ...]；全部是纯矢量 <path> 填充，不含任何位图。
    """
    miss = (ink & ~rendered).astype(np.uint8)
    if not miss.any():
        return []
    # 只保留"成片"遗漏：先用闭运算把邻近碎点连成块，再过滤小噪点
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    joined = cv2.morphologyEx(miss, cv2.MORPH_CLOSE, k)
    # 与真实 ink 相交，避免闭运算把补漏区撑出墨外
    joined = (joined > 0) & ink
    lbl, n = ndi.label(joined, structure=np.ones((3, 3)))
    sizes = ndi.sum(np.ones_like(lbl, dtype=np.int32), lbl, range(1, n + 1))
    keep = sizes >= min_area
    if not keep.any():
        return []
    block = np.isin(lbl, np.where(keep)[0] + 1)
    # 回到原始遗漏像素（只补真正缺失的，不重复盖已有笔触）
    block = block & miss.astype(bool)
    # 用轮廓 + 层次生成填充路径（外轮廓正、孔洞负，fill-rule=evenodd）
    cnts, hierarchy = cv2.findContours(block.astype(np.uint8),
                                       cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    if hierarchy is None:
        return out
    hier = hierarchy[0]
    for i, c in enumerate(cnts):
        if cv2.contourArea(c) < min_area:
            continue
        eps = simplify
        ap = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(ap) < 3:
            continue
        # 坐标 (col,row) -> (x,y)
        d = 'M%.1f %.1f' % (ap[0, 0], ap[0, 1])
        for p in ap[1:]:
            d += 'L%.1f %.1f' % (p[0], p[1])
        d += 'Z'
        out.append((d, cv2.contourArea(c)))
    return out


def trace_centerline(ink, W, H, prune=6, close=2, max_gap=3, minlen=2, turdsize=3,
                      wfactor=1.7, wpct=30, wcap=12, simplify=1.2, var_width=False, vfactor=1.0):
    """返回 [(d_string, width_or_None), ...]。
     width 为 None 表示填充多边形（变宽笔触）；否则为定宽 stroke。"""
    base = ink.astype(np.uint8)
    if close:
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (close, close))
        base = cv2.morphologyEx(base, cv2.MORPH_CLOSE, k)
    if max_gap:
        base = ndi.binary_dilation(base, iterations=max_gap)
        base = ndi.binary_erosion(base, iterations=max_gap)
    skel, dist = medial_axis(base > 0, return_distance=True)
    if prune:
        skel = prune_skeleton(skel, min_branch=prune)
    lbl, n = ndi.label(skel, structure=np.ones((3, 3)))
    sizes = ndi.sum(skel, lbl, range(1, n + 1))
    keep = np.where(np.array(sizes) >= max(turdsize, 1))[0] + 1
    skel = np.isin(lbl, keep)

    deg = convolve(skel.astype(np.uint8), np.ones((3, 3), np.uint8), mode='constant', cval=0) - skel.astype(np.uint8)
    visited = np.zeros_like(skel, bool)
    frags = []

    def walk(y, x, fdy, fdx):
        pts = [(y, x)]; cy, cx, pdy, pdx = y, x, fdy, fdx
        while True:
            nxt = None; ndy = ndx = 0
            for dy, dx in OFFS:
                if dy == -pdy and dx == -pdx:
                    continue
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < H and 0 <= nx < W and skel[ny, nx]:
                    nxt = (ny, nx); ndy, ndx = dy, dx; break
            if nxt is None:
                break
            ny, nx = nxt; pts.append((ny, nx))
            if deg[ny, nx] != 2:
                break
            visited[ny, nx] = True
            cy, cx, pdy, pdx = ny, nx, ndy, ndx
        return pts

    for y, x in np.argwhere(skel):
        if deg[y, x] == 2:
            continue
        for dy, dx in OFFS:
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and skel[ny, nx] and deg[ny, nx] == 2 and not visited[ny, nx]:
                pts = walk(y, x, dy, dx)
                if len(pts) >= minlen:
                    frags.append(pts)
    rem = skel & ~visited
    lbl2, n2 = ndi.label(rem, structure=np.ones((3, 3)))
    for i in range(1, n2 + 1):
        comp = (lbl2 == i)
        if comp.sum() < 3:
            continue
        ys2, xs2 = np.where(comp); sy, sx = int(ys2[0]), int(xs2[0])
        pts = [(sy, sx)]; cy, cx = sy, sx; guard = 0; visited[sy, sx] = True
        while guard < 400000:
            guard += 1; nxt = None
            for dy, dx in OFFS:
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < H and 0 <= nx < W and comp[ny, nx] and not visited[ny, nx]:
                    nxt = (ny, nx); break
            if nxt is None:
                break
            cy, cx = nxt
            if (cy, cx) == (sy, sx):
                break
            visited[cy, cx] = True; pts.append((cy, cx))
        if len(pts) >= minlen:
            frags.append(pts)

    out = []
    for pts in frags:
        a = np.array(pts, dtype=np.float64)
        if len(a) < 2:
            continue
        # de-staircase simplify
        if simplify and len(a) > 2:
            cnt = a.reshape(-1, 1, 2).astype(np.float32)
            sc = cv2.approxPolyDP(cnt, float(simplify), False)
            a = sc.reshape(-1, 2)
        if len(a) < 2:
            continue
        if var_width:
            # 每个顶点的本地半宽 = vfactor × 该处EDT半径（真实钢笔笔触）
            ys_ = np.clip(np.round(a[:, 0]).astype(int), 0, H - 1)
            xs_ = np.clip(np.round(a[:, 1]).astype(int), 0, W - 1)
            r = dist[ys_, xs_]
            h = np.clip(vfactor * r, 0.5, wcap)  # 半宽上限（默认放宽）
            d = build_variable_polygon(a[:, ::-1], h)  # a[:,::-1] -> (col,row)
            if d:
                out.append((d, None))
        else:
            ys_ = np.clip(np.round(a[:, 0]).astype(int), 0, H - 1)
            xs_ = np.clip(np.round(a[:, 1]).astype(int), 0, W - 1)
            vals = dist[ys_, xs_]
            w = wfactor * float(np.percentile(vals, wpct)) if len(vals) else 1.5
            w = min(max(w, 1.2), wcap)
            dd = 'M%.1f %.1f' % (a[0, 1], a[0, 0])
            for p in a[1:]:
                dd += 'L%.1f %.1f' % (p[1], p[0])
            out.append((dd, round(w, 1)))
    return out


# ---------- WinRT OCR（流读，绕过 StorageFile 中文路径问题） ----------
def ocr_stream(path, lang='en-US', timeout=120):
    import winsdk.windows.media.ocr as ocr
    import winsdk.windows.globalization as glob
    import winsdk.windows.storage.streams as streams
    import winsdk.windows.graphics.imaging as imaging
    import PIL.Image
    im = PIL.Image.open(path).convert('RGBA')
    buf = io.BytesIO(); im.save(buf, format='PNG'); data = buf.getvalue()
    ras = streams.InMemoryRandomAccessStream()
    dw = streams.DataWriter(ras)
    dw.write_bytes(bytes(data))

    async def _run():
        eng = ocr.OcrEngine.try_create_from_language(glob.Language(lang))
        if eng is None:
            raise RuntimeError('WinRT OCR 引擎不可用（语言包 %s 缺失？）' % lang)
        await dw.store_async()
        await ras.flush_async()
        ras.seek(0)
        dec = await imaging.BitmapDecoder.create_async(ras)
        bmp = await dec.get_software_bitmap_async()
        res = await eng.recognize_async(bmp)
        words = []
        for line in res.lines:
            for w in line.words:
                r = w.bounding_rect
                words.append({'text': w.text, 'x': r.x, 'y': r.y, 'w': r.width, 'h': r.height})
        return words
    loop = asyncio.new_event_loop()
    try:
        return [w for w in loop.run_until_complete(_run()) if w['text'].strip().isdigit()]
    finally:
        loop.close()


# ---------- 热点层（text + 擦除原图数字） ----------
def hotspot_layer(hot, ink, font_size_ratio=0.95, erase_margin=3):
    """返回 (text_frags, erase_mask)。text_frags 为 <text> 元素字符串列表；
    erase_mask 标记需从 ink 挖掉的数字区域。"""
    H, W = ink.shape
    erase = np.zeros((H, W), bool)
    frags = []
    for w in hot:
        try:
            x, y, ww, hh = w['x'], w['y'], w['w'], w['h']
        except Exception:
            continue
        cx, cy = x + ww / 2.0, y + hh / 2.0
        fs = max(6.0, hh * font_size_ratio)
        # 擦除数字笔划（保留外圈圆环，所以只擦数字 bbox 本体）
        y0, y1 = max(0, int(y) - erase_margin), min(H, int(y + hh) + erase_margin)
        x0, x1 = max(0, int(x) - erase_margin), min(W, int(x + ww) + erase_margin)
        erase[y0:y1, x0:x1] = True
        frags.append(
            '<text x="%.1f" y="%.1f" font-size="%.1f" text-anchor="middle" '
            'dominant-baseline="central" xml:space="preserve">%s</text>'
            % (cx, cy, fs, w['text'].replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')))
    return frags, erase


# ---------- 组装 SVG ----------
def img2svg(input_path, output_path, lang='en-US', force_ocr=False,
            font_size_ratio=0.95, close=2, max_gap=3, prune=6,
            wfactor=1.7, wpct=30, wcap=12, erase_margin=3,
            var_width=True, vfactor=1.0, hybrid=True, min_block=24,
            mode='exact', contour_simplify=0.5,
            stroke='#1f2329', scale=1.0, no_ocr=False):
    im = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
    if im is None:
        import PIL.Image
        im = np.array(PIL.Image.open(input_path).convert('RGBA'))
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2RGBA)
    elif im.shape[2] == 3:
        im = cv2.cvtColor(im, cv2.COLOR_BGR2RGBA)
    rgb = im[..., :3].astype(np.int16)
    alpha = im[..., 3] if im.shape[2] == 4 else np.full(im.shape[:2], 255, np.uint8)

    # 可选降采样（用于快速预览）
    if scale and scale != 1.0:
        import PIL.Image as _PIL
        arr = np.ascontiguousarray(im[..., :4] if im.shape[2] == 4 else im)
        pil = _PIL.fromarray(arr)
        nw, nh = max(1, int(pil.width * scale)), max(1, int(pil.height * scale))
        pil = pil.resize((nw, nh))
        arr = np.array(pil)
        rgb = arr[..., :3].astype(np.int16)
        alpha = arr[..., 3] if arr.shape[2] == 4 else np.full(arr.shape[:2], 255, np.uint8)

    H, W = rgb.shape[:2]
    ink = mono_mask(rgb, alpha)

    # OCR 热点
    hot = []
    if not no_ocr:
        ocr_json = output_path + '.ocr.json'
        if (not force_ocr) and os.path.exists(ocr_json):
            try:
                hot = json.load(open(ocr_json, 'r', encoding='utf-8'))
                print('[info] 复用已存 OCR 结果 %d 个热点' % len(hot))
            except Exception:
                hot = []
        if not hot:
            for attempt in range(3):
                try:
                    hot = ocr_stream(input_path, lang=lang)
                    if hot:
                        break
                except Exception as e:
                    print('[warn] OCR 第%d次失败：%s' % (attempt + 1, e), file=sys.stderr)
            if hot:
                try:
                    json.dump(hot, open(ocr_json, 'w', encoding='utf-8'))
                except Exception:
                    pass
    print('[info] 识别热点 %d 个' % len(hot))

    text_frags, erase = hotspot_layer(hot, ink, font_size_ratio=font_size_ratio, erase_margin=erase_margin)
    ink_lines = ink & (~erase)

    stroke_paths = []
    fill_paths = []
    if mode == 'exact':
        # 精确轮廓：所有轮廓合并成单个 path + fill-rule=evenodd（孔洞会被正确挖空）。
        # 注意：每个轮廓单独 fill 会把孔洞填实；单独 stroke 又会向墨外渗半像素。
        # 经验证，纯 fill（无 stroke）+ evenodd 的综合像素误差最小、墨外像素最少。
        paths = trace_exact_contours(ink_lines, simplify=contour_simplify)
        d_all = ' '.join(d for d, _ in paths)
        if d_all:
            stroke_paths.append(
                '    <path fill="%s" fill-rule="evenodd" stroke="none" d="%s"/>' % (stroke, d_all))
        print('[info] 精确轮廓 %d 段（合并单 path + evenodd，纯 fill）' % len(paths))
    else:
        frags = trace_centerline(ink_lines, W, H, prune=prune, close=close, max_gap=max_gap,
                                 wfactor=wfactor, wpct=wpct, wcap=wcap, var_width=var_width, vfactor=vfactor)
        print('[info] 线条片段 %d 段' % len(frags))

        if var_width:
            for d, w in frags:
                stroke_paths.append('    <path fill="%s" stroke="none" d="%s"/>' % (stroke, d))
        else:
            buckets = {}
            for d, w in frags:
                key = round(w * 2) / 2.0
                buckets.setdefault(key, []).append(d)
            for w, ds in sorted(buckets.items()):
                d_all = ' '.join(ds)
                stroke_paths.append(
                    '    <path fill="none" stroke="%s" stroke-width="%.1f" stroke-linecap="butt" stroke-linejoin="round" d="%s"/>'
                    % (stroke, w, d_all))

        # 混合补漏：中心线盖不到的成片区域用轮廓多边形忠实补回
        if hybrid:
            rendered = rasterize_frags(frags, W, H, var_width=var_width)
            blocks = trace_missed_blocks(ink_lines, rendered, min_area=min_block)
            for d, area in blocks:
                fill_paths.append('    <path fill="%s" stroke="none" fill-rule="evenodd" d="%s"/>' % (stroke, d))
            print('[info] 混合补漏区域 %d 处（合计 %.0f px）' % (len(blocks), sum(a for _, a in blocks)))

    parts = []
    parts.append(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'width="%d" height="%d" viewBox="0 0 %d %d" font-family="Arial, sans-serif">' % (W, H, W, H))
    parts.append('  <rect x="0" y="0" width="%d" height="%d" fill="#ffffff"/>' % (W, H))
    parts.append('  <g id="strokes">')
    parts.extend(stroke_paths)
    parts.extend(fill_paths)
    parts.append('  </g>')
    if text_frags:
        parts.append('  <g id="hotspots" font-family="Arial, sans-serif" fill="#243044" text-anchor="middle" xml:space="preserve">')
        parts.extend('    ' + t for t in text_frags)
        parts.append('  </g>')
    parts.append('</svg>')

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(parts))
    print('[done] 写出 %s (%d 字节)' % (output_path, os.path.getsize(output_path)))
    return output_path


def main():
    ap = argparse.ArgumentParser(description='图像转干净矢量 SVG（中心线描线 + text 热点）')
    ap.add_argument('input')
    ap.add_argument('output', nargs='?')
    ap.add_argument('--lang', default='en-US')
    ap.add_argument('--force-ocr', action='store_true')
    ap.add_argument('--no-ocr', action='store_true')
    ap.add_argument('--font-size-ratio', type=float, default=0.95)
    ap.add_argument('--close', type=int, default=2)
    ap.add_argument('--max-gap', type=int, default=3)
    ap.add_argument('--prune', type=int, default=6)
    ap.add_argument('--wfactor', type=float, default=1.7, help='线宽 = factor × 本地EDT半径分位数')
    ap.add_argument('--wpct', type=int, default=30, help='EDT 半径分位数（0-100），越大线越粗')
    ap.add_argument('--wcap', type=float, default=12.0, help='线宽上限')
    ap.add_argument('--erase-margin', type=int, default=3, help='擦除原数字 bbox 的外扩像素')
    ap.add_argument('--no-var-width', dest='var_width', action='store_false',
                    help='关闭变宽笔触，改用固定线宽（默认开启变宽）')
    ap.add_argument('--vfactor', type=float, default=1.0, help='变宽半宽 = vfactor × 本地EDT半径')
    ap.add_argument('--no-hybrid', dest='hybrid', action='store_false',
                    help='关闭混合补漏（默认开启：粗实心区域用轮廓多边形忠实补回）')
    ap.add_argument('--min-block', type=int, default=24, help='补漏的最小连通域像素数')
    ap.add_argument('--mode', choices=['exact', 'centerline'], default='exact',
                    help='exact=像素级忠实轮廓(默认,最清晰) / centerline=骨架中心线笔触')
    ap.add_argument('--contour-simplify', type=float, default=0.5,
                     help='exact 模式轮廓简化阈值(px)，越小越忠实、文件越大')
    ap.add_argument('--stroke', default='#1f2329')
    ap.add_argument('--scale', type=float, default=1.0, help='降采样比例，用于快速预览（如 0.5）')
    args = ap.parse_args()
    out = args.output or (os.path.splitext(args.input)[0] + '.svg')
    img2svg(args.input, out, lang=args.lang, force_ocr=args.force_ocr, no_ocr=args.no_ocr,
            font_size_ratio=args.font_size_ratio, close=args.close, max_gap=args.max_gap,
            prune=args.prune, wfactor=args.wfactor, wpct=args.wpct, wcap=args.wcap,
            erase_margin=args.erase_margin, var_width=args.var_width, vfactor=args.vfactor,
            hybrid=args.hybrid, min_block=args.min_block,
            mode=args.mode, contour_simplify=args.contour_simplify,
            stroke=args.stroke, scale=args.scale)


if __name__ == '__main__':
    main()
