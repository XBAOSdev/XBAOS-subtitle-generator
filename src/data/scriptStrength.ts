/**
 * 「原文案参考强度」的四档定义。
 *
 * 档位文案同时出现在三处：设置页、AI 辅助窗口第 1 步、提示词构建器。
 * 写在一个文件里而不是各自抄一份 —— 用户看到的措辞和提示词里实际写的话
 * 一旦对不上，就会出现「界面说宽松，AI 却在逐字改」这种无从排查的问题。
 *
 * 滑块用的下标就是 `ScriptStrength` 的取值（0..3），不要另建映射：
 * 两套编号并存时，加一档就得改三处，漏一处就是错位。
 */

import type { ScriptStrength } from '@/types'

export interface ScriptStrengthOption {
  value: ScriptStrength
  /** 滑块刻度上的短标签，两个字以内，否则四列排不开 */
  label: string
  /** 选到这一档时显示的一句话解释 */
  hint: string
  /** 写进提示词的一句概括，语气要与该档的约束强度一致 */
  prompt: string
}

export const SCRIPT_STRENGTH_OPTIONS: readonly ScriptStrengthOption[] = [
  {
    value: 0,
    label: '严格',
    hint: '文稿即标准答案。识别结果与文稿不一致就按文稿改，整句不同、多字少字都算识别错误。',
    prompt: '这段音频是照着文稿逐字朗读的，文稿就是标准答案。',
  },
  {
    value: 1,
    label: '偏严',
    hint: '文稿优先，但只改「同一处对得上」的字词；朗读时多出来的口语不按文稿删。',
    prompt: '这段音频基本照着文稿朗读，个别地方有即兴改动，以文稿的用词为准。',
  },
  {
    value: 2,
    label: '平衡',
    hint: '只借文稿纠正同音字、专有名词与数字；整句对不上的地方保留识别结果。',
    prompt: '文稿只作参考，用来纠正读错的字，不用来改变说了什么。',
  },
  {
    value: 3,
    label: '宽松',
    hint: '只借文稿里的专有名词写法，其余只要读得通就不改。',
    prompt: '文稿仅供参考，只借它的专有名词写法，其余内容保持识别结果。',
  },
]

/** 把存储值夹到合法档位。旧存档里的越界值不至于让界面崩掉 */
export function normalizeStrength(value: number): ScriptStrength {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 2
  return Math.min(3, Math.max(0, n)) as ScriptStrength
}

export function strengthOption(value: number): ScriptStrengthOption {
  return SCRIPT_STRENGTH_OPTIONS[normalizeStrength(value)]
}
