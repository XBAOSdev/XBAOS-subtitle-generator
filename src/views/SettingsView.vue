<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import type { PunctuationMode } from '@/types'
import { PAUSE_PUNCT_LABELS } from '@/utils/punctuation'
import { parseReplaceDict } from '@/utils/dictReplace'
import { buildWrapWords } from '@/utils/wrapWords'
import { COMMON_WORDS, COMMON_WORD_GROUPS } from '@/data/commonWords'
import { LEXICONS } from '@/data/lexicons'
import {
  SCRIPT_STRENGTH_OPTIONS,
  normalizeStrength,
  strengthOption,
} from '@/data/scriptStrength'
import {
  SETTINGS_GROUPS,
  entryCountOf,
  groupOfDomId,
  searchSettings,
  settingsGroupById,
  type SettingsEntry,
} from '@/data/settingsMap'
import Icon from '@/components/Icon.vue'
import WordbookDialog from '@/components/dialogs/WordbookDialog.vue'

const settings = useSettingsStore()
const ui = useUiStore()

/** 词表里能解析出多少条可用规则。给个即时反馈，免得手滑写了不生效还不知道 */
const dictRuleCount = computed(() => parseReplaceDict(settings.dictReplacements).length)

/** 内置词表的规模，界面上直接报数，用户不用点开也心里有数 */
const commonWordCount = COMMON_WORDS.length
const commonGroupCount = COMMON_WORD_GROUPS.length
/** 当前实际参与断句的词数：常用词库 + 勾选的领域词库 + 手填术语，去重后 */
const activeWrapCount = computed(
  () => buildWrapWords(settings.lexiconIds, settings.promptTerms).length,
)
const wordbookOpen = ref(false)

/** 当前档位的解释文字。越界值先夹一次，旧存档里的脏值不该让设置页崩 */
const activeStrength = computed(() => strengthOption(settings.aiScriptStrength))

/** 滑块给的是字符串，写回 store 前必须夹成 0..3 的整数 */
function onStrengthInput(event: Event): void {
  settings.aiScriptStrength = normalizeStrength(Number((event.target as HTMLInputElement).value))
}

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
    hint: '检测到支持 Vulkan 的显卡时启用加速；显卡后端出问题会自动改用 CPU 重试',
  },
  {
    value: 'cpu',
    label: '仅 CPU',
    hint: '完全不加载显卡后端，兼容性最好，速度取决于处理器性能',
  },
  { value: 'vulkan', label: '强制 Vulkan', hint: '需要显卡驱动支持，若不可用会导致识别失败' },
] as const

/**
 * 搜索。
 *
 * 面板的打开与否和查询串分开两个状态：清空输入后仍要能重新点开面板看上次搜的词，
 * 而「搜索框有焦点 + 有内容」才出面板 —— 否则用户点了输入框却什么都看不到。
 */
const searchQuery = ref('')
const searchOpen = ref(false)
const searchCursor = ref(0)
const searchResults = computed(() => searchSettings(searchQuery.value))
const searchInput = ref<HTMLInputElement | null>(null)

watch(searchQuery, () => {
  searchCursor.value = 0
  searchOpen.value = searchQuery.value.trim().length > 0
})

function clearSearch(): void {
  searchQuery.value = ''
  searchOpen.value = false
  searchInput.value?.focus()
}

function onSearchKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    searchOpen.value = false
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (searchResults.value.length === 0) return
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = searchCursor.value + step
    searchCursor.value = (next + searchResults.value.length) % searchResults.value.length
    return
  }
  if (event.key === 'Enter') {
    const hit = searchResults.value[searchCursor.value]
    if (hit) jumpTo(hit)
  }
}

/* ------------------------------------------------------------ 分组与跳转 */

const scroller = ref<HTMLDivElement | null>(null)

/**
 * 每个分组各自的滚动位置。
 *
 * 只存在组件里（设置页被 KeepAlive 缓存，切走再回来还在），关掉软件即失效 ——
 * 这正是用户要的「会话内记住，重启不记」。存 store 反而要额外操心清理。
 */
const scrollTops = new Map<string, number>()

function rememberScroll(): void {
  if (scroller.value) scrollTops.set(ui.settingsGroup, scroller.value.scrollTop)
}

function selectGroup(id: string): void {
  if (id === ui.settingsGroup) return
  rememberScroll()
  ui.settingsGroup = id
  searchOpen.value = false
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scrollTops.get(id) ?? 0
  })
}

/** 高亮刚跳到的目标，1.6 秒后自己淡出 */
let flashTimer = 0
function flash(el: HTMLElement): void {
  window.clearTimeout(flashTimer)
  for (const node of document.querySelectorAll('.is-flash')) node.classList.remove('is-flash')
  el.classList.add('is-flash')
  flashTimer = window.setTimeout(() => el.classList.remove('is-flash'), 1600)
}

/**
 * 跳到某个 DOM id（设置项锚点或整个区块）。
 *
 * 必须**先切分组再找元素**：被 `v-show` 藏起来的元素 `display:none`，
 * `scrollIntoView` 对它是空操作 —— 用户会看到「点了没反应」。
 */
async function jumpToDomId(domId: string): Promise<void> {
  const group = groupOfDomId(domId)
  if (group && group !== ui.settingsGroup) {
    rememberScroll()
    ui.settingsGroup = group
  }
  await nextTick()
  const el = document.getElementById(domId)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flash(el)
  if (scroller.value) scrollTops.set(ui.settingsGroup, scroller.value.scrollTop)
}

function jumpTo(entry: SettingsEntry): void {
  searchOpen.value = false
  searchInput.value?.blur()
  void jumpToDomId(entry.anchor ?? entry.section)
}

/* ------------------------------------------------------- 快捷键与诊断 */

/** 诊断导出：把现场收成一个文件，用户直接发过来就行 */
const diagBusy = ref(false)
const diagNote = ref('')

async function exportDiag() {
  if (!bridge?.diag) {
    diagNote.value = '当前环境不支持导出'
    return
  }
  diagBusy.value = true
  diagNote.value = ''
  try {
    const res = await bridge.diag.export()
    diagNote.value = res.ok ? '已生成，文件已在资源管理器中打开' : `导出失败：${res.message ?? '未知原因'}`
  } catch (err) {
    diagNote.value = `导出失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    diagBusy.value = false
  }
}

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
 * 从模型管理页点「模型存储位置」跳进来时，直接切到对应分组并滚到章节。
 * 设置页被 KeepAlive 缓存着，切回来**不会**重新挂载 —— 所以跳转只能靠
 * `ui.settingsAnchor` 这个状态触发，不能只写在 onMounted 里。
 */
onActivated(() => {
  void refreshModelsDir()
  const anchor = ui.settingsAnchor
  if (!anchor) return
  ui.settingsAnchor = null
  void nextTick(() => jumpToDomId(anchor))
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
    <!-- 点内容区任意处收起搜索面板；搜索框自己 stop 掉，否则一落点就收 -->
    <div class="setbody" @mousedown="searchOpen = false">
      <!-- 二级菜单：与编辑器左侧文件导航同一套观感（surface 底 + 右侧细边 + 选中填充） -->
      <nav class="setnav">
        <!-- 搜索：命中设置项后切分组 + 滚动 + 高亮，不是「过滤列表」 -->
        <div class="setnav__search" @mousedown.stop>
          <div class="setsearch__box" :class="{ 'is-active': searchOpen && searchQuery.trim() }">
            <Icon name="search" :size="14" class="setsearch__icon" />
            <input
              ref="searchInput"
              v-model="searchQuery"
              class="setsearch__input"
              type="text"
              placeholder="搜索设置"
              spellcheck="false"
              @focus="searchOpen = searchQuery.trim().length > 0"
              @keydown.stop="onSearchKey"
            />
            <button
              v-if="searchQuery"
              class="setsearch__clear"
              type="button"
              aria-label="清空搜索"
              @click="clearSearch"
            >
              <Icon name="x" :size="12" />
            </button>
          </div>

          <div v-if="searchOpen && searchQuery.trim()" class="setsearch__panel">
            <p v-if="searchResults.length === 0" class="setsearch__empty">
              没有匹配的设置项
            </p>
            <button
              v-for="(item, index) in searchResults"
              :key="item.id"
              class="setsearch__item"
              :class="{ 'is-active': index === searchCursor }"
              type="button"
              @mousedown.prevent="jumpTo(item)"
              @mouseenter="searchCursor = index"
            >
              <span class="setsearch__label">{{ item.label }}</span>
              <span class="setsearch__meta">
                {{ item.note ?? settingsGroupById(item.group)?.label }}
              </span>
            </button>
          </div>
        </div>

        <div class="setnav__body scroll-y">
          <ul class="setnav__list">
            <li v-for="group in SETTINGS_GROUPS" :key="group.id">
              <button
                class="setnav__item"
                :class="{ 'is-active': ui.settingsGroup === group.id }"
                type="button"
                @click="selectGroup(group.id)"
              >
                <Icon :name="group.icon" :size="13" class="setnav__icon" />
                <span class="setnav__label">{{ group.label }}</span>
                <span class="setnav__num">{{ entryCountOf(group.id) }}</span>
              </button>
            </li>
          </ul>
        </div>
      </nav>

      <div ref="scroller" class="setmain">
        <div class="setmain__inner">
          <!-- ---------------------------------------------------------- 外观 -->
          <div v-show="ui.settingsGroup === 'appearance'" class="setgroup">
            <section id="sec-appearance" class="block">
              <div class="block__head">
                <Icon name="sun" :size="14" />
                <span class="block__title">外观</span>
              </div>
              <div class="block__body">
                <p class="field__label">主题</p>
                <div id="field-theme" v-seg-thumb class="choice-row">
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
                <label id="field-glass" class="switch glass-switch">
                  <input v-model="settings.glassEnabled" type="checkbox" />
                  <span class="switch__track" />
                  <span>毛玻璃效果</span>
                </label>
                <p class="hint">Windows 11 22H2 及以上生效，其余环境自动使用纯色。</p>
              </div>
            </section>
          </div>

          <!-- ------------------------------------------------- 识别与性能 -->
          <div v-show="ui.settingsGroup === 'engine'" class="setgroup">
            <section id="sec-backend" class="block">
              <div class="block__head">
                <Icon name="cpu" :size="14" />
                <span class="block__title">性能</span>
              </div>
              <div class="block__body">
                <p class="field__label">推理后端</p>
                <div id="field-backend" class="backend-list">
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
              </div>
            </section>

            <!-- 模型存储位置 -->
            <section id="models-dir" class="block">
              <div class="block__head">
                <Icon name="folder" :size="14" />
                <span class="block__title">模型存储位置</span>
              </div>
              <div class="block__body">
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
                  更改后<strong>只会</strong>从新位置查找，原位置已下载的模型需自行复制过去。
                </p>
              </div>
            </section>

            <!-- 识别相关的设置已整体移到「导入」页，方便每次导入前顺手调整 -->
            <section id="sec-recognize" class="block">
              <div class="block__head">
                <Icon name="wave" :size="14" />
                <span class="block__title">识别</span>
              </div>
              <div class="block__body">
                <button class="btn btn--sm" type="button" @click="ui.navigate('home')">
                  <Icon name="import" :size="13" />
                  <span>前往导入页设置</span>
                </button>
              </div>
            </section>
          </div>

          <!-- ---------------------------------------------------- 字幕处理 -->
          <div v-show="ui.settingsGroup === 'subtitle'" class="setgroup">
            <!-- 标点处理 -->
            <section id="sec-punctuation" class="block">
              <div class="block__head">
                <Icon name="spell-check" :size="14" />
                <span class="block__title">标点处理</span>
              </div>
              <div class="block__body">
                <div class="grid-2">
                  <label id="field-punct-zh" class="field">
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

                  <label id="field-punct-en" class="field">
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
            <section id="sec-spec" class="block">
              <div class="block__head">
                <Icon name="type" :size="14" />
                <span class="block__title">字幕规格</span>
              </div>
              <div class="block__body">
                <p class="punct-intro">
                  同时作用于 <strong>AI 校对提示词</strong>与<strong>导出折行</strong>。
                </p>
                <div class="grid-2">
                  <label id="field-maxCharsPerLine" class="field">
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

                  <label id="field-maxCharsPerLineEn" class="field">
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

                  <label id="field-maxLinesPerSegment" class="field">
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

                  <label id="field-maxSegmentDuration" class="field">
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
                <p class="punct-intro punct-intro--summary">
                  按当前设置：中文单条不超过
                  <strong>{{ settings.maxCharsPerLine * settings.maxLinesPerSegment }}</strong> 字，
                  英文单条不超过
                  <strong>{{ settings.maxCharsPerLineEn * settings.maxLinesPerSegment }}</strong> 字符。
                </p>
              </div>
            </section>

            <!-- 填充空隙 -->
            <section id="sec-gapfill" class="block">
              <div class="block__head">
                <Icon name="wand" :size="14" />
                <span class="block__title">填充空隙的默认参数</span>
              </div>
              <div class="block__body">
                <div class="grid-3">
                  <label id="field-gap-threshold" class="field">
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

                  <label id="field-gap-keep" class="field">
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

                  <label id="field-gap-max" class="field">
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
          </div>

          <!-- ------------------------------------------------------ AI 辅助 -->
          <div v-show="ui.settingsGroup === 'ai'" class="setgroup">
            <section id="sec-ai" class="block">
              <div class="block__head">
                <Icon name="spell-check" :size="14" />
                <span class="block__title">AI 校对</span>
              </div>
              <div class="block__body">
                <p id="field-ai-strength" class="field__label">原文案参考强度</p>
                <div class="levels">
                  <input
                    class="levels__input"
                    type="range"
                    min="0"
                    max="3"
                    step="1"
                    :value="settings.aiScriptStrength"
                    aria-label="原文案参考强度"
                    @input="onStrengthInput"
                  />
                  <div class="levels__ticks">
                    <button
                      v-for="item in SCRIPT_STRENGTH_OPTIONS"
                      :key="item.value"
                      class="levels__tick"
                      :class="{ 'is-on': settings.aiScriptStrength === item.value }"
                      type="button"
                      @click="settings.aiScriptStrength = item.value"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                </div>
                <p class="field__hint">{{ activeStrength.hint }}</p>
                <p class="field__hint">
                  只在 AI 校对的提示词里粘贴了原文稿时起作用；不贴文稿时这一项不影响结果。
                </p>

                <label id="field-ai-tip" class="switch tip-switch">
                  <input v-model="settings.aiReviewTipEnabled" type="checkbox" />
                  <span class="switch__track" />
                  <span>在编辑器显示「AI 校对」引导提示</span>
                </label>
                <p class="hint">
                  识别完成后，编辑器底部「AI 校对」按钮上方会出现一段提示。关掉后不再出现；
                  重新打开时会连「不再提示」一起复位。
                </p>
              </div>
            </section>
          </div>

          <!-- -------------------------------------------------------- 导出 -->
          <div v-show="ui.settingsGroup === 'export'" class="setgroup">
            <section id="sec-export" class="block">
              <div class="block__head">
                <Icon name="save" :size="14" />
                <span class="block__title">导出</span>
              </div>
              <div class="block__body">
                <div class="grid-2">
                  <label id="field-export-format" class="field">
                    <span class="field__label">默认格式</span>
                    <select v-model="settings.exportFormat" class="select">
                      <option value="srt">SRT</option>
                      <option value="vtt">VTT</option>
                      <option value="ass">ASS</option>
                      <option value="txt">TXT</option>
                    </select>
                  </label>

                  <label id="field-export-encoding" class="field">
                    <span class="field__label">默认编码</span>
                    <select v-model="settings.exportEncoding" class="select">
                      <option value="utf-8">UTF-8</option>
                      <option value="utf-8-bom">UTF-8 带 BOM</option>
                      <option value="gbk">GBK</option>
                    </select>
                  </label>

                  <label id="field-export-lineending" class="field">
                    <span class="field__label">换行符</span>
                    <select v-model="settings.exportLineEnding" class="select">
                      <option value="crlf">CRLF（Windows）</option>
                      <option value="lf">LF（Unix）</option>
                    </select>
                  </label>

                  <label id="field-output-mode" class="field">
                    <span class="field__label">输出位置</span>
                    <select v-model="settings.outputMode" class="select">
                      <option value="follow-source">跟随音频所在目录</option>
                      <option value="unified">统一输出到指定目录</option>
                      <option value="per-file">每个文件分别指定</option>
                    </select>
                  </label>
                </div>

                <label id="field-open-folder" class="switch limit-switch">
                  <input v-model="settings.openFolderAfterExport" type="checkbox" />
                  <span class="switch__track" />
                  <span>导出后打开所在文件夹</span>
                </label>
              </div>
            </section>
          </div>

          <!-- -------------------------------------------------------- 词表 -->
          <div v-show="ui.settingsGroup === 'words'" class="setgroup">
            <!-- 自定义替换词表 -->
            <section id="sec-dict" class="block">
              <div class="block__head">
                <Icon name="replace" :size="14" />
                <span class="block__title">自定义替换词表</span>
              </div>
              <div class="block__body">
                <p class="field__hint">
                  每行一条，用 <code>=</code> 或 <code>=&gt;</code> 分隔错词与正词，
                  <code>#</code> 开头不生效。
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

            <!-- 内置词表（只读） -->
            <section id="sec-wordbook" class="block">
              <div class="block__head">
                <Icon name="book" :size="14" />
                <span class="block__title">内置词表</span>
                <span class="block__badge">只读</span>
              </div>
              <div class="block__body">
                <p class="punct-intro">
                  断行切点靠它判断词边界，<strong>只参与断点判断</strong>，不发给识别引擎，也不改文字。
                </p>
                <div class="wb-stats">
                  <div class="wb-stat">
                    <span class="wb-stat__num">{{ commonWordCount }}</span>
                    <span class="wb-stat__label">常用词</span>
                  </div>
                  <div class="wb-stat">
                    <span class="wb-stat__num">{{ commonGroupCount }}</span>
                    <span class="wb-stat__label">常用词类别</span>
                  </div>
                  <div class="wb-stat">
                    <span class="wb-stat__num">{{ LEXICONS.length }}</span>
                    <span class="wb-stat__label">领域词库</span>
                  </div>
                  <div class="wb-stat">
                    <span class="wb-stat__num">{{ activeWrapCount }}</span>
                    <span class="wb-stat__label">当前实际生效</span>
                  </div>
                </div>
                <p class="field__hint">
                  含已勾选词库与手填领域词，去重后统计。
                </p>
                <div class="row-actions">
                  <button class="btn btn--sm" type="button" @click="wordbookOpen = true">
                    <Icon name="search" :size="13" />
                    <span>查看词表内容</span>
                  </button>
                </div>
              </div>
            </section>
          </div>

          <!-- ------------------------------------------------------ 快捷键 -->
          <div v-show="ui.settingsGroup === 'shortcut'" class="setgroup">
            <section id="sec-shortcuts" class="block">
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
          </div>

          <!-- -------------------------------------------------------- 其他 -->
          <div v-show="ui.settingsGroup === 'other'" class="setgroup">
            <section id="sec-diag" class="block">
              <div class="block__head">
                <Icon name="info" :size="14" />
                <span class="block__title">诊断信息</span>
              </div>
              <div class="block__body">
                <p class="field__hint">
                  识别出错或引擎异常退出时导出，发给开发者即可排查。<b>不含音频内容与字幕文本</b>。
                </p>
                <div class="diag">
                  <button class="btn" type="button" :disabled="diagBusy" @click="exportDiag">
                    {{ diagBusy ? '正在收集…' : '导出诊断信息' }}
                  </button>
                  <span v-if="diagNote" class="diag__note">{{ diagNote }}</span>
                </div>
              </div>
            </section>

            <section id="sec-reset" class="block">
              <div class="block__head">
                <Icon name="refresh" :size="14" />
                <span class="block__title">恢复默认</span>
              </div>
              <div class="block__body">
                <p class="field__hint">
                  把上面所有设置（含模型存储位置、词表与外观）恢复为出场状态。
                  该操作不可撤销，已下载的模型文件不会被删除。
                </p>
                <div class="row-actions">
                  <button class="btn btn--danger btn--sm" type="button" @click="reset">
                    恢复所有默认设置
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>

    <WordbookDialog v-if="wordbookOpen" @close="wordbookOpen = false" />
  </div>
</template>

<style scoped>
/* ---- 侧栏顶端的搜索 ---- */
/*
 * 搜索框从页头搬到了分组栏顶端：占位提示也压成「搜索设置」四个字，
 * 196px 的侧栏里放不下「搜索设置项，如 编码、毛玻璃、单行字数」那种举例式文案。
 * 容器只留上方内边距，下方改用 margin —— 结果面板靠 top:100% 定位，
 * 只有内边距为 0 时 100% 才正好是输入框的下沿。
 */
.setnav__search {
  flex: none;
  position: relative;
  padding: var(--space-3) var(--space-2) 0;
  margin-bottom: var(--space-2);
}

.setsearch__box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-height);
  padding: 0 var(--space-2) 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  transition: border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.setsearch__box:hover {
  border-color: var(--color-border-strong);
}

.setsearch__box:focus-within {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-subtle);
}

.setsearch__icon {
  flex: none;
  color: var(--color-text-tertiary);
}

.setsearch__input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.setsearch__input:focus {
  outline: none;
}

.setsearch__input::placeholder {
  color: var(--color-text-tertiary);
}

.setsearch__clear {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: var(--color-text-tertiary);
}

.setsearch__clear:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

/*
 * 结果面板比侧栏宽：条目标题 + 右侧分组说明挤在 196px 里必然被省略号吃掉，
 * 让它按 300px 往内容区方向张开，左边缘与输入框对齐。
 */
.setsearch__panel {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: var(--space-2);
  z-index: var(--z-dropdown, 40);
  width: 300px;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-lg);
}

.setsearch__empty {
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.setsearch__item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  text-align: left;
}

.setsearch__item.is-active {
  background: var(--color-bg-hover);
}

.setsearch__label {
  min-width: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.setsearch__meta {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

/* ---- 二级菜单 + 内容区 ---- */
.setbody {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 与编辑器左侧文件导航同一套观感：surface 底、右侧细边、条目选中填充 */
.setnav {
  width: 196px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border);
}

.setnav__body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--space-2) var(--space-3);
}

.setnav__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.setnav__item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.setnav__item:hover:not(.is-active) {
  background: var(--color-bg-hover);
}

.setnav__item.is-active {
  background: var(--color-accent-subtle);
  border-color: var(--color-accent-border);
}

.setnav__icon {
  flex: none;
  color: var(--color-text-tertiary);
}

.setnav__item.is-active .setnav__icon {
  color: var(--color-text-primary);
}

.setnav__label {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.setnav__num {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.setmain {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  /* 顶部取 space-3：与左侧搜索框的上内边距同值，两者顶边才对得齐 */
  padding: var(--space-3) var(--space-6) var(--space-6);
}

.setmain__inner {
  width: 100%;
  /*
   * 980px 不是随手取的：窗口 − 主侧栏 208 − 分组栏 196 − 左右内边距 48，
   * 默认 1480 窗口下可用 1028 —— 取 980 让表单在常见宽度下不被拉成超长单行，
   * 同时右侧仍留一点余量，窄窗自动收窄。
   */
  max-width: 980px;
  margin: 0 auto;
}

.setgroup {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.block__badge {
  margin-left: var(--space-1);
  padding: 1px 6px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  font-size: 10px;
  color: var(--color-text-tertiary);
}

/* 搜索跳转后的短暂高亮：目标区块描边 + 底色，1.6 秒后淡出 */
.is-flash {
  animation: settings-flash 1.6s var(--ease-out);
}

@keyframes settings-flash {
  0%,
  60% {
    box-shadow: 0 0 0 2px var(--color-accent-border);
    border-color: var(--color-accent-border);
  }
  100% {
    box-shadow: none;
  }
}

/* ---- 内置词表：数字概览 ---- */
.wb-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-3);
  margin: var(--space-3) 0;
}

.wb-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-inset);
}

.wb-stat__num {
  font-size: var(--font-size-lg);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.wb-stat__label {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

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
  margin-top: var(--space-3);
}

.punct-intro {
  margin-bottom: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  line-height: var(--line-base);
}

/* 紧跟在表单网格后面的结论行：不留上间距会和上一行的字段说明连成一段 */
.punct-intro--summary {
  margin-top: var(--space-4);
  margin-bottom: 0;
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
  margin: var(--space-2) 0;
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

.tip-switch {
  margin-top: var(--space-5);
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

.diag {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

/* 中文按钮在 flex 行里 min-content 只有一字宽，会被长说明压成竖排 —— 钉死不许收缩 */
.diag > .btn {
  flex-shrink: 0;
}

.diag__note {
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

/* 通用开关布局 */
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

/* ---- 窄窗口：左列收起，分组改横向标签条 ---- */
@media (max-width: 1080px) {
  .setbody {
    flex-direction: column;
  }

  .setnav {
    width: auto;
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  /* 搜索框跟着内容一起收边：横向模式下它独占一行，内边距要与下方标签条一致 */
  .setnav__search {
    padding: var(--space-3) var(--space-4) 0;
  }

  .setsearch__panel {
    left: var(--space-4);
  }

  /* 横向模式不要纵向滚动条，改成一条可横滚的标签带 */
  .setnav__body {
    overflow-x: auto;
    overflow-y: hidden;
    padding: var(--space-2) var(--space-4);
  }

  .setnav__list {
    flex-direction: row;
    gap: var(--space-2);
    width: max-content;
  }

  .setnav__item {
    width: auto;
    white-space: nowrap;
  }

  .setmain {
    padding: var(--space-4) var(--space-4) var(--space-5);
  }

  .grid-3,
  .wb-stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
