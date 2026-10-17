# 第三方组件与许可

本软件（XBAOS 字幕生成器）的全部**内置**功能均基于**免费、开源、可商用**的组件构建。
可选的大模型辅助能力（AI 校对、AI 翻译）不属于内置组件：它经系统剪贴板把提示词交给使用者，
由使用者自行粘贴到所选的第三方在线服务，本软件不代使用者发起请求、也不接收结果以外的数据。
本文件列出随产物分发的组件，以及仅在构建阶段使用、不进入产物的工具。

最后核对日期：2026-10-14

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
| whisper.cpp | 1.9.4 | MIT | The ggml authors | 语音识别推理 |
| ggml | 随 whisper.cpp | MIT | The ggml authors | 张量计算与 CPU/Vulkan 后端 |
| dr_mp3 | 0.7.4 | MIT-0 / Unlicense | Mackie Lab（dr_libs） | MP3 音频解码 |
| dr_flac | 0.13.4 | MIT-0 / Unlicense | Mackie Lab（dr_libs） | FLAC 音频解码 |
| stb_vorbis | 1.22 | MIT / Unlicense | Sean Barrett（stb） | OGG Vorbis 音频解码 |
| libopus | 1.5.2 | BSD-3-Clause | Xiph.Org 基金会 | Opus 音频解码 |
| FFmpeg | non-proprietary 构建 | LGPL-2.1-or-later | the FFmpeg developers | 音视频容器解析（`ffmpeg.dll`，Electron 随包） |

**关于 Electron 自带的 ffmpeg**：Electron 默认分发的 `ffmpeg.dll` 含 H.264 / AAC 等
专有编解码器。本项目在打包时通过 `downloadAlternateFFmpeg: true` 将其替换为
**不含专有编解码器的开源构建**（上表最后一行的 non-proprietary 版本）。该构建以
**独立 `ffmpeg.dll`** 的形式分发，使用者可以自行替换，符合 LGPL 对动态链接的要求；
许可证全文见 `FFmpeg.LICENSE.txt`。

**识别引擎的运行库**：`xbaos-engine.exe` 使用 MSVC `/MT` 静态链接 C 运行时，
不依赖 `vcruntime140.dll` / `msvcp140.dll` 等微软运行时，也不依赖任何第三方 DLL。

**关于语音识别模型**：模型文件（`ggml-*.bin`）**不随本安装包分发**，由使用者自行
下载或放入模型文件夹。版权归各自权利人所有，**不属于本软件的权利范围**。

各模型的许可由各自权利人单独确定，并非统一一种：

- **Whisper 官方权重**（`ggerganov/whisper.cpp` 分发的 ggml 格式，原始模型源自 OpenAI）
  —— **MIT**。
- **Belle-whisper-large-v3-turbo-zh**（BELLE-2 组织发布的中文微调版）
  —— **Apache License 2.0**，再分发或修改需保留版权与许可声明、并说明所做的修改。

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
