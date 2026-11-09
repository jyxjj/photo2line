#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
photo2line 本地服务 —— 零第三方 Web 框架（仅 Python 标准库）

启动：
    python server.py                       # 默认 http://127.0.0.1:8777，并自动打开浏览器
    python server.py --port 9000 --no-browser
    python server.py --debug               # 出错时返回堆栈

接口：
    GET  /                 静态页面 web/index.html
    GET  /api/health       服务与依赖状态
    POST /api/convert      multipart/form-data 上传图片 → SVG + PNG(data URI)
    OPTIONS *              CORS 预检
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import traceback
import webbrowser
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
DEFAULT_PORT = 8777
VERSION = "1.0.0"

# 允许的图片类型（扩展名 + 文件魔数）
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
MAGIC = [
    (b"\xff\xd8\xff", "jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"RIFF", "webp"),          # 后面再校验 WEBP
    (b"BM", "bmp"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
    (b"II*\x00", "tiff"),
    (b"MM\x00*", "tiff"),
]

_STR_KEYS = ("preset", "stroke", "bg")
_NUM_KEYS = ("denoise", "detail", "min_area", "simplify", "line_width", "upscale", "png_scale")
_BOOL_KEYS = ("transparent", "invert", "crop", "centerline", "flat_light")
_ALL_KEYS = set(_STR_KEYS) | set(_NUM_KEYS) | set(_BOOL_KEYS)


def log(msg: str) -> None:
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


# ---------------------------------------------------------------------------
# 输入校验
# ---------------------------------------------------------------------------

def safe_filename(name: str) -> str:
    """去掉路径、控制字符，保留可读性。"""
    name = (name or "image").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    return (name[:180] or "image")


def sniff_image(data: bytes, filename: str) -> str | None:
    """返回检测到的类型，或 None。"""
    if not data or len(data) < 12:
        return None
    for magic, kind in MAGIC:
        if data.startswith(magic):
            if kind == "webp" and data[8:12] != b"WEBP":
                continue
            return kind
    return None


def normalize_params(fields: dict[str, str]) -> dict[str, Any]:
    """字符串表单字段 → 类型正确、范围夹紧的参数字典。"""
    p: dict[str, Any] = {}
    for k in _ALL_KEYS:
        if k in fields:
            p[k] = fields[k]
    # preset 白名单
    preset = str(p.get("preset", "auto")).strip().lower()
    if preset not in ("auto", "clean", "detailed", "blueprint"):
        preset = "auto"
    p["preset"] = preset
    # 颜色：只允许 #rgb/#rrggbb、transparent 与少量安全颜色名
    color_re = re.compile(r"^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|transparent|none|"
                          r"black|white|red|blue|navy|gray|grey|silver)$", re.I)
    for k in ("stroke", "bg"):
        if k in p:
            s = str(p[k]).strip()
            p[k] = s if color_re.match(s) else ("#1a1a1a" if k == "stroke" else "#ffffff")
    # 数值：交给 photo2line 再做一次夹紧，这里先去掉明显脏值
    for k in _NUM_KEYS:
        if k in p:
            try:
                f = float(str(p[k]).strip())
                if not (-1e9 < f < 1e9):
                    raise ValueError
                p[k] = f
            except (ValueError, TypeError):
                del p[k]
    # 布尔
    for k in _BOOL_KEYS:
        if k in p:
            s = str(p[k]).strip().lower()
            p[k] = s in ("1", "true", "yes", "on", "y", "t")
    return p


# ---------------------------------------------------------------------------
# multipart 解析（用 email 标准库，稳健处理二进制，不依赖 cgi）
# ---------------------------------------------------------------------------

def parse_multipart(body: bytes, boundary: str) -> tuple[dict[str, str], dict[str, tuple[str, bytes]]]:
    """返回 (文本字段, 文件字段{name: (filename, bytes)})。"""
    # 构造一个最小 MIME 头，让 email 解析器帮我们按 boundary 切分
    header = ("Content-Type: multipart/form-data; boundary=%s\r\n"
              "MIME-Version: 1.0\r\n\r\n" % boundary).encode("ascii", "ignore")
    msg = BytesParser(policy=email_policy).parsebytes(header + body)
    if not msg.is_multipart():
        raise ValueError("multipart 数据格式无效（boundary 不匹配）")
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}
    for part in msg.iter_parts():
        cd = part.get("Content-Disposition", "")
        name_m = re.search(r'\bname="([^"]*)"', cd)
        if not name_m:
            continue
        name = name_m.group(1)
        fn_m = re.search(r'\bfilename="([^"]*)"', cd)
        payload = part.get_payload(decode=True) or b""
        if fn_m is not None:
            filename = safe_filename(fn_m.group(1))
            files[name] = (filename, payload)
        else:
            charset = part.get_content_charset() or "utf-8"
            try:
                fields[name] = payload.decode(charset, "replace")
            except (LookupError, UnicodeError):
                fields[name] = payload.decode("utf-8", "replace")
    return fields, files


# ---------------------------------------------------------------------------
# 延迟导入核心模块（--help / 缺依赖时也能给出友好提示）
# ---------------------------------------------------------------------------

_CONVERT = None
_IMPORT_ERR: str | None = None


def get_convert():
    global _CONVERT, _IMPORT_ERR
    if _CONVERT is not None:
        return _CONVERT
    if _IMPORT_ERR is not None:
        raise RuntimeError(_IMPORT_ERR)
    sys.path.insert(0, HERE)
    try:
        import photo2line  # type: ignore
        _CONVERT = photo2line.convert
        return _CONVERT
    except Exception as e:
        _IMPORT_ERR = ("无法加载 photo2line 转换模块：%s。请确认 photo2line.py 与本文件同目录，"
                       "并安装依赖：pip install numpy opencv-python scipy scikit-image pillow"
                       % e)
        raise RuntimeError(_IMPORT_ERR)


def opencv_version() -> str:
    try:
        import cv2  # type: ignore
        return str(getattr(cv2, "__version__", "unknown"))
    except Exception:
        return "未安装"


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "Photo2Line/%s" % VERSION
    sys_version = ""
    protocol_version = "HTTP/1.1"

    max_mb: int = 25
    debug: bool = False

    # ---------- 基础响应 ----------
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, obj: Any, status: int = 200) -> None:
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_bytes(self, data: bytes, ctype: str, status: int = 200,
                   cache: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=300" if cache else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt: str, *args: Any) -> None:
        pass  # 用下面的自定义日志

    def _log(self, status: int, t0: float, extra: str = "") -> None:
        log("%-6s %-24s %3s %6.0fms %s" % (
            self.command, self.path.split("?")[0], status,
            (time.time() - t0) * 1000, extra))

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    # ---------- GET ----------
    def do_GET(self) -> None:
        t0 = time.time()
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/index.html", ""):
            f = os.path.join(WEB_DIR, "index.html")
            return self._serve_file(f, t0)
        if path == "/api/health":
            return self._health(t0)
        if path == "/api/convert":
            self.send_json({"ok": False, "error": "请使用 POST 方法上传图片"}, 405)
            self._log(405, t0)
            return
        # 静态文件：只允许 WEB_DIR 内
        if path.startswith("/api/"):
            self.send_json({"ok": False, "error": "未知 API：" + path}, 404)
            self._log(404, t0)
            return
        rel = path.lstrip("/").replace("/", os.sep)
        target = os.path.abspath(os.path.join(WEB_DIR, rel))
        if not target.startswith(os.path.abspath(WEB_DIR) + os.sep):
            self.send_json({"ok": False, "error": "非法路径"}, 403)
            self._log(403, t0)
            return
        return self._serve_file(target, t0)

    def _serve_file(self, path: str, t0: float) -> None:
        if not os.path.isfile(path):
            self.send_bytes(b"404 Not Found", "text/plain; charset=utf-8", 404)
            self._log(404, t0)
            return
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError as e:
            self.send_json({"ok": False, "error": "读取文件失败：%s" % e}, 500)
            self._log(500, t0)
            return
        self.send_bytes(data, ctype, 200, cache=False)
        self._log(200, t0, "%d B" % len(data))

    def _health(self, t0: float) -> None:
        ok = True
        detail = ""
        try:
            get_convert()
        except Exception as e:
            ok = False
            detail = str(e)
        self.send_json({
            "ok": ok,
            "service": "photo2line",
            "version": VERSION,
            "python": sys.version.split()[0],
            "opencv": opencv_version(),
            "max_upload_mb": self.max_mb,
            "detail": detail,
        }, 200 if ok else 500)
        self._log(200 if ok else 500, t0)

    # ---------- POST ----------
    def do_POST(self) -> None:
        t0 = time.time()
        if urlparse(self.path).path.rstrip("/") != "/api/convert":
            self.send_json({"ok": False, "error": "未知 API，请使用 /api/convert"}, 404)
            self._log(404, t0)
            return
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r'boundary=(?:"([^"]+)"|([^;\s]+))', ctype, re.I)
        if not ctype.lower().startswith("multipart/form-data") or not m:
            self.send_json({"ok": False, "error": "请求必须是 multipart/form-data 且带 boundary"}, 400)
            self._log(400, t0)
            return
        boundary = m.group(1) or m.group(2)

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        limit = self.max_mb * 1024 * 1024
        if length > limit:
            self.send_json({"ok": False,
                            "error": "图片过大（%.1f MB），上限 %d MB" % (length / 1048576, self.max_mb)}, 413)
            self._log(413, t0)
            return
        try:
            body = self.rfile.read(length)
        except (OSError, socket.timeout) as e:
            self.send_json({"ok": False, "error": "读取请求体失败：%s" % e}, 400)
            self._log(400, t0)
            return
        if len(body) > limit:
            self.send_json({"ok": False, "error": "请求体超过大小上限"}, 413)
            self._log(413, t0)
            return

        try:
            fields, files = parse_multipart(body, boundary)
        except Exception as e:
            self.send_json({"ok": False, "error": "表单解析失败：%s" % e}, 400)
            self._log(400, t0)
            return
        if "image" not in files:
            self.send_json({"ok": False, "error": "缺少 image 文件字段"}, 400)
            self._log(400, t0)
            return
        filename, img = files["image"]
        if not img:
            self.send_json({"ok": False, "error": "上传的图片为空"}, 400)
            self._log(400, t0)
            return
        kind = sniff_image(img, filename)
        if kind is None:
            ext = os.path.splitext(filename)[1].lower()
            # 有些浏览器会给无魔数的文件；扩展名也不在白名单就拒绝
            if ext not in ALLOWED_EXT:
                self.send_json({"ok": False, "error": "不支持的文件类型，请上传 JPG/PNG/WebP/BMP/GIF"}, 400)
                self._log(400, t0)
                return
        elif os.path.splitext(filename)[1].lower() not in ALLOWED_EXT \
                and os.path.splitext(filename)[1].lower() != "":
            self.send_json({"ok": False, "error": "文件扩展名不是支持的图片格式"}, 400)
            self._log(400, t0)
            return

        params = normalize_params(fields)
        summary = "%s %s KB preset=%s detail=%s" % (
            filename, round(len(img) / 1024, 1), params.get("preset"), params.get("detail", "-"))
        log("转换请求：%s" % summary)
        try:
            convert = get_convert()
            res = convert(img, params)
            png = res["png"]
            if isinstance(png, str):
                png = png.encode("utf-8")
            payload = {
                "ok": True,
                "svg": res["svg"],
                "png": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
                "stats": res.get("stats", {}),
                "params": res.get("params", {}),
                "elapsed": round(time.time() - t0, 3),
                "filename": filename,
            }
            self.send_json(payload, 200)
            self._log(200, t0, "SVG %.1f KB / PNG %.1f KB" %
                      (len(res["svg"].encode("utf-8")) / 1024, len(png) / 1024))
        except Exception as e:
            err = "%s：%s" % (type(e).__name__, e)
            obj: dict[str, Any] = {"ok": False, "error": err}
            if self.debug:
                obj["trace"] = traceback.format_exc()[-2000:]
            self.send_json(obj, 500)
            self._log(500, t0, err)
            if self.debug:
                traceback.print_exc()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 的 SO_REUSEADDR 语义与 Linux 不同：设为 True 会让第二个进程
    # 也能绑定同一端口（互相抢连接），导致 --auto-port 的占用检测失效。
    allow_reuse_address = (os.name != "nt")
    request_queue_size = 32

    def __init__(self, addr, handler, max_mb=25, debug=False):
        Handler.max_mb = max_mb
        Handler.debug = debug
        super().__init__(addr, handler)


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="零部件实物图 → 线条图 · 本地 Web 工具")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（默认 %d）" % DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1）")
    ap.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    ap.add_argument("--debug", action="store_true", help="错误响应附带堆栈")
    ap.add_argument("--max-mb", type=int, default=25, dest="max_mb", help="上传大小上限 MB")
    ap.add_argument("--auto-port", action="store_true", dest="auto_port",
                    help="端口被占用时自动向后顺延（最多尝试 20 个端口）")
    ap.add_argument("--version", action="version", version="photo2line server " + VERSION)
    args = ap.parse_args(argv)

    if not os.path.isfile(os.path.join(WEB_DIR, "index.html")):
        print("错误：找不到界面文件 %s" % os.path.join(WEB_DIR, "index.html"), file=sys.stderr)
        return 2
    srv = None
    port = args.port
    last_err: Exception | None = None
    attempts = 21 if args.auto_port else 1
    for i in range(attempts):
        try:
            srv = Server((args.host, port), Handler, max_mb=args.max_mb, debug=args.debug)
            break
        except OSError as e:
            last_err = e
            if not args.auto_port:
                break
            port += 1
    if srv is None:
        print("无法启动服务（端口 %d 可能被占用）：%s" % (args.port, last_err), file=sys.stderr)
        print("换一个端口试试：python server.py --port %d" % (args.port + 1), file=sys.stderr)
        return 1
    if port != args.port:
        print("[提示] 端口 %d 已被占用，自动改用 %d" % (args.port, port), flush=True)

    url = "http://%s:%d/" % (args.host if args.host != "0.0.0.0" else "127.0.0.1", port)
    print("=" * 62)
    print("  零件图 → 线条图   ·   photo2line server %s" % VERSION)
    print("  界面地址：%s" % url)
    print("  Python %s  |  OpenCV %s  |  上传上限 %d MB" %
          (sys.version.split()[0], opencv_version(), args.max_mb))
    print("  按 Ctrl+C 停止服务")
    print("=" * 62, flush=True)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("\n正在停止服务…", flush=True)
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
