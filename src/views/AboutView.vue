<script setup lang="ts">
import { useSettingsStore } from '@/stores/settings'
import { useUpdateStore } from '@/stores/update'
import { useUiStore } from '@/stores/ui'
import { branding, appVersion } from '@/branding'
import Icon from '@/components/Icon.vue'

const settings = useSettingsStore()
const update = useUpdateStore()
const ui = useUiStore()

/** 手动检查。查到新版本直接把详情弹窗打开，省一次点击 */
async function checkNow(): Promise<void> {
  await update.check()
  if (update.phase === 'update') ui.openDialog('update')
}

async function openSite(): Promise<void> {
  const ok = await update.openTarget()
  if (!ok) ui.notify('error', '打不开官网', `请手动访问 ${update.targetUrl}`)
}

/** 协议入口。正文在 `src/legal`，这里只负责「看哪一份」 */
const LEGAL_ENTRIES = [
  {
    doc: 'terms' as const,
    name: '用户协议',
    desc: '软件授权范围、用户内容归属、识别结果性质、免责与责任限制',
  },
  {
    doc: 'privacy' as const,
    name: '隐私政策',
    desc: '会联网的功能逐项说明、本机保存的数据、剪贴板中继的边界',
  },
]

function openLegal(doc: 'terms' | 'privacy'): void {
  ui.openDialog('legal', { doc })
}

const LIBS = [
  { name: 'Electron', license: 'MIT License' },
  { name: 'Chromium', license: 'BSD 3-Clause License' },
  { name: 'Node.js', license: 'MIT License' },
  { name: 'Vue.js', license: 'MIT License' },
  { name: 'Pinia', license: 'MIT License' },
  { name: 'whisper.cpp', license: 'MIT License' },
  { name: 'OpenAI Whisper 模型权重', license: 'MIT License' },
  { name: 'BELLE 中文微调模型权重', license: 'Apache License 2.0' },
  { name: 'dr_libs（WAV / MP3 / FLAC 解码）', license: 'MIT-0 或 Public Domain' },
  { name: 'stb_vorbis（OGG Vorbis 解码）', license: 'MIT-0 或 Public Domain' },
  { name: 'libopus / libogg', license: 'BSD 3-Clause License' },
  { name: 'Vulkan-Headers', license: 'Apache License 2.0' },
  { name: '思源黑体 Source Han Sans SC', license: 'SIL Open Font License 1.1' },
]
</script>

<template>
  <div class="view">
    <header class="view__head">
      <div class="view__head-inner">
        <h1 class="view__title">关于本软件</h1>
      </div>
    </header>

    <div class="view__body">
      <div class="view__body-inner">
        <section class="hero">
          <span class="hero__mark" aria-hidden="true">
            <!-- 品牌图标缩微版：五柱黄金分割双色 + 三色字幕条，全部直角 -->
            <svg viewBox="0 0 20 20" width="26" height="26">
              <rect x="1.2" y="9" width="2.4" height="2.3" fill="#F2EADB" />
              <rect x="1.2" y="11.3" width="2.4" height="3.7" fill="#4A7BA6" />
              <rect x="5" y="6" width="2.4" height="3.4" fill="#C08A5F" />
              <rect x="5" y="9.4" width="2.4" height="5.6" fill="#4A7BA6" />
              <rect x="8.8" y="3.8" width="2.4" height="4.2" fill="#F2EADB" />
              <rect x="8.8" y="8" width="2.4" height="7" fill="#4A7BA6" />
              <rect x="12.6" y="7" width="2.4" height="3.1" fill="#C08A5F" />
              <rect x="12.6" y="10.1" width="2.4" height="4.9" fill="#4A7BA6" />
              <rect x="16.4" y="10" width="2.4" height="1.9" fill="#F2EADB" />
              <rect x="16.4" y="11.9" width="2.4" height="3.1" fill="#4A7BA6" />
              <rect x="1.2" y="17.2" width="9.9" height="1.6" fill="#4A7BA6" />
              <rect x="11.9" y="17.2" width="3.8" height="1.6" fill="#F2EADB" />
              <rect x="16.5" y="17.2" width="2.3" height="1.6" fill="#C08A5F" />
            </svg>
          </span>

          <div class="hero__text">
            <h2 class="hero__name">{{ branding.productName }}</h2>
            <p class="hero__version mono">版本 {{ appVersion }}</p>
          </div>

          <dl class="hero__meta">
            <div>
              <dt>开发者</dt>
              <dd>{{ branding.developer }}</dd>
            </div>
            <div>
              <dt>官网</dt>
              <dd>
                <a
                  :href="branding.website"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="hero__link"
                >
                  {{ branding.websiteLabel }}
                  <Icon name="external" :size="12" />
                </a>
              </dd>
            </div>
            <div>
              <dt>主站</dt>
              <dd>
                <a
                  :href="branding.mainSite"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="hero__link"
                >
                  {{ branding.mainSiteLabel }}
                  <Icon name="external" :size="12" />
                </a>
              </dd>
            </div>
          </dl>
        </section>

        <section class="block">
          <div class="block__head">
            <Icon name="download" :size="14" />
            <span class="block__title">软件更新</span>
          </div>
          <div class="block__body">
            <dl class="upd">
              <div class="upd__row">
                <dt>当前版本</dt>
                <dd class="mono">v{{ update.current }}</dd>
              </div>
              <div class="upd__row">
                <dt>最新版本</dt>
                <dd class="mono">{{ update.latest ? `v${update.latest}` : '—' }}</dd>
              </div>
              <div class="upd__row">
                <dt>状态</dt>
                <dd
                  :class="{
                    'upd__state--ok': update.phase === 'latest',
                    'upd__state--new': update.phase === 'update',
                    'upd__state--bad': update.phase === 'error',
                  }"
                >
                  {{ update.statusLabel }}
                </dd>
              </div>
            </dl>

            <div class="upd__actions">
              <button
                class="btn btn--sm"
                type="button"
                :disabled="update.phase === 'checking'"
                @click="checkNow"
              >
                <Icon name="refresh" :size="13" />
                <span>{{ update.phase === 'checking' ? '正在检查' : '检查更新' }}</span>
              </button>
              <button
                v-if="update.phase === 'update'"
                class="btn btn--sm"
                type="button"
                @click="openSite"
              >
                <Icon name="external" :size="13" />
                <span>前往官网更新</span>
              </button>
              <span class="spacer" />
              <label class="switch">
                <input v-model="settings.checkUpdateOnStart" type="checkbox" />
                <span class="switch__track"></span>
                <span class="upd__switch-label">启动时自动检查</span>
              </label>
            </div>

            <p class="upd__note">
              检查更新只读取一份版本清单（<span class="mono">{{ branding.updateSiteLabel }}</span
              >），不会上传任何数据。
            </p>
          </div>
        </section>

        <section class="block">
          <div class="block__head">
            <Icon name="shield" :size="14" />
            <span class="block__title">许可与合规声明</span>
          </div>
          <div class="block__body">
            <ul class="licenses">
              <li v-for="item in LIBS" :key="item.name" class="licenses__row">
                <span class="licenses__name">{{ item.name }}</span>
                <span class="licenses__license mono">{{ item.license }}</span>
              </li>
            </ul>

            <p class="licenses__note">
              本软件不含任何需要付费授权的组件，只内置可自由分发的开源音频解码实现
              （WAV、AIFF、MP3、FLAC、OGG Vorbis、Opus）。
              AAC、WMA、AMR、DTS 等格式的部分专利仍在保护期内，所以没有内置它们的解码器，
              需要先转换为上列任一格式。
            </p>
          </div>
        </section>

        <section class="block">
          <div class="block__head">
            <Icon name="info" :size="14" />
            <span class="block__title">隐私说明</span>
          </div>
          <div class="block__body">
            <ul class="privacy">
              <li>音频文件的解码、识别、编辑与导出全部在本机完成，不会上传到任何服务器。</li>
              <li>
                当前版本只有两处会联网：<strong>检查更新</strong>（向
                <span class="mono">{{ branding.updateSiteLabel }}</span> 读取版本清单，可在设置中关闭）与
                <strong>下载可选模型</strong>（访问模型仓库）。不下载模型时，关掉自动检查即可完全离线使用。
              </li>
              <li>软件不收集任何使用数据，不包含统计与埋点组件。</li>
              <li>AI 校对与 AI 翻译走系统剪贴板中继，由你自己粘贴到所选的在线服务，我们不接收也不存储这些内容。</li>
            </ul>
          </div>
        </section>

        <section class="block">
          <div class="block__head">
            <Icon name="book" :size="14" />
            <span class="block__title">协议与政策</span>
          </div>
          <div class="block__body">
            <div class="legal-grid">
              <button
                v-for="item in LEGAL_ENTRIES"
                :key="item.doc"
                class="legal-card"
                type="button"
                :data-legal="item.doc"
                @click="openLegal(item.doc)"
              >
                <span class="legal-card__head">
                  <span class="legal-card__name">{{ item.name }}</span>
                  <Icon name="chevron-right" :size="13" class="legal-card__arrow" />
                </span>
                <span class="legal-card__desc">{{ item.desc }}</span>
              </button>
            </div>
          </div>
        </section>

        <p class="copyright">{{ branding.copyright }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
}

.hero__mark {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  flex: none;
  border-radius: var(--radius-lg);
  /* 品牌深灰底：固定色，保证米白/陶土块在深浅两套主题下都清晰 */
  background: #2e3236;
}

.hero__text {
  flex: 1;
  min-width: 0;
}

.hero__name {
  font-size: var(--font-size-lg);
  font-weight: var(--weight-semibold);
}

.hero__version {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.hero__meta {
  display: flex;
  gap: var(--space-8);
}

.hero__meta dt {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.hero__meta dd {
  margin: 2px 0 0;
  font-size: var(--font-size-sm);
}

.hero__link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* ---- 软件更新 ---- */

.upd {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.upd__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
}

.upd__row:nth-child(odd) {
  background: var(--color-bg-inset);
}

.upd__row dt {
  width: 64px;
  flex: none;
  color: var(--color-text-tertiary);
}

.upd__row dd {
  margin: 0;
  min-width: 0;
  color: var(--color-text-secondary);
}

.upd__state--ok {
  color: var(--color-success);
}

.upd__state--new {
  color: var(--color-text-primary);
  font-weight: var(--weight-medium);
}

.upd__state--bad {
  color: var(--color-warning);
}

.upd__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.upd__switch-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.upd__note {
  margin-top: var(--space-3);
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-tertiary);
}

.licenses {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-1) var(--space-6);
}.licenses__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 5px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
}

.licenses__row:nth-child(odd) {
  background: var(--color-bg-inset);
}

.licenses__name {
  color: var(--color-text-secondary);
}

.licenses__license {
  flex: none;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.licenses__note {
  margin-top: var(--space-4);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-warning-subtle);
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}

.privacy {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  line-height: var(--line-loose);
  color: var(--color-text-secondary);
}

.privacy li {
  padding-left: var(--space-4);
  position: relative;
}

.privacy li::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 8px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent);
}

.privacy strong {
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

/* ---- 协议与政策入口 ---- */

.legal-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}

.legal-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  text-align: left;
  transition: border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.legal-card:hover {
  border-color: var(--color-accent-border);
  background: var(--color-bg-raised);
}

.legal-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.legal-card__name {
  font-size: var(--font-size-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-primary);
}

.legal-card__arrow {
  flex: none;
  color: var(--color-text-tertiary);
  transition: transform var(--dur-fast) var(--ease-out);
}

.legal-card:hover .legal-card__arrow {
  transform: translateX(2px);
  color: var(--color-text-secondary);
}

.legal-card__desc {
  font-size: 11px;
  line-height: var(--line-base);
  color: var(--color-text-tertiary);
}

.copyright {
  text-align: center;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  padding: var(--space-2) 0 var(--space-4);
}
</style>
