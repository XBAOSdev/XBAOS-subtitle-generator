# xbaos-engine —— 识别引擎

XBAOS 字幕生成器的语音识别核心。是一个独立的可执行文件，通过标准输入输出
与主进程通信。

## 为什么做成独立进程

不是随手的设计，而是为了绕开 Electron 原生模块的两个硬伤：

1. **零外部运行时依赖**。引擎用 `/MT` 静态链接 C 运行时。如果做成原生模块，
   Electron 主进程和模块会共享同一个 C 运行时 —— 用 `/MT` 会变成两套运行时实例，
   跨边界释放内存直接崩；用 `/MD` 又要依赖 `vcruntime140.dll`。
   做成独立进程后 `/MT` 完全安全，发布包里一个微软 DLL 都不带。

2. **模型只加载一次**。模型常驻在引擎进程里，多次识别不用重新加载
   （small 模型加载约 0.5 秒，大模型更久）。

顺带的好处：引擎崩溃只影响自己，主进程能感知并重启；以后加 Vulkan 后端
只需要重编引擎，主进程和前端一行都不用改。

## 通信协议

行分隔的 JSON。每读一行请求，写回若干行响应。stdout 只用于协议，
日志全部走 stderr。

### 请求

```jsonc
{"id": 1, "cmd": "ping"}

{"id": 2, "cmd": "load", "model": "C:\\models\\ggml-small.bin", "backend": "auto"}
// backend: auto（默认）| cpu | vulkan

{"id": 3, "cmd": "transcribe",
 "audio": "C:\\temp\\a.wav",     // 必须是 16kHz 单声道 WAV
 "language": "zh",                // "auto" 表示自动检测
 "prompt": "神经网络 深度学习",     // 热词提示，能明显提升专有名词准确率
 "threads": 8,                    // 省略则自动取 min(核数, 8)，见下方说明
 "translate": false}              // 翻译成英文（只有 large 系列支持）

{"id": 4, "cmd": "abort"}         // 识别中途取消
{"id": 5, "cmd": "unload"}
{"id": 6, "cmd": "shutdown"}
```

### 响应

```jsonc
{"id": 1, "type": "pong", "engine": "xbaos-engine", "whisper": "1.9.4",
 "backends": ["cpu", "vulkan"], "modelLoaded": false}

{"id": 2, "type": "loaded", "model": "ggml-small.bin", "backend": "cpu",
 "reused": false, "loadMs": 538}

{"id": 2, "type": "fallback", "from": "vulkan", "to": "cpu", "reason": "..."}

{"id": 3, "type": "progress", "percent": 42}

{"id": 3, "type": "segment", "i": 0, "start": 0.0, "end": 3.6,
 "text": "人工智能正在改变我们的生活方式。",
 "noSpeech": 0.0, "avgLogprob": -0.2155}
// start / end 单位是秒
// avgLogprob 越接近 0 置信度越高，明显偏低时界面上可以提示复核

{"id": 3, "type": "done", "count": 5, "elapsed": 12.486, "duration": 20.879,
 "backend": "cpu", "model": "ggml-small.bin", "language": "zh",
 "sourceRate": 22050, "sourceChannels": 1, "threads": 8}

{"id": 5, "type": "canceled"}
{"id": 3, "type": "error", "message": "..."}
```

`segment` 是流式推送的 —— 每识别出一段就立刻发出去，界面能边跑边出字幕，
不用等整段音频跑完。

### 路径编码

协议里所有路径都是 **UTF-8**（JSON 本身就是 UTF-8），中文和空格都允许。

**引擎内部读文件前必须先把路径转成宽字符**，用 `xbaos::pathFromUtf8()` 再交给文件流
（见 `src/platform.hpp`）。不要直接写 `std::ifstream f(path)` 的窄字符重载 ——
Windows 上它走 ANSI 代码页（简体中文系统是 GBK），路径里有中文就会打不开。

这条不是推测，是实测出来的：

| 用例 | 结果 |
|---|---|
| 全 ASCII 路径 | 正常 |
| 模型路径含中文与空格 | 正常（whisper.cpp 内部自己做了宽字符转换） |
| 音频路径含中文与空格 | **修复前失败**，报「无法打开文件」；改用宽字符后正常 |

模型那侧能通过是运气好，不能当作「Windows 不用管编码」的依据。
以后集成 MP3 / FLAC 解码器时，同样要先 `readFile()` 读进内存再交给 dr_libs，
不要直接用它们各自的按文件名打开接口。

## 线程数的默认值为什么封顶在 8

**不要改成「有几个核用几个核」。** 实测（Core Ultra 5 225H，
4 个性能核 + 8 个能效核 + 2 个低频 LP 能效核，共 14 线程；small 模型，
20.9 秒中文音频）：

| 线程数 | 耗时 | 相对 8 线程 |
|---|---|---|
| 4 | 4.90 秒 | 慢 29% |
| **8** | **3.81 秒** | — |
| 12 | 23.87 秒 | **慢 6.3 倍** |
| 14 | 更差 | — |

ggml 每层都用屏障同步，整批线程要一起等最慢的那一个。线程池扩到 12 之后，
那两个低频 LP E 核被拉进来，每一层都卡在它们身上。线程越多，被拖住的机会越大。

所以默认值取 `min(核数, 8)`：少用几个核最多损失一点峰值性能，
线程超订的代价却是数量级的。需要精细控制时用 `threads` 参数手动指定。

GPU 后端不受这个影响（`threads=4/8/12` 实测都是 1.65 秒左右），
因为计算在显卡上，CPU 线程基本闲置。

## 已知问题

**GPU（fp16）在中文且未给热词提示时，可能输出繁体中文。**

同一段音频，CPU 输出简体、GPU 输出繁体（如「改變」「語音識別」），
且平均对数概率明显偏低（-0.24 对比 CPU 的 -0.13）。
给一个简体中文的初始提示可以压住，但**通用提示词会引入幻觉**
（实测 `以下是普通话的句子。` 会把「字幕」识别成「"雾"」），
所以不能用通用提示词兜底。

待办：在引擎侧实现简繁转换后处理（`transcribe` 增加 `simplified` 参数，
`language=zh` 时默认开启），内置常用对照表，不引第三方库。

## 构建

### 环境

需要 MSVC + CMake + Ninja（Vulkan 版还需要 Vulkan SDK）。
按 [PLAN.md](../PLAN.md) 第三章配置，装到 `D:\Code\PCDevEnv`：

```powershell
. D:\Code\PCDevEnv\activate.ps1
```

### 获取依赖源码

第三方源码不入库，克隆仓库后跑一次：

```bash
bash engine/fetch-deps.sh
```

### 编译

```bash
bash engine/build.sh            # CPU 版
bash engine/build.sh vulkan     # Vulkan GPU 版
bash engine/build.sh clean      # 清理
```

产物在 `engine/build/<变体>/bin/xbaos-engine.exe`。

也可以手动调用 CMake：

```bash
cmake -S engine -B engine/build/cpu -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build engine/build/cpu
```

### CMake 里两个不能动的设置

**1. `GGML_AVX512` 必须保持 OFF**

目标机是 Intel Core Ultra 5 225H（Arrow Lake），消费级型号已经禁用了 AVX-512。
一旦编译进去，程序会在第一次推理时触发非法指令直接崩溃，且报错很难定位。
`CMakeLists.txt` 里把它以及三个子项都显式关掉了，不要改。

**2. `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`**

这是 `/MT` 静态链接。改成 `/MD` 会让产物依赖 `vcruntime140.dll` 和
`msvcp140.dll`，破坏「零外部运行时依赖」这条约束。

## 单独调试

引擎可以脱离主进程直接用：

```bash
EXE=engine/build/cpu/bin/xbaos-engine.exe

# 看版本
"$EXE" --version

# 从标准输入喂命令
echo '{"id":1,"cmd":"ping"}' | "$EXE"

# 直接跑一段音频
{
  echo '{"id":1,"cmd":"load","model":"models/ggml-small.bin"}'
  echo '{"id":2,"cmd":"transcribe","audio":"engine/test-data/zh-sample.wav","language":"zh"}'
  echo '{"id":3,"cmd":"shutdown"}'
} | "$EXE" 2>/dev/null
```

`engine/test-data/` 下的测试音频可以自己生成（用系统 TTS）：

```bash
"$PYTHON" -c "
import pyttsx3
e = pyttsx3.init()
e.setProperty('voice', r'HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\Voices\Tokens\TTS_MS_ZH-CN_HUIHUI_11.0')
e.save_to_file('要合成的中文文本', r'engine\test-data\zh-sample.wav')
e.runAndWait()"
```

## 目录

```
engine/
├── CMakeLists.txt        构建定义（含指令集与静态 CRT 约束）
├── build.sh              一键构建
├── env.sh                Git Bash 环境入口
├── fetch-deps.sh         获取第三方源码
├── src/
│   ├── main.cpp          引擎主循环与命令处理
│   ├── mini_json.hpp     零依赖的迷你 JSON
│   ├── platform.hpp      路径编码：UTF-8 → 宽字符
│   └── audio.hpp         WAV 读取与重采样
├── test-data/            测试音频（不入库）
└── third_party/
    └── whisper.cpp/      whisper.cpp 源码（不入库）
```

## 当前能力与边界

**已实现**：模型加载与复用、流式识别、进度上报、中途取消、
热词提示、语言指定/自动检测、多线程、WAV 解码与重采样、后端回退、
含中文与空格的路径。

**还没做**：
- 音频解码只支持 WAV。MP3 / FLAC / OGG / Opus 的解码器（dr_libs / stb_vorbis /
  libopus）还没集成，暂时由主进程负责把音频转成 16kHz 单声道 WAV。
- VAD（静音过滤）需要额外的 VAD 模型文件，暂未启用。
- 词级时间戳（`token_timestamps`）未开启。

---

© 2026 XBAOS
