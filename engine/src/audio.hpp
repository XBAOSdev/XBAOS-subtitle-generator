// 音频读取与解码 —— 统一入口。
//
// 支持格式与解码方式：
//   WAV / AIFF   本文件直接解析（PCM 不经第三方库）
//   MP3          dr_mp3      （decoders/decoders.cpp）
//   FLAC         dr_flac     （decoders/decoders.cpp）
//   OGG Vorbis   stb_vorbis  （decoders/decoders.cpp）
//   OGG Opus     libopus     （decoders/oggopus.cpp）
//
// 硬性前提：任何解码都发生在「整个文件读进内存」之后。不使用
// 「按文件名打开」的第三方接口 —— 中文路径必须走 xbaos::pathFromUtf8()
// 自己打开（见 platform.hpp 顶部的实测记录），第三方库拿到的
// std::string 文件名在 Windows 上会打不开。
//
// 所有格式统一转成 16kHz 单声道 float（whisper 的输入要求）。
// 多声道混合为单声道，非 16k 采样率线性插值重采样。
//
// 不支持（会明确报错，不静默出错）：压缩 WAV（ADPCM / μ-law 等）、
// AAC / M4A（专利与许可风险，产品层面刻意不支持）。

#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "decoders/decoders.hpp"
#include "platform.hpp"

namespace xaudio {

struct AudioData {
    std::vector<float> samples;   // 单声道，16kHz，取值范围 -1..1
    int sample_rate = 16000;      // 输出采样率，恒为 16000
    double duration = 0.0;        // 秒
    int source_channels = 0;
    int source_rate = 0;
};

namespace detail {

inline uint16_t rd_u16(const uint8_t *p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

inline uint32_t rd_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

inline uint16_t rd_u16be(const uint8_t *p) {
    return (uint16_t)((p[0] << 8) | p[1]);
}

inline uint32_t rd_u32be(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

inline bool readFile(const std::string &path, std::vector<uint8_t> &out, std::string &err) {
    // 必须走 pathFromUtf8 —— 传 std::string 会走窄字符重载，中文路径打不开。
    // 详见 platform.hpp 顶部记录的实测结果。
    std::ifstream f(xbaos::pathFromUtf8(path), std::ios::binary | std::ios::ate);
    if (!f) {
        err = "无法打开文件：" + path;
        return false;
    }
    std::streamsize size = f.tellg();
    if (size <= 0) {
        err = "文件为空：" + path;
        return false;
    }
    f.seekg(0, std::ios::beg);
    out.resize((size_t)size);
    if (!f.read(reinterpret_cast<char *>(out.data()), size)) {
        err = "读取文件失败：" + path;
        return false;
    }
    return true;
}

// 把交错的原始采样换成 float 单声道
inline float sampleAt(const uint8_t *base, int index, int channels, int bytes_per_sample,
                      uint16_t format, bool is_float, int valid_bits) {
    const uint8_t *p = base + (size_t)index * (size_t)channels * (size_t)bytes_per_sample;
    // 只取第一个声道之外的整体平均在下面处理，这里先读第 0 个声道
    (void)format;
    if (is_float) {
        if (bytes_per_sample == 4) {
            float v;
            std::memcpy(&v, p, 4);
            return v;
        }
        if (bytes_per_sample == 8) {
            double v;
            std::memcpy(&v, p, 8);
            return (float)v;
        }
        return 0.0f;
    }
    switch (bytes_per_sample) {
        case 1: return ((float)p[0] - 128.0f) / 128.0f;
        case 2: return (float)(int16_t)rd_u16(p) / 32768.0f;
        case 3: {
            int32_t v = (int32_t)((uint32_t)p[0] << 8 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 24);
            return (float)(v >> 8) / 8388608.0f;
        }
        case 4: {
            int32_t v = (int32_t)rd_u32(p);
            if (valid_bits > 0 && valid_bits < 32) {
                // 有效位靠左对齐，先右移再归一
                v >>= (32 - valid_bits);
                return (float)v / (float)(1 << (valid_bits - 1));
            }
            return (float)v / 2147483648.0f;
        }
        default: return 0.0f;
    }
}

/**
 * 混音 + 重采样：把解码出的交错 PCM 变成 16kHz 单声道。
 * MP3/FLAC/OGG/Opus/AIFF 的解码产物都汇到这里。
 */
inline bool finishAudio(std::vector<float> interleaved, int channels, int source_rate,
                        AudioData &out, std::string &err) {
    if (channels <= 0 || source_rate <= 0 || interleaved.empty()) {
        err = "解码结果为空或参数不合法";
        return false;
    }

    std::vector<float> mono;
    if (channels == 1) {
        mono = std::move(interleaved);
    } else {
        const size_t frames = interleaved.size() / (size_t)channels;
        mono.resize(frames);
        for (size_t i = 0; i < frames; i++) {
            double sum = 0.0;
            for (int c = 0; c < channels; c++) sum += interleaved[i * (size_t)channels + (size_t)c];
            mono[i] = (float)(sum / channels);
        }
    }

    out.source_channels = channels;
    out.source_rate = source_rate;

    const int kTarget = 16000;
    if (source_rate == kTarget) {
        out.samples = std::move(mono);
    } else {
        // 线性插值重采样。质量不如多相滤波，但对语音识别足够，
        // 且正常路径上主进程已经做过高质量重采样，这里是兜底。
        const double ratio = (double)source_rate / (double)kTarget;
        const size_t frames = mono.size();
        size_t out_count = (size_t)std::floor((double)frames / ratio);
        if (out_count == 0) {
            err = "音频太短，重采样后没有采样点";
            return false;
        }
        out.samples.resize(out_count);
        for (size_t i = 0; i < out_count; i++) {
            const double src_pos = (double)i * ratio;
            const size_t i0 = (size_t)src_pos;
            const size_t i1 = i0 + 1 < frames ? i0 + 1 : i0;
            const double frac = src_pos - (double)i0;
            out.samples[i] = (float)((1.0 - frac) * mono[i0] + frac * mono[i1]);
        }
    }

    out.sample_rate = kTarget;
    out.duration = (double)out.samples.size() / (double)kTarget;
    return true;
}

} // namespace detail

// ------------------------------------------------------------------ WAV

/**
 * 读取 WAV（已在内存中）并转成 16kHz 单声道 float。
 * 返回 false 时 err 里是给用户看的中文说明。
 */
inline bool loadWavFromMemory(const std::vector<uint8_t> &buf, AudioData &out, std::string &err) {
    if (buf.size() < 44 || std::memcmp(buf.data(), "RIFF", 4) != 0 ||
        std::memcmp(buf.data() + 8, "WAVE", 4) != 0) {
        err = "不是有效的 WAV 文件";
        return false;
    }

    uint16_t format = 0;
    uint16_t channels = 0;
    uint32_t sample_rate = 0;
    uint16_t bits = 0;
    uint16_t valid_bits = 0;
    const uint8_t *data_ptr = nullptr;
    size_t data_size = 0;
    bool have_fmt = false;

    size_t pos = 12;
    while (pos + 8 <= buf.size()) {
        const uint8_t *chunk = buf.data() + pos;
        uint32_t chunk_size = detail::rd_u32(chunk + 4);
        const uint8_t *body = chunk + 8;
        // chunk 数据超出文件时截断处理，避免越界
        if (pos + 8 + chunk_size > buf.size()) chunk_size = (uint32_t)(buf.size() - pos - 8);

        if (std::memcmp(chunk, "fmt ", 4) == 0 && chunk_size >= 16) {
            format      = detail::rd_u16(body + 0);
            channels    = detail::rd_u16(body + 2);
            sample_rate = detail::rd_u32(body + 4);
            bits        = detail::rd_u16(body + 14);
            have_fmt = true;

            if (format == 0xFFFE && chunk_size >= 40) {
                // WAVE_FORMAT_EXTENSIBLE：真正的格式在 SubFormat 的前两字节
                valid_bits = detail::rd_u16(body + 18);
                uint16_t sub = detail::rd_u16(body + 24);
                format = sub;
            } else if (format == 0xFFFE) {
                err = "WAVE_FORMAT_EXTENSIBLE 头不完整";
                return false;
            }
        } else if (std::memcmp(chunk, "data", 4) == 0) {
            data_ptr = body;
            data_size = chunk_size;
        }

        pos += 8 + chunk_size + (chunk_size & 1); // chunk 按偶数字节对齐
    }

    if (!have_fmt || !data_ptr || data_size == 0) {
        err = "WAV 缺少 fmt 或 data 块";
        return false;
    }
    if (channels == 0 || sample_rate == 0 || bits == 0) {
        err = "WAV 头信息不合法";
        return false;
    }

    bool is_float = false;
    if (format == 1) {
        is_float = false;
    } else if (format == 3) {
        is_float = true;
    } else {
        err = "该 WAV 使用了压缩编码（format=" + std::to_string(format) +
              "），暂不支持，请先转成 PCM 或浮点 WAV";
        return false;
    }

    const int bytes_per_sample = bits / 8;
    if (bytes_per_sample <= 0) {
        err = "WAV 位深不合法";
        return false;
    }

    const size_t frame_bytes = (size_t)bytes_per_sample * channels;
    if (frame_bytes == 0) {
        err = "WAV 帧长不合法";
        return false;
    }
    const size_t frames = data_size / frame_bytes;
    if (frames == 0) {
        err = "WAV 里没有采样数据";
        return false;
    }

    // 先按原采样率取单声道
    std::vector<float> mono(frames, 0.0f);
    for (size_t i = 0; i < frames; i++) {
        if (channels == 1) {
            mono[i] = detail::sampleAt(data_ptr, (int)i, 1, bytes_per_sample, format, is_float, valid_bits);
        } else {
            double sum = 0.0;
            for (int c = 0; c < channels; c++) {
                const uint8_t *p = data_ptr + i * frame_bytes + (size_t)c * bytes_per_sample;
                sum += detail::sampleAt(p, 0, 1, bytes_per_sample, format, is_float, valid_bits);
            }
            mono[i] = (float)(sum / channels);
        }
    }

    out.source_channels = channels;
    out.source_rate = (int)sample_rate;

    const int kTarget = 16000;
    if ((int)sample_rate == kTarget) {
        out.samples = std::move(mono);
    } else {
        // 线性插值重采样。质量不如多相滤波，但对语音识别足够，
        // 且正常路径上主进程已经做过高质量重采样，这里是兜底。
        double ratio = (double)sample_rate / (double)kTarget;
        size_t out_count = (size_t)std::floor((double)frames / ratio);
        if (out_count == 0) {
            err = "音频太短，重采样后没有采样点";
            return false;
        }
        out.samples.resize(out_count);
        for (size_t i = 0; i < out_count; i++) {
            double src_pos = (double)i * ratio;
            size_t i0 = (size_t)src_pos;
            size_t i1 = i0 + 1 < frames ? i0 + 1 : i0;
            double frac = src_pos - (double)i0;
            out.samples[i] = (float)((1.0 - frac) * mono[i0] + frac * mono[i1]);
        }
    }

    out.sample_rate = kTarget;
    out.duration = (double)out.samples.size() / (double)kTarget;
    return true;
}

inline bool loadWav16k(const std::string &path, AudioData &out, std::string &err) {
    std::vector<uint8_t> buf;
    if (!detail::readFile(path, buf, err)) return false;
    return loadWavFromMemory(buf, out, err);
}

// ------------------------------------------------------------------ AIFF

namespace detail {

/** IEEE 754 80 位扩展浮点（AIFF 的采样率存储格式，大端） */
inline double readExtended80(const uint8_t *p) {
    const int32_t exponent = (int16_t)rd_u16be(p); // 偏移 16383
    const uint64_t mantissa = ((uint64_t)rd_u32be(p + 2) << 32) | rd_u32be(p + 6);
    if (exponent == 0 && mantissa == 0) return 0.0;
    return std::ldexp((double)mantissa, exponent - 16383 - 63);
}

} // namespace detail

/**
 * 解析 AIFF / AIFC（已在内存中）。
 * 支持 NONE（大端 PCM）、sowt（小端 PCM）、fl32/FL32（浮点）三种采样编码；
 * 压缩格式（IMA4 等）明确报错。
 */
inline bool loadAiffFromMemory(const std::vector<uint8_t> &buf, AudioData &out, std::string &err) {
    if (buf.size() < 12 || std::memcmp(buf.data(), "FORM", 4) != 0 ||
        (std::memcmp(buf.data() + 8, "AIFF", 4) != 0 && std::memcmp(buf.data() + 8, "AIFC", 4) != 0)) {
        err = "不是有效的 AIFF 文件";
        return false;
    }

    const bool isAifc = std::memcmp(buf.data() + 8, "AIFC", 4) == 0;
    uint16_t channels = 0;
    uint16_t bits = 0;
    double rate = 0.0;
    int format = 0; // 0 = 大端 PCM，1 = 小端 PCM（sowt），2 = 大端 float32
    const uint8_t *data_ptr = nullptr;
    size_t data_size = 0;

    size_t pos = 12;
    while (pos + 8 <= buf.size()) {
        const uint8_t *chunk = buf.data() + pos;
        uint32_t chunk_size = detail::rd_u32be(chunk + 4);
        const uint8_t *body = chunk + 8;
        if (pos + 8 + chunk_size > buf.size()) chunk_size = (uint32_t)(buf.size() - pos - 8);

        if (std::memcmp(chunk, "COMM", 4) == 0 && chunk_size >= 18) {
            channels = detail::rd_u16be(body + 0);
            bits = detail::rd_u16be(body + 6);
            rate = detail::readExtended80(body + 8);
            if (isAifc) {
                if (chunk_size < 22) {
                    err = "AIFC 的 COMM 块不完整";
                    return false;
                }
                char comp[4] = {0};
                std::memcpy(comp, body + 18, 4);
                if (std::memcmp(comp, "NONE", 4) == 0) {
                    format = 0;
                } else if (std::memcmp(comp, "sowt", 4) == 0) {
                    format = 1;
                } else if (std::memcmp(comp, "fl32", 4) == 0 || std::memcmp(comp, "FL32", 4) == 0) {
                    format = 2;
                    bits = 32;
                } else {
                    err = "AIFF-C 压缩格式（" + std::string(comp, 4) + "）暂不支持，" +
                          "请先转成 WAV 或无压缩 AIFF";
                    return false;
                }
            }
        } else if (std::memcmp(chunk, "SSND", 4) == 0 && chunk_size >= 8) {
            const uint32_t offset = detail::rd_u32be(body + 0);
            data_ptr = body + 8 + offset;
            data_size = (size_t)chunk_size - 8 - offset;
        }

        pos += 8 + chunk_size + (chunk_size & 1);
    }

    if (channels == 0 || bits == 0 || rate <= 0.0 || !data_ptr || data_size == 0) {
        err = "AIFF 缺少 COMM 或 SSND 块";
        return false;
    }

    const int bytes_per_sample = bits / 8;
    if (bytes_per_sample <= 0 || bytes_per_sample > 4) {
        err = "不支持的 AIFF 位深：" + std::to_string(bits);
        return false;
    }
    const size_t frame_bytes = (size_t)bytes_per_sample * channels;
    const size_t frames = data_size / frame_bytes;
    if (frames == 0) {
        err = "AIFF 里没有采样数据";
        return false;
    }

    // AIFF 的整型采样全部是有符号的（与 WAV 的 8bit 无符号不同）
    std::vector<float> interleaved;
    interleaved.reserve(frames * channels);
    for (size_t i = 0; i < frames; i++) {
        for (int c = 0; c < channels; c++) {
            const uint8_t *p = data_ptr + i * frame_bytes + (size_t)c * bytes_per_sample;
            float v = 0.0f;
            if (format == 2 && bytes_per_sample == 4) {
                uint32_t raw = detail::rd_u32be(p);
                float f;
                std::memcpy(&f, &raw, 4);
                v = f;
            } else if (format == 1) {
                // sowt：小端整型
                switch (bytes_per_sample) {
                    case 1: v = ((int8_t)p[0]) / 128.0f; break;
                    case 2: v = (float)(int16_t)detail::rd_u16(p) / 32768.0f; break;
                    case 3: {
                        int32_t x = (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8) |
                                              ((uint32_t)p[2] << 16));
                        v = (float)(x << 8 >> 8) / 8388608.0f;
                        break;
                    }
                    case 4: v = (float)(int32_t)detail::rd_u32(p) / 2147483648.0f; break;
                }
            } else {
                // 大端整型
                switch (bytes_per_sample) {
                    case 1: v = ((int8_t)p[0]) / 128.0f; break;
                    case 2: v = (float)(int16_t)detail::rd_u16be(p) / 32768.0f; break;
                    case 3: {
                        int32_t x = (int32_t)(((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
                                              ((uint32_t)p[2] << 8));
                        v = (float)(x >> 8) / 8388608.0f;
                        break;
                    }
                    case 4: v = (float)(int32_t)detail::rd_u32be(p) / 2147483648.0f; break;
                }
            }
            interleaved.push_back(v);
        }
    }

    return detail::finishAudio(std::move(interleaved), channels, (int)rate, out, err);
}

/**
 * 电平归一化 —— 识别前的可选前处理。
 *
 * 三步：
 *   1. 去直流偏移（减去均值）。有些声卡/采集卡的录音整体偏一个常数，
 *      whisper 的 log-mel 前端会因此损失动态范围；
 *   2. 峰值限幅到 -1dBFS：先把可能已经削波的录音压回安全区；
 *   3. RMS 归一化到目标电平（默认 -20dBFS），增益限制在 [0.5, 4] 倍以内，
 *      并加一段软限幅（0.7 以上按 tanh 曲线压缩），避免把近乎静音的一段
 *      放大成噪声，也避免正常录音被推爆。
 *
 * small 模型对输入电平敏感：实测低电平录音整段错误率明显偏高，
 * 而这一步不改变时长，对时间轴没有任何影响。
 */
inline void normalizeLevel(AudioData &a, double target_db = -20.0) {
    if (a.samples.empty()) return;
    const size_t n = a.samples.size();

    // 1. 去直流
    double mean = 0.0;
    for (float v : a.samples) mean += v;
    mean /= (double)n;
    if (std::fabs(mean) > 1e-6) {
        for (float &v : a.samples) v = (float)((double)v - mean);
    }

    auto softLimit = [](double x) {
        const double ax = std::fabs(x);
        if (ax <= 0.7) return x;
        const double limited = 0.7 + 0.28 * std::tanh((ax - 0.7) / 0.28);
        return x < 0.0 ? -limited : limited;
    };

    // 2. 峰值压到 -1dBFS 以内
    double peak = 0.0;
    for (float v : a.samples) peak = std::max(peak, (double)std::fabs(v));
    const double peak_target = std::pow(10.0, -1.0 / 20.0); // ≈0.891
    if (peak > peak_target) {
        const double g = peak_target / peak;
        for (float &v : a.samples) v = (float)softLimit((double)v * g);
    }

    // 3. RMS 归一化（增益有上限，防止静音段被推成噪声）
    double sum_sq = 0.0;
    for (float v : a.samples) sum_sq += (double)v * (double)v;
    const double rms = std::sqrt(sum_sq / (double)n);
    if (rms > 1e-6) {
        const double target = std::pow(10.0, target_db / 20.0);
        double gain = target / rms;
        gain = std::min(4.0, std::max(0.5, gain));
        if (std::fabs(gain - 1.0) > 0.01) {
            for (float &v : a.samples) v = (float)softLimit((double)v * gain);
        }
    }
    a.duration = (double)a.samples.size() / (double)a.sample_rate;
}

/**
 * 高通滤波 —— 切除 80Hz 以下的低频成分。
 *
 * 低频是识别的纯负担：市电哼声（50Hz 及其谐波）、空调与风扇声、手持摩擦声、
 * 桌面震动都集中在这里，而人类语音的基频最低也只到 ~70Hz（男声），信息量极少。
 * 这些能量在 log-mel 频谱上抬高了低频带的底噪，挤占动态范围，
 * 还会干扰后面 VAD 的噪声底估计。
 *
 * 实现：两阶级联的一阶高通（每级 y[i] = α·(y[i-1] + x[i] - x[i-1])），
 * 80Hz 处约 -6dB、40Hz 处约 -18dB，过渡足够平缓，不会伤到语音基频区。
 * 纯算术、零依赖、不改采样点数，对时间轴没有任何影响。
 * 必须在 normalizeLevel **之前**调用：先滤掉低频能量，RMS 归一化
 * 才不会被哼声拖着把真正的人声压小。
 */
inline void highPass(AudioData &a, double cutoff_hz = 80.0) {
    if (a.samples.empty() || a.sample_rate <= 0) return;
    const double dt = 1.0 / (double)a.sample_rate;
    const double rc = 1.0 / (6.283185307179586 * cutoff_hz);
    const double alpha = rc / (rc + dt);
    for (int stage = 0; stage < 2; stage++) {
        double prev_in = 0.0;
        double prev_out = 0.0;
        for (float &v : a.samples) {
            const double x = (double)v;
            prev_out = alpha * (prev_out + x - prev_in);
            prev_in = x;
            v = (float)prev_out;
        }
    }
}

// ------------------------------------------------------------- 统一入口

/**
 * 识别侧的统一音频入口：按魔数识别格式，解码并转成 16kHz 单声道。
 * 返回 false 时 err 里是给用户看的中文说明。
 */
inline bool loadAudio16k(const std::string &path, AudioData &out, std::string &err) {
    std::vector<uint8_t> buf;
    if (!detail::readFile(path, buf, err)) return false;
    if (buf.size() < 12) {
        err = "文件太小，不是有效的音频文件：" + path;
        return false;
    }

    const uint8_t *d = buf.data();
    const size_t n = buf.size();

    const bool isWav = std::memcmp(d, "RIFF", 4) == 0 && std::memcmp(d + 8, "WAVE", 4) == 0;
    const bool isAiff = std::memcmp(d, "FORM", 4) == 0 &&
                        (std::memcmp(d + 8, "AIFF", 4) == 0 || std::memcmp(d + 8, "AIFC", 4) == 0);
    const bool isFlac = std::memcmp(d, "fLaC", 4) == 0;
    const bool isOgg = std::memcmp(d, "OggS", 4) == 0;
    const bool isId3 = std::memcmp(d, "ID3", 3) == 0; // ID3 只有 3 字节，别把 \0 比进去
    const bool isMp3Sync = d[0] == 0xFF && (d[1] & 0xE0) == 0xE0; // MPEG 帧同步位

    xdec::DecodedAudio dec;
    if (isWav) {
        return loadWavFromMemory(buf, out, err);
    }
    if (isAiff) {
        return loadAiffFromMemory(buf, out, err);
    }
    if (isOgg && xdec::isOggOpus(d, n)) {
        if (!xdec::decodeOggOpus(d, n, dec, err)) return false;
        return detail::finishAudio(std::move(dec.pcm), dec.channels, dec.sample_rate, out, err);
    }
    if (isOgg) {
        if (!xdec::decodeVorbis(d, n, dec, err)) return false;
        return detail::finishAudio(std::move(dec.pcm), dec.channels, dec.sample_rate, out, err);
    }
    if (isFlac) {
        if (!xdec::decodeFlac(d, n, dec, err)) return false;
        return detail::finishAudio(std::move(dec.pcm), dec.channels, dec.sample_rate, out, err);
    }
    if (isId3 || isMp3Sync) {
        if (!xdec::decodeMp3(d, n, dec, err)) return false;
        return detail::finishAudio(std::move(dec.pcm), dec.channels, dec.sample_rate, out, err);
    }

    err = "无法识别的音频格式。支持 WAV / AIFF / MP3 / FLAC / OGG / Opus";
    return false;
}

} // namespace xaudio
