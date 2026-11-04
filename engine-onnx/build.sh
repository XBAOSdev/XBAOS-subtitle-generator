#!/usr/bin/env bash
# ============================================================================
#  构建 ONNX 识别引擎（sherpa-onnx + SenseVoice）
#
#  用法（在项目根目录执行）：
#      bash engine-onnx/build.sh          # 构建
#      bash engine-onnx/build.sh clean    # 清掉构建目录
#
#  产物：engine-onnx/build/bin/xbaos-engine-asr.exe
#
#  前置：
#    · engine/third_party/sherpa-onnx/  源码（含预置的依赖 tar 包）
#    · engine/third_party/opus/         可选，OGG Opus 解码
#
#  依赖包必须预置在源码根目录，构建过程不联网 —— 国内直连 github 通常不通，
#  这是整个流程能否走通的关键。包名与哈希见该目录下的 *.cmake。
#  缺什么就补什么：node tools/fetch-deps.mjs engine-onnx 会扫 build/_deps 里的
#  FetchContent 声明，把 github 归档换成 codeload 直连拉下来。
#  说话人分离专用的 hclust-cpp（分层聚类）只有打开 diarization 时才需要，
#  最容易漏，见 engine/third_party/sherpa-onnx/cmake/hclust-cpp.cmake。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BUILD_DIR="engine-onnx/build"

if [ "${1:-}" = "clean" ]; then
    rm -rf "$BUILD_DIR"
    echo "已清理 $BUILD_DIR"
    exit 0
fi

# 载入 MSVC / CMake / Ninja 环境
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../engine/env.sh" > /dev/null

if [ ! -f engine/third_party/sherpa-onnx/CMakeLists.txt ]; then
    echo "错误：找不到 engine/third_party/sherpa-onnx" >&2
    exit 1
fi

cmake -S engine-onnx -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR"

EXE="$BUILD_DIR/bin/xbaos-engine-asr.exe"
if [ -f "$EXE" ]; then
    SIZE=$(stat -c%s "$EXE" 2>/dev/null || echo 0)
    echo ""
    echo "构建完成：$EXE"
    printf "产物大小：%.1f MB\n" "$(echo "$SIZE / 1048576" | bc -l 2>/dev/null || echo 0)"
else
    echo "构建失败：没有生成 $EXE" >&2
    exit 1
fi
