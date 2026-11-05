import { ref } from 'vue'
import { defineStore } from 'pinia'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogLine {
  id: number
  /** 毫秒时间戳，界面上自己格式化成 HH:MM:SS */
  at: number
  level: LogLevel
  text: string
}

/**
 * 环形缓冲上限。
 *
 * 日志在这里的作用是「进度条说不清的时候，让用户看见现在到底在干什么」，
 * 不是取证材料 —— 无限攒下去只会吃掉内存，翻到第 800 行也没人看。
 */
const MAX_LINES = 300

/**
 * 运行日志（引擎 + 应用自己的关键节点）。
 *
 * 引擎进程的 stdout/stderr 由主进程转成 `engine:log` 发过来，这里只负责攒着；
 * 识别流程里的「开始第 n 遍」「开始分析讲话人」由 project store 主动写进来，
 * 这样气泡里既能看到模型自己的输出，也能看到我们在让它做什么。
 */
export const useLogStore = defineStore('logs', () => {
  const lines = ref<LogLine[]>([])
  let seq = 0

  function push(level: LogLevel, text: string): void {
    // 引擎一条日志里可能带换行（分组输出、进度多行），拆开逐行记才好读
    for (const raw of text.split(/\r?\n/)) {
      const body = raw.trimEnd()
      if (!body.trim()) continue
      seq += 1
      lines.value.push({ id: seq, at: Date.now(), level, text: body })
    }
    const over = lines.value.length - MAX_LINES
    if (over > 0) lines.value.splice(0, over)
  }

  /** 开始新一轮识别时清空：上一轮的行留着只会让人对错时间 */
  function clear(): void {
    lines.value = []
  }

  return { lines, push, clear }
})
