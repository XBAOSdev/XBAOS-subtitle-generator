<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useDownloadsStore } from '@/stores/downloads'
import Icon from '@/components/Icon.vue'
import type { AppInfo } from '@/types/engine'

const ui = useUiStore()
const settings = useSettingsStore()
const downloads = useDownloadsStore()

interface ModelItem {
  key: string
  name: string
  params: string
  sizeLabel: string
  quality: string
  /**
   * 许可证**逐个模型写**，不能共用一份。
   *
   * whisper.cpp 与 OpenAI 官方权重是 MIT，但社区中文微调版沿用自己的许可：
   * Belle-whisper-large-v3-turbo-zh 在 Hugging Face 上标的是 Apache-2.0。
   * 这里若统一写死 MIT，界面就对外发布了一条错误的许可信息 —— 有人照着
   * 「MIT」去做二次分发，会漏掉 Apache-2.0 的署名与变更声明义务。
   */
  license: string
  note: string
}

/**
 * key 与主进程 model-download.js 的 MODEL_CATALOG 一一对应，
 * 「切换使用」写入 settings.modelFile 后由引擎加载时解析。
 */
const MODELS: ModelItem[] = [
  {
    key: 'small',
    name: 'Whisper small',
    params: '244M',
    sizeLabel: '约 480MB',
    quality: '可用',
    license: 'MIT',
    note: '推荐。体积与准确度较平衡，首次使用建议先装这个',
  },
  {
    key: 'base',
    name: 'Whisper base',
    params: '74M',
    sizeLabel: '约 140MB',
    quality: '一般',
    license: 'MIT',
    note: '速度最快，适合先看整体效果',
  },
  {
    key: 'turbo',
    name: 'Whisper large-v3-turbo',
    params: '809M',
    sizeLabel: '约 1.6GB',
    quality: '很好',
    license: 'MIT',
    note: '速度与准确度较平衡',
  },
  {
    key: 'belle',
    name: 'Belle-whisper-large-v3-turbo-zh',
    params: '809M',
    sizeLabel: '约 1.6GB',
    quality: '最佳',
    license: 'Apache-2.0',
    note: '中文语料微调，中文口播与访谈首选',
  },
]

const bridge = window.xbaos
const info = ref<AppInfo | null>(null)

/**
 * 下载状态来自 downloads store，这里不自己订阅。
 *
 * 原因见那个 store 的注释：状态若挂在页面组件上，用户切走再回来进度就没了、
 * 按钮又变回「下载」，而主进程那边其实还在跑。这里只是把它映射成模板原本
 * 就在用的两个名字，模板一行都不用改。
 */
const downloading = computed(() => downloads.activeKey)
const progress = computed(() => downloads.progress)

/** 设置里记着的模型文件名。空串 = 没选过，识别时由主进程挑一个已装模型 */
const activeModelFile = computed(() => settings.modelFile)

/**
 * 这次实际会用哪个模型（**主进程权威判定**）。
 *
 * 不拿 `activeModelFile` 直接比名字：设置里存的是名字，文件可能已经被手动
 * 删掉或改过名 —— 只比名字会让界面挂着一个「使用中」的空壳，而识别那边
 * 早就回退到别的模型了（或者干脆没有模型可用）。
 */
const resolvedModel = ref('')

async function refreshResolved(): Promise<void> {
  if (!bridge?.models?.resolve) return
  try {
    const hit = await bridge.models.resolve(settings.modelFile)
    resolvedModel.value = hit?.name ?? ''
  } catch {
    resolvedModel.value = ''
  }
}

onMounted(() => void refreshInfo())

/*
 * 本页在 <KeepAlive> 里，切走再回来**不会**重新挂载 —— 而「模型文件夹里
 * 有没有东西」是页面之外发生的事（用户去资源管理器拖了个文件进来），
 * 所以 onActivated 必须再刷一次。首次挂载两个钩子都会触发，多扫一遍目录
 * 的代价可以忽略，比漏刷一次让用户以为没生效划算。
 */
onActivated(() => void refreshInfo())

async function refreshInfo(): Promise<void> {
  if (!bridge) return
  info.value = await bridge.info()
  await refreshResolved()
}

/**
 * 下载收尾后重新扫描一次模型列表。
 *
 * 「刷新列表」是页面自己的事（要更新 `info`），所以留在页面里；事件的其余处理
 * 统一在 store。取消或失败也会走到这里 —— 重扫一次代价很低，不值得为省这一下
 * 把三种收尾拆开，何况取消时磁盘上确实多了半个文件。
 */
watch(
  () => downloads.activeKey,
  (now, before) => {
    if (before && !now) void refreshInfo()
  },
)

/** 该条目对应的已安装模型（真实扫描，随下载/删除即时变化） */
function installedOf(item: ModelItem): AppInfo['models'][number] | null {
  const name = modelFileOf(item.key)
  const list = info.value?.models ?? []
  return list.find((m) => m.name === name) ?? null
}

// key -> 磁盘上的模型文件名（与主进程 MODEL_CATALOG 一致）
const FILE_BY_KEY: Record<string, string> = {
  small: 'ggml-small.bin',
  base: 'ggml-base.bin',
  turbo: 'ggml-large-v3-turbo.bin',
  belle: 'ggml-belle-large-v3-turbo-zh.bin',
}

function modelFileOf(key: string): string {
  return FILE_BY_KEY[key] ?? `ggml-${key}.bin`
}

function isDownloaded(item: ModelItem): boolean {
  return installedOf(item) !== null
}

/**
 * 该条目是不是「实际正在用」的那个模型。
 *
 * 判据取自主进程（resolvedModel）而不是设置里的名字 —— 设置里那个名字对应
 * 的文件可能已经被删掉或改了名，那样界面会一直挂着「使用中」。
 */
function activeKeyOf(item: ModelItem): boolean {
  return resolvedModel.value !== '' && resolvedModel.value === modelFileOf(item.key)
}

/**
 * 目录里躺着、但不属于内置目录的模型 —— 用户自己放进去的，文件名随意。
 *
 * 必须列出来：识别时主进程本来就会用上它们（内置档一个都没装就任取一个
 * 已装模型），界面若不显示，用户会看到「一个都没装」却又能识别成功，
 * 既无从理解，也没有入口切换或删掉它。
 */
const extraModels = computed(() => {
  const known = new Set(MODELS.map((m) => modelFileOf(m.key)))
  return (info.value?.models ?? []).filter((m) => !known.has(m.name))
})

function download(item: ModelItem): void {
  void downloads.start(item.key, item.name)
}

function cancelDownload(item: ModelItem): void {
  void downloads.cancel(item.key)
}

/** 切换到指定文件名的模型（内置档与用户自放的模型共用同一条路径） */
function useFile(name: string, label: string): void {
  settings.modelFile = name
  // 立即回显，不等下一次 IPC 往返 —— 否则点完按钮有半拍延迟
  resolvedModel.value = name
  ui.notify('success', `已切换到 ${label}`, '下一次识别开始生效')
}

function use(item: ModelItem): void {
  useFile(modelFileOf(item.key), item.name)
}

/** 可删除 = 位于用户自己的目录里；随包（bundled）与仓库内（dev）的删不了 */
function isRemovableSource(source: string): boolean {
  return source === 'user' || source === 'custom'
}

async function removeFile(name: string, label: string): Promise<void> {
  if (!bridge) return

  const ok = await bridge.dialog.confirm({
    title: '删除模型',
    message: `确定删除 ${label} 吗？`,
    detail: '删除后可以重新下载，或把模型文件放回模型文件夹。',
    buttons: ['取消', '删除'],
    defaultId: 0,
    cancelId: 0,
  })
  if (ok !== 1) return

  try {
    await bridge.models.remove(name)
    // 删的正是当前在用的那个：清掉设置，交给识别那边重新挑一个可用模型
    if (activeModelFile.value === name) settings.modelFile = ''
    ui.notify('info', `已删除 ${label}`)
    await refreshInfo()
  } catch (err) {
    ui.notify('error', '删除失败', err instanceof Error ? err.message : String(err))
  }
}

async function remove(item: ModelItem): Promise<void> {
  const installed = installedOf(item)
  if (!installed) return
  if (!isRemovableSource(installed.source)) {
    ui.notify('info', '该模型不在用户目录中', '无法在此删除，请直接删除对应文件')
    return
  }
  await removeFile(installed.name, item.name)
}

const storageDir = computed(() => info.value?.paths.downloadDir ?? '')

/** 字节数 → 显示用体积 */
function sizeText(bytes: number): string {
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${Math.round(mb)}MB`
}

/** 已安装显示真实字节数，未安装显示档位估计 */
function sizeLabelOf(item: ModelItem): string {
  const installed = installedOf(item)
  return installed ? sizeText(installed.size) : item.sizeLabel
}

/** 下载中的进度文案：总量未知时退化为已下载量 */
function progressText(key: string): string {
  // 模板里 computed 会自动解包，script 里必须显式 .value
  const p = progress.value[key]
  if (!p) return ''
  if (p.total > 0) {
    return `${p.percent.toFixed(1)}%`
  }
  const mb = p.received / 1024 / 1024
  return `${mb >= 1024 ? (mb / 1024).toFixed(2) + 'GB' : Math.round(mb) + 'MB'}`
}

function installedSourceOf(item: ModelItem): string {
  return installedOf(item)?.source ?? ''
}

/** 可删除 = 位于用户自己的目录里；随包（bundled / dev）的删不了 */
function isRemovable(item: ModelItem): boolean {
  return isRemovableSource(installedSourceOf(item))
}

/** 在系统文件管理器里打开模型文件夹，方便用户往里放自己的 ggml 模型 */
async function openModelsDir(): Promise<void> {
  if (!bridge) return
  try {
    const res = await bridge.models.openDir()
    if (!res.ok && res.message) ui.notify('error', '打不开模型文件夹', res.message)
  } catch (err) {
    ui.notify('error', '打不开模型文件夹', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 跳到设置页的「模型存储位置」章节并滚到那里。
 *
 * 换目录、恢复默认这些操作归设置页管（还牵扯迁移提醒），在模型页重复一套会分叉；
 * 但用户想改存储位置时第一反应就是来模型页，所以这里必须有个入口 ——
 * 直接把人送过去，而不是让他自己找。
 */
function goModelsDirSetting(): void {
  ui.navigate('settings', 'models-dir')
}
</script>

<template>
  <div class="view">
    <header class="view__head">
      <div class="view__head-inner">
        <h1 class="view__title">模型管理</h1>
        <p class="view__desc">
          模型不随安装包分发，首次使用前需要先下载一个，或把自己的 ggml 模型放进模型文件夹。
          识别全程在本机离线运行。
        </p>
      </div>
    </header>

    <div class="view__body">
      <div class="view__body-inner">
        <div class="notice">
          <Icon name="info" :size="14" />
          <p>
            <template v-if="storageDir">
              模型存储位置：<span class="mono">{{ storageDir }}</span
              ><br />
            </template>
            <template v-else>
              模型存储位置：<span class="mono">%APPDATA%\XBAOS\SubtitleGenerator\Models\</span
              ><br />
            </template>
            下载源为 Hugging Face 官方仓库，失败时自动切换国内镜像（hf-mirror.com），
            支持断点续传，下载完成会做文件完整性校验。
          </p>
        </div>

        <section
          v-for="item in MODELS"
          :key="item.key"
          class="model"
          :class="{ 'is-active': activeKeyOf(item) }"
        >
          <div class="model__main">
            <div class="model__title-row">
              <h2 class="model__name">{{ item.name }}</h2>
              <span v-if="activeKeyOf(item)" class="tag tag--ok">使用中</span>
              <span v-if="downloading === item.key" class="tag">下载中</span>
            </div>
            <p class="model__note">{{ item.note }}</p>

            <dl class="model__specs">
              <div>
                <dt>参数量</dt>
                <dd class="mono">{{ item.params }}</dd>
              </div>
              <div>
                <dt>占用空间</dt>
                <dd class="mono">{{ sizeLabelOf(item) }}</dd>
              </div>
              <div>
                <dt>中文准确度</dt>
                <dd>{{ item.quality }}</dd>
              </div>
              <div>
                <dt>许可证</dt>
                <dd class="mono">{{ item.license }}</dd>
              </div>
            </dl>
          </div>

          <div class="model__actions">
            <template v-if="downloading === item.key">
              <div class="model__progress">
                <div class="model__progress-track">
                  <span :style="{ width: `${progress[item.key]?.percent ?? 0}%` }" />
                </div>
                <span class="mono model__progress-text">{{ progressText(item.key) }}</span>
                <button class="btn btn--sm" type="button" @click="cancelDownload(item)">
                  取消
                </button>
              </div>
            </template>

            <template v-else-if="isDownloaded(item)">
              <button
                class="btn btn--sm"
                type="button"
                :disabled="activeKeyOf(item)"
                @click="use(item)"
              >
                {{ activeKeyOf(item) ? '当前使用' : '切换使用' }}
              </button>
              <button
                v-if="isRemovable(item)"
                class="btn btn--sm btn--danger"
                type="button"
                @click="remove(item)"
              >
                删除
              </button>
            </template>

            <button v-else class="btn btn--sm btn--primary" type="button" @click="download(item)">
              <Icon name="download" :size="13" />
              <span>下载</span>
            </button>
          </div>
        </section>

        <!-- 使用自己的模型 -->
        <section class="own">
          <div class="own__head">
            <Icon name="folder" :size="14" />
            <span class="own__title">使用自己的模型</span>
          </div>
          <p class="own__text">
            把 whisper.cpp 格式的 <span class="mono">.bin</span> 模型文件放进模型文件夹，
            回到这里点「刷新列表」就能切换使用。<strong>文件名不必和上面一致</strong>
            ：识别时会自动用上目录里可用的模型，不会因为改了名就找不到。
          </p>
          <p class="own__path mono">{{ storageDir || '（正在读取…）' }}</p>
          <p class="own__current">
            当前使用：<span class="mono">{{ resolvedModel || '未检测到可用模型' }}</span>
          </p>
          <div class="own__actions">
            <button class="btn btn--sm" type="button" :disabled="!bridge" @click="openModelsDir">
              <Icon name="folder-open" :size="13" />
              <span>打开模型文件夹</span>
            </button>
            <button class="btn btn--sm" type="button" @click="goModelsDirSetting">
              <Icon name="settings" :size="13" />
              <span>更改存储位置</span>
            </button>
            <button class="btn btn--sm" type="button" :disabled="!bridge" @click="refreshInfo">
              <Icon name="refresh" :size="13" />
              <span>刷新列表</span>
            </button>
          </div>

          <!-- 自己放进去的模型（文件名随意）。列出来才能切换与删除，
               否则它们在识别时会被用上，在界面上却完全看不到。 -->
          <ul v-if="extraModels.length" class="own__list">
            <li v-for="m in extraModels" :key="m.path" class="own__item">
              <div class="own__item-main">
                <span class="own__item-name mono">{{ m.name }}</span>
                <span class="own__item-size">{{ sizeText(m.size) }}</span>
              </div>
              <div class="own__item-actions">
                <span v-if="resolvedModel === m.name" class="tag tag--ok">使用中</span>
                <button v-else class="btn btn--sm" type="button" @click="useFile(m.name, m.name)">
                  切换使用
                </button>
                <button
                  v-if="isRemovableSource(m.source)"
                  class="btn btn--sm btn--danger"
                  type="button"
                  @click="removeFile(m.name, m.name)"
                >
                  删除
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="own__empty">模型文件夹里还没有检测到 <span class="mono">.bin</span> 文件。</p>

          <div class="own__warn">
            <Icon name="alert" :size="13" />
            <span>
              只支持 whisper.cpp 的 ggml 格式。其他格式（如 <span class="mono">.pt</span> /
              <span class="mono">.safetensors</span> / <span class="mono">ONNX</span>）
              无法加载、也不会出现在列表里 —— 放进去了但不兼容的文件，识别时会报错，
              那不是软件坏了，是格式不对。
            </span>
          </div>
        </section>

        <p class="hint">
          注：模型体积较大，纯 CPU 推理时大模型速度会明显下降。若机器支持 Vulkan，
          可在设置中开启硬件加速。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---- 使用自己的模型 ---- */
.own {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.own__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

.own__head :deep(.icon) {
  color: var(--color-text-tertiary);
}

.own__text {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  line-height: var(--line-base);
}

.own__path {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  overflow-wrap: anywhere;
}

.own__current {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

/* 用户自放的模型列表。行内是「名字（可换行）+ 按钮组」，
   按钮组必须 flex: none —— 长文件名一挤，中文按钮会掉成竖排 */
.own__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.own__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
}

.own__item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.own__item-name {
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

.own__item-size {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.own__item-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.own__empty {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.own__actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.own__warn {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-warning);
  line-height: var(--line-base);
}

.own__warn :deep(.icon) {
  flex: none;
  margin-top: 1px;
}

.notice {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-info-border);
  border-radius: var(--radius-md);
  background: var(--color-info-subtle);
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}

.notice :deep(.icon) {
  margin-top: 3px;
  color: var(--color-info);
}

.model {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
}

.model.is-active {
  border-color: var(--color-accent-border);
}

.model__main {
  flex: 1;
  min-width: 0;
}

.model__title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.model__name {
  font-size: var(--font-size-base);
  font-weight: var(--weight-semibold);
}

.tag {
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: var(--weight-medium);
}

.tag--ok {
  background: var(--color-success-subtle);
  color: var(--color-success);
}

.model__note {
  margin-top: 3px;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.model__specs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
  margin-top: var(--space-3);
}

.model__specs dt {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.model__specs dd {
  margin: 1px 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
  /* 许可证有的写 MIT、有的写 Apache-2.0，宽度不一。不锁 nowrap 的话
     「Apache-2.0」会在连字符处被折成两行，规格行高度跟着参差。 */
  white-space: nowrap;
}

.model__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.model__progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 160px;
}

.model__progress-track {
  flex: 1;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--color-bg-subtle);
  overflow: hidden;
}

.model__progress-track span {
  display: block;
  height: 100%;
  background: var(--color-accent);
  border-radius: var(--radius-pill);
  transition: width var(--dur-base) var(--ease-out);
}

.model__progress-text {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
