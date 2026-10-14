// 多格式音频解码 —— 统一入口声明。
//
// 全部解码器都吃「已经在内存里的字节」（main 侧先 readFile 进内存再调用），
// 不用任何「按文件名打开」的接口 —— 这是中文路径正确性的硬性前提，
// 详见 platform.hpp 顶部的实测记录。
//
// 解码器与许可证（均可免费商用，见仓库 licenses/ 目录）：
//   MP3        dr_mp3    (mackron/dr_libs)   公有领域 / MIT-0
//   FLAC       dr_flac   (mackron/dr_libs)   公有领域 / MIT-0
//   Ogg Vorbis stb_vorbis (nothings/stb)     公有领域 / MIT
//   Opus       libopus   (xiph)              BSD-3-Clause

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace xdec {

struct DecodedAudio {
    // 交错的原始采样（未重采样、未混音），取值范围 -1..1
    std::vector<float> pcm;
    int channels = 0;
    int sample_rate = 0;
};

bool decodeMp3(const uint8_t *data, size_t size, DecodedAudio &out, std::string &err);
bool decodeFlac(const uint8_t *data, size_t size, DecodedAudio &out, std::string &err);
bool decodeVorbis(const uint8_t *data, size_t size, DecodedAudio &out, std::string &err);

/** 探测一个 Ogg 流是不是 Opus（看首包是否为 OpusHead） */
bool isOggOpus(const uint8_t *data, size_t size);
bool decodeOggOpus(const uint8_t *data, size_t size, DecodedAudio &out, std::string &err);

} // namespace xdec
