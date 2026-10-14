#!/usr/bin/env bash
# ============================================================================
#  XBAOS 开发环境入口（Git Bash）
#
#  用法：
#      source engine/env.sh
#
#  载入后可用：cl.exe / cmake / ninja / glslc
#  PowerShell 用户请用同目录的 env.ps1。
#
#  这套环境装一次即可长期复用：任何需要 MSVC 的 C/C++ 原生项目、
#  任何 Electron / Node 项目都能用。
#
#  ⚠ 注意：PATH 里只能出现 MSYS 风格的路径（/d/... /c/...）。
#     写 "D:/Code/..." 会因为盘符后的冒号被当成 PATH 分隔符，把一项拆成两项。
# ============================================================================

# ---- PATH 用的路径：MSYS 风格 ----
export PC_DEV_ENV="/d/Code/PCDevEnv"
export XBAOS_VSBT="/d/Code/PCDevEnv/vsbt"
export XBAOS_WINSDK="/c/Program Files (x86)/Windows Kits/10"
export XBAOS_VULKAN_BIN="/c/VulkanSDK/1.4.363.0/Bin"

# ---- 供 Windows 程序读取的路径：Windows 风格、分号分隔，MSYS 不会替我们转换 ----
export XBAOS_MSVC_VER="14.44.35207"
export XBAOS_SDK_VER="10.0.26100.0"
export VULKAN_SDK="C:\\VulkanSDK\\1.4.363.0"

# SDK 的 host 工具目录：rc.exe（资源编译）与 mt.exe（清单工具）在这里。
# 少了它 CMake 会报 "Check for working C compiler - broken"。
export XBAOS_SDK_BIN="$XBAOS_WINSDK/bin/$XBAOS_SDK_VER/x64"

# ---- PATH：CMake 与 Ninja 放在最前，避免被系统里的旧版本抢到 ----
export PATH="$PC_DEV_ENV/tools/cmake/bin:$PC_DEV_ENV/tools:$XBAOS_VSBT/VC/Tools/MSVC/$XBAOS_MSVC_VER/bin/Hostx64/x64:$XBAOS_SDK_BIN:$PATH"
export PATH="$XBAOS_VULKAN_BIN:$PATH"

# ---- MSVC 头文件与库搜索路径 ----
export INCLUDE="D:\\Code\\PCDevEnv\\vsbt\\VC\\Tools\\MSVC\\$XBAOS_MSVC_VER\\include;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\$XBAOS_SDK_VER\\ucrt;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\$XBAOS_SDK_VER\\shared;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\$XBAOS_SDK_VER\\um;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\$XBAOS_SDK_VER\\winrt;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\$XBAOS_SDK_VER\\cppwinrt"

export LIB="D:\\Code\\PCDevEnv\\vsbt\\VC\\Tools\\MSVC\\$XBAOS_MSVC_VER\\lib\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\$XBAOS_SDK_VER\\ucrt\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\$XBAOS_SDK_VER\\um\\x64"

export LIBPATH="D:\\Code\\PCDevEnv\\vsbt\\VC\\Tools\\MSVC\\$XBAOS_MSVC_VER\\lib\\x64"

# ---- 国内镜像：Electron 二进制下载加速 ----
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

xbaos_env_check() {
    echo "--- XBAOS 开发环境 ---"
    if command -v cl > /dev/null 2>&1; then
        printf 'cl      : %s\n' "$(cl 2>&1 | head -1 | tr -d '\r')"
    else
        printf 'cl      : 未找到\n'
    fi
    printf 'cmake   : %s\n' "$(cmake --version 2>/dev/null | head -1)"
    printf 'ninja   : %s\n' "$(ninja --version 2>/dev/null | head -1)"
    printf 'glslc   : %s\n' "$(glslc --version 2>/dev/null | head -1)"
    printf 'VULKAN  : %s\n' "$VULKAN_SDK"
}

xbaos_env_check
