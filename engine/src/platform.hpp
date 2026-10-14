// 平台适配：路径与编码。
//
// 引擎协议里的路径一律是 UTF-8（JSON 本身就是 UTF-8），但 Windows 的窄字符
// 文件 API 走的是 ANSI 代码页 —— 简体中文系统上就是 GBK。把 UTF-8 字节直接
// 丢给 std::ifstream 的 const char* 构造函数，路径里只要有中文就会打开失败。
//
// 实测（.workbuddy/tmp/中文 路径测试/，目录名和文件名都含中文与空格）：
//   全 ASCII 路径                            → 正常
//   模型路径 <...>\中文 路径测试\models\a.bin → 正常（whisper.cpp 自己做了宽字符转换）
//   音频路径 <...>\中文 路径测试\我的录音.wav → 失败，报「无法打开文件」
//
// 所以音频侧必须自己转。做法是转成宽字符后交给 std::filesystem::path：
// Windows 上 path::value_type 就是 wchar_t，MSVC 的文件流会走 _wfopen 分支，
// 天然支持任意 Unicode 路径，也不必手写一份 FILE* 的 RAII 包装。

#pragma once

#include <filesystem>
#include <string>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
// windows.h 会定义 min/max 宏，和 std::min/std::max 冲突
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace xbaos {

#if defined(_WIN32)

/** UTF-8 → 宽字符。转换失败返回空串，由调用方决定怎么报错。 */
inline std::wstring utf8ToWide(const std::string &utf8) {
    if (utf8.empty()) return std::wstring();
    const int need = ::MultiByteToWideChar(CP_UTF8, 0, utf8.data(), (int)utf8.size(), nullptr, 0);
    if (need <= 0) return std::wstring();
    std::wstring wide((size_t)need, L'\0');
    const int got = ::MultiByteToWideChar(CP_UTF8, 0, utf8.data(), (int)utf8.size(), wide.data(), need);
    if (got <= 0) return std::wstring();
    wide.resize((size_t)got);
    return wide;
}

/**
 * UTF-8 路径 → 可直接喂给文件流的 path。
 *
 * 转换失败时返回空 path，打开必然失败 —— 这正是想要的：上层会报
 * 「无法打开文件」并带上原始路径，而不是悄悄去读了另一个文件。
 */
inline std::filesystem::path pathFromUtf8(const std::string &utf8) {
    return std::filesystem::path(utf8ToWide(utf8));
}

#else

inline std::filesystem::path pathFromUtf8(const std::string &utf8) {
    return std::filesystem::path(utf8);
}

#endif

} // namespace xbaos
