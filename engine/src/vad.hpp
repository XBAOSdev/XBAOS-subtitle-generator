// 静音检测（能量 VAD）与长音频切分。
//
// 为什么要自己写而不引第三方：
//   1. 只需要「哪里有人说话」这一个判断，VAD 模型（Silero 等）体积与依赖都不划算；
//   2. 全流程离线、零外部依赖是产品硬约束，纯算术实现最稳。
//
// 算法（全部在 16kHz 单声道 float 上做）：
//   1. 20ms 分析帧、10ms 步进计算 RMS；
//   2. 取全片段 RMS 的第 20 百分位作为「噪声底」，阈值 = max(噪声底 × 3, -55dBFS)；
//   3. 双门限滞回：起判 = 阈值 × 2，判停 = 阈值 × 1.2，
//      避免句中的气息停顿把一句话切成两半；
//   4. 合并间隔小于 minSilence 的语音区间，丢弃短于 minSpeech 的碎片
//      （后者多半是键盘声、呼吸声一类的瞬时噪声）；
//   5. 按目标时长（默认 24s，whisper 窗口 30s 留余量）在静音中点切块，
//      块首尾各留 0.3s 余量；单个语音区间超长时按目标时长硬切并保留 1s 重叠，
//      重叠部分在拼接阶段按字符级后缀/前缀对齐去重。
//
// 长静音（> 4s）直接跨过、不产生块：既省算力，也避免 whisper 在纯静音窗口上
// 编造文本（这是「漏句」与「幻觉」的共同来源之一）。

#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <iostream>
#include <vector>

namespace xaudio {

struct VadOptions {
    double frame_sec = 0.02;          // 分析帧长
    double hop_sec = 0.01;            // 帧步进
    double min_speech_sec = 0.20;     // 短于此的语音碎片丢弃
    double min_silence_sec = 0.30;    // 短于此的间隔视为句内停顿，合并
    double long_silence_sec = 4.0;    // 长于此的静音直接跳过
    double absolute_floor_db = -55.0; // 绝对静音下限
    double noise_percentile = 0.20;   // 噪声底取 RMS 的百分位
    double start_factor = 2.0;        // 起判倍数
    double stop_factor = 1.2;         // 判停倍数
};

/** 语音 / 切片区间，单位秒 */
struct TimeRange {
    double start = 0.0;
    double end = 0.0;
};

struct VadResult {
    std::vector<TimeRange> speech;    // 合并后的语音区间
    std::vector<TimeRange> chunks;    // 计划识别的切片
    std::vector<bool> hard_cut;       // 该片是否因连续语音过长而硬切（有重叠）
    double noise_floor = 0.0;
    double threshold = 0.0;
    double speech_seconds = 0.0;
    int skipped_silence = 0;          // 被跨过的长静音段数
};

namespace detail {

inline double rmsOf(const float *p, size_t n) {
    if (n == 0) return 0.0;
    double sum = 0.0;
    for (size_t i = 0; i < n; i++) sum += (double)p[i] * (double)p[i];
    return std::sqrt(sum / (double)n);
}

} // namespace detail

/**
 * 检测语音区间并按目标时长切块。
 *
 * @param samples 16kHz 单声道 float
 * @param target_sec 单块目标时长（秒）
 * @param overlap_sec 硬切时的重叠时长（秒）
 */
inline VadResult detectSpeech(const std::vector<float> &samples, const VadOptions &opt = {},
                              double target_sec = 24.0, double overlap_sec = 1.0) {
    VadResult result;
    const double kRate = 16000.0;
    const size_t frame = (size_t)std::max<double>(1.0, opt.frame_sec * kRate);
    const size_t hop = (size_t)std::max<double>(1.0, opt.hop_sec * kRate);
    const double total_sec = (double)samples.size() / kRate;
    if (samples.size() < frame * 4) {
        // 太短，不值得做 VAD，交给调用方当单块处理
        return result;
    }

    // 1. 逐帧 RMS
    std::vector<double> rms;
    rms.reserve(samples.size() / hop + 1);
    for (size_t pos = 0; pos + frame <= samples.size(); pos += hop) {
        rms.push_back(detail::rmsOf(samples.data() + pos, frame));
    }
    if (rms.empty()) return result;

    // 2. 噪声底 = 百分位
    std::vector<double> sorted(rms);
    std::sort(sorted.begin(), sorted.end());
    const size_t idx = (size_t)(opt.noise_percentile * (double)(sorted.size() - 1));
    result.noise_floor = sorted[idx];
    const double floor_db = std::pow(10.0, opt.absolute_floor_db / 20.0);
    result.threshold = std::max(result.noise_floor * 3.0, floor_db);

    const double start_thr = result.threshold * opt.start_factor;
    const double stop_thr = result.threshold * opt.stop_factor;
    const double min_speech_frames = opt.min_speech_sec / opt.hop_sec;
    const double min_silence_frames = opt.min_silence_sec / opt.hop_sec;

    // 3. 滞回状态机
    std::vector<TimeRange> raw;
    bool in_speech = false;
    size_t start_frame = 0;
    size_t silence_run = 0;
    for (size_t i = 0; i < rms.size(); i++) {
        if (!in_speech) {
            if (rms[i] >= start_thr) {
                in_speech = true;
                start_frame = i;
                silence_run = 0;
            }
            continue;
        }
        if (rms[i] < stop_thr) {
            silence_run++;
            if (silence_run >= (size_t)min_silence_frames) {
                const size_t end_frame = i - silence_run;
                if ((double)(end_frame - start_frame) >= min_speech_frames) {
                    raw.push_back({(double)start_frame * opt.hop_sec,
                                   (double)(end_frame + 1) * opt.hop_sec});
                }
                in_speech = false;
                silence_run = 0;
            }
        } else {
            silence_run = 0;
        }
    }
    if (in_speech) {
        const size_t end_frame = rms.size();
        if ((double)(end_frame - start_frame) >= min_speech_frames) {
            raw.push_back({(double)start_frame * opt.hop_sec, (double)end_frame * opt.hop_sec});
        }
    }

    // 4. 合并邻近区间（间隔 < min_silence 的句内停顿）
    for (const TimeRange &r : raw) {
        if (!result.speech.empty() && r.start - result.speech.back().end < opt.min_silence_sec) {
            result.speech.back().end = std::max(result.speech.back().end, r.end);
        } else {
            result.speech.push_back(r);
        }
    }
    if (result.speech.empty()) return result; // 整段没有语音

    for (const TimeRange &r : result.speech) result.speech_seconds += (r.end - r.start);

    // 5. 切片：在静音中点下刀；单段过长则硬切 + 重叠
    const double pad = 0.3;
    size_t i = 0;
    while (i < result.speech.size()) {
        const double range_len = result.speech[i].end - result.speech[i].start;

        if (range_len + pad * 2 > target_sec) {
            // 连续说话超长：硬切成 target_sec 长的片，片间留 overlap 重叠
            double begin = std::max(0.0, result.speech[i].start - pad);
            while (begin + 0.05 < result.speech[i].end) {
                const double end = std::min(total_sec, begin + target_sec);
                result.chunks.push_back({begin, end});
                result.hard_cut.push_back(true);
                if (end >= result.speech[i].end + pad) break;
                begin = std::max(0.0, end - overlap_sec);
            }
            i++;
            continue;
        }

        double begin = std::max(0.0, result.speech[i].start - pad);
        double end = std::min(total_sec, result.speech[i].end + pad);
        size_t j = i;
        while (j + 1 < result.speech.size()) {
            const double candidate_end = std::min(total_sec, result.speech[j + 1].end + pad);
            if (candidate_end - begin > target_sec) break;
            // 中间的长静音不并入：跨过长静音会让 whisper 在空窗上编造内容
            if (result.speech[j + 1].start - result.speech[j].end > opt.long_silence_sec) break;
            j++;
            end = candidate_end;
        }
        result.chunks.push_back({begin, end});
        result.hard_cut.push_back(false);
        // 统计被跨过的长静音
        for (size_t k = i; k < j; k++) {
            if (result.speech[k + 1].start - result.speech[k].end > opt.long_silence_sec) {
                result.skipped_silence++;
            }
        }
        if (j + 1 < result.speech.size() &&
            result.speech[j + 1].start - result.speech[j].end > opt.long_silence_sec) {
            result.skipped_silence++;
        }
        i = j + 1;
    }

    return result;
}

} // namespace xaudio
