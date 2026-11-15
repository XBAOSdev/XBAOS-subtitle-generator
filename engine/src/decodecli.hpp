// 引擎的「一次性解码」命令行模式 —— 为编辑器的试听与波形服务。
//
// 背景：软件包内的 ffmpeg.dll 是非专有构建，Chromium 解不了 AAC（实测
// audio 元素直接报 DEMUXER_ERROR_NO_SUPPORTED_STREAMS）。而编辑器播放与波形都
// 走 Chromium 的解码链路，所以 m4a / mp4 / aac 必须先由本引擎（经系统解码器）
// 解成一份 WAV，界面才播得出来、画得出波形。
//
// 用法（主进程在需要时拉起，用完即退，不参与 JSON-RPC 协议）：
//     xbaos-engine-asr.exe --decode <源文件> <目标.wav>
//   退出码 0 成功；2 读文件失败；3 解码失败；4 写文件失败
//   失败原因写 stderr（UTF-8 中文），成功时 stdout 打一行 JSON 供主进程记日志
//
// 输出格式固定 16 位 PCM **单声道**、采样率保持源文件：
//   · 保持采样率：这是给耳朵听的原声，降到 16k 会像打电话
//   · 混成单声道：波形与试听都用不到声道分离，而文件体积直接减半
//     （1 小时 44.1kHz 从约 635MB 降到 318MB）

#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <shellapi.h> // CommandLineToArgvW
#endif

#include "audio.hpp"
#include "decoders/decoders.hpp"
#include "platform.hpp"

namespace xaudio {

namespace detail_cli {

inline void put16(std::vector<uint8_t> &b, uint16_t v) {
    b.push_back((uint8_t)(v & 0xFF));
    b.push_back((uint8_t)((v >> 8) & 0xFF));
}

inline void put32(std::vector<uint8_t> &b, uint32_t v) {
    b.push_back((uint8_t)(v & 0xFF));
    b.push_back((uint8_t)((v >> 8) & 0xFF));
    b.push_back((uint8_t)((v >> 16) & 0xFF));
    b.push_back((uint8_t)((v >> 24) & 0xFF));
}

} // namespace detail_cli

/**
 * 把解码结果写成 16 位 PCM 单声道 WAV。
 *
 * 逐项写小端字节而不是直接 fwrite 一个结构体：WAV 头的字段是固定布局，
 * 结构体在 MSVC 下虽然也不会插填充，但依赖它属于「编译器没变就没事」的写法。
 */
inline bool writeWav16Mono(const std::string &outPath, const xdec::DecodedAudio &dec,
                           std::string &err) {
    if (dec.sample_rate <= 0 || dec.channels <= 0 || dec.pcm.empty()) {
        err = "解码结果为空";
        return false;
    }

    const size_t frames = dec.pcm.size() / (size_t)dec.channels;
    std::vector<uint8_t> out;
    out.reserve(44 + frames * 2);

    const uint32_t dataBytes = (uint32_t)(frames * 2);
    out.insert(out.end(), {'R', 'I', 'F', 'F'});
    detail_cli::put32(out, 36 + dataBytes);
    out.insert(out.end(), {'W', 'A', 'V', 'E'});
    out.insert(out.end(), {'f', 'm', 't', ' '});
    detail_cli::put32(out, 16);            // fmt 块长度
    detail_cli::put16(out, 1);             // PCM
    detail_cli::put16(out, 1);             // 单声道
    detail_cli::put32(out, (uint32_t)dec.sample_rate);
    detail_cli::put32(out, (uint32_t)dec.sample_rate * 2); // 字节率
    detail_cli::put16(out, 2);             // 块对齐
    detail_cli::put16(out, 16);            // 位深
    out.insert(out.end(), {'d', 'a', 't', 'a'});
    detail_cli::put32(out, dataBytes);

    const int channels = dec.channels;
    for (size_t i = 0; i < frames; i++) {
        double sum = 0.0;
        for (int c = 0; c < channels; c++) sum += (double)dec.pcm[i * (size_t)channels + (size_t)c];
        double v = sum / (double)channels;
        if (v > 1.0) v = 1.0;
        if (v < -1.0) v = -1.0;
        const int16_t s = (int16_t)(v * 32767.0);
        detail_cli::put16(out, (uint16_t)s);
    }

    // 必须走 pathFromUtf8：中文路径交给窄字符重载会按 GBK 解释 UTF-8 而失败
    std::ofstream f(xbaos::pathFromUtf8(outPath), std::ios::binary | std::ios::trunc);
    if (!f) {
        err = "无法写入文件：" + outPath;
        return false;
    }
    f.write(reinterpret_cast<const char *>(out.data()), (std::streamsize)out.size());
    if (!f) {
        err = "写入失败：" + outPath;
        return false;
    }
    return true;
}

/**
 * 从 GetCommandLineW() 取命令行（UTF-8 化）。
 *
 * 不能用 main 的 argv：它是进程 ANSI 代码页（GBK），中文路径到这里已经烂了。
 * 详见 platform.hpp 的 wideToUtf8 注释。
 */
inline std::vector<std::string> cliArgs() {
    std::vector<std::string> out;
#if defined(_WIN32)
    int count = 0;
    LPWSTR *wide = ::CommandLineToArgvW(::GetCommandLineW(), &count);
    if (!wide) return out;
    out.reserve((size_t)count);
    for (int i = 0; i < count; i++) out.push_back(xbaos::wideToUtf8(wide[i]));
    ::LocalFree(wide);
#endif
    return out;
}

/**
 * 命令行入口。不是 `--decode` 模式时返回 -1，调用方继续走原来的流程。
 */
inline int runDecodeCli() {
    const std::vector<std::string> args = cliArgs();
    if (args.size() < 2 || args[1] != "--decode") return -1;
    if (args.size() < 4) {
        std::fprintf(stderr, "用法：--decode <源音频> <目标.wav>\n");
        return 1;
    }
    const std::string src = args[2];
    const std::string dst = args[3];

    std::vector<uint8_t> buf;
    std::string err;
    if (!detail::readFile(src, buf, err)) {
        std::fprintf(stderr, "%s\n", err.c_str());
        return 2;
    }

    xdec::DecodedAudio dec;
    if (!xdec::decodeMediaFoundation(buf.data(), buf.size(), dec, err)) {
        std::fprintf(stderr, "%s\n", err.c_str());
        return 3;
    }

    if (!writeWav16Mono(dst, dec, err)) {
        std::fprintf(stderr, "%s\n", err.c_str());
        return 4;
    }

    const double seconds =
        (double)(dec.pcm.size() / (size_t)dec.channels) / (double)dec.sample_rate;
    std::printf("{\"ok\":true,\"seconds\":%.3f,\"sourceRate\":%d,\"sourceChannels\":%d}\n",
                seconds, dec.sample_rate, dec.channels);
    std::fflush(stdout);
    return 0;
}

} // namespace xaudio
