#!/usr/bin/env bash
# ============================================================================
#  构建识别引擎
#
#  用法（在项目根目录执行）：
#      bash engine/build.sh            # CPU 版
#      bash engine/build.sh vulkan     # Vulkan GPU 版
#      bash engine/build.sh clean      # 清掉构建目录
#
#  产物：engine/build/<变体>/bin/xbaos-engine.exe
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

VARIANT="${1:-cpu}"

if [ "$VARIANT" = "clean" ]; then
    rm -rf engine/build
    echo "已清理 engine/build"
    exit 0
fi

# 载入 MSVC / CMake / Ninja / Vulkan 环境
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh" > /dev/null

BUILD_DIR="engine/build/$VARIANT"
EXTRA_ARGS=()

case "$VARIANT" in
    cpu)
        ;;
    vulkan)
        if [ -z "${VULKAN_SDK:-}" ]; then
            echo "错误：没有找到 VULKAN_SDK，无法编译 GPU 版" >&2
            exit 1
        fi
        EXTRA_ARGS+=("-DXBAOS_VULKAN=ON")
        ;;
    *)
        echo "未知变体：$VARIANT（可选 cpu / vulkan / clean）" >&2
        exit 1
        ;;
esac

echo "=== 配置 $VARIANT 版 ==="
cmake -S engine -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release "${EXTRA_ARGS[@]}"

echo ""
echo "=== 编译 $VARIANT 版 ==="
# MSVC 输出是 GBK，转成 UTF-8 才能正常显示中文报错
cmake --build "$BUILD_DIR" 2>&1 | iconv -f GBK -t UTF-8 2>/dev/null || cmake --build "$BUILD_DIR"

echo ""
echo "=== 产物 ==="
ls -la "$BUILD_DIR/bin/" 2>/dev/null || true
