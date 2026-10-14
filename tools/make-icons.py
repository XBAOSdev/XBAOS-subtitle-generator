# -*- coding: utf-8 -*-
"""生成 XBAOS 字幕生成器应用图标。

设计规范（用户定稿）：
  - 320x320 逻辑画布，深灰纯色底板 #2E3236，外框圆角 32，内部全部直角
  - 5 根竖向波形柱：自底向上 61.8%（黄金分割）为钢蓝 #4A7BA6，
    上段 38.2% 按柱交替 米白 #F2EADB / 陶土 #C08A5F
  - 下方字幕条与波形区分离：三块宽度 61.8% / 23.6% / 14.6%（连续黄金分割），
    依次钢蓝 / 米白 / 陶土，块间留 8px 缝隙
  - 主元素组（波形 + 间距 + 字幕 = 204px 高）在底板内水平垂直双居中
  - 四角 12px 像素角标 #41464C，内移避开圆角

输出：
  build/icon.ico        多尺寸（16/24/32/48/64/128/256，小尺寸 BMP、大尺寸 PNG）
  build/icon-<n>.png    各尺寸 PNG（含 512 母版）

纯标准库实现：矩形场景自带光栅化（3x3 超采样抗锯齿），不依赖 Pillow。
"""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"

# ---------------------------------------------------------------- 设计数据
CHARCOAL = (0x2E, 0x32, 0x36)
MARK = (0x41, 0x46, 0x4C)
BLUE = (0x4A, 0x7B, 0xA6)
CREAM = (0xF2, 0xEA, 0xDB)
TERRA = (0xC0, 0x8A, 0x5F)

# 竖柱：(x, 顶段y, 顶段高, 顶段颜色, 蓝段y, 蓝段高) —— 320 逻辑坐标
BARS = [
    (63, 158, 23, CREAM, 181, 37),
    (105, 108, 42, TERRA, 150, 68),
    (147, 58, 61, CREAM, 119, 99),
    (189, 124, 36, TERRA, 160, 58),
    (231, 168, 19, CREAM, 187, 31),
]
BAR_W = 26
SUB_Y, SUB_H = 244, 18
SUBS = [(63, 110, BLUE), (181, 42, CREAM), (231, 26, TERRA)]


def shapes():
    """从顶到底排列（先命中先用）。"""
    yield ("rrect", 0, 0, 320, 320, 32, CHARCOAL)
    for cx, cy in ((18, 18), (290, 18), (18, 290), (290, 290)):
        yield ("rect", cx, cy, 12, 12, MARK)
    for x, ty, th, tc, by, bh in BARS:
        yield ("rect", x, ty, BAR_W, th, tc)
        yield ("rect", x, by, BAR_W, bh, BLUE)
    for x, w, c in SUBS:
        yield ("rect", x, SUB_Y, w, SUB_H, c)


def inside(shape, x, y):
    kind = shape[0]
    if kind == "rect":
        _, sx, sy, w, h, _ = shape
        return sx <= x < sx + w and sy <= y < sy + h
    _, sx, sy, w, h, r, _ = shape
    if not (sx <= x < sx + w and sy <= y < sy + h):
        return False
    # 圆角判定：四个角区各以 (角点内收 r) 为圆心
    for cx, cy in ((sx + r, sy + r), (sx + w - r, sy + r), (sx + r, sy + h - r), (sx + w - r, sy + h - r)):
        in_corner_x = (x < sx + r) if cx == sx + r else (x >= sx + w - r)
        in_corner_y = (y < sy + r) if cy == sy + r else (y >= sy + h - r)
        if in_corner_x and in_corner_y:
            return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return True


def rasterize(size, ss=3):
    scale = size / 320.0
    shp = list(shapes())
    buf = bytearray(size * size * 4)
    for py in range(size):
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    lx = (px + (sx + 0.5) / ss) / scale
                    ly = (py + (sy + 0.5) / ss) / scale
                    for shape in reversed(shp):
                        if inside(shape, lx, ly):
                            c = shape[-1]
                            r += c[0]
                            g += c[1]
                            b += c[2]
                            a += 255
                            break
            n = ss * ss
            i = (py * size + px) * 4
            buf[i] = r // n
            buf[i + 1] = g // n
            buf[i + 2] = b // n
            buf[i + 3] = a // n
    return bytes(buf)


def png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def encode_png(rgba, size):
    raw = b"".join(b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", zlib.compress(raw, 9)) + png_chunk(b"IEND", b""))


def bmp_entry(rgba, size):
    """ICO 的 BMP 条目：40 字节头 + 自底向上 BGRA + 全零 AND 掩码。"""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0)
    px = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            i = (y * size + x) * 4
            px += bytes((rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]))
    mask_row = ((size + 31) // 32) * 4
    return header + bytes(px) + b"\x00" * (mask_row * size)


ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def build_ico(images):
    header = struct.pack("<HHH", 0, 1, len(ICO_SIZES))
    offset = 6 + 16 * len(ICO_SIZES)
    entries, blobs = b"", b""
    for s in ICO_SIZES:
        rgba, data = images[s], None
        if s <= 64:
            data = bmp_entry(rgba, s)
        else:
            data = encode_png(rgba, s)
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


def main():
    OUT.mkdir(exist_ok=True)
    sizes = sorted(set(ICO_SIZES + [512]))
    images = {}
    for s in sizes:
        images[s] = rasterize(s)
        (OUT / f"icon-{s}.png").write_bytes(encode_png(images[s], s))
        print(f"icon-{s}.png")
    (OUT / "icon.ico").write_bytes(build_ico(images))
    print("icon.ico")


if __name__ == "__main__":
    main()
