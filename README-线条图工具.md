# 零部件实物图 → 2D 线条图（SVG / PNG）

一个**本地运行**的小工具：上传机械零部件的实物照片，自动提取结构轮廓，
输出干净、可编辑的 2D 矢量 SVG 与高清 PNG。

- 输出的是**真正的矢量图**：只有 `<rect>` / `<g>` / `<path>`，没有 `<image>`、没有 base64 位图套壳，
  可以直接放进 CAD / Illustrator / Inkscape / 本目录的 SVG 编辑器继续编辑。
- 自动识别输入类型：**实物照片**走「光照平坦化 → 结构边缘 → 骨架化」；
  **已有黑白线稿/扫描图**走「Otsu → 骨架」直通，不会被描成糊边。
- 完全离线：所有计算在本机完成，不上传任何图片。Web 服务只用 Python 标准库。
- 可选 AI 通道：放入 ONNX 边缘模型后自动启用；没有模型也能用内置视觉算法。

---

## 一、最快开始（推荐）

**双击 `启动线条图工具.bat`**，浏览器会自动打开 `http://127.0.0.1:8777/`。

或者命令行：

```powershell
cd D:\SVG编辑器
pip install -r requirements.txt
python server.py
```

常用参数：

```powershell
python server.py --port 8778            # 换端口
python server.py --no-browser           # 不自动开浏览器
python server.py --debug                # 出错时返回堆栈
python server.py --max-mb 50            # 放宽上传上限到 50MB
```

> 关闭终端窗口 / 按 `Ctrl+C` 即停止服务。
> 页面必须通过这个本地服务打开才能调用转换接口；直接双击 `web/index.html`
> 时前端会回落到 `http://127.0.0.1:8777`，需要服务已经启动。

### 界面操作

1. **上传**：点击选择、拖拽投放、或 `Ctrl/⌘ + V` 粘贴图片（jpg/png/webp/bmp/gif）。
2. **选方案**：自动 / 简洁 / 精细 / 工程图（深底浅线蓝图风）。
3. **调参数**：降噪、细节、最小区域、轮廓简化、线宽、放大倍率；
   线条色 / 背景色 / 透明背景 / 反色 / 自动裁边。
4. 点 **「生成线条图」**，右侧可拖动分割线做原图 ↔ 线稿对比，也可切双栏。
5. **下载 SVG** / **下载 PNG**（生成前按钮禁用）。

---

## 二、命令行批处理

无需启动服务，适合批量处理或集成到脚本：

```powershell
# 基础：同时产出 SVG 与同名 PNG
python photo2line.py part.jpg out.svg

# 四种预设
python photo2line.py part.jpg out.svg --preset auto
python photo2line.py part.jpg out.svg --preset clean       # 更少杂线
python photo2line.py part.jpg out.svg --preset detailed    # 更多细节 + 1.5× 放大
python photo2line.py part.jpg out.svg --preset blueprint   # 深蓝底浅色线

# 常用组合
python photo2line.py part.jpg out.svg --png out@2x.png --png-scale 2
python photo2line.py part.jpg out.svg --transparent
python photo2line.py part.jpg out.svg --centerline --line-width 1.5
python photo2line.py part.jpg out.svg --invert --stroke '#dceaff' --bg '#0d2b4e'
python photo2line.py part.jpg out.svg --detail 65 --denoise 1.0 --min-area 12 --simplify 0.4
python photo2line.py part.jpg out.svg --debug-dir debug/ --json
```

`--debug-dir` 会输出 `00_input / 01_gray / 02_flat / 03_edge / 04_ink` 五张中间图，
调参时非常直观。`--json` 把统计信息输出为 JSON，便于脚本解析。

完整参数见：

```powershell
python photo2line.py --help
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--preset` | `auto` | `auto` / `clean` / `detailed` / `blueprint` |
| `--denoise` | 1.5 | 0–5，抑制噪点、金属拉丝纹理、反光 |
| `--detail` | 50 | 0–100，越高保留越多的浅刻线与细小结构 |
| `--min-area` | 24 | 过滤小于该面积(px²)的连通域 |
| `--simplify` | 0.8 | 0–5 px，轮廓简化；越大节点越少、文件越小 |
| `--line-width` | 1.2 | 输出线条粗细（填充轮廓与中心线两种模式都生效） |
| `--upscale` | 1.0 | 1–3，先放大原图再提取，利于微小特征 |
| `--stroke` / `--bg` | `#1a1a1a` / `#ffffff` | 线条色 / 背景色（`transparent` 亦可） |
| `--transparent` | 关 | 透明背景 SVG + 带 alpha 的 PNG |
| `--invert` | 关 | 深底浅线；未指定颜色时自动切深蓝底 |
| `--no-crop` | 关 | 不自动裁掉空白边距 |
| `--centerline` | 关 | 输出骨架中心线 + 统一 `stroke-width`，最便于后期改线宽 |
| `--no-flat` | 关 | 关闭光照平坦化 |
| `--png-scale` | 1.0 | PNG 输出倍率（如 2 = 2 倍分辨率） |
| `--ai-model` | 空 | 指定 ONNX 边缘模型；默认自动查找 `models/*.onnx` |

---

## 三、Python API

```python
from photo2line import convert

with open("part.jpg", "rb") as f:
    data = f.read()

res = convert(data, {
    "preset": "detailed",
    "transparent": True,
    "line_width": 1.4,
})

open("out.svg", "w", encoding="utf-8").write(res["svg"])
open("out.png", "wb").write(res["png"])
print(res["stats"])     # 尺寸 / 路径数 / 顶点数 / 裁边 / 耗时 / 处理链…
print(res["params"])    # 实际生效并已夹紧的参数
```

HTTP 接口（供二次开发）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务、Python、OpenCV 版本与上传上限 |
| `POST` | `/api/convert` | `multipart/form-data`：`image` 文件 + 上表同名参数 |
| `GET` | `/` | Web 界面 |

成功响应：

```json
{
  "ok": true,
  "svg": "<svg ...>...</svg>",
  "png": "data:image/png;base64,...",
  "stats": {"width":557,"height":344,"paths":19,"vertices":919,"renderer":"pymupdf"},
  "params": {"preset":"auto","detail":50.0},
  "elapsed": 1.32,
  "filename": "part_photo.png"
}
```

失败响应：`{"ok":false,"error":"..."}`，HTTP 400 / 413 / 500。
开启 `--debug` 时额外带 `trace` 字段。接口带 CORS 头，可被其它本地页面调用。

---

## 四、算法链路

```
读图 + EXIF 校正 + alpha 合成白底 + 可选放大
        │
        ├─ 判定为已有线稿 ─→ Otsu 二值化 → 断笔桥接 → 面积过滤 → 骨架
        │
        └─ 实物照片
             ├─ 光照平坦化：大尺度背景估计 ÷ 原图，抹掉渐变/暗角/单侧打光
             ├─ 保边降噪：bilateralFilter（强档叠加 fastNlMeansDenoising）
             ├─ 结构边缘：多尺度 DoG + Sobel 梯度 + 局部对比归一化
             │             （若存在 ONNX 模型，则这一步替换为 AI 推理）
             └─ 线条化：软阈值 → 闭运算补断笔 → 连通域过滤 → skeletonize
                        → 按 line_width 扩张 → 统一线宽
        │
        ├─ 自动裁边（保留 3% 留白）
        ├─ 矢量化：findContours(RETR_CCOMP) → approxPolyDP
        │          → Catmull-Rom 转三次贝塞尔 → 单 path + fill-rule="evenodd"
        │          （孔洞与外轮廓合并，孔洞被正确挖空）
        └─ 渲染 PNG：PyMuPDF → Edge/Chrome headless → OpenCV 兜底
```

**为什么不用「直接二值化照片」**：金属件的光照渐变、高光和投影是低频量，
直接阈值会得到大块斑驳而不是线条。先做除法平坦化把光照抹平，
剩下的高频才是真正的结构边界。

**为什么用骨架化**：边缘响应天然是 2–5px 宽的「带」，直接描轮廓会又粗又糊。
收成 1px 骨架再按用户设定的线宽扩张，才能得到干净、粗细一致的工程线条。

---

## 五、可选：启用 AI 边缘模型

工具默认用内置算法，不依赖任何模型。若想用深度模型提升复杂零件的边缘质量：

1. 把导出好的 ONNX 放进 `models/` 目录，例如 `models/hed.onnx`、`models/pidinet.onnx`。
2. 安装推理运行时：`pip install onnxruntime`
3. 重新运行即可（也可 `--ai-model path/to/model.onnx` 显式指定）。

模型约定：输入 `1×1×H×W` float32 灰度（0–1，3 通道模型会自动复制），
输出 0–1 或 0–255 的边缘概率图。固定输入尺寸的模型会自动缩放后再还原。
推理失败会自动静默回落到内置算法，不会让工具不可用。
`stats.ai_model` 会标明本次是否真的用了模型。

---

## 六、文件清单

| 文件 | 作用 |
| --- | --- |
| `启动线条图工具.bat` | 一键启动（Windows） |
| `server.py` | 零第三方依赖的本地 HTTP 服务 + API |
| `photo2line.py` | 核心算法、SVG/PNG 生成、命令行工具、Python API |
| `web/index.html` | 单文件 Web 界面（内联 CSS/JS，无 CDN、无构建） |
| `requirements.txt` | Python 依赖清单 |
| `samples/part_photo.png` | 合成零件实物照片（测试样例） |
| `samples/final_auto.*` | 默认参数的输出示例 |
| `index.html` / `app.js` / `core.js` / `styles.css` | 原有的纯前端 SVG 编辑器（未改动） |
| `img2svg.py` / `1.gif` / `1.svg` | 原有的线稿精确轮廓工具与样例（未改动） |

输出的 SVG 可以直接用同目录的 **`打开编辑器.bat`** 打开，作为可编辑矢量对象继续加工。

---

## 七、常见问题

**Q：双击 `web/index.html` 提示后端离线？**
A：请先运行 `启动线条图工具.bat`；界面需要通过 `http://127.0.0.1:8777/` 访问。

**Q：线条太多/太少？**
A：先调「细节灵敏度」（低=少线、高=多线），再调「降噪」与「最小区域」。
把 `--debug-dir debug/` 打开看 `03_edge.png` 与 `04_ink.png` 最直观。

**Q：细小的刻线断了？**
A：提高「细节」、降低「降噪」与「最小区域」，或把「放大倍率」调到 1.5–2。
命令行还能加 `--centerline` 得到更细的统一描边。

**Q：PNG 是空白 / 发虚？**
A：默认用 PyMuPDF 渲染，若版本异常会自动回落到浏览器截图。
`stats.renderer` 可查看本次实际渲染器；用 `--png-scale 2` 输出 2 倍分辨率。

**Q：超大图（如 2480×3508）会不会卡？**
A：会自动限制到 4000 万像素以内；内置算法全分辨率通常 1–6 秒。
Web 端上传上限默认 25 MB，可用 `--max-mb` 调整。

**Q：和 `img2svg.py` 有什么区别？**
A：`img2svg.py` 面向**已经是黑白线稿**的像素级忠实还原（含 OCR 热点数字）；
本工具面向**实物照片**转线条，并会把已有线稿自动分流到更合适的直通链路。
两者输出都可以交给同目录的 SVG 编辑器继续编辑。
