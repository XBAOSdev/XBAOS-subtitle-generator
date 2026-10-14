# ============================================================================
#  XBAOS 字幕生成器 —— 识别引擎
#
#  产物：xbaos-engine.exe
#     · /MT 静态链接 C 运行时，发布包不需要任何 vcruntime / msvcp DLL
#     · 静态链接 whisper.cpp 与 ggml，单文件即可运行
#     · 可选 Vulkan 后端（XBAOS_VULKAN=ON）
#
#  用法：
#    cmake -S . -B build/cpu -G Ninja -DCMAKE_BUILD_TYPE=Release
#    cmake --build build/cpu
#
#    cmake -S . -B build/vulkan -G Ninja -DCMAKE_BUILD_TYPE=Release -DXBAOS_VULKAN=ON
#    cmake --build build/vulkan
# ============================================================================

cmake_minimum_required(VERSION 3.20)

project(xbaos-engine
    VERSION 0.1.0
    DESCRIPTION "XBAOS 字幕生成器 识别引擎"
    LANGUAGES C CXX)

# ---------------------------------------------------------------------------
#  工具链
# ---------------------------------------------------------------------------

if(NOT MSVC)
    message(FATAL_ERROR
        "本引擎只支持 MSVC 工具链。\n"
        "原因是需要 /MT 静态链接 C 运行时，保证发布产物零外部运行时依赖。\n"
        "当前编译器：${CMAKE_CXX_COMPILER_ID}")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
endif()

# 源码含中文注释与中文字面量，必须显式按 UTF-8 解析，
# 否则 MSVC 会按系统代码页（GBK）读，中文全乱。
add_compile_options(/utf-8)

# ---------------------------------------------------------------------------
#  静态 C 运行时
#  这一条决定了发布产物能否做到「一个 exe，零外部 DLL」
# ---------------------------------------------------------------------------
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    CACHE STRING "MSVC 运行时库" FORCE)

# ---------------------------------------------------------------------------
#  依赖路径
# ---------------------------------------------------------------------------

set(WHISPER_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/whisper.cpp")
if(NOT EXISTS "${WHISPER_CPP_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "找不到 whisper.cpp 源码：${WHISPER_CPP_DIR}\n"
        "请先按 tools/fetch-deps.md 里的说明把源码放到 third_party/whisper.cpp")
endif()

# ---------------------------------------------------------------------------
#  whisper.cpp / ggml 构建选项
#  这些都必须在使用它们之前设定（add_subdirectory 之前）
# ---------------------------------------------------------------------------

set(BUILD_SHARED_LIBS              OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS            OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES         OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER           OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_IS_DEV           OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS           OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS_3RD_PARTY OFF CACHE BOOL "" FORCE)
set(WHISPER_FATAL_WARNINGS         OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL                   OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2                   OFF CACHE BOOL "" FORCE)
set(WHISPER_COREML                 OFF CACHE BOOL "" FORCE)
set(WHISPER_OPENVINO               OFF CACHE BOOL "" FORCE)
set(WHISPER_VITISAI                OFF CACHE BOOL "" FORCE)
set(WHISPER_USE_SYSTEM_GGML        OFF CACHE BOOL "" FORCE)
set(WHISPER_USE_SYSTEM_LLAMA       OFF CACHE BOOL "" FORCE)

# ---------------------------------------------------------------------------
#  CPU 指令集
#
#  目标机为 Intel Core Ultra 5 225H（Arrow Lake-H）。
#  Arrow Lake 的消费级型号已禁用 AVX-512，若误开，程序会在第一次推理时
#  触发非法指令直接崩溃，且很难排查 —— 所以这里逐个显式关闭，不依赖默认值。
# ---------------------------------------------------------------------------

# GGML_NATIVE=OFF：不让 ggml 走「针对本机自动探测」的分支。
# 该分支会自动打开一些指令集，正是我们要避免的。
set(GGML_NATIVE        OFF CACHE BOOL "" FORCE)

set(GGML_SSE42         ON  CACHE BOOL "" FORCE)
set(GGML_AVX           ON  CACHE BOOL "" FORCE)
set(GGML_AVX2          ON  CACHE BOOL "" FORCE)
set(GGML_BMI2          ON  CACHE BOOL "" FORCE)

set(GGML_AVX512        OFF CACHE BOOL "" FORCE)
set(GGML_AVX512_VBMI   OFF CACHE BOOL "" FORCE)
set(GGML_AVX512_VNNI   OFF CACHE BOOL "" FORCE)
set(GGML_AVX512_BF16   OFF CACHE BOOL "" FORCE)

# 目标机支持 AVX-VNNI，理论上对量化推理有加速。
# 先保守关闭，等 AVX2 路径实测稳定后再单独开一版对比。
set(GGML_AVX_VNNI      OFF CACHE BOOL "" FORCE)

# ---------------------------------------------------------------------------
#  其它后端一律关闭（减少编译面与体积）
# ---------------------------------------------------------------------------

set(GGML_ACCELERATE    OFF CACHE BOOL "" FORCE)
set(GGML_BLAS          OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP        OFF CACHE BOOL "" FORCE)
set(GGML_CUDA          OFF CACHE BOOL "" FORCE)
set(GGML_METAL         OFF CACHE BOOL "" FORCE)
set(GGML_SYCL          OFF CACHE BOOL "" FORCE)
set(GGML_HIP           OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL        OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN_CHECK_RESULTS OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN_DEBUG         OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN_MEMORY_DEBUG  OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN_SHADER_DEBUG_INFO OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN_VALIDATE      OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN_RUN_TESTS     OFF CACHE BOOL "" FORCE)

# ---------------------------------------------------------------------------
#  Vulkan（可选）
# ---------------------------------------------------------------------------

option(XBAOS_VULKAN "编译 Vulkan GPU 后端" OFF)

if(XBAOS_VULKAN)
    if(NOT DEFINED ENV{VULKAN_SDK})
        message(FATAL_ERROR
            "开启了 Vulkan 后端但环境变量 VULKAN_SDK 未设置。\n"
            "请先执行 env.ps1（或手动设置 VULKAN_SDK 指向 Vulkan SDK 安装目录）。")
    endif()
    list(APPEND CMAKE_PREFIX_PATH "$ENV{VULKAN_SDK}")
    message(STATUS "Vulkan 后端已启用，SDK：$ENV{VULKAN_SDK}")
endif()

set(GGML_VULKAN ${XBAOS_VULKAN} CACHE BOOL "" FORCE)

# ---------------------------------------------------------------------------
#  第三方源码
# ---------------------------------------------------------------------------

add_subdirectory("${WHISPER_CPP_DIR}" "${CMAKE_BINARY_DIR}/whisper.cpp" EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
#  libopus（可选，给 OGG Opus 解码用）
#
#  源码放到 third_party/opus/（xiph/opus，BSD-3-Clause）就自动启用。
#  不存在时引擎照常编译，只是识别 Opus 文件会提示未支持。
# ---------------------------------------------------------------------------

set(XBAOS_OPUS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/opus")
if(EXISTS "${XBAOS_OPUS_DIR}/CMakeLists.txt")
    set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
    set(OPUS_BUILD_TESTING       OFF CACHE BOOL "" FORCE)
    set(OPUS_BUILD_PROGRAMS      OFF CACHE BOOL "" FORCE)
    set(OPUS_INSTALL_PKG         OFF CACHE BOOL "" FORCE)
    # opus 自己的选项：静态运行时（/MT，保持零外部 DLL）、关掉 intrinsics
    # （实测 opus 1.5.2 的 silk SSE4.1 内联代码在 MSVC 14.44 下报
    #  C2440 int→__m128i，纯 C 路径解码性能对本场景足够）
    set(OPUS_STATIC_RUNTIME      ON  CACHE BOOL "" FORCE)
    set(OPUS_DISABLE_INTRINSICS  ON  CACHE BOOL "" FORCE)
    add_subdirectory("${XBAOS_OPUS_DIR}" "${CMAKE_BINARY_DIR}/opus" EXCLUDE_FROM_ALL)
    message(STATUS "libopus 已启用（OGG Opus 解码）")
    set(XBAOS_HAS_OPUS 1)
else()
    message(STATUS "third_party/opus 不存在，本版本不支持 Opus 解码")
    set(XBAOS_HAS_OPUS 0)
endif()

# ---------------------------------------------------------------------------
#  引擎可执行文件
# ---------------------------------------------------------------------------

add_executable(xbaos-engine
    src/main.cpp
    src/decoders/decoders.cpp
    src/decoders/oggopus.cpp)

target_include_directories(xbaos-engine PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${WHISPER_CPP_DIR}/include"
    "${WHISPER_CPP_DIR}/ggml/include")

target_link_libraries(xbaos-engine PRIVATE whisper)

if(XBAOS_HAS_OPUS)
    target_link_libraries(xbaos-engine PRIVATE opus)
    target_include_directories(xbaos-engine PRIVATE "${XBAOS_OPUS_DIR}/include")
endif()

if(XBAOS_VULKAN)
    target_compile_definitions(xbaos-engine PRIVATE XBAOS_HAS_VULKAN=1)
endif()

target_compile_definitions(xbaos-engine PRIVATE XBAOS_HAS_OPUS=${XBAOS_HAS_OPUS})

# 控制台程序：发布时不需要带着控制台窗口，但保留它便于排查问题。
# 主进程用管道通信，窗口不显示（CREATE_NO_WINDOW），所以这里不加 WIN32。
set_target_properties(xbaos-engine PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

message(STATUS "")
message(STATUS "==================== xbaos-engine 配置 ====================")
message(STATUS "  构建类型      : ${CMAKE_BUILD_TYPE}")
message(STATUS "  MSVC 运行时   : ${CMAKE_MSVC_RUNTIME_LIBRARY}")
message(STATUS "  CPU 指令集    : SSE4.2 AVX AVX2 BMI2（AVX-512 已显式关闭）")
message(STATUS "  Vulkan 后端   : ${XBAOS_VULKAN}")
message(STATUS "  whisper.cpp   : ${WHISPER_CPP_DIR}")
message(STATUS "==========================================================")
message(STATUS "")
