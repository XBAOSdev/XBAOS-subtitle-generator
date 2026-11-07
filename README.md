# 小包听幕

把音频转成字幕的 Windows 桌面软件。识别引擎同时支持 **whisper.cpp（GGML）** 与
**sherpa-onnx（ONNX Runtime）** 两套架构，可换用 Whisper 系列、Belle 中文微调版与
SenseVoice 等多种模型，用哪个由你决定。**解码、识别、编辑、导出全部在本机完成，音频与字幕不上传。**

官网 <https://subtitle.xbaos.com.cn>　主站 <https://www.xbaos.com.cn>

---

## 特性

- **核心链路本地完成**：解码、识别、编辑、合并、导出都在本机跑，音频与字幕不会离开你的电脑
- **两套识别引擎**：whisper.cpp 与 sherpa-onnx 各自独立进程，按所选模型的架构自动选用；
  Whisper 侧支持 CPU 与 Vulkan GPU 两个后端
- **剪辑式时间轴**：在波形轨道上直接拖动字幕块，边界可拉伸，同时重叠最多 5 条泳道
- **批量与合并**：多文件批量识别，也可把多个音频合并成一条连续时间轴
- **多语言字幕**：译文内嵌第二行，三态视图切换；可导出纯原文、双语、纯译文，或按语言分别导出
- **AI 校对与 AI 翻译**（可选）：软件不代你发起请求，只把提示词写进系统剪贴板，由你粘贴给自己选的第三方在线 AI 服务
- **免费可商用**：不含任何需要单独授权或付费的组件，不含专有编解码器
- **模型单独获取**：识别模型不随安装包分发，首次使用前下载一个，或把已有的模型放进模型文件夹
- **热词本地纠正**：识别完成后按全量热词做保守的同音纠正，等长、带声调同音才改；不依赖模型是否支持提示词
- **讲话人分离**（可选，默认关闭）：识别后按音色标注「谁在什么时候说话」，逐条给出发言人；
  可改称呼、把两位并成一位，导出时按格式带上标签（ASS 用 Name 列、VTT 用语音标签）；
  两个声纹模型随包分发，不联网下载，与两套识别引擎都能配合

## 下载

Windows 安装包见官网：<https://subtitle.xbaos.com.cn>

版本变更记录见[更新日志](https://subtitle.xbaos.com.cn/changelog.html)。

安装包**不含**识别模型。首次启动时软件会直接把你带到模型管理页：在那里下载一个
（几档可选，最小的约 140 MB），或者把已有的模型放进模型文件夹。模型有两种形态，
软件按目录内容自动判定该用哪套引擎：

| 形态 | 放置方式 | 判定依据 |
|---|---|---|
| 单文件（GGML） | `models/ggml-*.bin` | 文件本身 |
| 目录（ONNX） | `models/<任意名字>/` | 目录内同时有 `model.int8.onnx`（或 `model.onnx`）与 `tokens.txt`，且 `tokens.txt` 里能找到 SenseVoice 的词表标记 |

文件名不限，改过名的模型也能被认出来。

内置模型从公开的模型平台下载，按顺序尝试 **ModelScope → hf-mirror → huggingface.co**，
前一个拿不到才换下一个；每个文件带 SHA-256 校验，内容与清单不符会当场拒收。
模型文件是第三方内容，**不属于本软件的一部分**：它们由各自发布者提供，权利与许可归原权利人
（模型管理页逐条标注），本软件只负责下载、校验与调用，不重新分发、不修改模型内容，
也不对第三方站点的可用性与内容负责。

## 系统要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（64 位） |
| 显卡 | 无要求。支持 Vulkan 的显卡会自动走 GPU，否则用 CPU |
| 磁盘 | 安装后约 415 MB。识别模型需另行获取（约 140 MB ~ 1.6 GB，取决于所选档位） |
| 权限 | 不需要管理员权限，安装到用户目录即可 |

毛玻璃标题栏需要 Windows 11 22H2 及以上，其余环境自动退回纯色。

## 隐私

核心链路 —— 音频解码、语音识别、字幕编辑、导出 —— 全部在本机完成。
**音频、字幕与工程内容不会上传到任何服务器**，软件也不包含统计与埋点组件。

软件会联网的地方**只有两处，而且都不影响核心功能**：

1. **检查更新**：启动时读取一份几 KB 的版本清单（由官网 `subtitle.xbaos.com.cn` 托管）。
   **默认开启**，可在设置页关闭
2. **下载模型**：只有你主动到模型管理页点下载时，才会访问模型仓库

除此之外，本软件不会发起任何网络请求。关掉自动检查、模型就位之后，可以完全离线使用。

**AI 校对与 AI 翻译**是可选功能，它本身不访问任何网络接口：软件只把提示词写进系统剪贴板，
由你自己粘贴到所选的第三方在线 AI 服务，再把结果读回来。
需要留意的是，**从你把内容粘贴进那个服务起，内容就已经离开本机**，
之后的处理适用该服务自己的用户协议与隐私政策 —— 涉及他人隐私、商业秘密或未公开信息的内容，请谨慎粘贴。

## 支持的格式

**读入音频**

| 格式 | 解码实现 |
|---|---|
| WAV / AIFF | dr_wav |
| MP3 | dr_mp3 |
| FLAC | dr_flac |
| OGG Vorbis | stb_vorbis |
| Opus | libopus |

**字幕**：可读入 SRT / WebVTT / ASS / SSA，可导出 SRT / WebVTT / ASS。

**明确不支持的音频格式**，原因分两类，性质不同，不要混为一谈：

| 格式 | 原因 |
|---|---|
| M4A / AAC / MP4 | 编码涉及的**部分专利仍在保护期内** |
| WMA | 微软专有编解码器 |
| AMR / AMR-WB | 包含多项专利的语音编码标准 |
| DTS | 专有技术，专利保护期可能持续到 2040 年前后 |
| AC-3 / E-AC-3 | **专利已到期**（AC-3 为 2017 年，E-AC-3 为 2026 年初），**不存在法律障碍**，只是本软件尚未内置对应解码器 |

最后一行是刻意单列的：它和上面几行不是一回事，不是不能做，是还没做。

---

## 从源码构建

### 环境

- **Node.js 22 或以上**
- 构建识别引擎还需要：Visual Studio 2022 Build Tools（含 C++ 桌面开发）、CMake、Ninja、Vulkan SDK

> PowerShell 下如果提示「禁止运行脚本」，是默认执行策略 `Restricted` 拦掉了 `npm.ps1`，与 npm 本身无关。
> 可以只对当前用户放开（不需要管理员），或者用 `npm.cmd run ...` 绕开：
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```

### 步骤

```bash
git clone <仓库地址>
cd subtitle_generator

# 1. 安装前端依赖（只需一次）
npm install

# 2. 获取引擎的第三方源码（只需一次）
bash engine/fetch-deps.sh        # whisper.cpp
# sherpa-onnx 源码放到 engine/third_party/sherpa-onnx/

# 3. 编译识别引擎（只需一次，改了 C++ 才需要重跑）
bash engine/build.sh vulkan      # GGML 引擎，纯 CPU 环境用 bash engine/build.sh cpu
bash engine-onnx/build.sh        # ONNX 引擎

# 4. 启动
npm run dev
```

`npm run dev` 会先自检引擎与模型是否到位并打印结果，然后依次拉起 Vite 和 Electron。
关掉软件窗口即等于退出，不会残留后台进程。

两套引擎都需要若干第三方源码/预编译库。它们体积大（onnxruntime 的静态库单个就有 103 MB）
且属于构建输入，不入库。ONNX 引擎的依赖包必须**预置**在 `engine-onnx/` 下，构建过程不联网；
包名与哈希由 `engine-onnx/CMakeLists.txt` 引用的各个 `.cmake` 声明，
`node tools/fetch-deps.mjs` 可扫描缺失项并从 codeload 补齐。

模型文件不入库。从源码运行时，把模型放进 `models/` 目录（GGML 单文件或 ONNX 目录均可），
或启动后在模型管理页下载。

### 常用命令

```bash
# 开发
npm run dev           # Vite + Electron，跑真实桌面应用
npm run dev:ui        # 只起浏览器预览，改样式毫秒级热更新（UI 开发主力）
npm run dev:stop      # 清理占用开发端口的残留 node 进程
npm run build:ui      # 构建前端产物到 dist/

# 引擎
npm run engine              # 编译 GGML 引擎（CPU 版）
bash engine/build.sh vulkan # 编译 GGML 引擎（Vulkan GPU 版）
npm run engine:onnx         # 编译 ONNX 引擎

# 验证
npm run typecheck     # 类型检查
npm run unit          # 纯函数与算法语义自检（源码扫描守门）
npm run probe         # UI 探针：真实点击 + 断言 + 截图（需先 npm run dev:ui）
npm run probe:electron # Electron 端到端探针（界面 + preload 桥 + 引擎）

# 打包
npm run dist:dir      # 只生成解包目录，快，用于验证
npm run dist          # 生成 NSIS 安装程序
```

### 预览参数（仅开发模式生效）

| 参数 | 作用 |
|---|---|
| `?demo=1` | 载入演示数据，界面立刻有内容 |
| `?view=editor` | 直接进入指定页面：home / editor / models / settings / about |
| `?theme=light` | 强制主题，值为 `light` 或 `dark`（不带则跟随系统） |

```
http://127.0.0.1:5173/?demo=1&view=editor&theme=dark
```

---

## 项目结构

```
src/
├── branding.ts            产品名、官网、版本（改名只需改这里）
├── App.vue                应用外壳：标题栏 + 侧栏 + 状态条 + 全局弹窗
├── views/                 五个页面（导入 / 编辑 / 模型 / 设置 / 关于）
├── components/            可复用组件（字幕表格、波形、播放器、时间码、弹窗等）
├── stores/                Pinia 状态
├── composables/           组合式函数
├── utils/                 纯函数工具（时间码、格式、标点与繁简后处理、字幕序列化、折行）
├── locales/               文案
└── styles/                设计令牌与深浅色主题
```

```
electron/                  主进程、preload、引擎客户端、模型清单与架构探测
engine/                    GGML 识别引擎（C++，独立进程）
engine-onnx/               ONNX 识别引擎（C++，独立进程）
licenses/                  随包分发的开源许可原文与清单
models/                    模型文件（不入库）
tools/                     开发与验证脚本（不进产物）
```

## 技术栈

| 层 | 技术 | 许可证 |
|---|---|---|
| 桌面壳 | Electron | MIT |
| 前端 | Vue 3 + TypeScript + Vite | MIT / Apache-2.0 |
| 状态管理 | Pinia | MIT |
| 样式 | 手写 CSS + CSS 变量 | 无第三方依赖 |
| 推理引擎 A | whisper.cpp（GGML，CPU 与 Vulkan 两个后端） | MIT |
| 推理引擎 B | sherpa-onnx（ONNX Runtime） | Apache-2.0 |
| 推理框架 | ONNX Runtime | MIT |
| 音频解码 | dr_libs / stb_vorbis / libopus | MIT-0 / Unlicense / BSD-3-Clause |
| 字体 | 思源黑体（Noto Sans SC 子集，内嵌） | SIL OFL 1.1 |

两套引擎都使用 MSVC `/MT` 静态链接 C 运行时与全部依赖，不依赖任何外部 DLL。

界面字体内嵌了**思源黑体（Noto Sans SC）**的子集，随安装包分发，不依赖电脑上装没装 ——
此前只声明系统回退栈，而 Windows 默认没有思源黑体，多数机器上实际显示的是微软雅黑，
同一行字幕在不同电脑上宽度不同。子集覆盖常用汉字（U+4E00–9FFF）、拉丁、假名与全角标点，
保留变量字重 100–900，子集之外的生僻字按回退栈逐字降级到系统字体。
界面图标一律为内联 SVG，不使用 emoji。

## 许可

源代码依 **Apache License 2.0** 授权，全文见 [LICENSE](./LICENSE)。

品牌名称与标志、应用图标与安装器美术资源、项目文档
**不属于**源代码，不在 Apache License 2.0 的授权范围内，权利归 XBAOS 所有。
详见 [NOTICE](./NOTICE)。基于本仓库源代码构建衍生版本时，请替换上述品牌标识与美术资源。

识别模型由使用者自行获取，版权归其各自权利人所有，不在本软件的授权范围内。
各模型的许可由各自权利人单独确定，并非统一一种：

| 模型 | 形态 | 许可证 |
|---|---|---|
| Whisper 官方权重（原始模型源自 OpenAI） | GGML 单文件 | MIT |
| Belle-whisper-large-v3-turbo-zh（BELLE-2 中文微调版） | GGML 单文件 | Apache-2.0 |
| SenseVoice-Small（阿里巴巴通义实验室） | ONNX 目录 | FunASR Model License 1.1 |

SenseVoice 的许可允许免费商用，但**要求署名并保留模型名称**。三种许可的原文与
各自的义务说明见 [licenses/THIRD-PARTY.md](./licenses/THIRD-PARTY.md)。

第三方组件的许可原文在 [licenses/](./licenses) 目录，清单见 [licenses/THIRD-PARTY.md](./licenses/THIRD-PARTY.md)。

---

© 2026 XBAOS
