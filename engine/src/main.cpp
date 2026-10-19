// XBAOS 字幕生成器 —— 识别引擎
//
// 一个常驻子进程，通过标准输入输出与主进程（Electron 的 Node 侧）通信。
// 协议是行分隔的 JSON：每读一行请求，写回若干行响应。
//
// 为什么要做成独立进程而不是原生模块：
//   1. 可以用 /MT 静态链接，产物零外部运行时依赖（不带任何 vcruntime DLL）
//   2. 模型常驻内存，多次识别不用重新加载
//   3. 崩溃只影响引擎，主进程能感知并重启
//
// 请求：
//   {"id":1,"cmd":"ping"}
//   {"id":2,"cmd":"load","model":"C:\\models\\ggml-small.bin","backend":"auto"}
//   {"id":3,"cmd":"transcribe","audio":"C:\\temp\\a.wav","language":"zh",
//    "prompt":"热词","threads":8,"translate":false,
//    "temperature":0.2,"beamSize":1,"bestOf":1,"vad":true,"normalize":true,
//    "highPass":true,
//    "vadOptions":{"minSilenceSec":0.3,"minSpeechSec":0.2,"longSilenceSec":4.0,
//                  "noisePercentile":0.2,"startFactor":2.0,"stopFactor":1.2,
//                  "targetSec":24.0,"overlapSec":1.0},
//    "ranges":[{"start":12.5,"end":18.0}]}
//
//   ranges 给出时只识别这些时间区间（渲染层的低置信度复核用），VAD 被跳过；
//   vadOptions 缺省时用引擎默认值（与 vad.hpp 的 VadOptions 一致）。
//   {"id":4,"cmd":"abort"}
//   {"id":5,"cmd":"shutdown"}
//
// 响应（一次请求可能产生多行）：
//   {"id":3,"type":"progress","percent":42}
//   {"id":3,"type":"segment","i":0,"start":1.2,"end":3.45,"text":"大家好",
//    "noSpeech":0.02,"avgLogprob":-0.31}
//   {"id":3,"type":"done","elapsed":18.3,"count":28,"duration":106.77,
//    "language":"zh","backend":"cpu","model":"ggml-small.bin",
//    "chunks":5,"skipped":2,"speechSeconds":96.4,
//    "avgLogprob":-0.28,"noSpeechRatio":0.03,"temperature":0}
//   {"id":3,"type":"error","message":"..."}
//
// stdout 只用于协议，日志一律走 stderr。

// windows.h 里的 min / max 是宏，会和 <algorithm> 的 std::min / std::max 打架
// （报错是 "::" 右边的非法标记，很难一眼看出原因）。
// 必须在任何头文件之前定义。
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#endif

#include "whisper.h"

#include "audio.hpp"
#include "mini_json.hpp"
#include "vad.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

// 由 CMakeLists 依据 GGML_VULKAN 注入
#ifndef XBAOS_HAS_VULKAN
#define XBAOS_HAS_VULKAN 0
#endif

namespace {

/* ------------------------------------------------------------------ 输出 */

void emit(const std::string &line) {
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

// whisper / ggml 的日志默认写 stdout，会污染协议，统统转到 stderr
void logSink(ggml_log_level, const char *text, void *) {
    if (!text) return;
    std::fputs(text, stderr);
    std::fflush(stderr);
}

/* -------------------------------------------------------------- 全局状态 */

// 引擎是单线程执行命令的，这些状态只在「读线程」和「执行线程」之间共享
std::atomic<bool> g_cancel{false};
std::atomic<bool> g_quit{false};
// 标准输入已结束（对端关闭了管道）。注意它与 g_quit 不是一回事：
// 输入结束时队列里可能还有没执行完的命令，要排空后再退出。
std::atomic<bool> g_input_closed{false};

std::mutex g_queue_mutex;
std::condition_variable g_queue_cv;
std::queue<std::string> g_queue;

// 当前正在执行的请求 id，-1 表示无
std::atomic<int64_t> g_job_id{-1};
int g_last_percent = -1;

/* ------------------------------------------------------------ 分块与统计 */

// 静音切分后每块单独调 whisper_full：whisper 的时间戳相对当前这块音频，
// 必须补上块偏移；硬切产生的重叠部分还要做一次字符级去重。
double g_chunk_offset = 0.0;
bool g_chunk_hard_cut = false;
int g_chunk_index = 0;
int g_chunk_count = 1;
bool g_chunk_first_segment = true;
std::string g_text_tail;

// 置信度统计：多遍识别时渲染层要用它给每一遍打分
double g_logprob_sum = 0.0;
long long g_logprob_count = 0;
double g_nospeech_weighted = 0.0;
double g_speech_duration = 0.0;

/* ---------------------------------------------------------- UTF-8 小工具 */

/** 取字符串最后 n 个字符（按 UTF-8 字符，不是字节） */
std::string utf8Tail(const std::string &s, size_t max_chars) {
    if (s.empty()) return {};
    size_t pos = s.size();
    size_t count = 0;
    while (pos > 0 && count < max_chars) {
        pos--;
        while (pos > 0 && ((unsigned char)s[pos] & 0xC0) == 0x80) pos--;
        count++;
    }
    return s.substr(pos);
}

std::vector<std::string> utf8Chars(const std::string &s) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i < s.size()) {
        size_t len = 1;
        const unsigned char c = (unsigned char)s[i];
        if ((c & 0xE0) == 0xC0) len = 2;
        else if ((c & 0xF0) == 0xE0) len = 3;
        else if ((c & 0xF8) == 0xF0) len = 4;
        if (i + len > s.size()) len = 1;
        out.push_back(s.substr(i, len));
        i += len;
    }
    return out;
}

/**
 * 硬切重叠去重：找出 text 开头与 tail 结尾重复的字符数，返回应丢弃的字节数。
 * 例：tail 以「今天我们来聊」结尾、text 以「来聊聊显卡」开头，则丢掉「来聊」。
 */
size_t overlapBytesToDrop(const std::string &tail, const std::string &text, size_t max_chars) {
    if (tail.empty() || text.empty()) return 0;
    const std::vector<std::string> tail_chars = utf8Chars(utf8Tail(tail, max_chars));
    const std::vector<std::string> text_chars = utf8Chars(text);
    const size_t limit = std::min({tail_chars.size(), text_chars.size(), max_chars});
    size_t best = 0;
    for (size_t k = limit; k >= 1; k--) {
        bool same = true;
        for (size_t i = 0; i < k; i++) {
            if (tail_chars[tail_chars.size() - k + i] != text_chars[i]) {
                same = false;
                break;
            }
        }
        if (same) {
            best = k;
            break;
        }
    }
    size_t bytes = 0;
    for (size_t i = 0; i < best; i++) bytes += text_chars[i].size();
    return bytes;
}

/* -------------------------------------------------------------- 模型状态 */

struct ModelSlot {
    whisper_context *ctx = nullptr;
    std::string path;
    std::string name;
    std::string backend = "cpu";
    int64_t load_ms = 0;

    void release() {
        if (ctx) {
            whisper_free(ctx);
            ctx = nullptr;
        }
        path.clear();
        name.clear();
        backend = "cpu";
        load_ms = 0;
    }
};

ModelSlot g_model;

/* ---------------------------------------------------------------- 小工具 */

std::string baseName(const std::string &p) {
    size_t pos = p.find_last_of("\\/");
    return pos == std::string::npos ? p : p.substr(pos + 1);
}

void sendError(int64_t id, const std::string &message) {
    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value("error");
    w.key("message").value(message);
    w.endObject();
    emit(w.take());
}

void sendOk(int64_t id, const char *type) {
    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value(type);
    w.endObject();
    emit(w.take());
}

/* ---------------------------------------------------------------- 回调 */

void onProgress(whisper_context *, whisper_state *, int progress, void *) {
    if (progress < 0 || progress > 100) return;
    // 分块识别时把「当前块进度」折算成整体进度，界面上的百分比才连贯
    const int overall = g_chunk_count > 1
                            ? (int)(((double)g_chunk_index * 100.0 + (double)progress) /
                                    (double)g_chunk_count)
                            : progress;
    if (overall == g_last_percent) return;
    g_last_percent = overall;

    const int64_t id = g_job_id.load();
    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value("progress");
    w.key("percent").value(overall);
    w.endObject();
    emit(w.take());
}

// 每生成一段就立刻推给主进程，界面能边识别边出字幕
void onSegment(whisper_context *ctx, whisper_state *, int n_new, void *) {
    const int total = whisper_full_n_segments(ctx);
    const int64_t id = g_job_id.load();

    for (int i = total - n_new; i < total; i++) {
        if (i < 0) continue;
        const char *raw = whisper_full_get_segment_text(ctx, i);
        int64_t t0 = whisper_full_get_segment_t0(ctx, i); // 单位 10ms
        int64_t t1 = whisper_full_get_segment_t1(ctx, i);
        const float no_speech = whisper_full_get_segment_no_speech_prob(ctx, i);

        std::string text = raw ? std::string(raw) : std::string();

        // 硬切重叠：本块第一段可能与上一块结尾重复，按字符对齐后裁掉
        if (g_chunk_hard_cut && g_chunk_first_segment) {
            g_chunk_first_segment = false;
            const size_t drop = overlapBytesToDrop(g_text_tail, text, 10);
            if (drop > 0) text = text.substr(drop);
        }
        if (text.empty() || text.find_first_not_of(" \t\n\r") == std::string::npos) continue;

        // v1.9 没有段落级的 avg_logprob，用 token 概率的几何平均自己算。
        // 越接近 0 表示置信度越高；明显偏低时界面上可以提示复核。
        double logprob_sum = 0.0;
        int logprob_count = 0;
        const int n_tokens = whisper_full_n_tokens(ctx, i);
        for (int t = 0; t < n_tokens; t++) {
            const float p = whisper_full_get_token_p(ctx, i, t);
            if (p > 1e-6f) {
                logprob_sum += std::log((double)p);
                logprob_count++;
            }
        }
        const double avg_logprob = logprob_count > 0 ? logprob_sum / logprob_count : 0.0;

        // 统计（多遍识别打分用）
        g_logprob_sum += logprob_sum;
        g_logprob_count += logprob_count;
        const double seg_dur = std::max(0.0, (double)(t1 - t0) / 100.0);
        g_nospeech_weighted += (double)no_speech * seg_dur;
        g_speech_duration += seg_dur;

        const double offset = g_chunk_offset;
        g_text_tail = utf8Tail(g_text_tail + text, 24);

        mj::Writer w;
        w.beginObject();
        if (id >= 0) w.key("id").value(id);
        w.key("type").value("segment");
        w.key("i").value((int64_t)i);
        w.key("start").value((double)t0 / 100.0 + offset);
        w.key("end").value((double)t1 / 100.0 + offset);
        w.key("text").value(text);
        w.key("noSpeech").value((double)no_speech);
        w.key("avgLogprob").value((double)avg_logprob);
        w.endObject();
        emit(w.take());
    }
}

bool onAbort(void *) {
    return g_cancel.load();
}

/* ------------------------------------------------------------------ 命令 */

void cmdPing(const mj::Value &req, int64_t id) {
    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value("pong");
    w.key("engine").value("xbaos-engine");
    w.key("whisper").value(whisper_version() ? whisper_version() : "unknown");

    w.key("backends").beginArray().value("cpu");
#if XBAOS_HAS_VULKAN
    // 运行期被禁用时不要报 vulkan —— 否则界面会显示一个根本用不了的能力
    if (std::getenv("GGML_DISABLE_VULKAN") == nullptr) w.value("vulkan");
#endif
    w.endArray();

    w.key("modelLoaded").value(g_model.ctx != nullptr);
    if (g_model.ctx) {
        w.key("model").value(g_model.name);
        w.key("backend").value(g_model.backend);
    }
    w.endObject();
    emit(w.take());
}

void cmdLoad(const mj::Value &req, int64_t id) {
    const std::string path = req.str("model");
    if (path.empty()) {
        sendError(id, "缺少 model 参数");
        return;
    }

    const std::string requested = req.str("backend", "auto");

    // 有没有 GPU 后端是编译期决定的。没编 Vulkan 时若仍把 use_gpu 设为 true，
    // whisper 会静默忽略这个标志照常初始化成功，届时我们上报的后端就是错的，
    // 用户会看到「在用 GPU」而实际跑在 CPU 上。所以这里先按编译宏纠正。
    bool wantGpu = (requested != "cpu");
#if !XBAOS_HAS_VULKAN
    if (wantGpu) {
        const bool explicitGpu = (requested == "vulkan" || requested == "gpu");
        wantGpu = false;
        if (explicitGpu) {
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("fallback");
            w.key("from").value(requested);
            w.key("to").value("cpu");
            w.key("reason").value("这个版本没有编译 Vulkan 后端，只能用 CPU");
            w.endObject();
            emit(w.take());
        }
    }
#else
    /*
     * 编译了 Vulkan 不等于这次真的能用。
     *
     * GGML_DISABLE_VULKAN 会让 ggml 的后端注册表整个跳过 Vulkan，而 whisper 对
     * use_gpu=true 是**静默忽略**的 —— 它照样初始化成功，只是实际跑在 CPU 上。
     * 不在这里纠正，我们就会把跑 CPU 的识别上报成 gpu，用户看到
     * 「在用显卡」而其实没有。
     */
    if (wantGpu && std::getenv("GGML_DISABLE_VULKAN") != nullptr) {
        const bool explicitGpu = (requested == "vulkan" || requested == "gpu");
        wantGpu = false;
        if (explicitGpu) {
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("fallback");
            w.key("from").value(requested);
            w.key("to").value("cpu");
            w.key("reason").value("Vulkan 已被禁用（GGML_DISABLE_VULKAN），只能用 CPU");
            w.endObject();
            emit(w.take());
        }
    }
#endif

    // 已经加载了同一个模型且后端一致，直接复用
    if (g_model.ctx && g_model.path == path && g_model.backend == (wantGpu ? "gpu" : "cpu")) {
        mj::Writer w;
        w.beginObject();
        if (id >= 0) w.key("id").value(id);
        w.key("type").value("loaded");
        w.key("reused").value(true);
        w.key("model").value(g_model.name);
        w.key("backend").value(g_model.backend);
        w.key("loadMs").value(g_model.load_ms);
        w.endObject();
        emit(w.take());
        return;
    }

    g_model.release();

    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = wantGpu;
    cparams.flash_attn = false;

    const auto t0 = std::chrono::steady_clock::now();
    whisper_context *ctx = whisper_init_from_file_with_params(path.c_str(), cparams);

    // 指定要 GPU 但实际拿不到（未编译 Vulkan 后端 / 驱动不支持）时回退 CPU
    if (!ctx && wantGpu) {
        cparams.use_gpu = false;
        ctx = whisper_init_from_file_with_params(path.c_str(), cparams);
        if (ctx) {
            g_model.backend = "cpu";
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("fallback");
            w.key("from").value("vulkan");
            w.key("to").value("cpu");
            w.key("reason").value("GPU 初始化失败，已回退到 CPU");
            w.endObject();
            emit(w.take());
        }
    }

    if (!ctx) {
        sendError(id, "模型加载失败：" + path);
        return;
    }

    const auto t1 = std::chrono::steady_clock::now();
    g_model.ctx = ctx;
    g_model.path = path;
    g_model.name = baseName(path);
    g_model.backend = cparams.use_gpu ? "gpu" : "cpu";
    g_model.load_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value("loaded");
    w.key("reused").value(false);
    w.key("model").value(g_model.name);
    w.key("backend").value(g_model.backend);
    w.key("loadMs").value(g_model.load_ms);
    w.endObject();
    emit(w.take());
}

void cmdUnload(int64_t id) {
    g_model.release();
    sendOk(id, "unloaded");
}

void cmdTranscribe(const mj::Value &req, int64_t id) {
    if (!g_model.ctx) {
        sendError(id, "还没有加载模型");
        return;
    }

    const std::string audio_path = req.str("audio");
    if (audio_path.empty()) {
        sendError(id, "缺少 audio 参数");
        return;
    }

    xaudio::AudioData audio;
    std::string err;
    // 统一入口：按魔数识别 WAV / AIFF / MP3 / FLAC / OGG / Opus 并转 16k 单声道
    if (!xaudio::loadAudio16k(audio_path, audio, err)) {
        sendError(id, err);
        return;
    }

    // 电平归一化（去直流 + 峰值限幅 + RMS 归一）。默认开启，可在请求里关掉。
    if (req.boolean("normalize", true)) {
        xaudio::normalizeLevel(audio);
    }

    // 高通滤波（切掉 80Hz 以下低频噪声）。默认开启，可在请求里关掉。
    // 顺序有讲究：先滤波再归一，归一化的增益才不会浪费在哼声上。
    if (req.boolean("highPass", true)) {
        xaudio::highPass(audio);
    }

    std::string language = req.str("language", "zh");
    const bool auto_language = (language == "auto" || language.empty());
    const std::string prompt = req.str("prompt");
    const bool translate = req.boolean("translate", false);

    // 多遍识别用：每遍传一个略高的温度以获得互补的候选结果。
    // 温度 > 0 时把温度回退（temperature_inc）关掉 —— 否则 whisper 会在
    // 失败片段上继续升温，两遍之间的差异就不再只来自我们指定的温度了。
    double temperature = req.num("temperature", 0.0);
    temperature = std::min(1.0, std::max(0.0, temperature));
    int beam_size = (int)req.integer("beamSize", 1);
    beam_size = std::min(16, std::max(1, beam_size));
    int best_of = (int)req.integer("bestOf", 1);
    best_of = std::min(16, std::max(1, best_of));

    // 线程数的默认值有讲究，不能简单地「有多少核就用多少核」。
    //
    // 实测（Core Ultra 5 225H，4P + 8E + 2 个低频 LP E 核，14 线程；
    // small 模型，20.9 秒中文音频，同一份输入）：
    //     4 线程    4.90 秒
    //     8 线程    3.81 秒   <- 最优
    //    12 线程   23.87 秒   <- 反而慢 6 倍
    //
    // 原因是 ggml 每层都要屏障同步，整批线程得等最慢的那一个。把能效核
    // （尤其那两个低频 LP E 核）拉进线程池后，每一层都被它们拖住，
    // 线程越多拖得越狠。少用几个核最多损失一点峰值性能，线程超订的代价
    // 却是数量级的，所以默认值取保守值。用户仍可用 threads 参数手动指定。
    static const unsigned kMaxAutoThreads = 8;
    int threads = (int)req.integer("threads", 0);
    if (threads <= 0) {
        const unsigned hw = std::thread::hardware_concurrency();
        threads = (int)std::max(1u, std::min(hw == 0 ? 4u : hw, kMaxAutoThreads));
    }

    // 语言字符串必须在 whisper_full 期间保持有效，放到局部变量里
    const std::string lang_holder = auto_language ? std::string("auto") : language;

    // 采样策略：多遍识别时可选束搜索（更准但更慢）
    whisper_full_params params = beam_size > 1
                                     ? whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH)
                                     : whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = threads;
    params.translate = translate;
    params.language = lang_holder.c_str();
    params.detect_language = auto_language;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.print_special = false;
    // 必须为 true。引擎是常驻进程、whisper_context 跨请求复用：
    // no_context=false 时 whisper 会把「上一段（乃至上一个文件）的转录文本」
    // 累积进 prompt_past 并作为本次解码的初始提示。实测第二次识别会被第一次
    // 的结果严重带偏（输出变成英文残句、幻觉词），多文件批量时逐个污染，
    // 且时好时坏（取决于上一段文本内容）。每个请求都是独立转写，不允许继承。
    params.no_context = true;
    params.single_segment = false;
    params.token_timestamps = false;
    params.suppress_blank = true;
    params.new_segment_callback = onSegment;
    params.progress_callback = onProgress;
    params.abort_callback = onAbort;
    params.temperature = (float)temperature;
    if (temperature > 0.0) params.temperature_inc = 0.0f;
    if (beam_size > 1) params.beam_search.beam_size = beam_size;
    params.greedy.best_of = best_of;
    if (!prompt.empty()) {
        params.initial_prompt = prompt.c_str();
    }

    // ---- 静音切分：把音频切成 20~28 秒的块，逐块识别 ----
    // 为什么值得做：整段超 30 秒后 whisper 靠滑窗切分，窗口边界容易吞字；
    // 长静音段还会诱发幻觉。按能量 VAD 在静音处下刀能同时缓解这两个问题。
    int skipped_silence = 0;
    double speech_seconds = 0.0;
    bool vad_used = req.boolean("vad", true);
    std::vector<xaudio::TimeRange> plan;
    std::vector<bool> hard_cut;

    // 指定区间模式：只识别给定的时间区间，VAD 被跳过。
    // 低置信度复核走这条路 —— 渲染层已经知道哪几秒不可信，直接当成刀口。
    if (const mj::Value *rv = req.find("ranges"); rv != nullptr && rv->isArray()) {
        for (const mj::Value &item : rv->a) {
            const double s = item.num("start", -1.0);
            const double e = item.num("end", -1.0);
            if (s < 0.0 || e <= s || s >= audio.duration) continue;
            plan.push_back({s, std::min(e, audio.duration)});
            hard_cut.push_back(false);
        }
    }

    if (!plan.empty()) {
        // 区间模式下「有效语音时长」就是区间长度之和
        for (const xaudio::TimeRange &r : plan) speech_seconds += r.end - r.start;
    } else if (vad_used) {
        // 场景预设：主进程可以把整组 VAD 参数传进来（不同场景的最优切分不一样）。
        // 只覆盖请求里出现的字段，其余保持引擎默认，前后兼容。
        xaudio::VadOptions vad_opt;
        if (const mj::Value *vo = req.find("vadOptions"); vo != nullptr && vo->isObject()) {
            vad_opt.min_speech_sec = std::max(0.05, vo->num("minSpeechSec", vad_opt.min_speech_sec));
            vad_opt.min_silence_sec = std::max(0.05, vo->num("minSilenceSec", vad_opt.min_silence_sec));
            vad_opt.long_silence_sec = std::max(0.5, vo->num("longSilenceSec", vad_opt.long_silence_sec));
            vad_opt.noise_percentile = std::min(0.5, std::max(0.01,
                vo->num("noisePercentile", vad_opt.noise_percentile)));
            vad_opt.start_factor = std::max(1.1, vo->num("startFactor", vad_opt.start_factor));
            vad_opt.stop_factor = std::max(1.05, vo->num("stopFactor", vad_opt.stop_factor));
            // 判停倍数必须低于起判倍数，滞回才有意义
            vad_opt.stop_factor = std::min(vad_opt.stop_factor, vad_opt.start_factor);
        }
        double target_sec = 24.0;
        double overlap_sec = 1.0;
        if (const mj::Value *vo = req.find("vadOptions"); vo != nullptr && vo->isObject()) {
            target_sec = std::min(28.0, std::max(8.0, vo->num("targetSec", target_sec)));
            overlap_sec = std::min(3.0, std::max(0.0, vo->num("overlapSec", overlap_sec)));
        }

        const xaudio::VadResult vad = xaudio::detectSpeech(audio.samples, vad_opt, target_sec, overlap_sec);
        skipped_silence = vad.skipped_silence;
        speech_seconds = vad.speech_seconds;
        plan = vad.chunks;
        hard_cut = vad.hard_cut;
        if (plan.empty()) {
            // 整段检测不到人声：直接返回空结果。
            // 硬跑 whisper 的话，它会在纯静音上编出「谢谢观看」这类幻觉文本。
            mj::Writer w;
            w.beginObject();
            if (id >= 0) w.key("id").value(id);
            w.key("type").value("done");
            w.key("count").value((int64_t)0);
            w.key("elapsed").value(0.0);
            w.key("duration").value(audio.duration);
            w.key("backend").value(g_model.backend);
            w.key("model").value(g_model.name);
            w.key("language").value(lang_holder);
            w.key("sourceRate").value((int64_t)audio.source_rate);
            w.key("sourceChannels").value((int64_t)audio.source_channels);
            w.key("threads").value((int64_t)threads);
            w.key("chunks").value((int64_t)0);
            w.key("skipped").value((int64_t)skipped_silence);
            w.key("speechSeconds").value(speech_seconds);
            w.key("avgLogprob").value(0.0);
            w.key("noSpeechRatio").value(1.0);
            w.key("warning").value("未检测到人声，已跳过识别");
            w.endObject();
            emit(w.take());
            return;
        }
    } else {
        plan.push_back({0.0, audio.duration});
        hard_cut.push_back(false);
    }

    g_cancel.store(false);
    g_last_percent = -1;
    g_chunk_count = (int)plan.size();
    g_chunk_index = 0;
    g_text_tail.clear();
    g_logprob_sum = 0.0;
    g_logprob_count = 0;
    g_nospeech_weighted = 0.0;
    g_speech_duration = 0.0;

    const auto t0 = std::chrono::steady_clock::now();
    int64_t total_segments = 0;
    for (size_t ci = 0; ci < plan.size(); ci++) {
        if (g_cancel.load()) break;
        g_chunk_index = (int)ci;
        g_chunk_offset = plan[ci].start;
        g_chunk_hard_cut = hard_cut[ci];
        g_chunk_first_segment = true;

        const size_t begin = (size_t)std::max(0.0, plan[ci].start * 16000.0);
        size_t end = (size_t)std::min((double)audio.samples.size(), plan[ci].end * 16000.0);
        if (end <= begin + 800) continue; // 少于 50ms 的块没有意义
        if (end > audio.samples.size()) end = audio.samples.size();

        const int rc = whisper_full(g_model.ctx, params, audio.samples.data() + begin,
                                    (int)(end - begin));
        if (rc != 0) {
            if (g_cancel.load()) {
                sendOk(id, "canceled");
            } else {
                sendError(id, "识别失败（whisper_full 返回 " + std::to_string(rc) + "）");
            }
            g_job_id.store(-1);
            return;
        }
        total_segments += (int64_t)whisper_full_n_segments(g_model.ctx);
    }
    const auto t1 = std::chrono::steady_clock::now();

    if (g_cancel.load()) {
        sendOk(id, "canceled");
        return;
    }

    const double elapsed_ms =
        (double)std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    int lang_id = -1;
    if (!auto_language) lang_id = whisper_full_lang_id(g_model.ctx);
    const char *lang_str = lang_id >= 0 ? whisper_lang_str(lang_id) : nullptr;

    const double avg_logprob = g_logprob_count > 0 ? g_logprob_sum / (double)g_logprob_count : 0.0;
    const double nospeech_ratio =
        g_speech_duration > 0.0 ? g_nospeech_weighted / g_speech_duration : 0.0;

    mj::Writer w;
    w.beginObject();
    if (id >= 0) w.key("id").value(id);
    w.key("type").value("done");
    w.key("count").value(total_segments);
    w.key("elapsed").value(elapsed_ms / 1000.0);
    w.key("duration").value(audio.duration);
    w.key("backend").value(g_model.backend);
    w.key("model").value(g_model.name);
    w.key("language").value(lang_str ? std::string(lang_str) : lang_holder);
    w.key("sourceRate").value((int64_t)audio.source_rate);
    w.key("sourceChannels").value((int64_t)audio.source_channels);
    w.key("threads").value((int64_t)threads);
    // 分块与置信度统计：界面用来显示「跳过了几段静音」，
    // 多遍识别时也用它们给每一遍打分
    w.key("chunks").value((int64_t)plan.size());
    w.key("skipped").value((int64_t)skipped_silence);
    w.key("speechSeconds").value(speech_seconds);
    w.key("avgLogprob").value(avg_logprob);
    w.key("noSpeechRatio").value(nospeech_ratio);
    w.key("temperature").value(temperature);
    w.endObject();
    emit(w.take());
}

/* ------------------------------------------------------------ 请求分发 */

void handleLine(const std::string &line) {
    if (line.empty()) return;

    mj::Value req;
    std::string err;
    if (!mj::parse(line, req, err)) {
        sendError(-1, "请求不是合法 JSON：" + err);
        return;
    }

    const int64_t id = req.has("id") ? req.integer("id", -1) : -1;
    const std::string cmd = req.str("cmd");

    if (cmd == "ping") {
        cmdPing(req, id);
    } else if (cmd == "load") {
        cmdLoad(req, id);
    } else if (cmd == "unload") {
        cmdUnload(id);
    } else if (cmd == "transcribe") {
        g_job_id.store(id);
        cmdTranscribe(req, id);
        g_job_id.store(-1);
    } else if (cmd == "abort") {
        g_cancel.store(true);
        sendOk(id, "aborting");
    } else if (cmd == "shutdown") {
        sendOk(id, "bye");
        g_quit.store(true);
    } else {
        sendError(id, "未知命令：" + cmd);
    }
}

// 读线程：持续读取 stdin。识别耗时较长时它仍然在跑，
// 因此能在识别中途收到 abort 并立刻置位取消标志。
void readerLoop() {
    std::string line;
    line.reserve(4096);
    int c;
    while (!g_quit.load()) {
        c = std::fgetc(stdin);
        if (c == EOF) {
            // 输入结束。不能直接置 g_quit 就退出：把几条命令一次性写进管道
            // 然后关掉的情况下，队列里可能还有没执行完的命令。
            // 交给主循环把队列排空后再收工。
            g_input_closed.store(true);
            g_queue_cv.notify_all();
            break;
        }
        if (c == '\n') {
            {
                std::lock_guard<std::mutex> lk(g_queue_mutex);
                g_queue.push(line);
            }
            line.clear();
            g_queue_cv.notify_one();
        } else if (c != '\r') {
            line.push_back((char)c);
        }
    }
}

} // namespace

int main(int argc, char **argv) {
#ifdef _WIN32
    // 管道按二进制处理，JSON 里的中文以 UTF-8 原样通过，不经过代码页转换
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    whisper_log_set(logSink, nullptr);

    // 允许命令行直接指定模型，方便脱离主进程单独调试
    for (int i = 1; i < argc; i++) {
        if (std::strcmp(argv[i], "--model") == 0 && i + 1 < argc) {
            mj::Value fake;
            fake.type = mj::Value::OBJ;
            fake.o.emplace_back("model", mj::Value{});
            fake.o.back().second.type = mj::Value::STR;
            fake.o.back().second.s = argv[i + 1];
            cmdLoad(fake, -1);
            i++;
        } else if (std::strcmp(argv[i], "--version") == 0) {
            std::fprintf(stderr, "xbaos-engine (whisper.cpp %s)\n",
                         whisper_version() ? whisper_version() : "unknown");
            return 0;
        } else if (std::strcmp(argv[i], "--help") == 0) {
            std::fprintf(stderr,
                         "xbaos-engine —— XBAOS 字幕生成器的识别引擎\n"
                         "  --model <path>  预加载模型\n"
                         "  --version       打印版本\n"
                         "无参数时从标准输入读 JSON 命令。\n");
            return 0;
        }
    }

    std::thread reader(readerLoop);

    for (;;) {
        std::string line;
        bool have = false;
        {
            std::unique_lock<std::mutex> lk(g_queue_mutex);
            g_queue_cv.wait_for(lk, std::chrono::milliseconds(200), [] {
                return !g_queue.empty() || g_quit.load() || g_input_closed.load();
            });
            if (!g_queue.empty()) {
                line = std::move(g_queue.front());
                g_queue.pop();
                have = true;
            }
        }
        if (have) {
            handleLine(line);
            continue;
        }
        // 队列已空：收到 shutdown 或者输入结束，都该收工了
        if (g_quit.load() || g_input_closed.load()) break;
    }

    g_model.release();
    std::fflush(stdout);
    std::fflush(stderr);

    // 读线程可能仍阻塞在 fgetc 上（长连接下收到 shutdown 时就是这样），
    // join 会一直等下去。引擎退出不需要任何析构，直接结束进程最干净。
    std::_Exit(0);
}
