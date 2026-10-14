<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import type { PunctuationMode } from '@/types'
import { PAUSE_PUNCT_LABELS } from '@/utils/punctuation'
import { parseReplaceDict } from '@/utils/dictReplace'
import Icon from '@/components/Icon.vue'

const settings = useSettingsStore()
const ui = useUiStore()

/** 词表里能解析出多少条可用规则。给个即时反馈，免得手滑写了不生效还不知道 */
const dictRuleCount = computed(() => parseReplaceDict(settings.dictReplacements).length)

const bridge = window.xbaos

/** 主进程实际生效的模型目录（未必等于 settings.modelsDir，以主进程为准） */
const effectiveModelsDir = ref('')
const modelsDirBusy = ref(false)

const PUNCT_OPTIONS: { value: PunctuationMode; label: string; hint: string }[] = [
  { value: 'keep', label: '原样保留', hint: '不做任何处理' },
  { value: 'strip', label: '去除停顿标点', hint: '只删标点，不切分' },
  { value: 'strip-split', label: '去标点并按标点切分', hint: '一条长句拆成多条' },
]

const THEME_OPTIONS = [
  { value: 'auto', icon: 'monitor', label: '跟随系统' },
  { value: 'light', icon: 'sun', label: '浅色' },
  { value: 'dark', icon: 'moon', label: '深色' },
] as const

const BACKEND_OPTIONS = [
  {
    value: 'auto',
    label: '自动',
    hint: '检测到支持 Vulkan 的显卡时启用加速，初始化失败会自动回退到 CPU',
  },
  { value: 'cpu', label: '仅 CPU', hint: '兼容性最好，速度取决于处理器性能' },
  { value: 'vulkan', label: '强制 Vulkan', hint: '需要显卡驱动支持，若不可用会导致识别失败' },
] as const

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['F2'], label: '编辑当前字幕文本' },
  { keys: ['单击文本'], label: '直接在点击处编辑' },
  { keys: ['Enter'], label: '确认编辑' },
  { keys: ['Esc'], label: '取消编辑' },
  { keys: ['↑', '↓'], label: '上一条 / 下一条' },
  { keys: ['Space'], label: '播放 / 暂停' },
  { keys: ['L'], label: '循环当前句' },
  { keys: ['Insert'], label: '在当前条之后插入一条' },
  { keys: ['Delete'], label: '删除选中的字幕' },
  { keys: ['Ctrl', 'A'], label: '全选字幕' },
  { keys: ['Ctrl', '单击'], label: '多选（时间轴与列表通用）' },
  { keys: ['Ctrl', 'M'], label: '合并选中的字幕' },
  {
    keys: ['Ctrl', 'B'],
    label: '分割字幕：编辑文本时按光标切；否则按时间轴播放头切（选了多条就一起切）',
  },
  { keys: ['拖动条身'], label: '在时间轴上整体平移一条字幕' },
  { keys: ['拖动条边缘'], label: '在时间轴上调整字幕起止时间' },
  { keys: ['单击条身'], label: '选中字幕（不改播放头）；点空白处才移动播放头' },
  { keys: ['拖动序号'], label: '在列表里调整顺序：把内容搬到目标行的时间码上' },
  { keys: ['滚轮'], label: '时间轴左右平移' },
  { keys: ['Ctrl', '滚轮'], label: '缩放时间轴（触控板双指捏合同理）' },
  { keys: ['Ctrl', '↑/↓'], label: '切换上 / 下一个文件' },
  { keys: ['Ctrl', 'Z'], label: '撤销' },
  { keys: ['Ctrl', 'Y'], label: '重做' },
  { keys: ['Ctrl', 'H'], label: '查找替换（回车 / Shift+回车 找下一处 / 上一处）' },
]

/* ------------------------------------------------------- 模型存储位置 */

async function refreshModelsDir(): Promise<void> {
  if (!bridge?.models) {
    effectiveModelsDir.value = settings.modelsDir
    return
  }
  try {
    const res = await bridge.models.getDir()
    effectiveModelsDir.value = res.dir
  } catch {
    effectiveModelsDir.value = settings.modelsDir
  }
}

onMounted(() => {
  void refreshModelsDir()
})

/**
 * 从模型管理页点「模型存储位置」跳进来时，直接滚到对应章节。
 * 设置页被 KeepAlive 缓存着，切回来**不会**重新挂载 —— 所以滚动只能靠
 * `ui.settingsAnchor` 这个状态触发，不能只写在 onMounted 里。
 */
onActivated(() => {
  void refreshModelsDir()
  const anchor = ui.settingsAnchor
  if (!anchor) return
  ui.settingsAnchor = null
  void nextTick(() => {
    document.getElementById(anchor)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
})

/**
 * 更改模型存储位置。
 *
 * 换目录之后**旧目录不再被扫描**（拍板结论：换就彻底换），所以必须把后果
 * 说清楚 —— 否则用户切完目录会发现之前下载的模型全「消失」了。
 */
async function changeModelsDir(): Promise<void> {
  if (!bridge?.models) {
    ui.notify('info', '浏览器预览无法更改目录', '请在桌面应用中使用')
    return
  }
  const dir = await bridge.dialog.pickDirectory({ title: '选择模型存储位置' })
  if (!dir) return

  // 先确认再落设置：选错盘符是很常见的事，而这一步会影响后续所有下载
  const ok = await bridge.dialog.confirm({
    title: '更改模型存储位置',
    message: `要把模型存储位置改成这个文件夹吗？\n\n${dir}`,
    detail:
      '更改后软件只从这个新文件夹里查找模型。原来位置已经下载好的模型不会自动搬过去 —— ' +
      '请尽快把它们手动复制到新文件夹，否则界面上会显示没有可用模型，需要重新下载。',
    buttons: ['取消', '确认更改'],
    defaultId: 0,
    cancelId: 0,
  })
  if (ok !== 1) return

  modelsDirBusy.value = true
  try {
    const res = await bridge.models.setDir(dir)
    if (!res.ok) {
      ui.notify('error', '这个文件夹不能用', res.message ?? '无法写入，请换一个位置')
      return
    }
    settings.modelsDir = dir
    effectiveModelsDir.value = res.dir ?? dir
    ui.notify('success', '模型存储位置已更改', '记得把原来的模型复制到新位置')
  } catch (err) {
    ui.notify('error', '更改失败', err instanceof Error ? err.message : String(err))
  } finally {
    modelsDirBusy.value = false
  }
}

async function resetModelsDir(): Promise<void> {
  if (!bridge?.models) return
  modelsDirBusy.value = true
  try {
    const res = await bridge.models.setDir('')
    settings.modelsDir = ''
    effectiveModelsDir.value = res.dir ?? ''
    ui.notify('info', '已恢复默认模型位置')
  } catch (err) {
    ui.notify('error', '恢复默认失败', err instanceof Error ? err.message : String(err))
  } finally {
    modelsDirBusy.value = false
  }
}

async function openModelsDir(): Promise<void> {
  if (!bridge?.models) return
  const res = await bridge.models.openDir()
  if (!res.ok && res.message) ui.notify('error', '打不开模型文件夹', res.message)
}

function reset(): void {
  if (!window.confirm('确定要把所有设置恢复为默认值吗？此操作不可撤销。')) return
  settings.resetAll()
  void resetModelsDir()
  ui.notify('success', '设置已恢复默认值')
}
</script>

<template>
  <div class="view">
    <header class="view__head">
      <div class="view__head-inner">
        <h1 class="view__title">设置</h1>
        <p class="view__desc">修改后立即生效，并自动保存到本机</p>
      </div>
    </header>

    <div class="view__body">
      <div class="view__body-inner">
        <!-- 外观 -->
        <section class="block">
          <div class="block__head">
            <Icon name="sun" :size="14" />
            <span class="block__title">外观</span>
          </div>
          <div class="block__body">
            <p class="field__label">主题</p>
            <div v-seg-thumb class="choice-row">
              <button
                v-for="item in THEME_OPTIONS"
                :key="item.value"
                class="choice"
                :class="{ 'is-active': settings.themeMode === item.value }"
                type="button"
                @click="settings.themeMode = item.value"
              >
                <Icon :name="item.icon" :size="16" />
                <span>{{ item.label }}</span>
              </button>
            </div>
            <p class="hint">
              跟随系统时随系统深浅色切换，也可在此固定为一种。
            </p>
            <label class="switch glass-switch">
              <input v-model="settings.glassEnabled" type="checkbox" />
              <span class="switch__track" />
              <span>毛玻璃效果</span>
            </label>
            <p class="hint">Windows 11 22H2 及以上生效，其余环境自动使用纯色。</p>
          </div>
        </section>

        <!-- 性能 -->
        <section class="block">
          <div class="block__head">
            <Icon name="cpu" :size="14" />
            <span class="block__title">性能</span>
          </div>
          <div class="block__body">
            <p class="field__label">推理后端</p>
            <div class="backend-list">
              <label
                v-for="item in BACKEND_OPTIONS"
                :key="item.value"
                class="backend"
                :class="{ 'is-active': settings.backend === item.value }"
              >
                <input v-model="settings.backend" type="radio" :value="item.value" />
                <span class="backend__body">
                  <span class="backend__label">
                    {{ item.label }}
                    <Icon
                      v-if="item.value === 'auto'"
                      name="zap"
                      :size="12"
                      class="backend__zap"
                    />
                  </span>
                  <span class="backend__hint">{{ item.hint }}</span>
                </span>
              </label>
            </div>
            <p class="hint">
              当前档位：{{ BACKEND_OPTIONS.find((i) => i.value === settings.backend)?.label }}。
              实际使用的后端显示在底部状态条。
            </p>
          </div>
        </section>

        <!-- 模型存储位置 -->
        <section id="models-dir" class="block">
          <div class="block__head">
            <Icon name="folder" :size="14" />
            <span class="block__title">模型存储位置</span>
          </div>
          <div class="block__body">
            <p class="punct-intro">
              新下载的模型保存在此，识别时也从这里查找。也可以直接放入自备的
              whisper.cpp 模型（<span class="mono">ggml-*.bin</span>）。
            </p>
            <p class="path-box mono">{{ effectiveModelsDir || '（正在读取…）' }}</p>
            <div class="row-actions">
              <button
                class="btn btn--sm"
                type="button"
                :disabled="modelsDirBusy"
                @click="changeModelsDir"
              >
                <Icon name="folder" :size="13" />
                <span>更改位置</span>
              </button>
              <button
                v-if="settings.modelsDir"
                class="btn btn--sm"
                type="button"
                :disabled="modelsDirBusy"
                @click="resetModelsDir"
              >
                <span>恢复默认</span>
              </button>
              <button class="btn btn--sm" type="button" @click="openModelsDir">
                <Icon name="folder-open" :size="13" />
                <span>打开文件夹</span>
              </button>
            </div>
            <p class="hint">
              更改后软件<strong>只会</strong>从新位置查找模型。原位置已下载的模型需自行复制过去，
              否则会显示没有可用模型，需要重新下载。
            </p>
          </div>
        </section>

        <!-- 识别相关的设置已整体移到「导入」页，方便每次导入前顺手调整 -->
        <section class="block">
          <div class="block__head">
            <Icon name="wave" :size="14" />
            <span class="block__title">识别</span>
          </div>
          <div class="block__body">
            <p class="punct-intro">
              识别语言、推理深度、领域词库、热词提示与音质前处理都移到了「导入」页的识别设置面板，
              在导入音频时即可随手调整。
            </p>
            <button class="btn btn--sm" type="button" @click="ui.navigate('home')">
              <Icon name="import" :size="13" />
              <span>前往导入页设置</span>
            </button>
          </div>
        </section>

        <!-- 标点处理 -->
        <section class="block">
          <div class="block__head">
            <Icon name="spell-check" :size="14" />
            <span class="block__title">标点处理</span>
          </div>
          <div class="block__body">
            <p class="punct-intro">
              在识别结果进入预览与编辑之前自动执行。只处理起停顿作用的标点，
              引号、括号、书名号等结构标点一律不动；数字里的小数点、千分位逗号也会跳过。
            </p>
            <div class="grid-2">
              <label class="field">
                <span class="field__label">中文字幕（含中日韩字符）</span>
                <select v-model="settings.punctuation.zh" class="select">
                  <option v-for="item in PUNCT_OPTIONS" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </option>
                </select>
                <span class="field__hint">
                  默认去标点并切分。处理名单：{{ PAUSE_PUNCT_LABELS.zh }}
                </span>
              </label>

              <label class="field">
                <span class="field__label">西文字幕</span>
                <select v-model="settings.punctuation.en" class="select">
                  <option v-for="item in PUNCT_OPTIONS" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </option>
                </select>
                <span class="field__hint">
                  默认原样保留。处理名单：{{ PAUSE_PUNCT_LABELS.en }}
                </span>
              </label>
            </div>
          </div>
        </section>

        <!-- 字幕规格 -->
        <section class="block">
          <div class="block__head">
            <Icon name="type" :size="14" />
            <span class="block__title">字幕规格</span>
          </div>
          <div class="block__body">
            <p class="punct-intro">
              这几项同时决定 <strong>AI 校对的提示词</strong>和<strong>导出时的自动折行</strong>，
              改一次两边都生效。AI 校对会按这里的上限约束它的合并力度 —— 上限越松，
              AI 越倾向于把多条并成一条长字幕。
            </p>
            <div class="grid-2">
              <label class="field">
                <span class="field__label">中文单行上限</span>
                <input
                  v-model.number="settings.maxCharsPerLine"
                  class="input input--mono"
                  type="number"
                  min="8"
                  max="40"
                  step="1"
                />
                <span class="field__hint">单位字，行业惯例 14~16，上限 18</span>
              </label>

              <label class="field">
                <span class="field__label">英文单行上限</span>
                <input
                  v-model.number="settings.maxCharsPerLineEn"
                  class="input input--mono"
                  type="number"
                  min="20"
                  max="80"
                  step="1"
                />
                <span class="field__hint">单位字符（含空格），行业惯例 38~42</span>
              </label>

              <label class="field">
                <span class="field__label">单条最多行数</span>
                <input
                  v-model.number="settings.maxLinesPerSegment"
                  class="input input--mono"
                  type="number"
                  min="1"
                  max="4"
                  step="1"
                />
                <span class="field__hint">再多会压屏，常用 2 行</span>
              </label>

              <label class="field">
                <span class="field__label">单条时长上限</span>
                <input
                  v-model.number="settings.maxSegmentDuration"
                  class="input input--mono"
                  type="number"
                  min="0"
                  max="30"
                  step="0.5"
                />
                <span class="field__hint">单位秒，0 表示不限；超过就该考虑拆开</span>
              </label>
            </div>
            <p class="punct-intro">
              按当前设置：中文单条不超过
              <strong>{{ settings.maxCharsPerLine * settings.maxLinesPerSegment }}</strong> 字，
              英文单条不超过
              <strong>{{ settings.maxCharsPerLineEn * settings.maxLinesPerSegment }}</strong> 字符。
            </p>
          </div>
        </section>

        <!-- 填充空隙 -->
        <section class="block">
          <div class="block__head">
            <Icon name="wand" :size="14" />
            <span class="block__title">填充空隙的默认参数</span>
          </div>
          <div class="block__body">
            <div class="grid-3">
              <label class="field">
                <span class="field__label">间隔阈值</span>
                <input
                  v-model.number="settings.gapFill.thresholdSec"
                  class="input input--mono"
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.1"
                />
                <span class="field__hint">单位秒，超过则不填充</span>
              </label>

              <label class="field">
                <span class="field__label">保留间隙</span>
                <input
                  v-model.number="settings.gapFill.keepGapSec"
                  class="input input--mono"
                  type="number"
                  min="0"
                  max="0.2"
                  step="0.01"
                />
                <span class="field__hint">单位秒，防止边界闪烁</span>
              </label>

              <label class="field">
                <span class="field__label">单条最长时长</span>
                <input
                  v-model.number="settings.gapFill.maxDurationSec"
                  class="input input--mono"
                  type="number"
                  min="1"
                  max="60"
                  step="0.5"
                  :disabled="!settings.gapFill.limitEnabled"
                />
                <span class="field__hint">默认 2 秒</span>
              </label>
            </div>

            <label class="switch limit-switch">
              <input v-model="settings.gapFill.limitEnabled" type="checkbox" />
              <span class="switch__track" />
              <span>启用单条最长时长限制</span>
            </label>
          </div>
        </section>

        <!-- 导出 -->
        <section class="block">
          <div class="block__head">
            <Icon name="save" :size="14" />
            <span class="block__title">导出</span>
          </div>
          <div class="block__body">
            <div class="grid-2">
              <label class="field">
                <span class="field__label">默认格式</span>
                <select v-model="settings.exportFormat" class="select">
                  <option value="srt">SRT</option>
                  <option value="vtt">VTT</option>
                  <option value="ass">ASS</option>
                  <option value="txt">TXT</option>
                </select>
              </label>

              <label class="field">
                <span class="field__label">默认编码</span>
                <select v-model="settings.exportEncoding" class="select">
                  <option value="utf-8">UTF-8</option>
                  <option value="utf-8-bom">UTF-8 带 BOM</option>
                  <option value="gbk">GBK</option>
                </select>
              </label>

              <label class="field">
                <span class="field__label">换行符</span>
                <select v-model="settings.exportLineEnding" class="select">
                  <option value="crlf">CRLF（Windows）</option>
                  <option value="lf">LF（Unix）</option>
                </select>
              </label>

              <label class="field">
                <span class="field__label">输出位置</span>
                <select v-model="settings.outputMode" class="select">
                  <option value="follow-source">跟随音频所在目录</option>
                  <option value="unified">统一输出到指定目录</option>
                  <option value="per-file">每个文件分别指定</option>
                </select>
              </label>
            </div>

            <label class="switch limit-switch">
              <input v-model="settings.openFolderAfterExport" type="checkbox" />
              <span class="switch__track" />
              <span>导出后打开所在文件夹</span>
            </label>
          </div>
        </section>

        <!-- 自定义替换词表 -->
        <section class="block">
          <div class="block__head">
            <Icon name="book" :size="14" />
            <span class="block__title">自定义替换词表</span>
          </div>
          <div class="block__body">
            <p class="field__hint">
              编辑器「工具」面板里的<b>词表替换</b>按这里的规则批量纠错。每行一条，
              用 <code>=</code> 或 <code>=&gt;</code> 分隔「错词」与「正词」，
              <code>#</code> 开头的行不参与替换。一次性替换请改用编辑器里的「查找替换」。
            </p>
            <textarea
              v-model="settings.dictReplacements"
              class="dict__area"
              rows="6"
              spellcheck="false"
              placeholder="帐号=账号&#10;视屏 => 视频&#10;# 以井号开头的是注释"
            ></textarea>
            <p class="field__hint">
              当前解析出 <b>{{ dictRuleCount }}</b> 条规则。典型用法：把识别常错的人名、
              术语、同音字在此配好，之后在编辑器里批量纠正。
            </p>
          </div>
        </section>

        <!-- 快捷键 -->
        <section class="block">
          <div class="block__head">
            <Icon name="keyboard" :size="14" />
            <span class="block__title">快捷键</span>
          </div>
          <div class="block__body">
            <ul class="shortcuts">
              <li v-for="item in SHORTCUTS" :key="item.label" class="shortcuts__row">
                <span class="shortcuts__keys">
                  <kbd v-for="key in item.keys" :key="key">{{ key }}</kbd>
                </span>
                <span class="shortcuts__label">{{ item.label }}</span>
              </li>
            </ul>
          </div>
        </section>

        <div class="reset-row">
          <button class="btn btn--danger" type="button" @click="reset">恢复所有默认设置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---- 模型存储位置 ---- */
.path-box {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
  user-select: text;
}

.row-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.punct-intro {
  margin-bottom: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.field__label {
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field--full {
  margin-top: var(--space-4);
}

.field__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4) var(--space-5);
}

.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-4) var(--space-5);
}

/* 自定义替换词表：多行文本直接编辑，不做成列表控件 */
.dict__area {
  width: 100%;
  min-height: 118px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-xs);
  line-height: 1.8;
  resize: vertical;
}

.dict__area::placeholder {
  color: var(--color-text-tertiary);
}

.dict__area:focus {
  outline: none;
  border-color: var(--color-border-strong);
}

.field__hint code {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--color-bg-inset);
  color: var(--color-text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
}

/* 与导入页 .seg 同一套容器观感：inset 底 + 细边，选中标记交给滑动指示块 */
.choice-row {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
  margin-bottom: var(--space-2);
}

.choice {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 36px;
  border-radius: calc(var(--radius-md) - 2px);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  transition: color var(--dur-fast) var(--ease-out);
}

.choice:hover {
  color: var(--color-text-primary);
}

.choice.is-active {
  /* 选中标记在滑动指示块上（v-seg-thumb），这里只管文字 */
  color: var(--color-text-primary);
  font-weight: var(--weight-semibold);
}

.backend-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.backend {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.backend:hover {
  border-color: var(--color-border-strong);
}

.backend.is-active {
  /* 单选卡片：底色 + 描边 + 内圈同时上，深色下才分得清哪张是选中的 */
  border-color: var(--color-accent-border);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-sm), inset 0 0 0 1px var(--color-accent-border);
}

.backend input[type='radio'] {
  margin-top: 2px;
  width: 15px;
  height: 15px;
  flex: none;
  accent-color: var(--color-accent);
}

.backend__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.backend__label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
}

.backend__zap {
  color: var(--color-warning);
}

.backend__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

.limit-switch {
  margin-top: var(--space-4);
}

.glass-switch {
  margin-top: var(--space-4);
}

.shortcuts {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2) var(--space-6);
}

.shortcuts__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.shortcuts__keys {
  display: flex;
  gap: 3px;
  min-width: 96px;
}

.shortcuts__label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.reset-row {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-2);
}

/* 通用开关布局（填充空隙与导出区块使用） */

.switch {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--space-2);
  cursor: pointer;
}

.switch input[type='checkbox'] {
  grid-row: span 2;
  margin-top: 3px;
  width: 15px;
  height: 15px;
  accent-color: var(--color-accent);
}

.switch > span:first-of-type {
  font-size: var(--font-size-sm);
}
</style>
