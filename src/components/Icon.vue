<script setup lang="ts">
/**
 * 内联 SVG 图标集
 * 全部为几何线条自绘，不使用第三方图标库素材，不使用 emoji。
 */

withDefaults(
  defineProps<{
    name: string
    size?: number | string
    strokeWidth?: number
  }>(),
  {
    size: 16,
    strokeWidth: 1.6,
  },
)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="icon"
  >
    <!-- 导入 / 添加文件 -->
    <template v-if="name === 'import'">
      <path d="M12 3v11" />
      <path d="M8 10.5 12 14.5l4-4" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </template>

    <!-- 播放 / 暂停 -->
    <template v-else-if="name === 'play'">
      <path d="M8 5.5 18.5 12 8 18.5Z" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'pause'">
      <rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'stop'">
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" fill="currentColor" stroke="none" />
    </template>

    <!-- 循环 -->
    <template v-else-if="name === 'loop'">
      <path d="M4 9.5A4.5 4.5 0 0 1 8.5 5H17" />
      <path d="M14.5 2.5 17.5 5l-3 2.5" />
      <path d="M20 14.5A4.5 4.5 0 0 1 15.5 19H7" />
      <path d="M9.5 21.5 6.5 19l3-2.5" />
    </template>

    <!-- 状态：已编辑 / 待查看 / 有问题 / 失败 -->
    <template v-else-if="name === 'check'">
      <path d="M5 12.5 9.5 17 19 7" />
    </template>
    <template v-else-if="name === 'dot'">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'dot-outline'">
      <circle cx="12" cy="12" r="4" />
    </template>
    <template v-else-if="name === 'alert'">
      <path d="M12 4.5 21 19.5H3Z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'ban'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M6.4 17.6 17.6 6.4" />
    </template>
    <template v-else-if="name === 'spinner'">
      <path d="M12 3.5a8.5 8.5 0 1 1-6.01 2.49" />
    </template>

    <!-- 通用操作 -->
    <template v-else-if="name === 'x'">
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5.5v13M5.5 12h13" />
    </template>
    <template v-else-if="name === 'minus'">
      <path d="M5.5 12h13" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v5h-5" />
    </template>
    <template v-else-if="name === 'undo'">
      <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8" />
      <path d="M7.5 5 3.5 9l4 4" />
    </template>
    <template v-else-if="name === 'redo'">
      <path d="M20 9h-9.5a5.5 5.5 0 0 0 0 11H16" />
      <path d="M16.5 5l4 4-4 4" />
    </template>

    <!-- 方向 -->
    <template v-else-if="name === 'chevron-down'">
      <path d="M6.5 9.5 12 15l5.5-5.5" />
    </template>
    <template v-else-if="name === 'chevron-right'">
      <path d="M9.5 6.5 15 12l-5.5 5.5" />
    </template>
    <template v-else-if="name === 'chevron-left'">
      <path d="M14.5 6.5 9 12l5.5 5.5" />
    </template>
    <template v-else-if="name === 'chevron-up'">
      <path d="M6.5 14.5 12 9l5.5 5.5" />
    </template>
    <template v-else-if="name === 'arrow-up'">
      <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
    </template>
    <template v-else-if="name === 'arrow-down'">
      <path d="M12 5v14M6.5 13.5 12 19l5.5-5.5" />
    </template>

    <!-- 文件与目录 -->
    <template v-else-if="name === 'file-audio'">
      <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7Z" />
      <path d="M14 3v4h4" />
      <path d="M10.5 16.2v-3.4l4-1v3.4" />
      <circle cx="9.6" cy="16.6" r="1.1" />
      <circle cx="13.6" cy="15.6" r="1.1" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.8 2.2h8A1.5 1.5 0 0 1 20 9.7v8.8A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5Z" />
    </template>
    <template v-else-if="name === 'folder-open'">
      <path d="M4 8V6.5A1.5 1.5 0 0 1 5.5 5h3.2l1.8 2.2h7A1.5 1.5 0 0 1 19 8.7V10" />
      <path d="M3.2 11.2h17.1l-1.6 7A1.5 1.5 0 0 1 17.2 19.3H5.5a1.5 1.5 0 0 1-1.5-1.3Z" />
    </template>
    <template v-else-if="name === 'layers'">
      <path d="M12 3.5 20.5 8 12 12.5 3.5 8Z" />
      <path d="M4.5 12.4 12 16.4l7.5-4" />
      <path d="M4.5 16.4 12 20.4l7.5-4" />
    </template>

    <!-- 工具 -->
    <template v-else-if="name === 'wand'">
      <path d="M5 19 16 8" />
      <path d="M14.2 6.2 17.8 9.8" />
      <path d="M18.5 3v3M20 4.5h-3M6.5 4v2M7.5 5h-2M19 15v2M20 16h-2" />
    </template>
    <template v-else-if="name === 'shift'">
      <path d="M3.5 12h11" />
      <path d="M11 8.5 14.5 12 11 15.5" />
      <path d="M19 5v14" />
    </template>
    <template v-else-if="name === 'type'">
      <path d="M5 6.5h14" />
      <path d="M12 6.5v11" />
      <path d="M9 17.5h6" />
    </template>
    <template v-else-if="name === 'spell-check'">
      <path d="M3.5 17 8 7l4.5 10" />
      <path d="M5.2 13.5h5.6" />
      <path d="M14 14.5 16.5 17l4-5" />
    </template>
    <template v-else-if="name === 'book'">
      <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5Z" />
      <path d="M5 17.5h14" />
      <path d="M9 4v10" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.4 15.4 20 20" />
    </template>
    <template v-else-if="name === 'replace'">
      <path d="M4.5 8.5h10.5" />
      <path d="M12 5.5 15 8.5 12 11.5" />
      <path d="M19.5 15.5H9" />
      <path d="M12 12.5 9 15.5l3 3" />
    </template>
    <template v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.5V12l3 2" />
    </template>
    <template v-else-if="name === 'scissors'">
      <circle cx="7" cy="17.5" r="2.5" />
      <circle cx="17" cy="17.5" r="2.5" />
      <path d="M8.8 15.7 18 4M15.2 15.7 6 4" />
    </template>
    <template v-else-if="name === 'mic'">
      <!-- 话筒：胶囊 + 支架 + 底座 -->
      <rect x="9.2" y="3" width="5.6" height="10.4" rx="2.8" />
      <path d="M5.8 11.6a6.2 6.2 0 0 0 12.4 0" />
      <path d="M12 17.8V21M8.6 21h6.8" />
    </template>

    <!-- 系统 -->
    <template v-else-if="name === 'settings'">
      <path
        d="M10.3 5.88 L10.9 3.07 L13.1 3.07 L13.7 5.88 L15.13 6.47 L17.54 4.91 L19.09 6.46 L17.53 8.87 L18.12 10.3 L20.93 10.9 L20.93 13.1 L18.12 13.7 L17.53 15.13 L19.09 17.54 L17.54 19.09 L15.13 17.53 L13.7 18.12 L13.1 20.93 L10.9 20.93 L10.3 18.12 L8.87 17.53 L6.46 19.09 L4.91 17.54 L6.47 15.13 L5.88 13.7 L3.07 13.1 L3.07 10.9 L5.88 10.3 L6.47 8.87 L4.91 6.46 L6.46 4.91 L8.87 6.47 Z"
      />
      <circle cx="12" cy="12" r="2.9" />
    </template>
    <template v-else-if="name === 'sliders'">
      <path d="M5 7h9M18 7h1M5 17h1M10 17h9" />
      <circle cx="16" cy="7" r="2.1" />
      <circle cx="8" cy="17" r="2.1" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="5" y="10.5" width="14" height="9.5" rx="1.8" />
      <path d="M8.4 10.5V7.6a3.6 3.6 0 0 1 7.2 0v2.9" />
      <path d="M12 14.4v2.2" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="9" y="9" width="11" height="11" rx="1.8" />
      <path d="M15 9V5.8A1.8 1.8 0 0 0 13.2 4H5.8A1.8 1.8 0 0 0 4 5.8v7.4A1.8 1.8 0 0 0 5.8 15H9" />
    </template>
    <template v-else-if="name === 'pin'">
      <path d="M9.2 3.8h5.6l-.8 5.6 2.9 2.7H7.1l2.9-2.7Z" />
      <path d="M12 12.1v8.1" />
    </template>
    <template v-else-if="name === 'cpu'">
      <rect x="7" y="7" width="10" height="10" rx="1.6" />
      <path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3" />
    </template>
    <template v-else-if="name === 'zap'">
      <path d="M13.5 3 6 13.5h5l-.8 7.5L18 10.5h-5Z" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 4v10" />
      <path d="M8 10.5 12 14.5l4-4" />
      <path d="M5 18.5h14" />
    </template>
    <template v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.9" r="0.95" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'external'">
      <path d="M14 4h6v6" />
      <path d="M20 4 11.5 12.5" />
      <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6h4.5" />
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3.2v2M12 18.8v2M3.2 12h2M18.8 12h2M5.8 5.8l1.4 1.4M16.8 16.8l1.4 1.4M5.8 18.2l1.4-1.4M16.8 7.2l1.4-1.4" />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </template>
    <template v-else-if="name === 'monitor'">
      <rect x="3.5" y="5" width="17" height="11.5" rx="1.6" />
      <path d="M9 20h6M12 16.5V20" />
    </template>
    <template v-else-if="name === 'grip'">
      <circle cx="9" cy="7" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="7" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="9" cy="17" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="17" r="1.15" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'save'">
      <path d="M5.5 4h9L20 9.5V19a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4Z" />
      <path d="M8 4v5h6V4" />
      <rect x="8" y="13" width="8" height="7" rx="0.8" />
    </template>
    <template v-else-if="name === 'wave'">
      <path d="M3 12h2.5l1.8-5.5 3 12 2.6-9 2 6 1.6-3.5H21" />
    </template>

    <!-- 时间轴缩放：放大镜 + 加减号 -->
    <template v-else-if="name === 'zoom-in'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.6 15.6 21 21" />
      <path d="M10.5 7.8v5.4M7.8 10.5h5.4" />
    </template>
    <template v-else-if="name === 'zoom-out'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.6 15.6 21 21" />
      <path d="M7.8 10.5h5.4" />
    </template>
    <!-- 适应宽度：两侧边界 + 向内收拢的箭头 -->
    <template v-else-if="name === 'fit-width'">
      <path d="M4 5.5v13M20 5.5v13" />
      <path d="M7.6 12h8.8" />
      <path d="M10.2 9.4 7.6 12l2.6 2.6" />
      <path d="M13.8 9.4 16.4 12l-2.6 2.6" />
    </template>

    <template v-else-if="name === 'target'">
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3" />
    </template>
    <template v-else-if="name === 'minus-circle'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M8.5 12h7" />
    </template>
    <template v-else-if="name === 'window-min'">
      <path d="M7 12h10" />
    </template>
    <template v-else-if="name === 'window-max'">
      <rect x="6.5" y="6.5" width="11" height="11" rx="1" />
    </template>
    <template v-else-if="name === 'window-restore'">
      <rect x="5" y="8" width="10" height="10" rx="1" />
      <path d="M8.5 8V6.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H16" />
    </template>
    <template v-else-if="name === 'list'">
      <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" />
      <circle cx="4.6" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'keyboard'">
      <rect x="2.8" y="6.5" width="18.4" height="11" rx="1.6" />
      <path d="M6.5 10h1M9.8 10h1M13.1 10h1M16.4 10h1M6.5 13h1M9.8 13h1M13.1 13h1M16.4 13h1M8 15.8h8" />
    </template>
    <template v-else-if="name === 'shield'">
      <path d="M12 3.2 19.5 6v6.2c0 4.2-3 7.2-7.5 8.6-4.5-1.4-7.5-4.4-7.5-8.6V6Z" />
      <path d="M9 12l2.2 2.2L15.2 10" />
    </template>
    <template v-else-if="name === 'globe'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M3.8 12h16.4" />
      <path d="M12 3.8c2.2 2.4 3.3 5.1 3.3 8.2s-1.1 5.8-3.3 8.2c-2.2-2.4-3.3-5.1-3.3-8.2S9.8 6.2 12 3.8Z" />
    </template>
    <template v-else-if="name === 'eye'">
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </template>
    <template v-else-if="name === 'eye-off'">
      <path d="M4 4l16 16" />
      <path d="M9.6 5.9A9.4 9.4 0 0 1 12 5.6c6 0 9.5 5.5 9.5 5.5a15.4 15.4 0 0 1-3.4 3.8" />
      <path d="M6.2 7.7A15.6 15.6 0 0 0 2.5 11.1S6 16.6 12 16.6a9.7 9.7 0 0 0 4-.8" />
      <path d="M10 10a2.8 2.8 0 0 0 3.9 3.9" />
    </template>

    <!-- 兜底：方框 -->
    <template v-else>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </template>
  </svg>
</template>

<style scoped>
.icon {
  display: block;
  flex: none;
}
</style>
