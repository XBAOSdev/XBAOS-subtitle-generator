// MP3 / FLAC / Ogg Vorbis 的单头解码器实现。
//
// 实现宏必须只在这一个翻译单元里定义，否则会重复定义符号。
// stb_vorbis.c 直接包含进来（它本身就是实现文件），关闭 stdio 与
// pushdata 接口：我们只从内存读取，裁掉这两块能减少出错面。

#define DR_MP3_IMPLEMENTATION
#define DR_FLAC_IMPLEMENTATION
#define STB_VORBIS_NO_STDIO
#define STB_VORBIS_NO_PUSHDATA_API
#define STB_VORBIS_MAX_CHANNELS 16
#define _CRT_SECURE_NO_WARNINGS

#include "dr_mp3.h"
#include "dr_flac.h"
#include "stb_vorbis.c"

#include "decoders.hpp"

namespace xdec {

bool decodeMp3(const uint8_t *data, size_t size, DecodedAudio &out, std::string &err) {
    drmp3_config config = {};
    drmp3_uint64 frames = 0;
    // 输出通道数/采样率传 0：按源文件原生值输出，不做重采样
    float *pcm = drmp3_open_memory_and_read_pcm_frames_f32(data, size, &config, &frames, nullptr);
    if (!pcm || frames == 0 || config.channels == 0) {
        drmp3_free(pcm, nullptr);
        err = "MP3 解码失败（文件损坏或不是有效的 MP3）";
        return false;
    }
    out.pcm.assign(pcm, pcm + (size_t)frames * config.channels);
    drmp3_free(pcm, nullptr);
    out.channels = (int)config.channels;
    out.sample_rate = (int)config.sampleRate;
    return true;
}

bool decodeFlac(const uint8_t *data, size_t size, DecodedAudio &out, std::string &err) {
    unsigned int channels = 0;
    unsigned int sample_rate = 0;
    drflac_uint64 frames = 0;
    float *pcm = drflac_open_memory_and_read_pcm_frames_f32(data, size, &channels, &sample_rate,
                                                            &frames, nullptr);
    if (!pcm || frames == 0 || channels == 0) {
        drflac_free(pcm, nullptr);
        err = "FLAC 解码失败（文件损坏或不是有效的 FLAC）";
        return false;
    }
    out.pcm.assign(pcm, pcm + (size_t)frames * channels);
    drflac_free(pcm, nullptr);
    out.channels = (int)channels;
    out.sample_rate = (int)sample_rate;
    return true;
}

bool decodeVorbis(const uint8_t *data, size_t size, DecodedAudio &out, std::string &err) {
    int error = 0;
    stb_vorbis *v = stb_vorbis_open_memory(data, (long)size, &error, nullptr);
    if (!v) {
        err = "OGG Vorbis 解码失败（错误码 " + std::to_string(error) + "）";
        return false;
    }

    stb_vorbis_info info = stb_vorbis_get_info(v);
    out.channels = (int)info.channels;
    out.sample_rate = (int)info.sample_rate;

    bool ok = true;
    int channels = 0;
    float **outputs = nullptr;
    long frames = 0;
    while ((frames = stb_vorbis_get_frame_float(v, &channels, &outputs)) > 0) {
        if (channels != (int)info.channels || !outputs[0]) {
            ok = false;
            break;
        }
        out.pcm.insert(out.pcm.end(), outputs[0], outputs[0] + (size_t)frames * channels);
    }
    stb_vorbis_close(v);

    if (!ok || out.pcm.empty() || out.channels == 0) {
        err = "OGG Vorbis 解码失败（文件损坏或不是有效的 Vorbis 流）";
        return false;
    }
    return true;
}

} // namespace xdec
