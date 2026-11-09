#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
photo2line — 零部件实物照片 → 干净的 2D 线条图（真正的矢量 SVG + 高清 PNG）

设计目标
--------
零件的「实物照片」和「工程线稿」差别很大：照片里有光照渐变、金属高光、
投影、纹理和背景。直接二值化/描轮廓会得到一堆斑块，而不是线条。
本模块的处理链是：

    1. 读图 / 可选放大            (Pillow + OpenCV)
    2. 光照平坦化                 大尺度背景估计 ÷ 原图，抹掉渐变与暗角
    3. 抑噪                      bilateral / 非局部均值，保边不糊边
    4. 结构边缘                   多尺度 DoG / xDoG + 局部对比归一化
    5. 线条化                     软阈值 + 形态学闭运算补断笔 + 骨架化
    6. 去噪点                     连通域面积/长度过滤，去掉纹理毛刺
    7. 矢量化                     轮廓跟踪 → 三次贝塞尔拟合 → <path>
    8. 渲染 PNG                   PyMuPDF(优先) / Edge headless / OpenCV 兜底

输出绝不包含 <image> 或 base64 位图套壳：SVG 里只有 rect / g / path。
线条既可以选择「填充轮廓」(默认，笔画粗细完全忠实于图)，也可以选择
「中心线描边」(可统一设置 line_width，方便后续在编辑器里改线宽)。

命令行
------
    python photo2line.py part.jpg out.svg
    python photo2line.py part.jpg out.svg --png out.png --preset detailed
    python photo2line.py part.jpg out.svg --transparent --invert
    python photo2line.py part.jpg out.svg --debug-dir debug/

Python API
----------
    from photo2line import convert
    result = convert(image_bytes, {'preset': 'clean', 'invert': True})
    open('out.svg','w').write(result['svg'])
    open('out.png','wb').write(result['png'])
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass, asdict, field
from typing import Any, Iterable

import cv2
import numpy as np
from PIL import Image, ImageOps

__version__ = "1.0.0"

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------

PRESETS: dict[str, dict[str, Any]] = {
    #             降噪   细节  最小域  简化   线宽  放大  透明  反色  裁边
    "auto":     dict(denoise=1.5, detail=50, min_area=24, simplify=0.8,
                     line_width=1.2, upscale=1.0, transparent=False,
                     invert=False, crop=True, stroke="#1a1a1a", bg="#ffffff"),
    "clean":    dict(denoise=2.5, detail=35, min_area=60, simplify=1.4,
                     line_width=1.4, upscale=1.0, transparent=False,
                     invert=False, crop=True, stroke="#1a1a1a", bg="#ffffff"),
    "detailed": dict(denoise=0.8, detail=75, min_area=10, simplify=0.35,
                     line_width=1.0, upscale=1.5, transparent=False,
                     invert=False, crop=True, stroke="#1a1a1a", bg="#ffffff"),
    "blueprint": dict(denoise=1.5, detail=55, min_area=24, simplify=0.8,
                      line_width=1.1, upscale=1.0, transparent=False,
                      invert=True, crop=True, stroke="#dceaff", bg="#0d2b4e"),
}

_BOOL_TRUE = {"1", "true", "yes", "on", "y", "t"}
_BOOL_FALSE = {"0", "false", "no", "off", "n", "f", "", "none"}
_HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _as_bool(v: Any, default: bool = False) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    if s in _BOOL_TRUE:
        return True
    if s in _BOOL_FALSE:
        return False
    return default


def _as_num(v: Any, default: float, lo: float, hi: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float(default)
    if not math.isfinite(f):
        return float(default)
    return float(min(max(f, lo), hi))


def _as_int(v: Any, default: int, lo: int, hi: int) -> int:
    return int(round(_as_num(v, default, lo, hi)))


def _as_color(v: Any, default: str) -> str:
    if v is None:
        return default
    s = str(v).strip()
    if s.lower() in ("transparent", "none", ""):
        return "transparent"
    if _HEX_COLOR.match(s):
        if len(s) == 4:
            s = "#" + "".join(c * 2 for c in s[1:])
        return s.lower()
    # 少量安全颜色名（避免任意字符串进入 SVG 属性）
    named = {
        "black": "#000000", "white": "#ffffff", "red": "#e02020",
        "blue": "#1d4ed8", "navy": "#0d2b4e", "gray": "#808080",
        "grey": "#808080", "silver": "#c0c0c0",
    }
    return named.get(s.lower(), default)


@dataclass
class Params:
    preset: str = "auto"
    denoise: float = 1.5          # 0..5  降噪强度
    detail: float = 50.0          # 0..100 细节灵敏度
    min_area: int = 24            # 最小连通域面积(px²)
    simplify: float = 0.8         # 0..5  轮廓简化(px)
    line_width: float = 1.2       # 0.1..10  输出线条粗细（两种模式均生效）
    upscale: float = 1.0          # 1..3  输入放大倍率
    stroke: str = "#1a1a1a"       # 线条颜色
    bg: str = "#ffffff"           # 背景色或 transparent
    transparent: bool = False
    invert: bool = False          # True = 深底浅线
    crop: bool = True             # 自动裁掉多余白边
    centerline: bool = False      # True = 骨架中心线描边(统一线宽)
    flat_light: bool = True       # 光照平坦化
    close_gap: int = 2            # 断笔桥接半径
    png_scale: float = 1.0        # PNG 相对 SVG 的倍率
    ai_model: str = ""            # 可选 ONNX 边缘/线稿模型路径（留空=自动查找 models/）

    @staticmethod
    def from_dict(raw: dict[str, Any] | None) -> "Params":
        raw = raw or {}
        preset = str(raw.get("preset") or "auto").strip().lower()
        if preset not in PRESETS:
            preset = "auto"
        p = Params(preset=preset, **PRESETS[preset])
        # 显式传入的字段覆盖预设
        p.denoise = _as_num(raw.get("denoise", p.denoise), p.denoise, 0, 5)
        p.detail = _as_num(raw.get("detail", p.detail), p.detail, 0, 100)
        p.min_area = _as_int(raw.get("min_area", p.min_area), p.min_area, 0, 100000)
        p.simplify = _as_num(raw.get("simplify", p.simplify), p.simplify, 0, 5)
        p.line_width = _as_num(raw.get("line_width", p.line_width), p.line_width, 0.1, 10)
        p.upscale = _as_num(raw.get("upscale", p.upscale), p.upscale, 1, 3)
        p.png_scale = _as_num(raw.get("png_scale", p.png_scale), p.png_scale, 0.25, 4)
        p.close_gap = _as_int(raw.get("close_gap", p.close_gap), p.close_gap, 0, 8)
        p.ai_model = str(raw.get("ai_model") or "")[:500]
        p.stroke = _as_color(raw.get("stroke", p.stroke), p.stroke)
        p.bg = _as_color(raw.get("bg", p.bg), p.bg)
        for k in ("transparent", "invert", "crop", "centerline", "flat_light"):
            if k in raw:
                setattr(p, k, _as_bool(raw[k], getattr(p, k)))
        # 反色 / 透明 联动：
        # Web 界面每次都会显式发送 bg / stroke，所以这里按「是否仍是默认浅底深线」
        # 判断，而不是按「字段是否出现」。用户/蓝图预设自定义的颜色保持不变。
        if p.invert:
            if p.bg == "#ffffff":
                p.bg = "#101820"
            if p.stroke == "#1a1a1a":
                p.stroke = "#eef4ff"
        if p.transparent:
            p.bg = "transparent"
        return p

    def public(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# 图像读取与预处理
# ---------------------------------------------------------------------------

def load_image(data: bytes, upscale: float = 1.0) -> np.ndarray:
    """bytes -> BGR uint8（含 alpha 时先合成到白底）。"""
    try:
        pil = Image.open(io.BytesIO(data))
        pil = ImageOps.exif_transpose(pil)
        pil = pil.convert("RGBA")
    except Exception as e:
        raise ValueError("无法读取图片（不是有效的图片文件）：%s" % e)
    w, h = pil.size
    # 防止超大图把内存打爆
    max_pixels = 40_000_000
    if w * h > max_pixels:
        k = math.sqrt(max_pixels / (w * h))
        pil = pil.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
    # alpha 合成到白底
    rgba = np.asarray(pil, dtype=np.uint8)
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    rgb = (rgba[..., :3].astype(np.float32) * a + 255.0 * (1 - a)).clip(0, 255).astype(np.uint8)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    if upscale and abs(upscale - 1.0) > 1e-6:
        bgr = cv2.resize(bgr, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)
    return bgr


def to_gray(bgr: np.ndarray) -> np.ndarray:
    """彩色 → 灰度，取 LAB 的 L 通道更接近人眼，顺便做 CLAHE 前的准备。"""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    return lab[..., 0]


def flatten_illumination(gray: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """大尺度背景估计 + 除法平坦化：消除摄影棚渐变、暗角、单侧打光。

    这一步是「照片 → 线稿」最关键的一步：金属件的高光/阴影是低频量，
    把它们除掉之后，剩下的高频才是真正的结构边缘。
    """
    g = gray.astype(np.float32) / 255.0
    h, w = g.shape
    # 背景尺度取短边的 1/4，最多 400px，避免把结构本身当成背景
    k = int(max(15, min(400, min(h, w) / 4)))
    if k % 2 == 0:
        k += 1
    bg = cv2.GaussianBlur(g, (k, k), 0)
    # 防止除零；0.85 让校正不要太激进，保留一点立体感
    flat = g / np.maximum(bg, 0.08)
    flat = 0.5 + (flat - 1.0) * 0.85 * strength
    flat = np.clip(flat, 0.0, 1.0)
    return (flat * 255).astype(np.uint8)


def denoise(gray: np.ndarray, amount: float) -> np.ndarray:
    """双边滤波保边降噪；强度大时叠加一次非局部均值（缩小图以加速）。"""
    if amount <= 0.01:
        return gray
    d = 5 if amount < 2 else 7
    sigma = 18 + amount * 22
    out = cv2.bilateralFilter(gray, d, sigma, sigma)
    if amount >= 3.0:
        small = cv2.resize(out, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        small = cv2.fastNlMeansDenoising(small, None, 5, 7, 21)
        out = cv2.resize(small, (out.shape[1], out.shape[0]), interpolation=cv2.INTER_CUBIC)
        out = cv2.addWeighted(out, 0.55, gray, 0.45, 0)
    return out


# ---------------------------------------------------------------------------
# 可选 AI 通道：ONNX 边缘/线稿模型（HED / PiDiNet / lineart 等）
# ---------------------------------------------------------------------------

def find_onnx_model(explicit: str = "") -> str | None:
    """查找可用的 ONNX 模型。优先显式路径，其次本目录 models/*.onnx。

    没有模型时返回 None —— 内置视觉算法照常工作，工具完全离线可用。
    """
    _HERE = os.path.dirname(os.path.abspath(__file__))
    cands: list[str] = []
    if explicit:
        cands.append(explicit if os.path.isabs(explicit) else os.path.join(_HERE, explicit))
    md = os.path.join(_HERE, "models")
    if os.path.isdir(md):
        for name in sorted(os.listdir(md)):
            if name.lower().endswith(".onnx"):
                cands.append(os.path.join(md, name))
    for c in cands:
        if os.path.isfile(c):
            return c
    return None



def ai_edge(gray: np.ndarray, model_path: str) -> np.ndarray | None:
    """用 ONNX 模型推理出 0..255 边缘图；失败返回 None 以便静默回落。

    约定：输入为 1×1×H×W 的 float32 灰度图（0..1），输出为任意形状的
    float 张量（0..1 或 0..255 的概率图 / 边缘图）。HED、PiDiNet、
    lineart-anime 等导出成 ONNX 后大多符合此约定。若模型输入尺寸固定，
    会按模型的 H/W 缩放，输出再还原到原图尺寸。
    """
    try:
        import onnxruntime as ort  # type: ignore
    except ImportError:
        return None
    try:
        sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        inp = sess.get_inputs()[0]
        shape = inp.shape
        h = int(shape[2]) if len(shape) > 2 and isinstance(shape[2], int) else 0
        w = int(shape[3]) if len(shape) > 3 and isinstance(shape[3], int) else 0
        H, W = gray.shape
        ih, iw = (h or H), (w or W)
        # 限制推理分辨率，避免大模型把内存打爆
        scale = min(1.0, 1600.0 / max(ih, iw))
        ih, iw = max(32, int(ih * scale)), max(32, int(iw * scale))
        x = cv2.resize(gray, (iw, ih), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        x = x[np.newaxis, np.newaxis, :, :]
        # 3 通道模型则复制灰度
        if len(shape) > 1 and isinstance(shape[1], int) and shape[1] == 3:
            x = np.repeat(x, 3, axis=1)
        out = sess.run(None, {inp.name: x})[0]
        a = np.asarray(out, dtype=np.float32)
        if a.ndim >= 4:
            a = a[0, 0]
        elif a.ndim == 3:
            a = a[0]
        elif a.ndim == 2:
            pass
        else:
            return None
        # 多通道输出取均值
        if a.ndim == 3 and a.shape[0] in (1, 2, 3, 4):
            a = a.mean(axis=0)
        mx = float(a.max()) if a.size else 1.0
        if mx > 2.0:
            a = a / 255.0
        a = np.clip(a, 0, 1)
        a = cv2.resize(a, (W, H), interpolation=cv2.INTER_CUBIC)
        return (a * 255).astype(np.uint8)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# 结构边缘 → 线条掩码
# ---------------------------------------------------------------------------

def structural_edges(gray: np.ndarray, detail: float, denoise_amt: float) -> np.ndarray:
    """多尺度 DoG + 局部对比归一化 → 0..255 的边缘强度图。

    detail 越高：高频尺度权重越大、阈值越低 → 更多细线。
    """
    g = gray.astype(np.float32) / 255.0
    # 细节灵敏度映射到 sigma 与阈值
    t = detail / 100.0
    s1 = 0.7 + 0.5 * (1 - t)          # 0.7..1.2
    s2 = s1 * (2.6 + 2.2 * t)         # 2..6 倍
    b1 = cv2.GaussianBlur(g, (0, 0), s1)
    b2 = cv2.GaussianBlur(g, (0, 0), s2)
    dog = b1 - b2
    # 用梯度幅度补强：DoG 对细弱的划痕/分界线更敏感，梯度对硬边更稳
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    grad = cv2.magnitude(gx, gy)
    grad = grad / (grad.max() + 1e-6)
    # 局部对比归一化：强高光边缘不应压过暗部的结构线
    local = cv2.GaussianBlur(np.abs(dog), (0, 0), 8) * 3 + 0.012
    dog_n = dog / local
    pos = np.clip(dog_n, 0, 1) * 0.72 + grad * 0.28
    # 软阈值：细节越高阈值越低
    thr = 0.30 - 0.20 * t + 0.012 * denoise_amt
    soft = np.clip((pos - thr) / max(0.06, 0.22 * (1 - t) + 0.06), 0, 1)
    # 对比拉伸，让线条更"墨"
    soft = np.power(soft, 0.75)
    return (soft * 255).astype(np.uint8)


def edge_to_ink(edge: np.ndarray, p: Params) -> np.ndarray:
    """边缘强度 → 布尔墨迹掩码：阈值 + 桥接 + 细化 + 去毛刺。"""
    t = p.detail / 100.0
    thr = int(190 - 95 * t + 4 * p.denoise)   # 95..190
    ink = (edge >= thr).astype(np.uint8)

    # 桥接断笔：先闭运算，再去掉被闭运算带出来的粗块（后面骨架化会再收细）
    if p.close_gap > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                      (2 * p.close_gap + 1, 2 * p.close_gap + 1))
        ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, k)

    # 面积/长度过滤：去掉金属拉丝纹理造成的小噪点
    if p.min_area > 0:
        n, lab, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
        keep = np.zeros(n, np.uint8)
        for i in range(1, n):
            area = stats[i, cv2.CC_STAT_AREA]
            w = stats[i, cv2.CC_STAT_WIDTH]
            h = stats[i, cv2.CC_STAT_HEIGHT]
            # 细长的短划也可能是真实结构线，用对角线长度放宽
            if area >= p.min_area or max(w, h) >= max(12, p.min_area / 2):
                keep[i] = 1
        ink = (keep[lab] > 0).astype(np.uint8)

    # 骨架化：把 2~5px 宽的"带"收成 1px 中心线，这是线条感的来源
    # skimage.morphology.skeletonize 对布尔图稳定且比 medial_axis 少毛刺
    try:
        from skimage.morphology import skeletonize, thin
        sk = skeletonize(ink > 0)
        if p.denoise >= 2.0:
            sk = thin(sk, max_iter=3)
        ink = sk.astype(np.uint8)
    except Exception:
        pass

    # 骨架后按 line_width 扩张，得到可控线宽（默认约 1.2px，避免糊）
    # 这样界面上的「线宽」滑块在默认填充轮廓模式下同样真实生效。
    if not p.centerline:
        r = int(round(max(0.0, p.line_width) / 1.2))
        r = max(0, min(4, r))
        if r > 0:
            k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
            ink = cv2.dilate(ink, k2, iterations=1)
    return (ink > 0)


def looks_like_line_art(gray: np.ndarray) -> bool:
    """判断输入是否已经是黑白线稿（而非实物照片）。

    线稿的灰度直方图高度集中在两端（near-black 墨 / near-white 纸），
    中间调极少。此时再走「光照平坦化 + DoG」反而会把细线抹掉，
    直接阈值化 + 骨架化才是最忠实、最干净的做法。
    """
    sample = gray
    if gray.size > 2_000_000:
        sample = cv2.resize(gray, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    dark = float((sample < 90).mean())
    light = float((sample > 200).mean())
    mid = 1.0 - dark - light
    return (dark + light > 0.90) and (mid < 0.10) and (0.002 < dark < 0.75)


def lineart_to_ink(gray: np.ndarray, p: Params) -> np.ndarray:
    """已是线稿：Otsu 阈值 → 断笔桥接 → 面积过滤 → 骨架 → 可控线宽。"""
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink = (bw > 0).astype(np.uint8)
    gap = min(p.close_gap, 1)          # 细线不能大范围闭运算，否则会粘连
    if gap:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, k)
    if p.min_area > 0:
        n, lab, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
        keep = np.zeros(n, np.uint8)
        for i in range(1, n):
            area = stats[i, cv2.CC_STAT_AREA]
            w, h = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
            if area >= p.min_area or max(w, h) >= max(12, p.min_area / 2):
                keep[i] = 1
        ink = (keep[lab] > 0).astype(np.uint8)
    if p.centerline:
        try:
            from skimage.morphology import skeletonize
            ink = skeletonize(ink > 0).astype(np.uint8)
        except Exception:
            pass
    # 线稿本身通常已有 1~2px 线宽；这里只做轻度统一，避免"糊"
    return ink > 0


def auto_crop(ink: np.ndarray, pad: int = 24) -> tuple[int, int, int, int]:
    """返回 (x0,y0,x1,y1)，裁掉空白边距但保留少量留白。"""
    ys, xs = np.where(ink)
    h, w = ink.shape
    if len(xs) == 0:
        return 0, 0, w, h
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(w, int(xs.max()) + 1 + pad)
    y0 = max(0, int(ys.min()) - pad)
    y1 = min(h, int(ys.max()) + 1 + pad)
    return x0, y0, x1, y1


# ---------------------------------------------------------------------------
# 轮廓 → 贝塞尔路径
# ---------------------------------------------------------------------------

def _catmull_to_bezier(points: np.ndarray, closed: bool = True, tension: float = 0.5) -> str:
    """把折线点列转成三次贝塞尔 C 指令（Catmull-Rom 转 Bézier）。

    points: Nx2 float (x,y)。返回不含起始 M 的路径片段。
    """
    n = len(points)
    if n < 2:
        return ""
    P = points.astype(np.float64)
    segs: list[str] = []
    rng = range(n) if closed else range(n - 1)
    for i in rng:
        p0 = P[(i - 1) % n] if closed else P[max(0, i - 1)]
        p1 = P[i]
        p2 = P[(i + 1) % n] if closed else P[min(n - 1, i + 1)]
        p3 = P[(i + 2) % n] if closed else P[min(n - 1, i + 2)]
        c1 = p1 + (p2 - p0) * (tension / 3.0)
        c2 = p2 - (p3 - p1) * (tension / 3.0)
        segs.append("C%.2f %.2f %.2f %.2f %.2f %.2f" %
                    (c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]))
    return "".join(segs)


def contours_to_paths(ink: np.ndarray, simplify: float, offset=(0.0, 0.0)) -> tuple[list[str], int]:
    """墨迹 → 闭合轮廓 path 列表（外轮廓 + 孔洞合并，fill-rule=evenodd）。

    返回 (d 字符串列表, 顶点总数)。每个连通域（含其孔洞）合成一条 d。
    用 RETR_CCOMP 两层结构，孔洞与外轮廓写进同一个 path 才能被 evenodd 正确挖空。
    """
    H, W = ink.shape
    img = ink.astype(np.uint8)
    cnts, hier = cv2.findContours(img, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None or len(cnts) == 0:
        return [], 0
    hier = hier[0]
    # 按外轮廓分组：parent == -1
    groups: dict[int, list[int]] = {}
    for i in range(len(cnts)):
        parent = int(hier[i][3])
        root = i if parent == -1 else parent
        groups.setdefault(root, []).append(i)
    ox, oy = offset
    out: list[str] = []
    total_pts = 0
    for root, idxs in groups.items():
        # 外轮廓先，其余子轮廓后（evenodd 下顺序不影响，但便于阅读）
        idxs = sorted(idxs, key=lambda i: 0 if i == root else 1)
        chunks: list[str] = []
        for i in idxs:
            c = cnts[i]
            if cv2.contourArea(c) < 0.4 and cv2.arcLength(c, True) < 3:
                continue
            eps = float(simplify)
            ap = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(np.float64)
            if len(ap) < 3:
                continue
            # 亚像素：轮廓沿像素边界走，+0.5 让线条落在像素中心，视觉更挺
            ap = ap + np.array([ox + 0.5, oy + 0.5])
            total_pts += len(ap)
            # 点数多时用贝塞尔平滑，少时保持硬折线（避免圆角化方孔）
            if len(ap) >= 8 and simplify >= 0.25:
                d = "M%.2f %.2f" % (ap[0, 0], ap[0, 1])
                d += _catmull_to_bezier(ap, closed=True, tension=0.35)
                d += "Z"
            else:
                d = "M%.2f %.2f" % (ap[0, 0], ap[0, 1])
                d += "".join("L%.2f %.2f" % (x, y) for x, y in ap[1:])
                d += "Z"
            chunks.append(d)
        if chunks:
            out.append(" ".join(chunks))
    return out, total_pts


def ink_to_centerline_paths(ink: np.ndarray, simplify: float, offset=(0.0, 0.0)) -> tuple[list[str], int]:
    """骨架 → 折线路径（用于统一 stroke-width 的可编辑线条）。"""
    try:
        from skimage.morphology import skeletonize
        sk = skeletonize(ink > 0)
    except Exception:
        sk = ink
    H, W = sk.shape
    sk = sk.astype(np.uint8)
    # 8 邻域度数
    deg = cv2.filter2D(sk, cv2.CV_8U, np.ones((3, 3), np.uint8),
                       borderType=cv2.BORDER_CONSTANT) - sk
    visited = np.zeros_like(sk, bool)
    OFFS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    paths: list[str] = []
    total = 0
    max_paths = 6000
    ox, oy = offset

    def walk(y: int, x: int) -> list[tuple[int, int]]:
        pts = [(y, x)]
        visited[y, x] = True
        cy, cx = y, x
        guard = 0
        while guard < 200000:
            guard += 1
            nxt = None
            for dy, dx in OFFS:
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < H and 0 <= nx < W and sk[ny, nx] and not visited[ny, nx]:
                    nxt = (ny, nx)
                    break
            if nxt is None:
                break
            cy, cx = nxt
            visited[cy, cx] = True
            pts.append((cy, cx))
            if deg[cy, cx] > 2:      # 到分叉就停，让另一条分支另起
                break
        return pts

    seeds = [(int(y), int(x)) for y, x in np.argwhere((sk > 0) & (deg <= 1))]
    seeds += [(int(y), int(x)) for y, x in np.argwhere(sk > 0)]
    for y, x in seeds:
        if len(paths) >= max_paths:
            break
        if visited[y, x] or not sk[y, x]:
            continue
        pts = walk(y, x)
        if len(pts) < 3:
            continue
        a = np.array([(px + ox + 0.5, py + oy + 0.5) for py, px in pts], np.float32)
        eps = max(0.4, float(simplify))
        ap = cv2.approxPolyDP(a.reshape(-1, 1, 2), eps, False).reshape(-1, 2)
        if len(ap) < 2:
            continue
        total += len(ap)
        d = "M%.2f %.2f" % (ap[0, 0], ap[0, 1])
        d += "".join("L%.2f %.2f" % (px, py) for px, py in ap[1:])
        paths.append(d)
    return paths, total


# ---------------------------------------------------------------------------
# SVG 组装
# ---------------------------------------------------------------------------

def _xml_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def build_svg(ink: np.ndarray, p: Params, crop_box: tuple[int, int, int, int]) -> tuple[str, dict]:
    x0, y0, x1, y1 = crop_box
    W, H = int(x1 - x0), int(y1 - y0)
    sub = ink[y0:y1, x0:x1]
    if p.centerline:
        paths, npts = ink_to_centerline_paths(sub, p.simplify, offset=(0, 0))
    else:
        paths, npts = contours_to_paths(sub, p.simplify, offset=(0, 0))

    bg = p.bg
    if p.transparent:
        bg = "transparent"
    parts: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
        'width="%d" height="%d" viewBox="0 0 %d %d">' % (W, H, W, H),
        '  <title>零部件实物图转线条图 · photo2line %s</title>' % __version__,
        '  <desc>纯矢量路径，无位图。preset=%s，detail=%g，denoise=%g，'
        'simplify=%g，centerline=%s</desc>' % (
            _xml_escape(p.preset), p.detail, p.denoise, p.simplify, str(p.centerline).lower()),
    ]
    if bg != "transparent":
        parts.append('  <rect id="background" x="0" y="0" width="%d" height="%d" fill="%s"/>' %
                     (W, H, _xml_escape(bg)))
    else:
        # 透明背景仍放一个零填充标记，方便在编辑器里改背景
        parts.append('  <rect id="background" x="0" y="0" width="%d" height="%d" fill="none"/>' %
                     (W, H))

    parts.append('  <g id="linework" fill="%s" stroke="none" '
                 'fill-rule="evenodd" clip-rule="evenodd">' % _xml_escape(p.stroke)
                 if not p.centerline else
                 '  <g id="linework" fill="none" stroke="%s" stroke-width="%.3f" '
                 'stroke-linecap="round" stroke-linejoin="round">' %
                 (_xml_escape(p.stroke), p.line_width))
    if p.centerline:
        d_all = " ".join(paths)
        if d_all:
            parts.append('    <path d="%s"/>' % d_all)
    else:
        for d in paths:
            parts.append('    <path d="%s"/>' % d)
    parts.append('  </g>')
    parts.append('</svg>')
    svg = "\n".join(parts) + "\n"

    stats = {
        "width": W, "height": H,
        "paths": len(paths), "vertices": int(npts),
        "ink_pixels": int(sub.sum()),
        "svg_bytes": len(svg.encode("utf-8")),
        "mode": "centerline" if p.centerline else "filled-contour",
        "background": bg,
    }
    return svg, stats


# ---------------------------------------------------------------------------
# PNG 渲染
# ---------------------------------------------------------------------------

def render_png(svg: str, scale: float = 1.0) -> tuple[bytes, str]:
    """SVG → PNG。优先 PyMuPDF，其次 Edge headless，最后 OpenCV 近似光栅化。"""
    m = re.search(r'width="(\d+)"\s+height="(\d+)"', svg)
    W = int(m.group(1)) if m else 1000
    H = int(m.group(2)) if m else 1000
    W = max(1, min(12000, int(W * scale)))
    H = max(1, min(12000, int(H * scale)))
    if W * H > 60_000_000:
        k = math.sqrt(60_000_000 / (W * H))
        W, H = int(W * k), int(H * k)

    # 1) PyMuPDF（fitz）——本机已装，SVG 支持良好且无需浏览器
    try:
        try:
            import pymupdf as fitz  # PyMuPDF >= 1.24 的新包名
        except ImportError:
            import fitz  # type: ignore  # 旧版
        doc = fitz.open(stream=svg.encode("utf-8"), filetype="svg")
        page = doc[0]
        zoom = W / max(1.0, page.rect.width)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=True)
        # 输出统一为目标尺寸
        img = Image.frombytes("RGBA", (pix.width, pix.height), pix.samples)
        if img.size != (W, H):
            img = img.resize((W, H), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        doc.close()
        return buf.getvalue(), "pymupdf"
    except Exception:
        pass

    # 2) Edge / Chrome headless
    exe = None
    for c in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              "/usr/bin/chromium", "/usr/bin/google-chrome"):
        if os.path.exists(c):
            exe = c
            break
    if exe:
        with tempfile.TemporaryDirectory() as td:
            sp = os.path.join(td, "in.svg")
            op = os.path.join(td, "out.png")
            with open(sp, "w", encoding="utf-8") as f:
                f.write(svg)
            try:
                cmd = [exe, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                       "--no-sandbox", "--force-device-scale-factor=1",
                       "--window-size=%d,%d" % (W, H),
                       "--screenshot=" + op, "file:///" + sp.replace("\\", "/").lstrip("/")]
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=45, check=False)
                if os.path.exists(op):
                    im = Image.open(op).convert("RGBA")
                    if im.size != (W, H):
                        im = im.resize((W, H), Image.LANCZOS)
                    b = io.BytesIO(); im.save(b, format="PNG")
                    return b.getvalue(), "chromium-headless"
            except Exception:
                pass

    # 3) OpenCV 兜底：直接光栅化墨迹（不走 SVG），保证 PNG 永远有内容
    return _raster_fallback(svg, W, H), "opencv-fallback"


def _raster_fallback(svg: str, W: int, H: int) -> bytes:
    """极简 SVG 光栅化兜底：解析 path 的 M/L/C/Z 与 rect 背景。"""
    canvas = np.zeros((H, W, 4), np.uint8)
    bgm = re.search(r'<rect[^>]*fill="(#[0-9a-fA-F]{6})"', svg)
    if bgm:
        c = bgm.group(1)
        rgb = tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
        canvas[:] = (*rgb[::-1], 255)
    strokem = re.search(r'fill="(#[0-9a-fA-F]{6})"\s+stroke="none"', svg) or \
        re.search(r'stroke="(#[0-9a-fA-F]{6})"', svg)
    col = (30, 30, 30, 255)
    if strokem:
        c = strokem.group(1)
        rgb = tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
        col = (*rgb[::-1], 255)
    sx, sy = float(W) / max(1, _svg_w(svg)), float(H) / max(1, _svg_h(svg))
    for d in re.findall(r'\bd="([^"]+)"', svg):
        pts: list[tuple[int, int]] = []
        tokens = re.findall(r'[MLCZmlcz]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?', d)
        i = 0
        cur = (0.0, 0.0)
        start = (0.0, 0.0)
        cmd = ""
        while i < len(tokens):
            tok = tokens[i]
            if tok.isalpha():
                cmd = tok; i += 1
                if cmd in "Zz":
                    if len(pts) >= 3:
                        cv2.fillPoly(canvas, [np.array(pts, np.int32)], col)
                    pts = []
                    cur = start
                    continue
            try:
                x = float(tokens[i]); y = float(tokens[i + 1]); i += 2
            except (ValueError, IndexError):
                break
            if cmd in "LlMmCc":
                if cmd in "Cc":
                    # 三次贝塞尔用折线近似（兜底路径不追求完美）
                    try:
                        x2 = float(tokens[i]); y2 = float(tokens[i + 1])
                        x3 = float(tokens[i + 2]); y3 = float(tokens[i + 3]); i += 4
                        for s in np.linspace(0, 1, 6)[1:]:
                            u = 1 - s
                            bx = u**3 * cur[0] + 3*u*u*s*x + 3*u*s*s*x2 + s**3*x3
                            by = u**3 * cur[1] + 3*u*u*s*y + 3*u*s*s*y2 + s**3*y3
                            pts.append((int(bx * sx), int(by * sy)))
                        cur = (x3, y3)
                        continue
                    except (ValueError, IndexError):
                        pass
                cur = (x, y)
                pts.append((int(x * sx), int(y * sy)))
                if cmd in "Mm":
                    start = cur
        if len(pts) >= 3:
            cv2.fillPoly(canvas, [np.array(pts, np.int32)], col)
    b = io.BytesIO()
    Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGRA2RGBA)).save(b, format="PNG")
    return b.getvalue()


def _svg_w(svg: str) -> float:
    m = re.search(r'width="([\d.]+)"', svg)
    return float(m.group(1)) if m else 1.0


def _svg_h(svg: str) -> float:
    m = re.search(r'height="([\d.]+)"', svg)
    return float(m.group(1)) if m else 1.0


# ---------------------------------------------------------------------------
# 顶层 API
# ---------------------------------------------------------------------------

def convert(image_bytes: bytes, params: dict[str, Any] | None = None,
            debug_dir: str | None = None) -> dict[str, Any]:
    """主入口：图片字节 + 参数 → {'svg','png','stats','params'}。"""
    t0 = time.time()
    p = Params.from_dict(params)
    bgr = load_image(image_bytes, p.upscale)
    gray = to_gray(bgr)

    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        cv2.imwrite(os.path.join(debug_dir, "00_input.png"), bgr)
        cv2.imwrite(os.path.join(debug_dir, "01_gray.png"), gray)

    # 输入可能是「实物照片」，也可能本来就是扫描的黑白线稿。自动分流。
    is_lineart = looks_like_line_art(gray)
    ai_used = False
    if is_lineart:
        ink = lineart_to_ink(gray, p)
        edge = (ink.astype(np.uint8) * 255)
        print_mode = "线稿直通 (Otsu + 骨架)"
    else:
        if p.flat_light:
            gray = flatten_illumination(gray)
            if debug_dir:
                cv2.imwrite(os.path.join(debug_dir, "02_flat.png"), gray)
        gray = denoise(gray, p.denoise)
        # 可选 AI 通道：models/*.onnx 存在且能推理时使用，否则静默回落到内置算法
        onnx_path = find_onnx_model(p.ai_model)
        ai = ai_edge(gray, onnx_path) if onnx_path else None
        if ai is not None:
            edge = ai
            print_mode = "AI 边缘模型 (%s) + 骨架" % os.path.basename(onnx_path or "")
            ai_used = True
        else:
            edge = structural_edges(gray, p.detail, p.denoise)
            print_mode = "照片结构边缘 (平坦化 + DoG + 骨架)"
            ai_used = False
        if debug_dir:
            cv2.imwrite(os.path.join(debug_dir, "03_edge.png"), edge)
        ink = edge_to_ink(edge, p)
    if debug_dir:
        cv2.imwrite(os.path.join(debug_dir, "04_ink.png"), ink.astype(np.uint8) * 255)

    H, W = ink.shape
    if p.crop:
        box = auto_crop(ink, pad=max(16, int(min(W, H) * 0.03)))
    else:
        box = (0, 0, W, H)
    # 裁边后如果太小，退回全图
    if box[2] - box[0] < 32 or box[3] - box[1] < 32:
        box = (0, 0, W, H)

    svg, stats = build_svg(ink, p, box)
    png, renderer = render_png(svg, p.png_scale)
    stats.update({
        "renderer": renderer,
        "input_kind": "line-art" if is_lineart else "photo",
        "pipeline": print_mode,
        "ai_model": os.path.basename(find_onnx_model(p.ai_model) or "") if ai_used else "",
        "png_bytes": len(png),
        "source_size": [int(bgr.shape[1]), int(bgr.shape[0])],
        "crop": [int(v) for v in box],
        "ink_ratio": round(float(ink.sum()) / max(1, W * H), 5),
        "elapsed_ms": int((time.time() - t0) * 1000),
    })
    return {"svg": svg, "png": png, "stats": stats, "params": p.public()}


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="零部件实物照片 → 2D 线条图（纯矢量 SVG + PNG）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例：
  python photo2line.py part.jpg out.svg
  python photo2line.py part.jpg out.svg --png out.png --preset detailed
  python photo2line.py part.jpg out.svg --transparent --centerline --line-width 1.5
  python photo2line.py part.jpg out.svg --invert --stroke '#dceaff' --bg '#0d2b4e'
""")
    ap.add_argument("input", help="输入图片 (jpg/png/webp/bmp/gif)")
    ap.add_argument("output", nargs="?", help="输出 SVG 路径（默认同名 .svg）")
    ap.add_argument("--png", help="同时导出 PNG 的路径")
    ap.add_argument("--preset", choices=list(PRESETS), default="auto",
                    help="预设：auto 自动 / clean 简洁 / detailed 精细 / blueprint 工程蓝图")
    ap.add_argument("--denoise", type=float, help="降噪 0..5")
    ap.add_argument("--detail", type=float, help="细节 0..100")
    ap.add_argument("--min-area", type=int, dest="min_area", help="最小连通域面积")
    ap.add_argument("--simplify", type=float, help="轮廓简化 0..5 px")
    ap.add_argument("--line-width", type=float, dest="line_width", help="中心线模式线宽")
    ap.add_argument("--upscale", type=float, help="放大倍率 1..3")
    ap.add_argument("--stroke", help="线条颜色 #rrggbb")
    ap.add_argument("--bg", help="背景颜色 #rrggbb 或 transparent")
    ap.add_argument("--transparent", action="store_true", help="透明背景")
    ap.add_argument("--invert", action="store_true", help="深底浅线（反色）")
    ap.add_argument("--no-crop", dest="crop", action="store_false", help="不自动裁边")
    ap.add_argument("--centerline", action="store_true", help="输出骨架中心线（可统一改线宽）")
    ap.add_argument("--no-flat", dest="flat_light", action="store_false", help="关闭光照平坦化")
    ap.add_argument("--png-scale", type=float, dest="png_scale", default=1.0, help="PNG 倍率")
    ap.add_argument("--ai-model", dest="ai_model", default="",
                    help="可选 ONNX 边缘模型路径（默认自动查找 models/*.onnx）")
    ap.add_argument("--debug-dir", dest="debug_dir", help="输出中间过程图用于调参")
    ap.add_argument("--json", action="store_true", help="把统计信息打印为 JSON")
    args = ap.parse_args(argv)

    if not os.path.isfile(args.input):
        print("错误：找不到输入文件 %s" % args.input, file=sys.stderr)
        return 2
    out = args.output or (os.path.splitext(args.input)[0] + "_line.svg")
    raw: dict[str, Any] = {"preset": args.preset}
    for k in ("denoise", "detail", "min_area", "simplify", "line_width", "upscale",
              "stroke", "bg", "png_scale", "ai_model"):
        v = getattr(args, k, None)
        if v is not None:
            raw[k] = v
    for k in ("transparent", "invert", "centerline"):
        if getattr(args, k):
            raw[k] = True
    if not args.crop:
        raw["crop"] = False
    if not args.flat_light:
        raw["flat_light"] = False

    try:
        with open(args.input, "rb") as f:
            data = f.read()
        res = convert(data, raw, debug_dir=args.debug_dir)
    except Exception as e:
        print("转换失败：%s" % e, file=sys.stderr)
        if os.environ.get("PHOTO2LINE_DEBUG"):
            traceback.print_exc()
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(res["svg"])
    png_path = args.png or (os.path.splitext(out)[0] + ".png")
    with open(png_path, "wb") as f:
        f.write(res["png"])
    if args.json:
        print(json.dumps(res["stats"], ensure_ascii=False, indent=2))
    else:
        s = res["stats"]
        print("完成：%s" % out)
        print("      %s" % png_path)
        print("尺寸 %d×%d | 路径 %d 条 | 顶点 %d | 墨迹 %.2f%% | SVG %.1f KB | PNG %.1f KB | %s | %d ms"
              % (s["width"], s["height"], s["paths"], s["vertices"],
                 s["ink_ratio"] * 100, s["svg_bytes"] / 1024, s["png_bytes"] / 1024,
                 s["renderer"], s["elapsed_ms"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
