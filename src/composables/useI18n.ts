/**
 * 极简 i18n
 *
 * 一期只提供简体中文。这里保留完整的 key 查找与插值能力，
 * 未来加入多语言时只需：
 *   1. 新增 src/locales/en-US.ts
 *   2. 在 messages 中注册
 *   3. 设置页增加语言选项
 * 组件代码不需要改动。
 */

import { computed, ref, type ComputedRef } from 'vue'
import zhCN from '@/locales/zh-CN'

export type LocaleCode = 'zh-CN'

const messages: Record<LocaleCode, Record<string, unknown>> = {
  'zh-CN': zhCN,
}

const currentLocale = ref<LocaleCode>('zh-CN')

/** 按 a.b.c 路径取值 */
function resolve(dict: Record<string, unknown>, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, dict)
  return typeof value === 'string' ? value : undefined
}

export interface I18n {
  locale: ComputedRef<LocaleCode>
  /** 取文案；缺 key 时回退到 key 本身，方便开发期发现遗漏 */
  t: (key: string, vars?: Record<string, string | number>) => string
  /** 当前可选语言列表 */
  availableLocales: { code: LocaleCode; label: string }[]
  setLocale: (code: LocaleCode) => void
}

export function useI18n(): I18n {
  return {
    locale: computed(() => currentLocale.value),

    t(key: string, vars?: Record<string, string | number>): string {
      const dict = messages[currentLocale.value]
      let text = resolve(dict, key)
      if (text === undefined) text = resolve(messages['zh-CN'], key) ?? key
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
        }
      }
      return text
    },

    availableLocales: [{ code: 'zh-CN', label: '简体中文' }],

    setLocale(code: LocaleCode): void {
      currentLocale.value = code
    },
  }
}
