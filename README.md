# XBAOS 字幕生成器

把音频转成字幕的 Windows 桌面软件。**识别、编辑、导出全程在本机完成，音频不上传。**

官网 <https://subtitle.xbaos.com.cn>　主站 <https://www.xbaos.com.cn>

---

## 特性

- **全程本地**：识别、编辑、导出、合并都在本机完成，音频与文本不出本机
- **自带识别引擎**：whisper.cpp 独立进程，CPU 与 Vulkan GPU 两个后端自动选择
- **剪辑式时间轴**：在波形轨道上直接拖动字幕块，边界可拉伸，同时重叠最多 5 条泳道
- **批量与合并**：多文件批量识别，也可把多个音频合并成一条连续时间轴
- **多语言字幕**：译文内嵌第二行，三态视图切换；可导出纯原文、双语、纯译文，或按语言分别导出
- **AI 校对与 AI 翻译**（可选）：经剪贴板中转，交给你自己选的外部大模型，软件本身不联网
- **免费可商用**：不含任何需要单独授权或付费的组件，不含专有编解码器
- **模型单独获取**：识别模型不随安装包分发，首次使用前下载一个，或把已有的模型文件放进模型文件夹

## 下载

Windows 安装包见官网：<https://subtitle.xbaos.com.cn>

版本变更记录见[更新日志](https://subtitle.xbaos.com.cn/changelog.html)。

安装包**不含**识别模型。首次启动时软件会直接把你带到模型管理页：在那里下载一个
（几档可选，最小的约 140 MB），或者把已有的 ggml 格式模型文件放进模型文件夹 ——
**文件名不限**，软件按目录内容自动识别可用模型。

## 系统要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（64 位） |
| 显卡 | 无要求。支持 Vulkan 的显卡会自动走 GPU，否则用 CPU |
| 磁盘 | 安装后约 380 MB。识别模型需另行获取（约 140 MB ~ 1.6 GB，取决于所选档位） |
| 权限 | 不需要管理员权限，安装到用户目录即可 |

毛玻璃标题栏需要 Windows 11 22H2 及以上，其余环境自动退回纯色。

## 隐私

软件联网**只有两处，而且都可以不用**：

1. **检查更新**：启动时读一份几 KB 的版本清单（由官网 `subtitle.xbaos.com.cn` 托管），可在设置页关闭
2. **下载模型**：只有你主动到模型管理页点下载时，才会访问模型仓库

识别、编辑、导出全程不联网。AI 校对与 AI 翻译也**不访问任何网络接口**：它把提示词放进系统剪贴板，由你粘贴给外部大模型，再从剪贴板读回结果。

音频文件、识别结果、工程内容都不会上传到任何服务器。

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

# 2. 拉取引擎的第三方源码，如 whisper.cpp（只需一次）
bash engine/fetch-deps.sh

# 3. 编译识别引擎（只需一次，改了 C++ 才需要重跑）
bash engine/build.sh vulkan    # 纯 CPU 环境用 bash engine/build.sh cpu

# 4. 启动
npm run dev
```

`npm run dev` 会先自检引擎与模型是否到位并打印结果，然后依次拉起 Vite 和 Electron。
关掉软件窗口即等于退出，不会残留后台进程。

模型文件不入库。从源码运行时，把模型放进 `models/` 目录（例如 `ggml-small.bin`），
或启动后在模型管理页下载。

### 常用命令

```bash
# 开发
npm run dev           # Vite + Electron，跑真实桌面应用
npm run dev:ui        # 只起浏览器预览，改样式毫秒级热更新（UI 开发主力）
npm run dev:stop      # 清理占用开发端口的残留 node 进程
npm run build:ui      # 构建前端产物到 dist/

# 引擎
npm run engine              # 编译 CPU 版引擎
bash engine/build.sh vulkan # 编译 Vulkan GPU 版

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
electron/                  主进程、preload、引擎客户端、路径解析
engine/                    识别引擎（C++，独立进程，见 engine/README.md）
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
| 推理引擎 | whisper.cpp（独立进程） | MIT |
| 音频解码 | dr_libs / stb_vorbis / libopus | MIT-0 / Unlicense / BSD-3-Clause |

识别引擎使用 MSVC `/MT` 静态链接 C 运行时，不依赖任何外部 DLL。

文本字体走系统回退栈（思源黑体 / 苹方 / 微软雅黑），**不嵌入字体文件**。
界面图标一律为内联 SVG，不使用 emoji。

## 许可

源代码依 **Apache License 2.0** 授权，全文见 [LICENSE](./LICENSE)。

品牌名称与标志、应用图标与安装器美术资源、项目文档
**不属于**源代码，不在 Apache License 2.0 的授权范围内，权利归 XBAOS 所有。
详见 [NOTICE](./NOTICE)。基于本仓库源代码构建衍生版本时，请替换上述品牌标识与美术资源。

识别模型由使用者自行获取（来自 `ggerganov/whisper.cpp` 的 ggml 格式权重，MIT 许可），
版权归其各自权利人所有，也不在本软件的授权范围内。

第三方组件的许可原文在 [licenses/](./licenses) 目录，清单见 [licenses/THIRD-PARTY.md](./licenses/THIRD-PARTY.md)。

---

© 2026 XBAOS
