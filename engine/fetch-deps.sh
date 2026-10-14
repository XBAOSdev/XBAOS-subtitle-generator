#!/usr/bin/env bash
# ============================================================================
#  获取引擎的第三方源码
#
#  第三方源码不入库（whisper.cpp 解压后约 40MB），克隆仓库后跑一次即可。
#
#  用法：
#      bash engine/fetch-deps.sh
#
#  可以覆盖的变量：
#      XBAOS_GH_MIRROR    GitHub 加速前缀，默认 https://gh-proxy.com
#                         直连 GitHub 没问题的话设为空字符串即可
#      XBAOS_CACHE        下载缓存目录，默认 engine/.cache
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THIRD_PARTY="$SCRIPT_DIR/third_party"
CACHE="${XBAOS_CACHE:-$SCRIPT_DIR/.cache}"
MIRROR="${XBAOS_GH_MIRROR-https://gh-proxy.com}"

WHISPER_VERSION="v1.9.4"

mkdir -p "$THIRD_PARTY" "$CACHE"

# 给 GitHub 链接套上加速前缀
gh_url() {
    if [ -n "$MIRROR" ]; then
        echo "${MIRROR}/$1"
    else
        echo "$1"
    fi
}

download() {
    local url="$1"
    local dest="$2"
    if [ -f "$dest" ]; then
        echo "  已缓存：$(basename "$dest")"
        return 0
    fi
    echo "  下载：$url"
    curl -L --retry 3 --connect-timeout 20 -o "$dest" "$url"
}

echo "=== whisper.cpp $WHISPER_VERSION ==="
if [ -f "$THIRD_PARTY/whisper.cpp/CMakeLists.txt" ]; then
    echo "  已存在，跳过。要重新获取请先删除 $THIRD_PARTY/whisper.cpp"
else
    TARBALL="$CACHE/whisper.cpp-$WHISPER_VERSION.tar.gz"
    download \
        "$(gh_url "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$WHISPER_VERSION.tar.gz")" \
        "$TARBALL"

    echo "  解压中…"
    rm -rf "$THIRD_PARTY/whisper.cpp" "$THIRD_PARTY/whisper.cpp-$WHISPER_VERSION"
    tar -xzf "$TARBALL" -C "$THIRD_PARTY"

    # 归档解出来的目录名带版本号，统一成 whisper.cpp 方便引用
    if [ -d "$THIRD_PARTY/whisper.cpp-$WHISPER_VERSION" ]; then
        mv "$THIRD_PARTY/whisper.cpp-$WHISPER_VERSION" "$THIRD_PARTY/whisper.cpp"
    fi
    echo "  完成：$THIRD_PARTY/whisper.cpp"
fi

echo ""
echo "=== 检查结果 ==="
if [ -f "$THIRD_PARTY/whisper.cpp/include/whisper.h" ]; then
    echo "whisper.h            OK"
else
    echo "whisper.h            缺失，获取失败" >&2
    exit 1
fi

if [ -d "$THIRD_PARTY/whisper.cpp/ggml/src/ggml-vulkan" ]; then
    echo "ggml-vulkan 后端     OK"
else
    echo "ggml-vulkan 后端     缺失" >&2
    exit 1
fi

echo ""
echo "接下来：bash engine/build.sh"
