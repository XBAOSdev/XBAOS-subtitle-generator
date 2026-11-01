/**
 * 设置页导航与搜索索引。
 *
 * 设置页做成「左侧分组 + 右侧内容」两级菜单，搜索框在分组栏顶端，直接跳到**某一个设置项**。
 * 索引放这里而不是塞进组件，有三个理由：
 *
 *   ① 搜索是纯函数，可以单测（`searchSettings`）；
 *   ② 分组与条目是数据，模板只负责渲染，新增设置项时改一处；
 *   ③ `section` / `anchor` 都是 DOM id，可以写一条源码扫描守门 ——
 *      设置页里删了某个区块却忘了删索引时，测试会直接报出来，
 *      而不是等用户搜到一条点进去什么也没发生。
 *
 * 约定：`section` 指向一个 `.block` 的 id；`anchor` 指向区块里某个具体控件的 id，
 * 缺省时直接滚到区块。搜索命中越细越好 —— 用户搜的是「编码」，不是「导出」。
 */

export interface SettingsGroup {
  id: string
  label: string
  /** Icon 组件里的名字 */
  icon: string
}

export interface SettingsEntry {
  id: string
  /** 设置项名称，搜索结果里直接显示 */
  label: string
  /** 所属区块的 DOM id */
  section: string
  /** 具体控件的 DOM id；缺省时滚到区块顶部 */
  anchor?: string
  group: string
  /** 同义词与口语说法，用来提高命中率 */
  keywords: string[]
  /** 结果行右侧的补充说明，缺省显示分组名 */
  note?: string
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'appearance', label: '外观', icon: 'sun' },
  { id: 'engine', label: '识别与性能', icon: 'cpu' },
  { id: 'subtitle', label: '字幕处理', icon: 'type' },
  { id: 'ai', label: 'AI 辅助', icon: 'spell-check' },
  { id: 'export', label: '导出', icon: 'save' },
  { id: 'words', label: '词表', icon: 'book' },
  { id: 'shortcut', label: '快捷键', icon: 'keyboard' },
  { id: 'other', label: '其他', icon: 'info' },
]

export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  // ---- 外观
  {
    id: 'theme',
    label: '主题',
    section: 'sec-appearance',
    anchor: 'field-theme',
    group: 'appearance',
    keywords: ['深色', '浅色', '暗色', '亮色', '跟随系统', '配色', '外观', 'dark', 'light'],
  },
  {
    id: 'glass',
    label: '毛玻璃效果',
    section: 'sec-appearance',
    anchor: 'field-glass',
    group: 'appearance',
    keywords: ['玻璃', '透明', '亚克力', '材质', 'acrylic', 'glass', '模糊'],
  },

  // ---- 识别与性能
  {
    id: 'backend',
    label: '推理后端',
    section: 'sec-backend',
    anchor: 'field-backend',
    group: 'engine',
    keywords: ['显卡', '核显', '加速', 'cpu', 'vulkan', 'gpu', '仅cpu', '性能'],
  },
  {
    id: 'models-dir',
    label: '模型存储位置',
    section: 'models-dir',
    group: 'engine',
    keywords: ['模型目录', '模型路径', '存放位置', '下载目录', '文件夹', 'ggml'],
  },
  {
    id: 'recognize',
    label: '识别设置入口',
    section: 'sec-recognize',
    group: 'engine',
    keywords: ['语言', '推理深度', '领域词库', '热词提示', '音质前处理', '导入页'],
    note: '位于导入页',
  },

  // ---- 字幕处理
  {
    id: 'punct-zh',
    label: '中文字幕标点处理',
    section: 'sec-punctuation',
    anchor: 'field-punct-zh',
    group: 'subtitle',
    keywords: ['标点', '顿号', '逗号', '切分', '去标点', '中文'],
  },
  {
    id: 'punct-en',
    label: '西文字幕标点处理',
    section: 'sec-punctuation',
    anchor: 'field-punct-en',
    group: 'subtitle',
    keywords: ['标点', '切分', '英文', '西文', '逗号'],
  },
  {
    id: 'spec-zh',
    label: '中文单行上限',
    section: 'sec-spec',
    anchor: 'field-maxCharsPerLine',
    group: 'subtitle',
    keywords: ['字数', '每行字数', '单行字数', '一行多少字', '宽度'],
  },
  {
    id: 'spec-en',
    label: '英文单行上限',
    section: 'sec-spec',
    anchor: 'field-maxCharsPerLineEn',
    group: 'subtitle',
    keywords: ['字符数', '每行字符', '英文宽度', '单行'],
  },
  {
    id: 'spec-lines',
    label: '单条最多行数',
    section: 'sec-spec',
    anchor: 'field-maxLinesPerSegment',
    group: 'subtitle',
    keywords: ['行数', '几行', '双行', '单行', '折行'],
  },
  {
    id: 'spec-duration',
    label: '单条时长上限',
    section: 'sec-spec',
    anchor: 'field-maxSegmentDuration',
    group: 'subtitle',
    keywords: ['时长', '秒数', '最长', '持续时间'],
  },
  {
    id: 'gapfill',
    label: '填充空隙参数',
    section: 'sec-gapfill',
    group: 'subtitle',
    keywords: ['空隙', '间隙', '空白', '补齐', '填充'],
  },
  {
    id: 'gapfill-threshold',
    label: '填充的间隔阈值',
    section: 'sec-gapfill',
    anchor: 'field-gap-threshold',
    group: 'subtitle',
    keywords: ['阈值', '间隔', '空隙', '多长才填'],
  },
  {
    id: 'gapfill-keep',
    label: '填充的保留间隙',
    section: 'sec-gapfill',
    anchor: 'field-gap-keep',
    group: 'subtitle',
    keywords: ['保留间隙', '边界闪烁', '空隙'],
  },
  {
    id: 'gapfill-max',
    label: '单条最长时长限制',
    section: 'sec-gapfill',
    anchor: 'field-gap-max',
    group: 'subtitle',
    keywords: ['最长时长', '上限', '填充'],
  },

  // ---- AI 辅助
  {
    id: 'ai-script-strength',
    label: '原文案参考强度',
    section: 'sec-ai',
    anchor: 'field-ai-strength',
    group: 'ai',
    keywords: ['校对', '文案', '文稿', '原稿', '强度', '严格', '宽松', '逐字', '照着念'],
    note: '仅在粘贴原文稿时生效',
  },
  {
    id: 'ai-tip',
    label: 'AI 校对引导提示',
    section: 'sec-ai',
    anchor: 'field-ai-tip',
    group: 'ai',
    keywords: ['气泡', '提示', '引导', '新手', '关掉', '不再提示', '悬浮'],
  },

  // ---- 导出
  {
    id: 'export-format',
    label: '默认导出格式',
    section: 'sec-export',
    anchor: 'field-export-format',
    group: 'export',
    keywords: ['srt', 'vtt', 'ass', 'txt', '格式', '字幕格式'],
  },
  {
    id: 'export-encoding',
    label: '默认编码',
    section: 'sec-export',
    anchor: 'field-export-encoding',
    group: 'export',
    keywords: ['utf8', 'utf-8', 'bom', 'gbk', '乱码', '字符集', '编码'],
  },
  {
    id: 'export-lineending',
    label: '换行符',
    section: 'sec-export',
    anchor: 'field-export-lineending',
    group: 'export',
    keywords: ['crlf', 'lf', '换行', '回车'],
  },
  {
    id: 'export-output',
    label: '输出位置',
    section: 'sec-export',
    anchor: 'field-output-mode',
    group: 'export',
    keywords: ['保存位置', '输出目录', '跟随源文件', '统一目录', '导出路径'],
  },
  {
    id: 'export-openfolder',
    label: '导出后打开所在文件夹',
    section: 'sec-export',
    anchor: 'field-open-folder',
    group: 'export',
    keywords: ['打开文件夹', '导出完成', '资源管理器'],
  },

  // ---- 词表
  {
    id: 'dict',
    label: '自定义替换词表',
    section: 'sec-dict',
    group: 'words',
    keywords: ['替换', '纠错', '错词', '正词', '词表', '批量替换'],
  },
  {
    id: 'wordbook',
    label: '内置词表',
    section: 'sec-wordbook',
    group: 'words',
    keywords: ['断句', '断行', '常用词', '领域词库', '只读', '查看词库', '分词'],
  },

  // ---- 快捷键
  {
    id: 'shortcuts',
    label: '快捷键一览',
    section: 'sec-shortcuts',
    group: 'shortcut',
    keywords: ['热键', '按键', '组合键', '键盘'],
  },

  // ---- 其他
  {
    id: 'diag',
    label: '诊断信息导出',
    section: 'sec-diag',
    group: 'other',
    keywords: ['日志', '报错', '排查', '崩溃', '导出诊断'],
  },
  {
    id: 'reset',
    label: '恢复所有默认设置',
    section: 'sec-reset',
    group: 'other',
    keywords: ['重置', '清空设置', '还原', '默认值'],
  },
]

export function settingsGroupById(id: string): SettingsGroup | undefined {
  return SETTINGS_GROUPS.find((g) => g.id === id)
}

/** 每个分组下有几个设置项，左侧导航显示用 */
export function entryCountOf(groupId: string): number {
  return SETTINGS_ENTRIES.filter((e) => e.group === groupId).length
}

/** DOM id → 所属分组。深链（从模型页跳过来）用它决定先切哪一组 */
export function groupOfDomId(domId: string): string | null {
  const hit = SETTINGS_ENTRIES.find((e) => e.section === domId || e.anchor === domId)
  return hit?.group ?? null
}

/** 把查询串拆成词：空格分隔，全角空格也算 */
function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s\u3000]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * 搜索设置项。
 *
 * 规则很简单：**所有词都要命中**（AND），每个词可以命中名称、同义词或分组名。
 * 不做模糊匹配也不排序打分 —— 设置项总共二十几条，子串匹配已经够准，
 * 加打分反而会让「编码」把「解码」相关项排到前面。
 */
export function searchSettings(query: string): SettingsEntry[] {
  const words = tokens(query)
  if (words.length === 0) return []

  return SETTINGS_ENTRIES.filter((entry) => {
    const groupLabel = settingsGroupById(entry.group)?.label ?? ''
    const haystack = [entry.label, ...entry.keywords, groupLabel, entry.note ?? '']
      .join(' ')
      .toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}
