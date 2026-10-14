# -*- coding: utf-8 -*-
"""生成 NSIS 安装向导的品牌位图。

输出（全部落进 build/，electron-builder 按同名约定自动取用）：
  build/installerSidebar.bmp     164x314  完成页左侧的品牌面板
  build/uninstallerSidebar.bmp   164x314  卸载程序欢迎页
  build/installerHeader.bmp      150x57   内页（许可/目录/安装）右上角的标记

设计约束：
  - 位图里**只放图形、不放文字**。中文要渲染就得带字体，而 NSIS 自己会把标题
    （"选择安装位置" / "正在安装"）画在页面上，图里再写一遍是重复。纯几何还有一个
    好处：与「视觉素材 100% 代码自绘」一致，不引入任何字体授权问题。
  - 尺寸必须是 NSIS 规定的 164x314 / 150x57。给别的尺寸 MUI 会拉伸，边缘会糊。
  - 校验器规定这三个文件必须是**位图**（24 位 BMP 最稳；32 位带 alpha 在部分
    NSIS 版本上会显成黑底）。
  - header 用纯白底：MUI 的页头本来就是白的，白底位图贴上去边缘看不出来。
  - 品牌几何（柱高、色值、黄金分割宽度）从 `tools/make-icons.py` **导入**，不复制。
    否则改品牌时会出现「图标换了、安装器还是老样子」。

纯标准库实现，不依赖 Pillow。
"""

import importlib.util
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"


def _load_icon_module():
    """把 `make-icons.py` 当模块加载。

    不能直接 `import make-icons` —— 文件名里有连字符。它的 `main()` 有 `if __name__`
    守卫，所以加载模块不会顺手重新生成图标。
    """
    spec = importlib.util.spec_from_file_location("xbaos_make_icons", ROOT / "tools" / "make-icons.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ICONS = _load_icon_module()

CHARCOAL = ICONS.CHARCOAL
BLUE = ICONS.BLUE
CREAM = ICONS.CREAM
TERRA = ICONS.TERRA
BARS = ICONS.BARS
BAR_W = ICONS.BAR_W
SUB_Y, SUB_H = ICONS.SUB_Y, ICONS.SUB_H
SUBS = ICONS.SUBS

# 标记组的包围盒（320 逻辑坐标）：五根波形柱 + 三条字幕条
#   x：最左 63（柱与字幕条同起点），最右 257（231 + 26）
#   y：最上 58（中间那根柱子最高），最下 262（244 + 18）
MARK_BOX = (63, 58, 194, 204)

SS = 3  # 超采样倍数（3x3）


def fill_rect(buf, w, h, x0, y0, x1, y1, color):
    """带抗锯齿的实心矩形，直接写进 buf（RGB 三元组，自上而下）。

    位图不透明，所以这里不做 alpha 混合的除法，而是按覆盖率把新色**压**上去 ——
    只需要处理「部分覆盖」这一种情况。
    """
    ix0, iy0 = max(0, int(x0) - 1), max(0, int(y0) - 1)
    ix1, iy1 = min(w, int(x1) + 1), min(h, int(y1) + 1)
    n = SS * SS
    for py in range(iy0, iy1):
        for px in range(ix0, ix1):
            hits = 0
            for sy in range(SS):
                yy = py + (sy + 0.5) / SS
                if yy < y0 or yy >= y1:
                    continue
                for sx in range(SS):
                    xx = px + (sx + 0.5) / SS
                    if x0 <= xx < x1:
                        hits += 1
            if hits == 0:
                continue
            k = hits / n
            i = (py * w + px) * 3
            for c in range(3):
                old = buf[i + c]
                buf[i + c] = int(old + (color[c] - old) * k + 0.5)


def draw_mark(buf, w, h, x, y, width):
    """把品牌标记按给定宽度等比画到 (x, y)，返回实际高度。"""
    scale = width / MARK_BOX[2]
    height = MARK_BOX[3] * scale

    def put(sx, sy, sw, sh, color):
        fill_rect(
            buf, w, h,
            x + (sx - MARK_BOX[0]) * scale,
            y + (sy - MARK_BOX[1]) * scale,
            x + (sx - MARK_BOX[0] + sw) * scale,
            y + (sy - MARK_BOX[1] + sh) * scale,
            color,
        )

    for bx, ty, th, tc, by, bh in BARS:
        # 上段按柱交替 米白/陶土，下段统一钢蓝 —— 与图标完全一致
        put(bx, ty, BAR_W, th, tc)
        put(bx, by, BAR_W, bh, BLUE)
    for sx, sw, c in SUBS:
        put(sx, SUB_Y, sw, SUB_H, c)
    return height


def encode_bmp(buf, w, h):
    """24 位、自底向上、不压缩的 BMP。"""
    pad = (4 - (w * 3) % 4) % 4
    stride = w * 3 + pad
    offset = 14 + 40
    out = bytearray(b"BM")
    out += struct.pack("<IHHI", offset + stride * h, 0, 0, offset)
    # BITMAPINFOHEADER：宽高为正 = 自底向上
    out += struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, stride * h, 2835, 2835, 0, 0)
    for y in range(h - 1, -1, -1):
        row = y * w * 3
        for x in range(w):
            i = row + x * 3
            out += bytes((buf[i + 2], buf[i + 1], buf[i]))
        out += b"\x00" * pad
    return bytes(out)


def build_sidebar(accent):
    """164x314：完成页 / 卸载欢迎页的品牌面板。

    构图只有两件东西：居中的品牌标记 + 它下方一条**单色**分段横杠。

    为什么不画四角角标、也不用三色横杠：标记自带的三条字幕条（61.8/23.6/14.6，
    蓝/米白/陶土）就已经是那个形状了。再在下面放一条同形状同配色的横杠，
    它们会读成「画重了两遍」—— 第一版就是这么出来的。横杠改成**mono 强调色**、
    压到 6px，才读得出是「一条基线」而不是第二条字幕条。
    """
    w, h = 164, 314
    buf = bytearray(bytes(CHARCOAL) * (w * h))

    mw = w - 32                       # 品牌标记左右各留 16px
    mh = mw * MARK_BOX[3] / MARK_BOX[2]
    rule_h, gap = 6, 34
    top = (h - (mh + gap + rule_h)) / 2

    draw_mark(buf, w, h, 16, top, mw)

    # 分段横杠：宽度仍是黄金分割，但统一用强调色
    seg_gap = 4
    avail = mw - seg_gap * 2
    y = top + mh + gap
    x = 16.0
    for pct in (0.618, 0.236, 0.146):
        seg = avail * pct
        fill_rect(buf, w, h, x, y, x + seg, y + rule_h, accent)
        x += seg + seg_gap

    return encode_bmp(buf, w, h)


def build_header():
    """150x57：内页右上角的标记，白底融入 MUI 页头。"""
    w, h = 150, 57
    buf = bytearray(b"\xff" * (w * h * 3))
    mh = 34
    mw = mh * MARK_BOX[2] / MARK_BOX[3]
    draw_mark(buf, w, h, (w - mw) / 2, (h - mh) / 2, mw)
    return encode_bmp(buf, w, h)


def main():
    OUT.mkdir(exist_ok=True)

    # 安装器用钢蓝作强调色（与图标下段同色）；卸载器换成陶土，
    # 一眼能看出「这是另一件事」。品牌标记本身两边完全一致。
    (OUT / "installerSidebar.bmp").write_bytes(build_sidebar(BLUE))
    (OUT / "uninstallerSidebar.bmp").write_bytes(build_sidebar(TERRA))
    (OUT / "installerHeader.bmp").write_bytes(build_header())

    for name in ("installerSidebar.bmp", "uninstallerSidebar.bmp", "installerHeader.bmp"):
        f = OUT / name
        print(f"{name}  {f.stat().st_size} bytes")


if __name__ == "__main__":
    main()
