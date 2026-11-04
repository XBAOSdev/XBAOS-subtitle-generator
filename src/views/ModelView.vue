<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useDownloadsStore } from '@/stores/downloads'
import { useModelStore } from '@/stores/model'
import Icon from '@/components/Icon.vue'
import type { AppInfo, ModelCatalogItem, ModelFileInfo, ModelKind } from '@/types/engine'

const ui = useUiStore()
const settings = useSettingsStore()
const downloads = useDownloadsStore()
const model = useModelStore()

const bridge = window.xbaos

/**
 * 三个数据源，职责分明，不互相推导：
 *   catalog  主进程给的可下载条目（内置清单 + 架构 / 发行者 / 协议）
 *   info     磁盘上真实扫到的模型（含用户自己放的）
 *   model    主进程判定的「当前生效模型与架构」（stores/model.ts）
 *
 * 「使用中」只认 model.entry —— 拿设置里的字符串比一比会在文件被手动删掉之后
 * 留下一个空壳标记，而识别那边早就回退到别的模型了。
 */
const catalog = ref<ModelCatalogItem[]>([])
const info = ref<AppInfo | null>(null)
const loading = ref(true)
/** 取数失败时的可读原因。没有它，页面只会空着，看不出断在哪一步 */
const loadError = ref('')

const installed = computed<ModelFileInfo[]>(() => info.value?.models ?? [])

/** 下载状态来自 store：页面切走再回来进度还在，主进程那边的下载也不受影响 */
const downloading = computed(() => downloads.activeKey)
const progress = computed(() => downloads.progress)

/** 内置条目 → 磁盘上对应那一份 */
function installedOf(item: ModelCatalogItem): ModelFileInfo | null {
  return installed.value.find((m) => m.id === item.id) ?? null
}

/** 内置清单里的磁盘标识，用来兜底过滤，见 ownModels */
const catalogIds = computed(() => new Set(catalog.value.map((c) => c.id)))

/**
 * 用户自己放进目录、且不在内置清单里的模型。
 *
 * 必须列出来：识别时主进程本来就会用上它们，界面若不显示，用户会看到
 * 「一个都没下载」却又能识别成功，既无从理解，也没有入口切换或删掉它。
 *
 * 两个条件都要判：`catalogKey` 是主进程打的标，`catalogIds` 是拿当前清单
 * 再核一遍。只信前者的话，主进程还没重启、下发的是旧结构时，内置模型会
 * 全部落到这里，和上方卡片重复一遍。
 */
const ownModels = computed(() =>
  installed.value.filter((m) => !m.catalogKey && !catalogIds.value.has(m.id)),
)

/** 空态要说清是「一个模型都没有」还是「只有内置的」，两种情况该做的事完全不同 */
const hasAnyModel = computed(() => installed.value.length > 0)

/** 兜底顺序里第一个已装的内置条目没有时，标一下当前是谁在生效 */
const activeEntry = computed(() => model.entry)

onMounted(() => void refresh())
// 本页在 <KeepAlive> 里，切走再回来不重新挂载 —— 而模型目录是页面之外会变的东西
onActivated(() => void refresh())

async function refresh(): Promise<void> {
  if (!bridge) {
    // 浏览器预览：清单在主进程侧，没有桥就取不到，如实说明比空列表好
    loading.value = false
    return
  }
  loadError.value = ''
  try {
    /*
     * 两份数据分开兜错，不要用裸的 Promise.all。
     * 曾经因为 app:info 抛错（漏导入一个常量），整体 reject，内置清单连同
     * 下载入口一起消失，页面上只剩「正在读取」—— 用户既看不到模型，也无从
     * 判断是哪一步断的。分开取，坏一个还有一个，坏的那个把原因显示出来。
     */
    const [nextInfo, nextCatalog] = await Promise.all([
      bridge.info().catch((err: unknown) => {
        loadError.value = err instanceof Error ? err.message : String(err)
        return null
      }),
      bridge.models.catalog().catch((err: unknown) => {
        loadError.value = err instanceof Error ? err.message : String(err)
        return [] as ModelCatalogItem[]
      }),
    ])
    if (nextInfo) info.value = nextInfo
    catalog.value = nextCatalog
    await model.refresh()
  } finally {
    loading.value = false
  }
}

/** 扫描磁盘（用户在资源管理器里动过文件之后用），比 refresh 多一层重判架构 */
async function rescan(): Promise<void> {
  if (!bridge) return
  await bridge.models.refresh()
  await refresh()
}

// 下载收尾后重扫：取消与失败也走这里 —— 磁盘上确实多了半个文件
watch(
  () => downloads.activeKey,
  (now, before) => {
    if (before && !now) void refresh()
  },
)

function download(item: ModelCatalogItem): void {
  void downloads.start(item.key, item.name)
}

function cancelDownload(item: ModelCatalogItem): void {
  void downloads.cancel(item.key)
}

/**
 * 切换使用。写进去的是**模型标识**（文件名或目录名），由主进程解析成路径，
 * 顺便判定架构 —— 界面不参与「这该用哪个引擎」的判断。
 */
async function useModel(id: string, label: string): Promise<void> {
  settings.modelFile = id
  await refresh()
  const next = model.entry?.id === id ? model.archLabel : ''
  ui.notify('success', `已切换到 ${label}`, next ? `架构 ${next}` : '下一次识别开始生效')
}

function isActiveId(id: string): boolean {
  return activeEntry.value?.id === id
}

/** 目录型模型引擎认不出来（不是 SenseVoice）时不能切换，只能提示 */
function unsupported(m: ModelFileInfo): boolean {
  return m.arch === 'sherpa' && m.variant !== 'sensevoice'
}

/** 可删除 = 在用户自己的目录里；随包（bundled）与仓库内（dev）的删不了 */
function isRemovableSource(source: string): boolean {
  return source === 'user' || source === 'custom'
}

async function removeModel(id: string, label: string, kind: ModelKind): Promise<void> {
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
    await bridge.models.remove(id, kind)
    // 删的正是当前在用的那个：清掉设置，交给主进程重新挑一个可用模型
    if (settings.modelFile === id) settings.modelFile = ''
    ui.notify('info', `已删除 ${label}`)
    await rescan()
  } catch (err) {
    ui.notify('error', '删除失败', err instanceof Error ? err.message : String(err))
  }
}

const storageDir = computed(() => info.value?.paths.downloadDir ?? '')

/** 字节数 → 显示用体积 */
function sizeText(bytes: number): string {
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${Math.round(mb)}MB`
}

/** 已装显示真实字节数，未装显示档位估计 */
function sizeLabelOf(item: ModelCatalogItem): string {
  const hit = installedOf(item)
  return hit ? sizeText(hit.size) : item.sizeLabel
}

/** 当前生效架构是否缺少引擎可执行文件（开发态常见，正式包不该出现） */
const engineMissing = computed(() => {
  const arch = model.arch
  if (!arch || !info.value) return false
  return info.value.engines?.[arch]?.available === false
})

async function openModelsDir(): Promise<void> {
  if (!bridge) return
  try {
    const res = await bridge.models.openDir()
    if (!res.ok && res.message) ui.notify('error', '打不开模型文件夹', res.message)
  } catch (err) {
    ui.notify('error', '打不开模型文件夹', err instanceof Error ? err.message : String(err))
  }
}

/** 存储位置归设置页管（还牵扯迁移提醒），这里只把人送过去 */
function goModelsDirSetting(): void {
  ui.navigate('settings', 'models-dir')
}
</script>

<template>
  <div class="view">
    <div class="view__body">
      <div class="view__body-inner">
        <!-- 当前架构 -->
        <section class="arch">
          <div class="arch__info">
            <div class="arch__row">
              <span class="arch__label">当前架构</span>
              <span v-if="activeEntry" class="arch__value">{{ model.archLabel }}</span>
              <span v-else-if="loading" class="arch__value">正在读取</span>
              <span v-else class="arch__value arch__value--none">未检测到可用模型</span>
            </div>
            <div v-if="activeEntry" class="arch__sub">
              <span class="arch__model">{{ activeEntry.name }}</span>
              <span class="arch__sep">/</span>
              <span class="mono arch__path">{{ activeEntry.path }}</span>
            </div>
            <div v-if="engineMissing" class="arch__warn">
              <Icon name="alert" :size="13" />
              <span>当前架构的识别引擎缺失，请重新安装或先编译引擎</span>
            </div>
          </div>
          <div class="arch__actions">
            <button class="btn btn--sm" type="button" :disabled="!bridge" @click="openModelsDir">
              <Icon name="folder-open" :size="13" />
              <span>模型文件夹</span>
            </button>
            <button class="btn btn--sm" type="button" @click="goModelsDirSetting">
              <Icon name="settings" :size="13" />
              <span>存储位置</span>
            </button>
            <button class="btn btn--sm" type="button" @click="rescan">
              <Icon name="refresh" :size="13" />
              <span>重新扫描</span>
            </button>
          </div>
        </section>

        <!-- 内置条目 -->
        <p v-if="!bridge" class="own__empty">浏览器预览读不到模型清单，请在桌面应用中使用</p>
        <p v-else-if="loadError" class="load-error">
          <Icon name="alert" :size="13" />
          <span>模型清单读取失败：{{ loadError }}</span>
        </p>
        <section
          v-for="item in catalog"
          :key="item.key"
          class="model"
          :class="{ 'is-active': isActiveId(item.id) }"
        >
          <div class="model__main">
            <div class="model__head">
              <h2 class="model__name">{{ item.name }}</h2>
              <span v-if="item.key === 'sensevoice-small'" class="tag tag--rec">推荐</span>
              <span v-if="isActiveId(item.id)" class="tag tag--ok">使用中</span>
              <!-- 「装着但没在用」必须看得见：这是最容易发生的误解 -->
              <span v-else-if="installedOf(item)" class="tag tag--idle">未启用</span>
              <span v-if="downloading === item.key" class="tag">下载中</span>
            </div>
            <p class="model__summary">{{ item.summary }}</p>

            <dl class="model__specs">
              <div>
                <dt>架构</dt>
                <dd>{{ item.engine }}</dd>
              </div>
              <div>
                <dt>发行者</dt>
                <dd>{{ item.publisher }}</dd>
              </div>
              <div>
                <dt>协议</dt>
                <dd :title="item.licenseUrl">{{ item.license }}</dd>
              </div>
              <div>
                <dt>参数量</dt>
                <dd class="mono">{{ item.params }}</dd>
              </div>
              <div>
                <dt>占用空间</dt>
                <dd class="mono">{{ sizeLabelOf(item) }}</dd>
              </div>
              <div>
                <dt>语种</dt>
                <dd>{{ item.langs }}</dd>
              </div>
            </dl>
          </div>

          <div class="model__actions">
            <template v-if="downloading === item.key">
              <div class="progress">
                <div class="progress__track">
                  <span :style="{ width: `${progress[item.key]?.percent ?? 0}%` }" />
                </div>
                <span class="mono progress__text">
                  {{ (progress[item.key]?.percent ?? 0).toFixed(1) }}%
                </span>
              </div>
              <button class="btn btn--sm" type="button" @click="cancelDownload(item)">
                取消
              </button>
            </template>

            <template v-else-if="installedOf(item)">
              <button
                class="btn btn--sm"
                type="button"
                :disabled="isActiveId(item.id)"
                @click="useModel(item.id, item.name)"
              >
                {{ isActiveId(item.id) ? '当前使用' : '切换使用' }}
              </button>
              <button
                v-if="isRemovableSource(installedOf(item)!.source)"
                class="btn btn--sm btn--danger"
                type="button"
                @click="removeModel(item.id, item.name, item.kind)"
              >
                删除
              </button>
            </template>

            <button
              v-else
              class="btn btn--sm btn--primary"
              type="button"
              :disabled="!!downloading"
              @click="download(item)"
            >
              <Icon name="download" :size="13" />
              <span>下载</span>
            </button>
          </div>
        </section>

        <!-- 自己的模型 -->
        <section class="own">
          <div class="own__head">
            <Icon name="folder" :size="14" />
            <span class="own__title">自己的模型</span>
          </div>
          <p class="own__text">
            把模型放进模型文件夹后点「重新扫描」。支持单个
            <span class="mono">.bin</span> 文件，或含
            <span class="mono">model.int8.onnx</span> 与
            <span class="mono">tokens.txt</span> 的文件夹，架构按内容自动判定。
          </p>
          <p class="own__path mono">{{ storageDir || '正在读取' }}</p>

          <ul v-if="ownModels.length" class="own__list">
            <li v-for="m in ownModels" :key="m.path" class="own__item">
              <div class="own__item-main">
                <span class="own__item-name mono">{{ m.id }}</span>
                <span class="own__item-arch">{{ m.kind === 'dir' ? '目录' : '文件' }}</span>
                <span class="own__item-size mono">{{ sizeText(m.size) }}</span>
              </div>
              <div class="own__item-actions">
                <span v-if="isActiveId(m.id)" class="tag tag--ok">使用中</span>
                <span v-else-if="unsupported(m)" class="tag tag--idle">不支持</span>
                <button
                  v-else
                  class="btn btn--sm"
                  type="button"
                  @click="useModel(m.id, m.id)"
                >
                  切换使用
                </button>
                <button
                  v-if="isRemovableSource(m.source)"
                  class="btn btn--sm btn--danger"
                  type="button"
                  @click="removeModel(m.id, m.id, m.kind)"
                >
                  删除
                </button>
              </div>
            </li>
          </ul>
          <p v-else-if="!hasAnyModel" class="own__empty">模型文件夹里还没有检测到可用的模型。</p>
          <p v-else class="own__empty">除上面的内置条目外，模型文件夹里没有其他模型。</p>
        </section>

        <!-- 下载来源与责任边界 -->
        <section class="source">
          <div class="source__head">
            <Icon name="download" :size="14" />
            <span class="source__title">模型从哪来</span>
          </div>
          <div class="source__chain">
            <span class="source__hop mono">ModelScope</span>
            <span class="source__arrow">→</span>
            <span class="source__hop mono">hf-mirror</span>
            <span class="source__arrow">→</span>
            <span class="source__hop mono">huggingface.co</span>
          </div>
          <p class="source__text">
            依次尝试上面的来源，每个文件都做 SHA-256 校验，不符即拒收。
          </p>
          <p class="source__text">
            模型是第三方内容，不属于本软件；权利与许可归各自发布者，本软件只负责下载、校验与调用，不对第三方站点负责。
          </p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---- 当前架构 ---- */
.arch {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-sm);
}

.arch__info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.arch__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.arch__label {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.arch__value {
  font-size: var(--font-size-md);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

.arch__value--none {
  font-weight: var(--weight-regular);
  color: var(--color-text-secondary);
}

.arch__sub {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.arch__model {
  flex-shrink: 0;
}

.arch__sep {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}

.arch__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-tertiary);
}

.arch__warn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-warning);
}

.arch__actions {
  display: flex;
  flex-shrink: 0;
  gap: var(--space-2);
}

/* ---- 模型条目 ---- */
.model {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.model.is-active {
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-sm), inset 0 0 0 1px var(--color-accent-border);
}

.model__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
}

.model__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /*
   * 固定标题行高。带「使用中 / 未启用」标签的卡片，标题行会被标签撑到 21px，
   * 没标签的只有 19px —— 下面整块字段跟着下移 2px，五张卡片看起来就参差不齐。
   */
  min-height: 22px;
}

.model__name {
  font-size: var(--font-size-md);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

.model.is-active .model__name {
  font-weight: var(--weight-semibold);
}

.model__summary {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

/*
 * 三列两行、列宽均等。
 *
 * 之前是六列横排、宽度按 1.1/1.1/1.45/0.6/0.8/1.15 分配，列间距落在
 * 172/176/214/130/146 上 —— 每一列都对齐，但间隔忽宽忽窄，看着散。
 * 等宽以后每列都从同一条竖线起头；两行也避免了窄窗口下长值把列挤折行。
 */
.model__specs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3) var(--space-4);
  margin-top: var(--space-1);
}

.model__specs dt {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.model__specs dd {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

.model__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  /*
   * 宽度必须固定。
   *
   * 按钮组是「切换使用 + 删除」两个还是一个，会改变左侧内容区的可用宽度 ——
   * 而字段是三等分的 grid，于是每张卡片的三列起点都不一样，看起来就是
   * 「文字没对齐」。固定成能容下两个按钮的宽度，字段区才真正逐列对齐。
   */
  width: 172px;
  padding-top: 2px;
}

/* ---- 下载进度 ---- */
.progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 168px;
}

.progress__track {
  position: relative;
  overflow: hidden;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--color-bg-inset);
}

.progress__track span {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 2px;
  background: var(--color-accent);
  transition: width 180ms linear;
}

.progress__text {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

/* ---- 自己的模型 ---- */
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
  overflow: hidden;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.own__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.own__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.own__item-main {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: var(--space-2);
}

.own__item-name {
  overflow: hidden;
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.own__item-arch,
.own__item-size {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.own__item-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--space-2);
}

.own__empty {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.load-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  font-size: var(--font-size-xs);
  color: var(--color-warning);
}

/* ---- 下载来源 ---- */

.source {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.source__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

.source__head :deep(.icon) {
  color: var(--color-text-tertiary);
}

.source__text {
  font-size: var(--font-size-xs);
  line-height: var(--line-base);
  color: var(--color-text-secondary);
}

/* 回退顺序是这一块的重点：用等宽字体 + 箭头串成一行，扫一眼就知道顺序 */
.source__chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg-inset);
}

.source__hop {
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

.source__arrow {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

/* 「推荐」只是给首选模型一个轻标记，不用彩色，也不加左侧饰线 */
.tag--rec {
  padding: 1px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg-inset);
  font-size: var(--font-size-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-secondary);
}
</style>
