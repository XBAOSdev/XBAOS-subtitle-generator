// Ogg Opus 解码 —— 极简 Ogg 解封装 + libopus。
//
// 为什么不引 opusfile / libogg：
//   Ogg 的页面结构足够简单（捕获码 + 27 字节头 + lacing 表），单逻辑流的
//   播客/录音文件解析起来风险很低。引一整套 opusfile+libogg 只为了
//   读这一个容器不值得，还会显著增加编译面与发布体积。
//   这里只做我们需要的：按页拆包、按 lacing 还原完整数据包、跟踪
//   granule 位置，其余元数据一概忽略。CRC 校验也跳过 —— 解码端对
//   坏包本来就有容忍（跳过即可），不影响识别结果。
//
// Opus 固定以 48kHz 解码，前导样本数（pre-skip）从 OpusHead 读出，
// 输出样本总数按最后一页的 granule 对齐，多余尾巴裁掉。

#include "decoders.hpp"

#if defined(XBAOS_HAS_OPUS) && XBAOS_HAS_OPUS
#define OPUS_HAVE_OPUS 1
// 源码树（GitHub archive）的头文件直接在 include/ 下，
// 没有安装版的 opus/ 子目录层级，所以这里用 <opus.h>
#include <opus.h>
#endif

#include <cstring>

namespace xdec {

bool isOggOpus(const uint8_t *data, size_t size) {
    if (size < 4 || std::memcmp(data, "OggS", 4) != 0) return false;
    // Opus 流的第一个包是 19 字节的 OpusHead，一定落在第一页里。
    // 在开头 512 字节内扫它的魔数即可，不用完整解封装。
    const size_t scan = size < 512 ? size : 512;
    if (scan < 8) return false;
    for (size_t i = 0; i + 8 <= scan; i++) {
        if (std::memcmp(data + i, "OpusHead", 8) == 0) return true;
    }
    return false;
}

#ifdef OPUS_HAVE_OPUS

namespace {

// 极简 Ogg 解封装：只跟踪第一个出现的逻辑流，顺序交出完整数据包。
//
// 交付模型：pending_ 积累段数据，遇到长度 < 255 的段即视为包尾，
// 下一次 nextPacket() 调用时把 pending_ 整体交付。这样跨页的包
// （连续 255 段）也能正确拼起来。
class OggPacketReader {
public:
    OggPacketReader(const uint8_t *data, size_t size) : data_(data), size_(size) {}

    bool nextPacket(std::vector<uint8_t> &out) {
        for (;;) {
            // 先把当前页剩下的包交付完，再翻页
            while (segsLeft_ > 0) {
                const uint8_t lace = segTable_[segIdx_++];
                segsLeft_--;
                pending_.insert(pending_.end(), pagePos_, pagePos_ + lace);
                pagePos_ += lace;
                if (lace < 255) {
                    // 包尾就绪，立刻交付。拼页交付会让 opus_decode 全部失败。
                    if (pending_.empty()) continue; // 空包（连续 0 段）跳过
                    out = std::move(pending_);
                    pending_.clear();
                    return true;
                }
            }

            if (!nextPage()) return false; // 文件结束（残包不完整，丢弃）
            if (serial_ == 0) serial_ = pageSerial_; // 只跟第一个流
            if (pageSerial_ != serial_) continue;    // 其余流（如封面图）跳过
            if (pageGranule_ > maxGranule_) maxGranule_ = pageGranule_;
        }
    }

    int64_t maxGranule() const { return maxGranule_; }

private:
    bool nextPage() {
        for (;;) {
            if (resyncing_) {
                while (pos_ + 4 <= size_ && std::memcmp(data_ + pos_, "OggS", 4) != 0) pos_++;
                resyncing_ = false;
            }
            if (pos_ + 27 > size_ || std::memcmp(data_ + pos_, "OggS", 4) != 0) return false;

            const uint8_t *h = data_ + pos_;
            if (h[4] != 0) {
                // 未知版本：跳到下一个捕获码重新同步
                pos_++;
                resyncing_ = true;
                continue;
            }
            break;
        }

        const uint8_t *h = data_ + pos_;
        std::memcpy(&pageGranule_, h + 6, 8);
        std::memcpy(&pageSerial_, h + 14, 4);
        segCount_ = h[26];
        segIdx_ = 0;
        segsLeft_ = segCount_;
        if (pos_ + 27 + segCount_ > size_) return false;
        std::memcpy(segTable_, h + 27, (size_t)segCount_);
        pagePos_ = h + 27 + segCount_;

        uint32_t bodySize = 0;
        for (int i = 0; i < segCount_; i++) bodySize += segTable_[i];
        if ((size_t)((pagePos_ - data_)) + bodySize > size_) {
            pos_ = size_; // 页体不完整：当文件结束处理
            return false;
        }
        pos_ = (size_t)(pagePos_ - data_) + bodySize;
        return true;
    }

    const uint8_t *data_;
    size_t size_;
    size_t pos_ = 0;

    uint32_t serial_ = 0;
    uint32_t pageSerial_ = 0;
    int64_t pageGranule_ = 0;
    int64_t maxGranule_ = 0;
    int segCount_ = 0;
    int segIdx_ = 0;
    int segsLeft_ = 0;
    uint8_t segTable_[255] = {};
    const uint8_t *pagePos_ = nullptr;

    std::vector<uint8_t> pending_;
    bool resyncing_ = false;
};

inline uint16_t rdLE16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

#endif // OPUS_HAVE_OPUS

} // namespace

bool decodeOggOpus(const uint8_t *data, size_t size, DecodedAudio &out, std::string &err) {
#ifdef OPUS_HAVE_OPUS
    OggPacketReader reader(data, size);

    // ---- 第一个包：OpusHead ----
    std::vector<uint8_t> head;
    if (!reader.nextPacket(head) || head.size() < 19 ||
        std::memcmp(head.data(), "OpusHead", 8) != 0) {
        err = "不是有效的 OGG Opus 文件（缺少 OpusHead）";
        return false;
    }
    // OpusHead 布局：0-7 魔数，8 版本，9 通道数，10-11 前导样本（LE），12-15 源采样率
    const int channels = head[9];
    const int preSkip = (int)rdLE16(head.data() + 10);
    if (channels < 1 || channels > 8) {
        err = "不支持的 Opus 通道数：" + std::to_string(channels);
        return false;
    }

    // ---- 第二个包：OpusTags，跳过 ----
    std::vector<uint8_t> tags;
    if (!reader.nextPacket(tags)) {
        err = "不是有效的 OGG Opus 文件（缺少 OpusTags）";
        return false;
    }

    int opusErr = 0;
    OpusDecoder *dec = opus_decoder_create(48000, channels, &opusErr);
    if (!dec) {
        err = "Opus 解码器初始化失败（错误码 " + std::to_string(opusErr) + "）";
        return false;
    }

    const int kMaxFrame = 5760; // 120ms @ 48kHz，单个 Opus 包的上限
    std::vector<float> pcm;
    pcm.reserve(48000 * channels); // 先给一秒的余量，避免反复扩容
    std::vector<uint8_t> pkt;
    std::vector<float> tmp((size_t)kMaxFrame * channels);

    while (reader.nextPacket(pkt)) {
        if (pkt.size() >= 8 &&
            (std::memcmp(pkt.data(), "OpusHead", 8) == 0 ||
             std::memcmp(pkt.data(), "OpusTags", 8) == 0)) {
            continue; // 元数据包混进中间流：跳过
        }
        const int frame = opus_decode_float(dec, pkt.data(), (opus_int32)pkt.size(), tmp.data(),
                                            kMaxFrame, 0);
        if (frame < 0) continue; // 坏包：跳过不中断
        pcm.insert(pcm.end(), tmp.data(), tmp.data() + (size_t)frame * channels);
    }
    opus_decoder_destroy(dec);

    // 按granule对齐输出长度：先跳过 pre-skip，再裁掉 granule 之外的尾部
    const int64_t granule = reader.maxGranule();
    size_t start = (size_t)(preSkip > 0 ? preSkip : 0) * channels;
    if (start > pcm.size()) start = pcm.size();
    size_t count = pcm.size() - start;
    if (granule > 0) {
        const int64_t wanted = (granule - preSkip) * channels;
        if (wanted >= 0 && (size_t)wanted < count) count = (size_t)wanted;
    }
    if (count == 0) {
        err = "Opus 流里没有音频数据";
        return false;
    }

    out.pcm.assign(pcm.begin() + (long)start, pcm.begin() + (long)(start + count));
    out.channels = channels;
    out.sample_rate = 48000;
    return true;
#else
    (void)data;
    (void)size;
    (void)out;
    err = "此版本引擎未编译 Opus 解码器";
    return false;
#endif
}

} // namespace xdec
