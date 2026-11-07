// XBAOS 字幕生成器 —— ONNX 识别引擎
//
// 与 whisper 引擎（xbaos-engine.exe）并列的第二套识别后端，跑在 sherpa-onnx
// 之上，首个支持的模型是 SenseVoice-Small（非自回归 CTC，中文比 whisper 准得多）。
//
// 为什么再开一个进程而不是把 onnxruntime 塞进现有引擎：
//   1. 两套运行时的初始化方式完全不同（ggml/Vulkan vs onnxruntime），混在一个
//      进程里会让现有的「Vulkan 崩溃隔离 + 自动降级重试」逻辑无法判断是谁崩的
//   2. 现有引擎已稳定，不动它就是最好的兼容性保障
//   3. 主进程只需要按架构 spawn 不同的 exe，协议层零改动
//
// 协议与 whisper 引擎**完全一致**（行分隔 JSON），主进程与渲染层不必区分后端：
//
//   {"id":1,"cmd":"ping"}
//   {"id":2,"cmd":"load","model":"C:\\models\\sensevoice-small","backend":"cpu"}
//   {"id":3,"cmd":"transcribe","audio":"C:\\temp\\a.wav","language":"zh",
//    "threads":8,"vad":true,"normalize":true,"highPass":true,
//    "vadOptions":{...},"ranges":[{"start":12.5,"end":18.0}]}
//   {"id":4,"cmd":"abort"} / {"id":5,"cmd":"shutdown"}
//
// 说话人分离走独立命令，与识别解耦（识别完再跑，两套引擎都能配）：
//   {"id":6,"cmd":"diarize","audio":"C:\\temp\\a.wav",
//    "segModel":"C:\\...\\segmentation.onnx","embedModel":"C:\\...\\campplus.onnx",
//    "numSpeakers":0,"threshold":0.5,"threads":8}
//   → {"id":6,"type":"speaker","i":0,"start":0.5,"end":3.2,"speaker":0}
//   → {"id":6,"type":"done","elapsed":2.1,"duration":56.8,"speakers":4,"count":17}
//
// 响应：
//   {"id":3,"type":"progress","percent":42}
//   {"id":3,"type":"segment","i":0,"start":1.2,"end":3.45,"text":"大家好",
//    "noSpeech":0,"avgLogprob":-0.31,"offset":0,"relStart":1.2,"relEnd":3.45}
//   {"id":3,"type":"done","elapsed":18.3,"count":28,"duration":106.77,
//    "language":"zh","backend":"cpu","model":"sensevoice-small",
//    "chunks":5,"skipped":2,"speechSeconds":96.4,
//    "avgLogprob":-0.28,"noSpeechRatio":0,"temperature":0}
//   {"id":3,"type":"error","message":"..."}
//
// 与 whisper 引擎的已知差异（渲染层按架构灰化对应控件）：
//   · 不支持 translate —— CTC 模型没有翻译任务
//   · 不支持 prompt / 热词 —— sherpa-onnx 的热词只对 transducer 模型生效
//   · 不支持 temperature / beamSize / bestOf —— 贪心 CTC 没有这些概念
//
// stdout 只用于协议，日志一律走 stderr。

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#endif

#include "sherpa-onnx/c-api/c-api.h"

// audio.hpp 的符号全在 xaudio 命名空间内（与 whisper 引擎共用同一份实现）
#include "audio.hpp"
#include "mini_json.hpp"
#include "vad.hpp"

using namespace xaudio;

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

// ---------------------------------------------------------------- 全局状态

/** 常驻识别器。`load` 时创建，重新 load 时先销毁旧的。 */
const SherpaOnnxOfflineRecognizer *g_rec = nullptr;

/** 当前已加载的模型目录与其中的文件，用于 `done` 回报与重复 load 短路。 */
std::string g_model_dir;
std::string g_model_name;

/** abort 信号。SenseVoice 单块解码不可中断，只在块与块之间检查。 */
std::atomic<bool> g_cancel{false};

/** 当前请求 id，用于给异步回调带回去（-1 表示不在请求内） */
std::atomic<int64_t> g_job_id{-1};

/** stdout 只允许一行一行地写，多线程 emit 必须串行化 */
std::mutex g_out_mu;

std::chrono::steady_clock::time_point g_started;

void emit(const std::string &line) {
    std::lock_guard<std::mutex> lock(g_out_mu);
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

void logLine(const std::string &s) {
    std::fprintf(stderr, "[xbaos-asr] %s\n", s.c_str());
    std::fflush(stderr);
}

// ---------------------------------------------------------------- 分句参数

/*
 * 这些数字决定「一句话」有多长，直接决定字幕条的观感。
 *
 * 引擎这里的职责只是**把连续语音切成自然句**，不负责折行 —— 折行由渲染层的
 * 词表算法做（它知道行宽与词边界，引擎不该重复那套逻辑）。
 *
 * 判断依据按可靠性排序：
 *   1. 句末标点  —— 最准。ITN 打开时 SenseVoice 会输出标点
 *   2. 静音间隔  —— 次准。没人说话的地方切一刀，几乎不会错
 *   3. 超长兜底  —— 前两条都不满足时的保险，防止整段成一条
 */
constexpr double kGapSec = 0.60;      // 相邻 token 间隔超过它，视为句间停顿
constexpr double kMaxCueSec = 12.0;   // 单条字幕的最长时长
constexpr int kMaxCueChars = 42;      // 单条字幕的最多字数（中文按字计）

/*
 * 按「字幕规格」二次断句交给渲染层做（它知道行宽、词表、禁则）。
 *
 * 但渲染层手里只有**整句的起止时间**，按字数切一刀就只能按字数比例把这段
 * 时间分给两半 —— 谁说话都不按字数匀速，于是每条字幕的时间窗与实际发音
 * 错开，越靠句子末尾偏得越多。这正是「一句话的尾巴被扔到下一条」的来源。
 *
 * 所以引擎把**逐字时间戳**一起发出去（`charTimes`）：渲染层在哪个字上切，
 * 都能读到那个字的真实起止，时间窗不再靠猜。SenseVoice 是 CTC，时间戳来自
 * 峰值帧，比字数估算准得多。
 */
constexpr double kGapScoreCap = 0.45; // （保留：渲染层打分时同口径的停顿封顶值）

/*
 * token 时长估算：SenseVoice 只给起点（timestamps），没有 durations。
 * 中文正常语速约每秒 4.5 字，即每字 0.22 秒，前面再加一点起音余量。
 */
constexpr double kTokenBaseSec = 0.10;
constexpr double kCharSec = 0.22;

/** 句末标点：出现在一条的末尾时立刻断句 */
bool isSentenceEnd(const std::string &s) {
    if (s.empty()) return false;
    // UTF-8 三字节：。！？；…
    static const char *kPunct[] = {"。", "！", "？", "；", "…", "!", "?", ";", "."};
    for (const char *p : kPunct) {
        const size_t n = std::strlen(p);
        if (s.size() >= n && s.compare(s.size() - n, n, p) == 0) return true;
    }
    return false;
}

/** 软停顿：逗号、顿号、冒号也算断句候选，但只在超长时才用 */
bool isClauseEnd(const std::string &s) {
    if (s.empty()) return false;
    static const char *kPunct[] = {"，", "、", "：", ",", ":"};
    for (const char *p : kPunct) {
        const size_t n = std::strlen(p);
        if (s.size() >= n && s.compare(s.size() - n, n, p) == 0) return true;
    }
    return false;
}

/** 统计 UTF-8 字符个数（用于判断是否过长） */
int utf8Len(const std::string &s) {
    int n = 0;
    for (unsigned char c : s) {
        if ((c & 0xC0) != 0x80) n++;
    }
    return n;
}

/** sherpa-onnx 会在 tokens 里混入 <|zh|> <|HAPPY|> <|withitn|> 这类控制标记 */
bool isControlToken(const std::string &s) {
    return s.size() >= 4 && s.compare(0, 2, "<|") == 0 && s.compare(s.size() - 2, 2, "|>") == 0;
}

// ---------------------------------------------------------------- 数据结构

struct TokenItem {
    std::string text;
    double start = 0.0;   // 块内相对秒
    double end = 0.0;
    double logprob = 0.0;
};

struct Cue {
    double start = 0.0;
    double end = 0.0;
    std::string text;
    double logprob_sum = 0.0;
    int token_count = 0;
    int chars = 0;
    /** 本条覆盖 toks 的 [tok_begin, tok_end)，二次断句时靠它取真实时间 */
    int tok_begin = 0;
    int tok_end = 0;
};

// ---------------------------------------------------------------- 模型路径

/** 目录里找一个存在的文件，找不到返回空串 */
std::string pickFile(const std::string &dir, std::initializer_list<const char *> names) {
    for (const char *name : names) {
        std::string full = dir + "\\" + name;
        if (FILE *f = std::fopen(full.c_str(), "rb")) {
            std::fclose(f);
            return full;
        }
    }
    return {};
}

std::string parentDir(const std::string &path) {
    const size_t pos = path.find_last_of("\\/");
    return pos == std::string::npos ? std::string(".") : path.substr(0, pos);
}

std::string baseName(const std::string &path) {
    const size_t pos = path.find_last_of("\\/");
    return pos == std::string::npos ? path : path.substr(pos + 1);
}

/** 传进来的是目录还是单个 onnx，两种都要能处理 */
bool resolveModelFiles(const std::string &given, std::string &onnx, std::string &tokens,
                       std::string &err) {
    if (given.empty()) {
        err = "没有指定模型";
        return false;
    }

    std::string dir = given;
    // 传的是文件：优先当成 onnx，同时把目录推出来找 tokens.txt
    if (FILE *f = std::fopen(given.c_str(), "rb")) {
        std::fclose(f);
        dir = parentDir(given);
        onnx = given;
    } else {
        // 传的是目录
        onnx = pickFile(dir, {"model.int8.onnx", "model.onnx"});
        if (onnx.empty()) {
            err = "模型目录里没有 model.int8.onnx 或 model.onnx";
            return false;
        }
    }

    tokens = pickFile(dir, {"tokens.txt"});
    if (tokens.empty()) {
        err = "模型目录里没有 tokens.txt";
        return false;
    }
    return true;
}

/** whisper 的语言码 → SenseVoice 支持的语种。不支持的退回 auto，交给模型自己判。 */
const char *mapLanguage(const std::string &lang) {
    if (lang == "zh") return "zh";
    if (lang == "en") return "en";
    if (lang == "ja") return "ja";
    if (lang == "ko") return "ko";
    if (lang == "yue" || lang == "cantonese") return "yue";
    return "auto";
}

// ---------------------------------------------------------------- 识别与分句

/*
 * 人声边界图：把 Pcm 按 10ms 一帧算能量，给一个「有声 / 静音」阈值。
 *
 * 为什么需要它：SenseVoice 的 CTC 时间戳只给 token 的**起点**，终点没有。
 * 没有终点，两件事都做不好：
 *   · 每条字幕的结束时间只能按字数估，字幕与发音错开；
 *   · 「两个 token 之间停顿多久」无从得知，断句只能按标点或字数硬切 ——
 *     一句话的尾巴被切到下一条，正是这么来的。
 * 音频里这些都有现成答案：说话的人声在哪儿停，能量就掉下去。把终点钉到
 * 「该 token 起点之后最后一个有声帧」，停顿自然就算出来了。
 */
struct VoiceMap {
    std::vector<double> rms; // 每 10ms 一帧
    double threshold = 0.0;
};

VoiceMap buildVoiceMap(const std::vector<float> &pcm) {
    VoiceMap vm;
    const size_t frame = 320; // 20ms @16k
    const size_t hop = 160;   // 10ms
    for (size_t pos = 0; pos + frame <= pcm.size(); pos += hop) {
        double sum = 0.0;
        for (size_t i = 0; i < frame; i++) sum += (double)pcm[pos + i] * (double)pcm[pos + i];
        vm.rms.push_back(std::sqrt(sum / (double)frame));
    }
    if (vm.rms.empty()) return vm;

    // 阈值口径与 vad.hpp 一致：噪声底（第 20 百分位）×3，且不低于 -55dBFS
    std::vector<double> sorted(vm.rms);
    std::nth_element(sorted.begin(), sorted.begin() + (long)(sorted.size() / 5), sorted.end());
    const double floor_rms = std::max(sorted[sorted.size() / 5] * 3.0, std::pow(10.0, -55.0 / 20.0));
    vm.threshold = floor_rms;
    return vm;
}

/**
 * 在 `t` 之前最后一段人声的结束时间（秒，块内相对）。
 *
 * 往回最多找 0.6 秒；整段都安静就返回 -1。找不到有意义的结果时调用方
 * 保持原来的估算，不会因此把时间改坏。
 */
double lastVoicedEnd(const VoiceMap &vm, double t) {
    if (vm.rms.empty() || t <= 0.0) return -1.0;
    const double hop = 0.01;
    long i = (long)std::floor(t / hop);
    if (i >= (long)vm.rms.size()) i = (long)vm.rms.size() - 1;
    for (; i >= 0 && (t - (double)i * hop) <= 0.6; i--) {
        if (vm.rms[(size_t)i] >= vm.threshold) {
            const double end = ((double)i + 1.0) * hop + 0.02; // 帧尾 + 一点余量
            return std::min(t, end);
        }
    }
    return -1.0;
}

/** 把一次识别的原始 token 整理成可用的时间轴条目 */
std::vector<TokenItem> collectTokens(const SherpaOnnxOfflineRecognizerResult *r,
                                     double chunk_len, const VoiceMap &vm) {
    std::vector<TokenItem> out;
    if (!r || r->count <= 0 || !r->tokens_arr) return out;

    for (int i = 0; i < r->count; i++) {
        const char *raw = r->tokens_arr[i];
        if (!raw) continue;
        std::string s(raw);
        if (s.empty() || isControlToken(s)) continue;

        TokenItem item;
        item.text = s;
        // timestamps 可能整体缺失（模型不带时间戳时），那样只能退化成均分
        item.start = (r->timestamps != nullptr) ? (double)r->timestamps[i] : -1.0;

        if (r->durations != nullptr && r->durations[i] > 0.0f) {
            item.end = item.start + (double)r->durations[i];
        } else if (item.start >= 0.0) {
            /*
             * durations 常年为空（SenseVoice 只给起点）。终点分两步定：
             *
             *   ① 先按字数估一个上限（正常语速每字 0.22 秒）；
             *   ② 再用**音频能量**把终点钉到「下一个 token 起点之前最后一段
             *      人声结束的位置」。
             *
             * ② 是关键：没有它，连续说话时终点只能取「下一个起点」（gap 恒为 0，
             * 断句拿不到停顿），或者取估算值（句尾伸进静音里）。有了它，连读段
             * 落点几乎贴着下一个起点，真有停顿时落点就在人声收尾处 —— 停顿这才
             * 是可测的量。
             */
            double span = kTokenBaseSec + kCharSec * (double)utf8Len(item.text);
            double end = item.start + span;
            if (i + 1 < r->count && r->timestamps != nullptr) {
                const double next_start = (double)r->timestamps[i + 1];
                if (next_start > item.start) {
                    const double voiced = lastVoicedEnd(vm, next_start);
                    /*
                     * 人声一直持续到下一个 token 开始 → 连读，终点就是下一个起点。
                     * 这时若用估算值收尾，会在字与字之间留下一个并不存在的「停顿」，
                     * 断句就会照着这个假停顿乱切。
                     */
                    if (voiced > item.start && next_start - voiced < 0.05) end = next_start;
                    else if (voiced > item.start + 0.02) end = std::min(end, voiced);
                    else end = std::min(end, next_start);
                }
            }
            item.end = std::max(item.start + 0.02, end);
        } else {
            item.end = -1.0;
        }

        item.logprob = (r->ys_log_probs != nullptr) ? (double)r->ys_log_probs[i] : 0.0;
        out.push_back(item);
    }

    // 时间戳整体缺失：按字数均分整块时长，至少让字幕能落在正确位置
    if (!out.empty() && out.front().start < 0.0) {
        int total_chars = 0;
        for (const auto &t : out) total_chars += std::max(1, utf8Len(t.text));
        const double per = chunk_len / (double)std::max(1, total_chars);
        double cursor = 0.0;
        for (auto &t : out) {
            const int n = std::max(1, utf8Len(t.text));
            t.start = cursor;
            cursor += per * (double)n;
            t.end = cursor;
        }
    }
    return out;
}

/** 按标点与静音间隔把 token 合并成自然句 */
std::vector<Cue> buildCues(const std::vector<TokenItem> &toks, double chunk_offset,
                           double chunk_limit) {
    std::vector<Cue> cues;
    if (toks.empty()) return cues;

    Cue cur;
    bool open = false;

    auto flush = [&](int end_index) {
        if (!open) return;
        // 收尾时去掉首尾空白，避免字幕条两端出现空隙
        while (!cur.text.empty() && (cur.text.front() == ' ' || cur.text.front() == '\t')) {
            cur.text.erase(cur.text.begin());
        }
        cur.tok_end = end_index;
        if (!cur.text.empty() && utf8Len(cur.text) > 0) cues.push_back(cur);
        open = false;
    };

    for (size_t i = 0; i < toks.size(); i++) {
        const TokenItem &t = toks[i];
        if (!open) {
            cur = Cue{};
            cur.start = t.start;
            cur.end = t.end;
            cur.text = t.text;
            cur.logprob_sum = t.logprob;
            cur.token_count = 1;
            cur.chars = utf8Len(t.text);
            cur.tok_begin = (int)i;
            open = true;
            continue;
        }

        const double gap = t.start - cur.end;
        const bool too_long = (t.end - cur.start) >= kMaxCueSec || (cur.chars + utf8Len(t.text)) >= kMaxCueChars;
        // 软停顿只在已经攒得比较长时才用，否则会把一句话切得很碎
        const bool soft_break = isClauseEnd(cur.text) && cur.chars >= 12;

        if (isSentenceEnd(cur.text) || gap >= kGapSec || too_long || soft_break) {
            flush((int)i);
            cur = Cue{};
            cur.start = t.start;
            cur.end = t.end;
            cur.text = t.text;
            cur.logprob_sum = t.logprob;
            cur.token_count = 1;
            cur.chars = utf8Len(t.text);
            cur.tok_begin = (int)i;
            open = true;
        } else {
            cur.text += t.text;
            cur.end = t.end;
            cur.logprob_sum += t.logprob;
            cur.token_count += 1;
            cur.chars += utf8Len(t.text);
        }
    }
    flush((int)toks.size());

    // 加块偏移并夹进本块范围：跨块越界会让渲染层把整条往后推，逐块累积成系统偏移
    for (auto &c : cues) {
        c.start += chunk_offset;
        c.end += chunk_offset;
        if (c.start < chunk_offset) c.start = chunk_offset;
        if (chunk_limit > 0.0 && c.end > chunk_limit) c.end = chunk_limit;
        if (c.end <= c.start + 0.02) c.end = c.start + 0.02;
    }
    return cues;
}

// ---------------------------------------------------------------- 命令实现

void cmdPing(int64_t id) {
    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value("pong");
    w.key("engine").value("xbaos-engine-asr");
    w.key("backend").value("onnx");
    w.key("model").value(g_model_name);
    w.endObject();
    emit(w.take());
}

void cmdLoad(const mj::Value &req, int64_t id) {
    std::string given = req.str("model");
    std::string onnx, tokens, err;

    if (!resolveModelFiles(given, onnx, tokens, err)) {
        mj::Writer w;
        w.beginObject();
        if (id >= 0) w.key("id").value(id);
        w.key("type").value("error");
        w.key("message").value(err);
        w.endObject();
        emit(w.take());
        return;
    }

    // 同一个模型重复 load 就短路，省掉几百毫秒的初始化
    if (g_rec != nullptr && g_model_dir == onnx) {
        mj::Writer w;
        w.beginObject();
        if (id >= 0) w.key("id").value(id);
        w.key("type").value("loaded");
        w.key("model").value(g_model_name);
        w.key("backend").value("cpu");
        w.key("cached").value(true);
        w.endObject();
        emit(w.take());
        return;
    }

    if (g_rec != nullptr) {
        SherpaOnnxDestroyOfflineRecognizer(g_rec);
        g_rec = nullptr;
    }

    SherpaOnnxOfflineRecognizerConfig config;
    std::memset(&config, 0, sizeof(config));

    config.feat_config.sample_rate = 16000;
    config.feat_config.feature_dim = 80;

    config.model_config.tokens = tokens.c_str();
    config.model_config.num_threads = (int32_t)std::max<int64_t>(1, req.integer("threads", 4));
    config.model_config.provider = "cpu";
    config.model_config.debug = 0;
    config.model_config.model_type = "sense_voice";
    config.model_config.sense_voice.model = onnx.c_str();
    config.model_config.sense_voice.language = "auto";
    // ITN 打开才有标点与数字规整 —— 分段算法重度依赖标点，务必开着
    config.model_config.sense_voice.use_itn = 1;

    config.decoding_method = "greedy_search";
    config.max_active_paths = 4;

    g_started = std::chrono::steady_clock::now();
    g_rec = SherpaOnnxCreateOfflineRecognizer(&config);

    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    if (g_rec == nullptr) {
        w.key("type").value("error");
        w.key("message").value("模型加载失败，请确认文件完整");
    } else {
        g_model_dir = onnx;
        g_model_name = baseName(parentDir(onnx));
        if (g_model_name.empty()) g_model_name = baseName(onnx);
        w.key("type").value("loaded");
        w.key("model").value(g_model_name);
        w.key("backend").value("cpu");
        w.key("cached").value(false);
    }
    w.endObject();
    emit(w.take());
}

/** 把一块音频送去识别，返回 token 列表 */
std::vector<TokenItem> recognizeChunk(const std::vector<float> &samples) {
    std::vector<TokenItem> out;
    if (g_rec == nullptr || samples.empty()) return out;

    const SherpaOnnxOfflineStream *stream = SherpaOnnxCreateOfflineStream(g_rec);
    if (stream == nullptr) return out;

    SherpaOnnxAcceptWaveformOffline(stream, 16000, samples.data(), (int32_t)samples.size());
    SherpaOnnxDecodeOfflineStream(g_rec, stream);

    const SherpaOnnxOfflineRecognizerResult *r = SherpaOnnxGetOfflineStreamResult(stream);
    if (r != nullptr) {
        const double chunk_len = (double)samples.size() / 16000.0;
        out = collectTokens(r, chunk_len, buildVoiceMap(samples));
        SherpaOnnxDestroyOfflineRecognizerResult(r);
    }
    SherpaOnnxDestroyOfflineStream(stream);
    return out;
}

void cmdTranscribe(const mj::Value &req, int64_t id) {
    g_cancel.store(false);

    auto fail = [&](const std::string &msg) {
        mj::Writer w;
        w.beginObject();
        if (id >= 0) w.key("id").value(id);
        w.key("type").value("error");
        w.key("message").value(msg);
        w.endObject();
        emit(w.take());
    };

    if (g_rec == nullptr) {
        fail("引擎尚未加载模型");
        return;
    }

    // 这三项在 CTC 模型上没有意义。与其静默忽略让用户以为生效了，不如说清楚。
    if (req.boolean("translate", false)) {
        fail("当前模型不支持翻译，请切换到 Whisper 模型");
        return;
    }

    const std::string audio_path = req.str("audio");
    if (audio_path.empty()) {
        fail("没有指定音频文件");
        return;
    }

    AudioData audio;
    std::string err;
    const auto t0 = std::chrono::steady_clock::now();
    if (!loadAudio16k(audio_path, audio, err)) {
        fail("无法读取音频：" + err);
        return;
    }
    if (req.boolean("normalize", true)) normalizeLevel(audio);
    if (req.boolean("highPass", true)) highPass(audio);

    const double duration = (double)audio.samples.size() / 16000.0;

    // ---- 切块：给定区间就直接用区间，否则走 VAD ----
    std::vector<xaudio::TimeRange> plan;
    std::vector<bool> hard_cut;
    double speech_seconds = duration;
    int skipped = 0;

    const mj::Value *ranges = req.find("ranges");
    if (ranges != nullptr && ranges->isArray() && !ranges->a.empty()) {
        for (const auto &item : ranges->a) {
            if (!item.isObject()) continue;
            xaudio::TimeRange r;
            r.start = item.num("start", 0.0);
            r.end = item.num("end", 0.0);
            if (r.end > r.start) plan.push_back(r);
        }
        hard_cut.assign(plan.size(), false);
        speech_seconds = 0.0;
        for (const auto &r : plan) speech_seconds += (r.end - r.start);
    } else if (req.boolean("vad", true)) {
        xaudio::VadOptions opt;
        if (const mj::Value *vo = req.find("vadOptions"); vo != nullptr && vo->isObject()) {
            opt.min_silence_sec = vo->num("minSilenceSec", opt.min_silence_sec);
            opt.min_speech_sec = vo->num("minSpeechSec", opt.min_speech_sec);
            opt.long_silence_sec = vo->num("longSilenceSec", opt.long_silence_sec);
            opt.noise_percentile = vo->num("noisePercentile", opt.noise_percentile);
            opt.start_factor = vo->num("startFactor", opt.start_factor);
            opt.stop_factor = vo->num("stopFactor", opt.stop_factor);
        }
        double target = 24.0, overlap = 1.0;
        if (const mj::Value *vo = req.find("vadOptions"); vo != nullptr && vo->isObject()) {
            target = vo->num("targetSec", target);
            overlap = vo->num("overlapSec", overlap);
        }
        xaudio::VadResult vad = xaudio::detectSpeech(audio.samples, opt, target, overlap);
        if (vad.chunks.empty()) {
            // VAD 没找到语音：整段当一块，让模型自己决定（宁可多花时间也别漏）
            plan.push_back({0.0, duration});
            hard_cut.push_back(false);
        } else {
            plan = vad.chunks;
            hard_cut = vad.hard_cut;
            skipped = vad.skipped_silence;
            speech_seconds = vad.speech_seconds;
        }
    } else {
        plan.push_back({0.0, duration});
        hard_cut.push_back(false);
    }

    // ---- 逐块识别 ----
    int cue_index = 0;
    double logprob_sum = 0.0;
    int logprob_count = 0;
    std::string detected_lang;

    for (size_t ci = 0; ci < plan.size(); ci++) {
        if (g_cancel.load()) break;

        const double ss = std::max(0.0, plan[ci].start);
        const double se = std::min(duration, plan[ci].end);
        if (se <= ss) continue;

        const size_t from = (size_t)(ss * 16000.0);
        const size_t to = std::min(audio.samples.size(), (size_t)(se * 16000.0));
        if (to <= from) continue;

        std::vector<float> chunk(audio.samples.begin() + from, audio.samples.begin() + to);

        // 语言：界面指定优先，auto 交给模型
        const std::string want = req.str("language", "auto");
        const char *lang = mapLanguage(want);
        (void)lang; // C API 的 language 在 load 时定，这里只用于回报

        std::vector<TokenItem> toks = recognizeChunk(chunk);
        if (g_cancel.load()) break;

        const double limit = (ci + 1 < plan.size()) ? std::min(se, plan[ci + 1].start) : se;
        std::vector<Cue> cues = buildCues(toks, ss, limit);

        for (const auto &c : cues) {
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("segment");
            w.key("i").value((int64_t)cue_index++);
            w.key("start").value(c.start);
            w.key("end").value(c.end);
            w.key("offset").value(ss);
            w.key("relStart").value(c.start - ss);
            w.key("relEnd").value(c.end - ss);
            w.key("text").value(c.text);
            /*
             * 逐字时间轴：`[起, 止, 起, 止, …]`（毫秒，绝对时间）。
             *
             * 渲染层按字幕规格切条时，切在第几个字就从这里读那个字的真实
             * 起止 —— 不再拿「整句时长 ÷ 字数」摊派。这是时间码能对上的前提。
             * 一个 token 含多个字时按字均分，token 内部不会成为切点（切点两侧
             * 至少各留一个字，见渲染层的断点打分）。
             */
            w.key("charTimes");
            w.beginArray();
            for (int ti = c.tok_begin; ti < c.tok_end; ti++) {
                const TokenItem &tk = toks[(size_t)ti];
                const int n = utf8Len(tk.text);
                if (n <= 0) continue;
                const double step = (tk.end - tk.start) / (double)n;
                for (int k = 0; k < n; k++) {
                    w.value((int64_t)std::llround((tk.start + step * k + ss) * 1000.0));
                    w.value((int64_t)std::llround((tk.start + step * (k + 1) + ss) * 1000.0));
                }
            }
            w.endArray();
            // CTC 没有 no_speech 概率，留 0；置信度走 avgLogprob
            w.key("noSpeech").value(0.0);
            w.key("avgLogprob").value(c.token_count > 0 ? c.logprob_sum / (double)c.token_count : 0.0);
            w.endObject();
            emit(w.take());

            logprob_sum += c.logprob_sum;
            logprob_count += c.token_count;
        }

        mj::Writer pw;
        pw.beginObject();
        if (id >= 0) pw.key("id").value(id);
        pw.key("type").value("progress");
        pw.key("percent").value((int)((ci + 1) * 100 / plan.size()));
        pw.endObject();
        emit(pw.take());
    }

    const double elapsed =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value("done");
    w.key("elapsed").value(elapsed);
    w.key("count").value((int64_t)cue_index);
    w.key("duration").value(duration);
    w.key("language").value(detected_lang.empty() ? req.str("language", "auto") : detected_lang);
    w.key("backend").value("cpu");
    w.key("model").value(g_model_name);
    w.key("chunks").value((int64_t)plan.size());
    w.key("skipped").value((int64_t)skipped);
    w.key("speechSeconds").value(speech_seconds);
    w.key("avgLogprob").value(logprob_count > 0 ? logprob_sum / (double)logprob_count : 0.0);
    w.key("noSpeechRatio").value(0.0);
    w.key("temperature").value(0);
    w.key("aborted").value(g_cancel.load());
    w.endObject();
    emit(w.take());
}

// ---------------------------------------------------------------- 说话人分离

/**
 * 按音色把音频切成「谁在什么时候说话」。
 *
 * 与识别完全解耦：吃同一份 16 kHz 单声道波形，吐「时间区间 + 说话人编号」，
 * 主进程再把编号映射到字幕条目上。所以 whisper 与 sherpa 两套识别都配得上，
 * 不必各自引擎各写一遍。
 *
 * 模型路径由主进程传入，引擎不猜目录 —— 与 load 的做法一致。
 *
 * 与 transcribe 的两点差异：
 *   · 不读 ranges：分离看的是整段音频的声纹分布，切碎了反而判不准
 *   · abort 挡不住：sherpa 的进度回调返回值被忽略，只能等它跑完
 */
void cmdDiarize(const mj::Value &req, int64_t id) {
    g_cancel.store(false);

    auto fail = [&](const std::string &msg) {
        mj::Writer w;
        w.beginObject();
        if (id >= 0) w.key("id").value(id);
        w.key("type").value("error");
        w.key("message").value(msg);
        w.endObject();
        emit(w.take());
    };

    const std::string seg_model = req.str("segModel");
    const std::string embed_model = req.str("embedModel");
    if (seg_model.empty() || embed_model.empty()) {
        fail("缺少说话人分离模型");
        return;
    }

    const std::string audio_path = req.str("audio");
    if (audio_path.empty()) {
        fail("没有指定音频文件");
        return;
    }

    AudioData audio;
    std::string err;
    const auto t0 = std::chrono::steady_clock::now();
    if (!loadAudio16k(audio_path, audio, err)) {
        fail("无法读取音频：" + err);
        return;
    }
    if (audio.samples.empty()) {
        fail("音频是空的");
        return;
    }

    const double duration = (double)audio.samples.size() / 16000.0;

    SherpaOnnxOfflineSpeakerDiarizationConfig cfg;
    std::memset(&cfg, 0, sizeof(cfg));
    cfg.segmentation.pyannote.model = seg_model.c_str();
    cfg.segmentation.num_threads = (int32_t)std::max<int64_t>(1, req.integer("threads", 4));
    cfg.segmentation.provider = "cpu";
    cfg.embedding.model = embed_model.c_str();
    cfg.embedding.num_threads = cfg.segmentation.num_threads;
    cfg.embedding.provider = "cpu";
    // 人数已知时直接给定，比阈值猜更稳；0 表示让聚类自己判
    cfg.clustering.num_clusters = (int32_t)req.integer("numSpeakers", 0);
    cfg.clustering.threshold = (float)req.num("threshold", 0.5);
    cfg.clustering.compute_confidence = 0;
    cfg.min_duration_on = (float)req.num("minDurationOn", 0.3);
    cfg.min_duration_off = (float)req.num("minDurationOff", 0.5);

    const SherpaOnnxOfflineSpeakerDiarization *sd =
        SherpaOnnxCreateOfflineSpeakerDiarization(&cfg);
    if (sd == nullptr) {
        fail("无法加载说话人分离模型，请检查模型文件是否完整");
        return;
    }

    const int32_t need_sr = SherpaOnnxOfflineSpeakerDiarizationGetSampleRate(sd);
    if (need_sr != 16000) {
        SherpaOnnxDestroyOfflineSpeakerDiarization(sd);
        fail("分离模型要求 " + std::to_string(need_sr) + " Hz 采样率，与引擎的 16 kHz 不一致");
        return;
    }

    const SherpaOnnxOfflineSpeakerDiarizationResult *res =
        SherpaOnnxOfflineSpeakerDiarizationProcessWithCallback(
            sd, audio.samples.data(), (int32_t)audio.samples.size(),
            [](int32_t done, int32_t total, void *) -> int32_t {
                if (total > 0) {
                    mj::Writer w;
                    w.beginObject();
                    const int64_t jid = g_job_id.load();
                    if (jid >= 0) w.key("id").value(jid);
                    w.key("type").value("progress");
                    w.key("percent").value((int64_t)(done * 100 / total));
                    w.endObject();
                    emit(w.take());
                }
                return 0;
            },
            nullptr);

    if (res == nullptr) {
        SherpaOnnxDestroyOfflineSpeakerDiarization(sd);
        fail("说话人分离失败");
        return;
    }

    const int32_t num_speakers = SherpaOnnxOfflineSpeakerDiarizationResultGetNumSpeakers(res);
    const int32_t num_segments = SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(res);
    const SherpaOnnxOfflineSpeakerDiarizationSegment *segs =
        SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(res);

    for (int32_t i = 0; i < num_segments; ++i) {
        mj::Writer w;
        w.beginObject();
        if (id >= 0) w.key("id").value(id);
        w.key("type").value("speaker");
        w.key("i").value((int64_t)i);
        w.key("start").value((double)segs[i].start);
        w.key("end").value((double)segs[i].end);
        w.key("speaker").value((int64_t)segs[i].speaker);
        w.endObject();
        emit(w.take());
    }

    const double elapsed =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value("done");
    w.key("elapsed").value(elapsed);
    w.key("duration").value(duration);
    w.key("speakers").value((int64_t)num_speakers);
    w.key("count").value((int64_t)num_segments);
    w.endObject();
    emit(w.take());

    SherpaOnnxOfflineSpeakerDiarizationDestroyResult(res);
    SherpaOnnxDestroyOfflineSpeakerDiarization(sd);
}

} // namespace

int main() {
#ifdef _WIN32
    // 不做文本模式转换：协议行必须是裸 \n，否则主进程按行切会多出 \r
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    logLine("ONNX 识别引擎启动");

    std::string line;
    std::string parse_err;

    while (true) {
        line.clear();
        int ch;
        bool got = false;
        while ((ch = std::fgetc(stdin)) != EOF) {
            got = true;
            if (ch == '\n') break;
            if (ch == '\r') continue;
            line.push_back((char)ch);
        }
        if (!got && line.empty()) break;   // stdin 关闭，主进程退出了

        if (line.empty()) continue;

        mj::Value req;
        if (!mj::parse(line, req, parse_err)) {
            logLine("请求解析失败：" + parse_err);
            continue;
        }

        const std::string cmd = req.str("cmd");
        const int64_t id = req.integer("id", -1);

        if (cmd == "ping") {
            cmdPing(id);
        } else if (cmd == "load") {
            cmdLoad(req, id);
        } else if (cmd == "transcribe") {
            g_job_id.store(id);
            cmdTranscribe(req, id);
            g_job_id.store(-1);
        } else if (cmd == "diarize") {
            g_job_id.store(id);
            cmdDiarize(req, id);
            g_job_id.store(-1);
        } else if (cmd == "abort") {
            g_cancel.store(true);
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("aborted");
            w.endObject();
            emit(w.take());
        } else if (cmd == "shutdown") {
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("bye");
            w.endObject();
            emit(w.take());
            break;
        } else {
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("error");
            w.key("message").value("未知命令：" + cmd);
            w.endObject();
            emit(w.take());
        }
    }

    if (g_rec != nullptr) {
        SherpaOnnxDestroyOfflineRecognizer(g_rec);
        g_rec = nullptr;
    }
    logLine("引擎退出");
    return 0;
}
