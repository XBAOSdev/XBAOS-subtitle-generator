# ============================================================================
#  XBAOS 字幕生成器 —— ONNX 识别引擎
#
#  产物：xbaos-engine-asr.exe
#     · 与 whisper 引擎并列的第二套识别后端（sherpa-onnx + SenseVoice 等）
#     · /MT 静态链接 C 运行时，onnxruntime 同样静态链接，发布包零外部 DLL
#     · 复用 ../engine/src 下的音频解码、VAD 与 JSON 工具，不重复造轮子
#
#  用法（在项目根目录执行）：
#      bash engine-onnx/build.sh
# ============================================================================

cmake_minimum_required(VERSION 3.20)

project(xbaos-engine-asr
    VERSION 0.1.0
    DESCRIPTION "XBAOS 字幕生成器 ONNX 识别引擎"
    LANGUAGES C CXX)

if(NOT MSVC)
    message(FATAL_ERROR "本引擎只支持 MSVC 工具链（需要 /MT 静态链接）。")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
endif()

add_compile_options(/utf-8)

# 静态 C 运行时：与 whisper 引擎同一条硬约束
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    CACHE STRING "MSVC 运行时库" FORCE)

# ---------------------------------------------------------------------------
#  sherpa-onnx 源码与依赖
#
#  依赖包（*.tar.gz / *.tar.bz2）预置在源码根目录时，sherpa 的 cmake 会直接
#  使用它们而不联网下载 —— 国内直连 github 往往不通，这是构建能否成功的关键。
# ---------------------------------------------------------------------------

set(SHERPA_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../engine/third_party/sherpa-onnx")
if(NOT EXISTS "${SHERPA_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "找不到 sherpa-onnx 源码：${SHERPA_DIR}\n"
        "请按 docs/BUILD-ENGINE.md 的说明把源码放到 engine/third_party/sherpa-onnx")
endif()

# 静态构建 + 静态 CRT，缺一不可
set(BUILD_SHARED_LIBS                   OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_USE_STATIC_CRT          ON  CACHE BOOL "" FORCE)

# 只要 C API，其余全部关掉：体积与编译时间都省下来
set(SHERPA_ONNX_ENABLE_C_API            ON  CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_BINARY           OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_PYTHON           OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_TESTS            OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_CHECK            OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_PORTAUDIO        OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_JNI              OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_WEBSOCKET        OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_TTS              OFF CACHE BOOL "" FORCE)
# 说话人分离：靠 pyannote 分割 + 声纹聚类，与识别模型无关，两套引擎共用同一份
# 输出。打开它才能用 SherpaOnnxOfflineSpeakerDiarization* 这一组 C API（默认关着
# 时这些函数只有一句「not enabled」的桩），代价是引擎体积增加约 1 MB。
set(SHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION ON CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_GPU              OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_DIRECTML         OFF CACHE BOOL "" FORCE)
set(SHERPA_ONNX_ENABLE_AISHELL           OFF CACHE BOOL "" FORCE)

# 依赖包已预置在源码根目录，禁止再去网上找（找不到就直接失败，别静默等待）
set(FETCHCONTENT_FULLY_DISCONNECTED     OFF CACHE BOOL "" FORCE)

# Ninja 不会设置 CMAKE_VS_PLATFORM_NAME，而 onnxruntime 的预编译包靠它判断是否为
# x64 静态包；不补这一项，配置阶段会直接 FATAL_ERROR。只影响这套判断，不改编译器。
if(NOT CMAKE_VS_PLATFORM_NAME)
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(CMAKE_VS_PLATFORM_NAME X64)
    else()
        set(CMAKE_VS_PLATFORM_NAME Win32)
    endif()
endif()

add_subdirectory("${SHERPA_DIR}" "${CMAKE_BINARY_DIR}/sherpa-onnx" EXCLUDE_FROM_ALL)

# ---------------------------------------------------------------------------
#  libopus（可选，与 whisper 引擎共用同一份源码）
# ---------------------------------------------------------------------------

set(XBAOS_OPUS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../engine/third_party/opus")
if(EXISTS "${XBAOS_OPUS_DIR}/CMakeLists.txt")
    set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
    set(OPUS_BUILD_TESTING       OFF CACHE BOOL "" FORCE)
    set(OPUS_BUILD_PROGRAMS      OFF CACHE BOOL "" FORCE)
    set(OPUS_INSTALL_PKG         OFF CACHE BOOL "" FORCE)
    set(OPUS_STATIC_RUNTIME      ON  CACHE BOOL "" FORCE)
    set(OPUS_DISABLE_INTRINSICS  ON  CACHE BOOL "" FORCE)
    add_subdirectory("${XBAOS_OPUS_DIR}" "${CMAKE_BINARY_DIR}/opus" EXCLUDE_FROM_ALL)
    set(XBAOS_HAS_OPUS 1)
else()
    set(XBAOS_HAS_OPUS 0)
endif()

# ---------------------------------------------------------------------------
#  引擎可执行文件
# ---------------------------------------------------------------------------

set(SHARED_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../engine/src")

add_executable(xbaos-engine-asr
    src/main.cpp
    "${SHARED_SRC}/decoders/decoders.cpp"
    "${SHARED_SRC}/decoders/oggopus.cpp")

target_include_directories(xbaos-engine-asr PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${SHARED_SRC}"
    "${SHARED_SRC}/decoders"
    "${SHERPA_DIR}")

target_link_libraries(xbaos-engine-asr PRIVATE sherpa-onnx-c-api)

if(XBAOS_HAS_OPUS)
    target_link_libraries(xbaos-engine-asr PRIVATE opus)
    target_include_directories(xbaos-engine-asr PRIVATE "${XBAOS_OPUS_DIR}/include")
endif()

target_compile_definitions(xbaos-engine-asr PRIVATE XBAOS_HAS_OPUS=${XBAOS_HAS_OPUS})

set_target_properties(xbaos-engine-asr PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

message(STATUS "")
message(STATUS "============== xbaos-engine-asr 配置 ==============")
message(STATUS "  构建类型    : ${CMAKE_BUILD_TYPE}")
message(STATUS "  MSVC 运行时 : ${CMAKE_MSVC_RUNTIME_LIBRARY}")
message(STATUS "  sherpa-onnx : ${SHERPA_DIR}")
message(STATUS "  Opus 解码   : ${XBAOS_HAS_OPUS}")
message(STATUS "==================================================")
message(STATUS "")
