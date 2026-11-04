# 第三方组件与许可

本软件（XBAOS 字幕生成器）的全部**内置**功能均基于**免费、开源、可商用**的组件构建。
可选的大模型辅助能力（AI 校对、AI 翻译）不属于内置组件：它经系统剪贴板把提示词交给使用者，
由使用者自行粘贴到所选的第三方在线服务，本软件不代使用者发起请求、也不接收结果以外的数据。
本文件列出随产物分发的组件，以及仅在构建阶段使用、不进入产物的工具。

最后核对日期：2026-11-04

## 一、随产物分发

这些组件会进入安装包，也是使用者实际会运行到的部分。
对应的完整许可证原文见本目录下的 `*.LICENSE.txt`。

| 组件 | 版本 | 许可证 | 版权方 | 用途 |
|---|---|---|---|---|
| Electron | 44.5.1 | MIT | OpenJS Foundation 与 Electron 贡献者 | 桌面应用外壳 |
| Chromium | 随 Electron | BSD-3-Clause 及若干兼容许可 | The Chromium Authors | 界面渲染引擎 |
| Node.js | 随 Electron | MIT | OpenJS Foundation | 主进程运行时 |
| Vue | 3.5.x | MIT | Evan You | 界面框架 |
| Pinia | 4.x | MIT | Eduardo San Martin Morote | 状态管理 |
| whisper.cpp | 1.9.4 | MIT | The ggml authors | 语音识别推理（GGML 引擎） |
| ggml | 随 whisper.cpp | MIT | The ggml authors | 张量计算与 CPU/Vulkan 后端 |
| sherpa-onnx | 2.0.1 | Apache-2.0 | k2-fsa（Next-gen Kaldi 社区） | 语音识别推理（ONNX 引擎） |
| ONNX Runtime | 1.28.2 | MIT | Microsoft Corporation | ONNX 模型的执行框架 |
| kaldi-native-fbank | 1.22.4 | Apache-2.0 | k2-fsa | 音频特征提取（fbank） |
| kaldi-decoder | 0.3.0 | Apache-2.0 | k2-fsa | 解码器基础结构 |
| kaldifst | 1.8.0 | Apache-2.0 | k2-fsa | 有限状态转换器 |
| OpenFst | 1.8.5 | Apache-2.0 | OpenFst 贡献者 | 加权有限状态转换器 |
| Eigen | 5.0.1 | MPL-2.0 | Eigen 项目贡献者 | 线性代数（仅头文件） |
| kissfft | 2021 快照 | BSD-3-Clause | Mark Borgerding | 快速傅里叶变换 |
| utf8proc | 2.12.0 | MIT | JuliaStrings 与贡献者 | Unicode 规范化 |
| simple-sentencepiece | 0.7 | Apache-2.0 | k2-fsa | 分词 |
| hclust-cpp（fastcluster） | 2026-02-25 | BSD-2-Clause | Daniel Müllner、Christoph Dalitz | 说话人分层聚类 |
| nlohmann/json | 3.12.0 | MIT | Niels Lohmann | JSON 解析 |
| dr_mp3 | 0.7.4 | MIT-0 / Unlicense | Mackie Lab（dr_libs） | MP3 音频解码 |
| dr_flac | 0.13.4 | MIT-0 / Unlicense | Mackie Lab（dr_libs） | FLAC 音频解码 |
| stb_vorbis | 1.22 | MIT / Unlicense | Sean Barrett（stb） | OGG Vorbis 音频解码 |
| libopus | 1.5.2 | BSD-3-Clause | Xiph.Org 基金会 | Opus 音频解码 |
| FFmpeg | non-proprietary 构建 | LGPL-2.1-or-later | the FFmpeg developers | 音视频容器解析（`ffmpeg.dll`，Electron 随包） |

### 随包分发的模型权重

下面两个模型不是代码组件，而是**模型权重**，和识别模型一样由各自的发布者提供、
权利归原权利人。它们体积小（合计 33 MB）且与识别模型无关，所以随安装包分发，
用户不需要另外下载：

| 文件 | 来源 | 许可证 | 版权方 | 用途 |
|---|---|---|---|---|
| `resources/diarization/segmentation.onnx` | sherpa-onnx 由 [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) 转换 | MIT | CNRS | 说话人切分（谁在什么时候说话） |
| `resources/diarization/speaker-embedding.onnx` | [3D-Speaker](https://github.com/modelscope/3D-Speaker) CAM++ 中文版，经 sherpa-onnx 导出 | Apache-2.0 | 阿里巴巴通义实验室 | 声纹嵌入（判断两段是不是同一人） |

许可证原文见 `pyannote.LICENSE.txt` 与 `Apache-2.0.LICENSE.txt`。

### 随包分发的字体

界面正文字体随安装包分发，**不依赖使用者机器上装没装**。Windows 默认不带思源黑体，
不内嵌的话字体栈在绝大多数机器上一路落到微软雅黑 —— 同一行字幕在不同电脑上字宽不同，
排版校验的「显示宽度」也就跟着不准。

| 文件 | 来源 | 许可证 | 版权方 | 用途 |
|---|---|---|---|---|
| `assets/noto-sans-sc-subset-*.woff2` | Noto Sans SC 2.04（与 Adobe 思源黑体 Source Han Sans 同一套设计，两个发行名），按常用字集裁剪 | SIL Open Font License 1.1 | Adobe | 界面正文与字幕预览 |

裁剪范围：U+4E00–9FFF 常用汉字、拉丁与拉丁补充、常用标点与数学符号、假名、全角形式，
保留 `wght` 变量轴（100–900），因此 400 / 500 / 600 三档字重共用同一个文件（5.5 MB）。
子集之外的生僻字（CJK 扩展 A/B 等）按字体栈逐字回退到系统字体，不影响整行。
裁剪属于 OFL 定义的「修改版本」，未改动字形设计；许可证全文见 `Open-Font-License-1.1.txt`。



**关于 Electron 自带的 ffmpeg**：Electron 默认分发的 `ffmpeg.dll` 含 H.264 / AAC 等
专有编解码器。本项目在打包时通过 `downloadAlternateFFmpeg: true` 将其替换为
**不含专有编解码器的开源构建**（上表最后一行的 non-proprietary 版本）。该构建以
**独立 `ffmpeg.dll`** 的形式分发，使用者可以自行替换，符合 LGPL 对动态链接的要求；
许可证全文见 `FFmpeg.LICENSE.txt`。

**识别引擎的运行库**：两个引擎（`xbaos-engine.exe` 与 `xbaos-engine-asr.exe`）都使用
MSVC `/MT` 静态链接 C 运行时与各自全部第三方依赖，不依赖 `vcruntime140.dll` /
`msvcp140.dll` 等微软运行时，也不依赖任何第三方 DLL（onnxruntime 亦为静态库版本）。

**许可原文的文件对应关系**：`sherpa-onnx`、`kaldi-native-fbank`、`kaldi-decoder`、
`kaldifst`、`OpenFst`、`simple-sentencepiece` 六项均采用 Apache License 2.0，
共用本目录下的 `Apache-2.0.LICENSE.txt`；其余各项各有同名文件
（`eigen.LICENSE.txt`、`kissfft.LICENSE.txt`、`utf8proc.LICENSE.txt`、
`nlohmann-json.LICENSE.txt`、`onnxruntime.LICENSE.txt` 等）。

**关于语音识别模型**：模型文件（`ggml-*.bin` 或 ONNX 模型目录）**不随本安装包分发**，
由使用者自行下载或放入模型文件夹。版权归各自权利人所有，**不属于本软件的权利范围**。

各模型的许可由各自权利人单独确定，并非统一一种：

- **Whisper 官方权重**（`ggerganov/whisper.cpp` 分发的 ggml 格式，原始模型源自 OpenAI）
  —— **MIT**。
- **Belle-whisper-large-v3-turbo-zh**（BELLE-2 组织发布的中文微调版）
  —— **Apache License 2.0**，再分发或修改需保留版权与许可声明、并说明所做的修改。
- **SenseVoice-Small**（阿里巴巴通义实验室发布，随 `FunAudioLLM/SenseVoiceSmall` 分发）
  —— **FunASR Model Open Source License Agreement 1.1**。该许可允许免费商用，
  但**要求署名并保留模型名称**；本软件在模型管理页与「许可与合规声明」中列明该模型的
  名称、发行者与协议，以满足署名要求。再分发该模型时请一并保留这些信息与该许可原文。

使用或再分发某个模型前，请以该模型随附的许可条款为准。

## 二、仅构建阶段使用，不进入产物

这些工具只在开发者机器上参与编译，使用者下载到的安装包里不包含它们。

| 工具 | 许可证 | 用途 |
|---|---|---|
| Vulkan-Headers | Apache-2.0 | 引擎编译期的 Vulkan 接口定义。运行时由显卡驱动提供 `vulkan-1.dll`，不随包分发 |
| Vite | MIT | 前端构建 |
| TypeScript | Apache-2.0 | 类型检查 |
| vue-tsc | MIT | Vue 单文件组件类型检查 |
| electron-builder | MIT | 打包为安装程序 |
| CMake | BSD-3-Clause | 引擎构建配置 |
| Ninja | Apache-2.0 | 引擎构建执行 |
| MSVC Build Tools | Microsoft 商业许可（免费用于本用途） | C++ 编译 |
| Windows SDK | Microsoft 商业许可（免费用于本用途） | 系统头文件与资源编译 |
| Vulkan SDK（含 glslc） | Apache-2.0 / MIT | 着色器编译 |

## 三、明确不使用的组件

| 组件 | 原因 |
|---|---|
| FFmpeg（含专有编解码器的版本） | 相关编解码器受专利约束，许可情况复杂 |
| AAC / M4A 解码器（如 fdk-aac） | AAC 专利池虽已进入衰退期，但部分专利保护期延续至约 2029 年，风险无法完全排除 |
| 任何商业语音识别 SDK | 不可免费商用；其中一部分还要求把音频上传到厂商服务器 |
| 任何联网 API | 需由本软件代使用者把内容发往第三方服务器，并承担密钥保管、按量计费与内容合规责任 |

上表的取舍标准是两条：**许可必须免费可商用**；**不由本软件代使用者把内容送往外部服务器**。
软件本身不包含任何需要单独付费或申请授权的组件。

---

© 2026 XBAOS | https://www.xbaos.com.cn/
