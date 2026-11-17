// AAC / MP4 解码 —— 调用 Windows 自带的 Media Foundation 解码器。
//
// 为什么是「调系统」而不是「自带实现」：
//   AAC 的实现一旦编进本仓库的任何二进制，本软件就成了「制造 AAC 产品」的实施者，
//   需要自行取得 Via LA 的专利许可。调用 mfplat.dll / mfreadwrite.dll 里的解码器，
//   实现者与分发者都是微软，本软件只做「容器 → PCM」的搬运。
//   所以这个文件里**没有一行 AAC 解码算法**：所有分量都由系统 MFT 产生。
//
// 支持的输入由系统解码器决定，不由我们决定：
//   · MP4 / M4A / M4B（ISO BMFF）、裸 ADTS（.aac）、LOAS / LATM
//   · 音轨编码 AAC-LC、HE-AAC v1 / v2（SBR / PS 由解码器自行处理，这里不做分支）
//   · 不支持的：xHE-AAC（USAC）—— 系统没有对应解码器，报错时给出可读提示
//
// 环境依赖：
//   Windows 10 / 11 自带这两个 DLL，不需要随包分发任何东西，也不需要像 HEVC 那样
//   去商店买扩展。N / KN 版或精简镜像删掉了媒体功能时会失败，上层据此提示安装
//   Media Feature Pack —— 这个区分在 mfErrorText() 里做。

#include "decoders.hpp"

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <shlwapi.h>

#include <wrl/client.h>

#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>

using Microsoft::WRL::ComPtr;

namespace xdec {
namespace {

/**
 * 进程级只做一次的 MFStartup。
 *
 * MFShutdown 故意不调用：引擎是常驻进程，退出时由系统回收；反过来在退出路径里
 * 关 MF 很容易踩到「工作线程还在跑」的竞态，收益为零。
 */
HRESULT ensureMfStarted() {
    static std::once_flag once;
    static HRESULT hr = E_PENDING;
    std::call_once(once, [] {
        // MFSTARTUP_NOSOCKET：不初始化网络栈。本项目不播流媒体，少开一套东西
        hr = ::MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
    });
    return hr;
}

/**
 * 每个调用线程都要自己 CoInitializeEx。
 *
 * 不能只靠上面那个 once —— COM 是按线程的，而解码可能发生在主线程也可能发生在
 * 工作线程。RPC_E_CHANGED_MODE 表示这个线程已经按 STA 初始化过了，对 MF 够用，
 * 不当作失败（也不配对 CoUninitialize，因为不是我们初始化的）。
 */
struct ComScope {
    HRESULT hr = ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool owned = (hr == S_OK);
    ~ComScope() {
        if (owned) ::CoUninitialize();
    }
    bool usable() const { return SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE; }
};

/** 把 HRESULT 翻成人话。区分「没有解码器」和「文件坏了」，前者要给出可操作的建议。 */
std::string mfErrorText(HRESULT hr, const char *stage) {
    char code[16] = {0};
    std::snprintf(code, sizeof(code), "0x%08X", (unsigned)hr);
    switch (hr) {
    case MF_E_TOPO_CODEC_NOT_FOUND:
    case MF_E_UNSUPPORTED_BYTESTREAM_TYPE:
    case MF_E_INVALIDMEDIATYPE:
        // 两条最常见成因：音轨用了系统没有实现的编码（DTS、Opus、xHE-AAC 等），
        // 或者系统媒体功能被裁掉（Windows N 版 / 精简镜像）。
        // 这里不能替用户猜是哪一条 —— 只能把两个可能都摆出来。
        return std::string("系统的解码器解不了这条音轨（") + stage + "，错误码 " + code +
               "）。可能是音轨编码系统没有内置（如 DTS、Opus、xHE-AAC），"
               "也可能是系统缺少「媒体功能包」（Windows N 版）。";
    default:
        return std::string("系统解码器失败（") + stage + "，错误码 " + code + "）。";
    }
}

/** 采样缓冲的位宽与类型：解码器未必按我们要求的格式给，按实际类型解释。 */
bool appendSamples(const BYTE *p, DWORD bytes, const GUID &subtype, UINT32 bits,
                   std::vector<float> &dst) {
    if (IsEqualGUID(subtype, MFAudioFormat_Float)) {
        const size_t n = bytes / sizeof(float);
        const float *src = reinterpret_cast<const float *>(p);
        dst.insert(dst.end(), src, src + n);
        return true;
    }
    if (IsEqualGUID(subtype, MFAudioFormat_PCM)) {
        if (bits == 16) {
            const size_t n = bytes / sizeof(int16_t);
            const int16_t *src = reinterpret_cast<const int16_t *>(p);
            for (size_t i = 0; i < n; i++) dst.push_back((float)src[i] / 32768.0f);
            return true;
        }
        if (bits == 32) {
            const size_t n = bytes / sizeof(int32_t);
            const int32_t *src = reinterpret_cast<const int32_t *>(p);
            for (size_t i = 0; i < n; i++) dst.push_back((float)((double)src[i] / 2147483648.0));
            return true;
        }
    }
    return false;
}

} // namespace

bool decodeMediaFoundation(const uint8_t *data, size_t size, DecodedAudio &out,
                           std::string &err) {
    if (!data || size == 0) {
        err = "文件为空";
        return false;
    }
    // SHCreateMemStream 的长度参数是 UINT
    if (size > 0xFFFFFF00u) {
        err = "文件过大，超出系统解码器的处理范围";
        return false;
    }

    ComScope com;
    if (!com.usable()) {
        err = "无法初始化 COM，系统解码器不可用";
        return false;
    }
    const HRESULT mfHr = ensureMfStarted();
    if (FAILED(mfHr)) {
        err = mfErrorText(mfHr, "Media Foundation 启动失败");
        return false;
    }

    /*
     * 走内存流而不是文件路径：引擎的既有约定是「解码器只吃内存字节」（见 decoders.hpp
     * 顶部），这样中文路径、临时文件、被占用的文件都不会成为变量。
     * SHCreateMemStream 会复制一份数据 —— 换来的是不必自己实现 IStream，
     * 两个引擎都能直接跑，代价是解码期间多占一份文件大小的内存。
     */
    ComPtr<IStream> stream;
    stream.Attach(::SHCreateMemStream(reinterpret_cast<const BYTE *>(data), (UINT)size));
    if (!stream) {
        err = "内存不足，无法为解码分配缓冲区";
        return false;
    }

    ComPtr<IMFByteStream> byteStream;
    HRESULT hr = ::MFCreateMFByteStreamOnStream(stream.Get(), &byteStream);
    if (FAILED(hr)) {
        err = mfErrorText(hr, "创建字节流");
        return false;
    }

    // 同步读取：不传属性对象即可（异步需要 IMFSourceReaderCallback）
    ComPtr<IMFSourceReader> reader;
    hr = ::MFCreateSourceReaderFromByteStream(byteStream.Get(), nullptr, &reader);
    if (FAILED(hr)) {
        err = mfErrorText(hr, "解析容器");
        return false;
    }

    // 只看第一条音轨：MP4 里的视频轨一律不选，避免把整段视频解出来
    reader->SetStreamSelection((DWORD)MF_SOURCE_READER_ALL_STREAMS, FALSE);
    hr = reader->SetStreamSelection((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, TRUE);
    if (FAILED(hr)) {
        err = "该文件没有音频轨。";
        return false;
    }

    /*
     * 输出类型：先要 32 位浮点，拿不到退 16 位 PCM，再拿不到就用解码器的原生类型。
     *
     * 不在这里做重采样 —— 采样率与声道数保持源文件的，混音与降到 16k 由
     * audio.hpp 的 finishAudio() 统一负责，那条链路已经存在且被测过。
     */
    auto requestType = [&](const GUID &subtype, UINT32 bits) -> HRESULT {
        ComPtr<IMFMediaType> mt;
        HRESULT r = ::MFCreateMediaType(&mt);
        if (FAILED(r)) return r;
        mt->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        mt->SetGUID(MF_MT_SUBTYPE, subtype);
        if (bits) mt->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, bits);
        return reader->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr,
                                          mt.Get());
    };

    hr = requestType(MFAudioFormat_Float, 0);
    if (FAILED(hr)) hr = requestType(MFAudioFormat_PCM, 16);
    if (FAILED(hr)) hr = reader->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM,
                                                     nullptr, nullptr);
    if (FAILED(hr)) {
        err = mfErrorText(hr, "协商输出格式");
        return false;
    }

    auto readOutputFormat = [&](GUID &subtype, UINT32 &bits, UINT32 &rate, UINT32 &channels) {
        ComPtr<IMFMediaType> cur;
        if (FAILED(reader->GetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, &cur)))
            return false;
        subtype = GUID_NULL;
        bits = 0;
        rate = 0;
        channels = 0;
        cur->GetGUID(MF_MT_SUBTYPE, &subtype);
        cur->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &bits);
        cur->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate);
        cur->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels);
        return rate > 0 && channels > 0;
    };

    GUID subtype = GUID_NULL;
    UINT32 bits = 0, rate = 0, channels = 0;
    if (!readOutputFormat(subtype, bits, rate, channels)) {
        err = "读不到解码输出的格式信息";
        return false;
    }

    std::vector<float> interleaved;
    const DWORD kReadFlags = 0;
    for (;;) {
        DWORD flags = 0;
        LONGLONG timestamp = 0;
        DWORD streamIndex = 0;
        ComPtr<IMFSample> sample;
        hr = reader->ReadSample((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, kReadFlags,
                                &streamIndex, &flags, &timestamp, &sample);
        if (FAILED(hr)) {
            err = mfErrorText(hr, "读取采样");
            return false;
        }
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
        // 解码中途换格式（极少数流会在中途切声道配置）：重新读一次输出格式
        if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
            if (!readOutputFormat(subtype, bits, rate, channels)) {
                err = "解码过程中输出格式变化，且读不到新格式";
                return false;
            }
        }
        if (!sample) continue; // STREAMTICK 之类：没有数据，继续等

        ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) continue;

        BYTE *p = nullptr;
        DWORD maxLen = 0, len = 0;
        if (FAILED(buffer->Lock(&p, &maxLen, &len))) continue;
        const bool ok = appendSamples(p, len, subtype, bits, interleaved);
        buffer->Unlock();
        if (!ok) {
            err = "系统解码器给出了本软件不认识的采样格式";
            return false;
        }
    }

    if (interleaved.empty()) {
        err = "解码结果为空（音轨长度为 0 或数据损坏）";
        return false;
    }
    if (interleaved.size() % (size_t)channels != 0) {
        // 末尾不足一帧的零头直接丢掉：对识别无影响，留着会让后续按帧切分错位
        interleaved.resize(interleaved.size() - interleaved.size() % (size_t)channels);
    }

    out.pcm = std::move(interleaved);
    out.channels = (int)channels;
    out.sample_rate = (int)rate;
    return true;
}

} // namespace xdec

#endif // _WIN32
