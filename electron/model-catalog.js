/**
 * 模型目录与架构元数据 —— 模型相关信息的**单一真相源**。
 *
 * 这里只放「是什么」，不放「怎么用」：
 *   架构（跑哪个引擎）· 发行者 · 协议 · 体积 · 能力 · 下载地址
 * 扫描与解析在 models.js，下载在 model-download.js，界面在 ModelView.vue。
 *
 * 为什么把架构/发行者/协议摆在这一层：
 * 界面上要公示的字段必须与「真拿去跑」的那份数据同源，否则迟早出现
 * 「模型页写着 MIT、NOTICE 里写 Apache-2.0」这种自相矛盾。
 *
 * 许可口径（硬性约束：必须免费可商用）：
 *   · Whisper 系列（small/base/turbo）—— MIT
 *   · Belle-whisper-large-v3-turbo-zh —— Apache-2.0
 *   · SenseVoice-Small —— FunASR Model License 1.1：允许免费商用，
 *     **但要求署名并保留模型名称**，NOTICE 里已按此写明
 * 三者都不是「同一个协议」，别在别处概括成「均为 MIT」。
 */

/** 架构标识。字符串会存进设置、写进日志，改动要连迁移一起想。 */
export const ARCH_WHISPER = 'whisper'
export const ARCH_SHERPA = 'sherpa'

/**
 * 架构元数据。
 *
 * `exe` 是打包态的文件名（都在 resources/engine/ 下）；
 * `devExe` 是开发态的候选路径，按优先级排。
 */
export const ARCH_INFO = {
  [ARCH_WHISPER]: {
    id: ARCH_WHISPER,
    /** 界面上展示的引擎名 */
    engine: 'whisper.cpp',
    /** 运行时与模型格式，模型页「架构」一栏的第二行 */
    runtime: 'GGML',
    exe: 'xbaos-engine.exe',
    devExe: [
      'engine/build/vulkan/bin/xbaos-engine.exe',
      'engine/build/cpu/bin/xbaos-engine.exe',
    ],
    envVar: 'XBAOS_ENGINE_EXE',
    /**
     * 能力开关。渲染层按它决定控件是否可用 —— 不要在各处重写这套判断，
     * 换一个模型类型就要改三四个组件是上一版的真实教训。
     */
    caps: {
      /** 领域词 / 术语表进入识别提示词（热词偏置） */
      prompt: true,
      /** 翻译任务（whisper 自带 translate） */
      translate: true,
      /** 温度、束搜索、多遍推理等解码参数 */
      decode: true,
      /** GPU / Vulkan 后端 */
      gpu: true,
    },
  },
  [ARCH_SHERPA]: {
    id: ARCH_SHERPA,
    engine: 'sherpa-onnx',
    runtime: 'ONNX Runtime',
    exe: 'xbaos-engine-asr.exe',
    devExe: ['engine-onnx/build/bin/xbaos-engine-asr.exe'],
    envVar: 'XBAOS_ENGINE_ASR_EXE',
    caps: {
      // sherpa-onnx 的热词偏置只支持 transducer 模型且必须 modified_beam_search，
      // SenseVoice 是 CTC + greedy_search，两头都不满足
      prompt: false,
      // CTC 模型没有翻译任务
      translate: false,
      // 贪心 CTC 没有温度/束搜索的概念
      decode: false,
      // 引擎只用 onnxruntime CPU provider
      gpu: false,
    },
  },
}

/** 拿不到架构信息时的兜底，避免调用处到处写 `?? {}` */
export const EMPTY_CAPS = { prompt: false, translate: false, decode: false, gpu: false }

export function capsOf(arch) {
  return ARCH_INFO[arch]?.caps ?? EMPTY_CAPS
}

export function archLabel(arch) {
  const info = ARCH_INFO[arch]
  if (!info) return '未知架构'
  return `${info.engine}（${info.runtime}）`
}

/**
 * 内置模型清单。顺序即界面顺序：SenseVoice 排最前，它是新的默认推荐。
 *
 * `files` 是所有下载信息的唯一来源：
 *   · kind='dir'  模型是一个目录，files 里的文件都落在 <模型目录>/<id>/ 下
 *   · kind='file' 模型是单个文件，直接落在模型目录根下
 *
 * `sha256` 一律填真实哈希：Hugging Face 的 LFS 对象 id 与 ModelScope 的
 * `Sha256` 字段都是文件自身的 sha256，两处已逐一核对为同一个值。填了就走强校验，
 * 下载内容被 CDN 篡改、截断或换包都会当场拒收 —— 比「魔数 + 体积」可靠得多。
 *
 * `urls` 的顺序就是尝试顺序：**国内可达的排在前面**。ModelScope 有完全相同
 * 字节的条目时放第一，其余先用 hf-mirror（Hugging Face 的国内镜像），
 * 最后才是 huggingface.co 直连 —— 直连在国内通常拿不动，只能当最后的兜底。
 */
export const MODEL_CATALOG = [
  {
    key: 'sensevoice-small',
    id: 'sensevoice-small',
    name: 'SenseVoice-Small',
    arch: ARCH_SHERPA,
    kind: 'dir',
    publisher: '阿里巴巴通义实验室',
    license: 'FunASR Model License 1.1',
    licenseUrl: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
    params: '234M',
    langs: '中文 英文 粤语 日语 韩语',
    sizeLabel: '约 228MB',
    summary: '中文首选，自带标点与数字规整',
    files: [
      {
        name: 'model.int8.onnx',
        size: 239233841,
        sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
        urls: [
          'https://modelscope.cn/models/poloniumrock/SenseVoiceSmallOnnx/resolve/master/model.int8.onnx',
          'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
        ],
      },
      {
        name: 'tokens.txt',
        size: 315894,
        sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
        urls: [
          'https://modelscope.cn/models/poloniumrock/SenseVoiceSmallOnnx/resolve/master/tokens.txt',
          'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
        ],
      },
    ],
  },
  {
    key: 'belle',
    id: 'ggml-belle-large-v3-turbo-zh.bin',
    name: 'Belle-whisper Zh',
    arch: ARCH_WHISPER,
    kind: 'file',
    publisher: 'BELLE-2',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml',
    params: '809M',
    langs: '中文 英文',
    sizeLabel: '约 1.6GB',
    summary: '中文语料微调，专有名词更准',
    files: [
      {
        name: 'ggml-belle-large-v3-turbo-zh.bin',
        size: 1624555275,
        sha256: '2a3bba5bfdb4d4da3d9949a83b405711727ca1941d4d5810895e077eb3cb4d99',
        urls: [
          'https://hf-mirror.com/BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml/resolve/main/ggml-model.bin',
          'https://huggingface.co/BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml/resolve/main/ggml-model.bin',
        ],
      },
    ],
  },
  {
    key: 'turbo',
    id: 'ggml-large-v3-turbo.bin',
    name: 'Whisper Turbo',
    arch: ARCH_WHISPER,
    kind: 'file',
    publisher: 'OpenAI',
    license: 'MIT',
    licenseUrl: 'https://github.com/ggerganov/whisper.cpp',
    params: '809M',
    langs: '多语种',
    sizeLabel: '约 1.6GB',
    summary: 'large-v3-turbo，多语种大模型',
    files: [
      {
        name: 'ggml-large-v3-turbo.bin',
        size: 1624555275,
        sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
        // ModelScope 上的同名文件与 Hugging Face 逐字节一致（体积与 sha256 均已核对），
        // 所以它排在第一位：国内直连能跑满带宽
        urls: [
          'https://modelscope.cn/models/timeless/whispercpp/resolve/master/ggml-large-v3-turbo.bin',
          'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
          'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
        ],
      },
    ],
  },
  {
    key: 'small',
    id: 'ggml-small.bin',
    name: 'Whisper Small',
    arch: ARCH_WHISPER,
    kind: 'file',
    publisher: 'OpenAI',
    license: 'MIT',
    licenseUrl: 'https://github.com/ggerganov/whisper.cpp',
    params: '244M',
    langs: '多语种',
    sizeLabel: '约 480MB',
    summary: '体积与质量折中',
    files: [
      {
        name: 'ggml-small.bin',
        size: 487601967,
        sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
        urls: [
          'https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-small.bin',
          'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
          'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
        ],
      },
    ],
  },
  {
    key: 'base',
    id: 'ggml-base.bin',
    name: 'Whisper Base',
    arch: ARCH_WHISPER,
    kind: 'file',
    publisher: 'OpenAI',
    license: 'MIT',
    licenseUrl: 'https://github.com/ggerganov/whisper.cpp',
    params: '74M',
    langs: '多语种',
    sizeLabel: '约 140MB',
    summary: '最轻量，适合试跑',
    files: [
      {
        name: 'ggml-base.bin',
        size: 147951465,
        sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
        urls: [
          'https://modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-base.bin',
          'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
          'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
        ],
      },
    ],
  },
]

export function findCatalog(key) {
  return MODEL_CATALOG.find((m) => m.key === key) ?? null
}

/**
 * 按**磁盘标识**找条目。
 *
 * 与 `findCatalog` 不是一回事，两者的键根本不同：`key` 是逻辑短名（`small`），
 * `id` 才是磁盘上的名字（`ggml-small.bin` / `sensevoice-small`）。界面要判断
 * 「这个已装模型是不是内置清单里的那一个」必须用磁盘标识 —— 拿 key 去比
 * 文件名永远匹配不上，结果就是内置条目在「自己的模型」里又列了一遍。
 */
export function findCatalogByDiskId(diskId) {
  return MODEL_CATALOG.find((m) => m.id === diskId) ?? null
}

/**
 * 兜底顺序：用户从没选过模型时按这个挑。
 *
 * 按**能力**排，不按体积也不按字母序 —— 字母序会把 ggml-base 排在
 * ggml-small 前面，等于默认给用户最差的那个。
 *
 * SenseVoice 排第一：中文标点与数字规整是它最强的地方，而字幕场景
 * 缺了标点几乎没法用。注意这只在 modelFile 为空时生效，
 * 老用户选了谁就继续用谁。
 */
export const FALLBACK_ORDER = ['sensevoice-small', 'belle', 'turbo', 'small', 'base']

/** 渲染进程可见的目录条目：下载地址留在主进程，不下发 */
export function publicCatalog() {
  return MODEL_CATALOG.map((m) => ({
    key: m.key,
    id: m.id,
    name: m.name,
    arch: m.arch,
    /** 引擎短名，卡片表格「架构」一栏用；全名带运行时，只在顶部信息条展示 */
    engine: ARCH_INFO[m.arch]?.engine ?? '',
    archLabel: archLabel(m.arch),
    kind: m.kind,
    publisher: m.publisher,
    license: m.license,
    licenseUrl: m.licenseUrl,
    params: m.params,
    langs: m.langs,
    sizeLabel: m.sizeLabel,
    summary: m.summary,
    /** 下载总字节数：界面按它算进度百分比 */
    bytes: m.files.reduce((sum, f) => sum + (f.size || 0), 0),
  }))
}
