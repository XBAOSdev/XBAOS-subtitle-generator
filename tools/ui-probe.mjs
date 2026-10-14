/**
 * UI 探针
 *
 * 用 Chrome DevTools Protocol 驱动无头浏览器，做「真实点击 + 断言 + 截图」，
 * 用来验收那些静态截图看不出来的交互（例如单击文本是否进入编辑、光标位置）。
 *
 * 依赖：Node 22 内置的 WebSocket，无第三方包。
 *
 * 用法：
 *   node tools/ui-probe.mjs                     跑全部场景
 *   node tools/ui-probe.mjs click-text          只跑指定场景
 *
 * 输出的截图放在 .workbuddy/shots/ 下。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const BASE = `http://127.0.0.1:${process.env.XBAOS_DEV_PORT || 5173}`
const OUT_DIR = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/probe-profile')

mkdirSync(OUT_DIR, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

/* -------------------------------------------------------------------- 工具 */

// Cdp / connect / capture 来自 ./lib/cdp.mjs，与 Electron 探针共用同一份实现

/**
 * 截图到 OUT_DIR。
 *
 * 失败**只记一条失败，不往外抛**：本机 GPU 环境下 `Page.captureScreenshot`
 * 偶发 90 秒超时（见项目备忘），而截图纯粹是装饰性的 —— 让它把整个进程带走，
 * 后面那些场景连跑都跑不到，一次全量验证就白做了。
 * 但也不能静默吞掉：吞掉会变成「断言全绿、截图却全缺」，那更难查。
 */
const shot = async (cdp, file, clip) => {
  try {
    await capture(cdp, path.join(OUT_DIR, file), clip)
  } catch (err) {
    check(`截图 ${file}`, false, err instanceof Error ? err.message : String(err))
  }
}

/**
 * 轮询等待某个条件成立，超时返回 false。
 *
 * 等「识别跑完」这类**耗时依赖机器负载**的事不能靠固定 sleep：单跑时富余，
 * 全量跑时前面已经开了十几个页面、内存压力大，演示识别会慢上一截，
 * 于是那条断言假失败、后面还跟着崩（`merge-timeline` 就栽在这里）。
 * 宁可多轮询几秒，也不要一条时序脆弱的断言。
 */
const waitFor = async (cdp, expr, timeoutMs = 60_000, stepMs = 300) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cdp.evaluate(expr)) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/* ------------------------------------------------------------------ 启动浏览器 */

async function launch() {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    // 本地回环不能走代理。开发机常挂着 HTTP_PROXY，Chrome 会照着走，
    // 结果访问 127.0.0.1:5173 被代理挡掉，页面显示 ERR_CONNECTION_REFUSED。
    '--no-proxy-server',
    '--proxy-bypass-list=<-loopback>',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1480,940',
    'about:blank',
  ]
  const child = spawn(CHROME, args, { stdio: 'ignore' })

  let version = null
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) {
        version = await res.json()
        break
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  if (!version) throw new Error('Chrome 调试端口未就绪')

  // 新开一个标签页
  const tabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  if (!tabRes.ok) throw new Error('创建标签页失败: ' + tabRes.status)
  const tab = await tabRes.json()

  const cdp = await connect(tab.webSocketDebuggerUrl)

  return { child, cdp }
}

/* -------------------------------------------------------------------- 场景 */

/** 打开页面并等 Vue 渲染完 */
/** 导航到某个地址，并确认页面**真的**加载进了应用。 */
async function goto(cdp, url) {
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // 每次导航前把标签页拉到前台。探针的 Chrome 是无头-ish 的，标签页随时可能
  // 进入「遮挡」状态：合成器停帧 → `Page.captureScreenshot` 卡满 90s 超时，
  // requestAnimationFrame 永不触发 → Vue 的离场过渡（viewfade）停在 leave-from
  // 永远不结束，下一个视图根本不挂载（表现是「入口找不到 = []」）。这三件事
  // 是同一个根因，bringToFront 一并解决。
  await cdp.send('Page.bringToFront').catch(() => {})
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url })
  await loaded
  // 等演示数据与图表绘制完成
  await sleep(1200)

  // 导航失败时 Chromium 会渲染自己的错误页，而错误页同样会触发 load 事件、
  // 同样能截图成功。后面的选择器却会全部落空，表现出来是一堆莫名其妙的
  // 「找不到第 3 条字幕行」，排查方向完全跑偏 —— 曾经真的被这个骗过一次：
  // 服务没起来，6 张截图全是通过状态，里面全是 ERR_CONNECTION_REFUSED。
  // 所以每次导航后先确认页面确实进了我们的应用。
  const state = await cdp.evaluate(`(() => {
    const app = document.querySelector('#app')
    return {
      chromeError: !!document.querySelector('#main-frame-error'),
      appMounted: !!app && app.children.length > 0,
      title: document.title,
    }
  })()`)

  if (state.chromeError || !state.appMounted) {
    throw new Error(
      `页面未加载成功：${url}\n` +
        `  Chromium 错误页=${state.chromeError}  应用已挂载=${state.appMounted}  title="${state.title}"\n` +
        '  通常是开发服务器没起来，先执行 npm run dev:ui',
    )
  }
}

const scenarios = {

  /**
   * AI 校对辅助窗口（?window=assist）。
   *
   * 浏览器里没有 Electron 桥，复制与读取剪贴板会走 navigator.clipboard；
   * headless 下真剪贴板不稳，注入一个替身让断言可复现。
   */
  async 'assist-view'(cdp) {
    await cdp.send('Page.enable')
    const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const store = { text: '' }
        window.__xbaosClip = store
        try {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: (t) => { store.text = String(t); return Promise.resolve() },
              readText: () => Promise.resolve(store.text),
            },
          })
        } catch (err) { /* 覆盖失败就退回真实剪贴板 */ }
      })()`,
    })

    const centerOfBtn = (label) =>
      cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('.pane__actions .btn')]
          .find((b) => b.textContent.includes(${JSON.stringify(label)}))
        if (!btn) return null
        // 第 1 步内容越来越长（勾选区 + 文案区 + 提示词预览），按钮常被推到视口外；
        // 不先滚进视口的话，算出来的坐标点到空白处，等于没点。
        btn.scrollIntoView({ block: 'center' })
        const r = btn.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)

    const centerOf = (js) =>
      cdp.evaluate(`(() => {
        const el = ${js}
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)

    const activeStep = () =>
      cdp.evaluate(
        `document.querySelector('.steps__item.is-active')?.textContent.replace(/\\s+/g, '') ?? ''`,
      )

    try {
      // 按真实辅助窗口的尺寸渲染，截图才与实际观感一致（主窗口是 1480 宽）
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 720,
        height: 840,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await goto(cdp, BASE + '/?window=assist&demo=1&theme=light')

      // ---- 界面骨架
      check('辅助窗口有自绘标题栏', (await cdp.evaluate(`!!document.querySelector('.abar')`)) === true)
      check(
        '辅助窗口不渲染主界面外壳',
        (await cdp.evaluate(`!!document.querySelector('.assist') && !document.querySelector('.app')`)) ===
          true,
      )
      const stepCount = await cdp.evaluate(`document.querySelectorAll('.steps__item').length`)
      check('步骤条 3 项', stepCount === 3, String(stepCount))
      check('初始停在第 1 步', String(await activeStep()).includes('准备提示词'), String(await activeStep()))

      const promptLen = await cdp.evaluate(
        `document.querySelector('.prompt__body')?.textContent.length ?? 0`,
      )
      check('提示词预览有内容', promptLen > 50, String(promptLen))

      // 多文件选择区：演示数据有 2 个文件，默认应当全选
      const pickCount = await cdp.evaluate(`document.querySelectorAll('.pick__box').length`)
      check('多文件时出现文件选择区', pickCount === 2, String(pickCount))
      const checkedCount = await cdp.evaluate(
        `[...document.querySelectorAll('.pick__box')].filter((b) => b.checked).length`,
      )
      check('文件默认全选', checkedCount === 2, String(checkedCount))

      // 提示词按设置动态生成：默认设置是「去停顿标点」，就不能再要求 AI 补标点
      const promptText1 = await cdp.evaluate(`document.querySelector('.prompt__body')?.textContent ?? ''`)
      const noPunc = promptText1.includes('不要给字幕添加任何标点符号')
      check('提示词按设置要求不要加标点', noPunc, noPunc ? '' : '没写这条')
      const hasSpec = promptText1.includes('【字幕规格】')
      check('提示词写入字幕规格', hasSpec, hasSpec ? '' : '缺字幕规格段')

      // 正文在提示词末尾，预览默认只给前 800 字符，得先展开全文才看得到分隔行
      const expandBtn = await centerOf(
        `[...document.querySelectorAll('.prompt__head .link')].find((b) => b.textContent.includes('展开全文'))`,
      )
      if (expandBtn) {
        await cdp.click(expandBtn.x, expandBtn.y)
        await sleep(200)
      }
      const fullPrompt = await cdp.evaluate(
        `document.querySelector('.prompt__body')?.textContent ?? ''`,
      )
      const hasMark = fullPrompt.includes('【文件 1/2】')
      check('多文件提示词带分隔行', hasMark, hasMark ? '' : '缺分隔行')
      const keepMark = fullPrompt.includes('一个都不能少')
      check('多文件提示词要求原样保留分隔行', keepMark, keepMark ? '' : '缺这句')

      // 原文案参考区
      check(
        '有文案参考输入框',
        (await cdp.evaluate(`!!document.querySelector('textarea.script')`)) === true,
      )
      await cdp.evaluate(`(() => {
        const ta = document.querySelector('textarea.script')
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '今天我们聊一聊显卡这个东西')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(200)
      const scriptStat = await cdp.evaluate(
        `document.querySelector('.script__stat')?.textContent ?? ''`,
      )
      check(
        '粘贴文案后本地算出吻合度',
        scriptStat.includes('能在文案里找到'),
        scriptStat.slice(0, 50),
      )
      check('文案对得上时给出肯定判断', scriptStat.includes('吻合度良好'), scriptStat.slice(0, 60))
      // 覆盖率回归：演示文案是识别结果的子串，就算两侧长度不同也该接近满分。
      // 曾经用对称相似度，这种「真吻合」的情况只会给到 60% 出头。
      check(
        '吻合度按覆盖率算而非对称相似度',
        /约\s*(9\d|100)%/.test(scriptStat),
        scriptStat.slice(0, 60),
      )

      // 商业风险回归：不得出现任何第三方 AI 品牌名或外链
      const brands = ['ChatGPT', 'Kimi', '豆包', '通义', '文心', 'DeepSeek', 'Claude', 'Gemini']
      const bodyText = await cdp.evaluate(`document.body.innerText`)
      const hitBrands = brands.filter((b) => bodyText.includes(b))
      check('文案不含第三方 AI 品牌名', hitBrands.length === 0, hitBrands.join(','))
      check(
        '辅助窗口内没有任何外部链接',
        (await cdp.evaluate(`document.querySelectorAll('a[href^="http"]').length`)) === 0,
      )

      await shot(cdp, 'probe-assist-step1.png')

      // 取消勾选第二个文件：第 3 步的前后对照概览只对「单文件」有意义。
      // 必须用真实鼠标事件 —— 复选框在 label 内部，JS 的 .click() 会被
      // label 的默认转发行为再点一次，等于没取消。
      const secondBox = await centerOf(`document.querySelectorAll('.pick__box')[1]`)
      if (!secondBox) throw new Error('找不到第二个文件的复选框')
      await cdp.click(secondBox.x, secondBox.y)
      await sleep(250)
      const footText = await cdp.evaluate(
        `document.querySelector('.block__foot')?.textContent?.replace(/\\s+/g, ' ') ?? ''`,
      )
      check('可以逐个取消勾选文件', footText.includes('已选 1 / 2'), footText.trim())

      // ---- 复制提示词 → 进入第 2 步
      const copyBtn = await centerOfBtn('复制提示词')
      if (!copyBtn) throw new Error('找不到「复制提示词」按钮')
      await cdp.click(copyBtn.x, copyBtn.y)
      await sleep(400)

      check('复制后进入第 2 步', String(await activeStep()).includes('粘贴'), String(await activeStep()))
      const clipLen = await cdp.evaluate(`window.__xbaosClip ? window.__xbaosClip.text.length : -1`)
      check('提示词确实写进了剪贴板', clipLen > 50, String(clipLen))
      const howtoCount = await cdp.evaluate(`document.querySelectorAll('.howto li').length`)
      check('第 2 步给出分步说明', howtoCount >= 4, String(howtoCount))
      // 引导文案不能教用户按 Ctrl+A：那会把整个网页的文字都选上，解析器扛不住
      const step2Text = await cdp.evaluate(`document.querySelector('.pane')?.textContent ?? ''`)
      const noCtrlA = !step2Text.includes('Ctrl+A')
      check('第 2 步不再出现 Ctrl+A 全选', noCtrlA, noCtrlA ? '' : '仍写着 Ctrl+A')
      const saysAll = step2Text.includes('全部内容')
      check('第 2 步改为「复制全部内容」', saysAll, saysAll ? '' : '没写这句')

      await shot(cdp, 'probe-assist-step2.png')

      // ---- 进入第 3 步
      const nextBtn = await centerOfBtn('去取回')
      if (!nextBtn) throw new Error('找不到进入第 3 步的按钮')
      await cdp.click(nextBtn.x, nextBtn.y)
      await sleep(400)
      check('进入第 3 步', String(await activeStep()).includes('取回'), String(await activeStep()))

      // ---- 模拟「从 AI 复制回来的结果」：带围栏与寒暄，验证解析容错
      await cdp.evaluate(`(() => {
        window.__xbaosClip.text = [
          '好的，以下是校对后的字幕：',
          '',
          '\`\`\`srt',
          '1',
          '00:00:00,000 --> 00:00:02,500',
          '大家好，欢迎来到本期节目。',
          '',
          '2',
          '00:00:02,500 --> 00:00:06,000',
          '今天我们聊一聊显卡。',
          '\`\`\`',
          '',
          '希望对你有帮助！',
        ].join('\\n')
        return true
      })()`)

      const readBtn = await centerOfBtn('读取剪贴板')
      if (!readBtn) throw new Error('找不到「读取剪贴板」按钮')
      await cdp.click(readBtn.x, readBtn.y)
      await sleep(500)

      check('读取后出现结果概览', (await cdp.evaluate(`!!document.querySelector('.review')`)) === true)
      const nums = await cdp.evaluate(
        `[...document.querySelectorAll('.review__num')].map((el) => el.textContent.trim())`,
      )
      check('概览显示原文与结果条数', Array.isArray(nums) && nums.length >= 3, JSON.stringify(nums))
      check(
        '出现确认覆盖按钮',
        (await cdp.evaluate(
          `[...document.querySelectorAll('.pane__actions .btn')].some((b) => b.textContent.includes('确认覆盖'))`,
        )) === true,
      )
      const status = await cdp.evaluate(`document.querySelector('.astatus')?.textContent ?? ''`)
      check('状态条给出读取成功提示', status.includes('读取成功'), status.slice(0, 40))

      await shot(cdp, 'probe-assist-step3.png')

      // ---- 多文件：每个文件都要能展开看到校对结果 ----
      // 用户实测反馈：多字幕文件时第 3 步只列出「文件名 + N 条」，看不到内容。
      await goto(cdp, BASE + '/?window=assist&demo=1&theme=light')
      await sleep(300)
      const copyAll = await centerOfBtn('复制提示词')
      if (!copyAll) throw new Error('多文件段：找不到「复制提示词」按钮')
      await cdp.click(copyAll.x, copyAll.y)
      await sleep(350)
      const toApply = await centerOfBtn('去取回')
      if (!toApply) throw new Error('多文件段：找不到「去取回」按钮')
      await cdp.click(toApply.x, toApply.y)
      await sleep(350)

      // 造一份「带文件分隔行」的 AI 输出（这是多文件模式下约定的格式）
      await cdp.evaluate(`(() => {
        window.__xbaosClip.text = [
          '【文件 1/2】示例音频 1.wav',
          '',
          '1',
          '00:00:00,000 --> 00:00:03,000',
          '大家好，欢迎来到本期节目。',
          '',
          '2',
          '00:00:03,000 --> 00:00:07,000',
          '今天聊一聊显卡。',
          '',
          '【文件 2/2】示例音频 2.wav',
          '',
          '1',
          '00:00:00,000 --> 00:00:04,000',
          '先说说它为什么这么贵。',
        ].join('\\n')
        return true
      })()`)
      const readAll = await centerOfBtn('读取剪贴板')
      if (!readAll) throw new Error('多文件段：找不到「读取剪贴板」按钮')
      await cdp.click(readAll.x, readAll.y)
      await sleep(500)

      const rowCount = await cdp.evaluate(`document.querySelectorAll('.block .pick__row').length`)
      check('多文件逐个列出解析结果', rowCount === 2, String(rowCount))
      const caretCount = await cdp.evaluate(`document.querySelectorAll('.pick__caret').length`)
      check('每个文件都有展开指示', caretCount === 2, String(caretCount))
      check(
        '默认收起（不占屏）',
        (await cdp.evaluate(`document.querySelectorAll('.result').length`)) === 0,
      )

      const firstRow = await centerOf(`document.querySelectorAll('.block .pick__row')[0]`)
      if (!firstRow) throw new Error('多文件段：找不到第一行')
      await cdp.click(firstRow.x, firstRow.y)
      await sleep(250)
      const resultText = await cdp.evaluate(
        `document.querySelector('.result')?.textContent?.replace(/\\s+/g, ' ') ?? ''`,
      )
      check('点文件名能展开看到结果', resultText.includes('条'), resultText.slice(0, 60))
      const diffCount = await cdp.evaluate(`document.querySelectorAll('.result .diff').length`)
      check('展开后有逐条变化明细', diffCount > 0, String(diffCount))
      check(
        '明细里能看到校对后的具体文本',
        (await cdp.evaluate(
          `document.querySelector('.result')?.textContent?.includes('大家好') === true`,
        )) === true,
      )

      await shot(cdp, 'probe-assist-multi.png')

      // ---- 翻译：取回（P0 回归 · 用户实测） ----
      // 模型常把输出开头的【文件 1/N】当成"标题"吞掉。老实现按分隔行分组，
      // 少一块就整份拒绝（「识别到 1 个文件块，应当是 2 个」），第一个文件的译文
      // 直接被丢掉。现在改成按已知条数分组，这条断言测的就是那条真实链路：
      // 剪贴板 → 解析 → 界面呈现「可载入」。
      await goto(cdp, BASE + '/?window=assist&demo=1&theme=light&task=translate')
      await sleep(300)
      check(
        '翻译模式第 1 步出现目标语言选择',
        (await cdp.evaluate(`!!document.querySelector('.langpick')`)) === true,
      )
      check(
        '翻译模式不再显示「原文案参考」（那是校对专用的输入）',
        (await cdp.evaluate(`!!document.querySelector('textarea.script')`)) === false,
      )

      const copyTr = await centerOfBtn('复制提示词')
      if (!copyTr) throw new Error('翻译段：找不到「复制提示词」按钮')
      await cdp.click(copyTr.x, copyTr.y)
      await sleep(350)
      const toApplyTr = await centerOfBtn('去取回')
      if (!toApplyTr) throw new Error('翻译段：找不到「去取回」按钮')
      await cdp.click(toApplyTr.x, toApplyTr.y)
      await sleep(350)
      check('翻译模式第 3 步标题是「取回译文」', String(await activeStep()).includes('取回'))

      // 演示数据是 2 个文件（2 条 + 1 条）。这里**故意不写【文件 1/2】**，
      // 复现「模型把第一个分隔行吞掉」——老实现会在这里整份拒绝。
      await cdp.evaluate(`(() => {
        window.__xbaosClip.text = [
          '1. Hello everyone.',
          '2. Today we talk about GPUs.',
          '【文件 2/2】示例音频 2.wav',
          '1. First, why is it so expensive?',
        ].join('\\n')
        return true
      })()`)
      const readTr = await centerOfBtn('读取剪贴板')
      if (!readTr) throw new Error('翻译段：找不到「读取剪贴板」按钮')
      await cdp.click(readTr.x, readTr.y)
      await sleep(500)

      const trErr = await cdp.evaluate(`document.querySelector('.warn')?.textContent ?? ''`)
      check('首个分隔行被吞掉时不再误报失败', !trErr.includes('文件块'), trErr.slice(0, 60))
      const trStatus = await cdp.evaluate(`document.querySelector('.astatus')?.textContent ?? ''`)
      check('翻译取回成功', trStatus.includes('读取成功'), trStatus.slice(0, 60))
      check(
        '出现「载入译文」按钮',
        (await cdp.evaluate(
          `[...document.querySelectorAll('.pane__actions .btn')].some((b) => b.textContent.includes('载入译文'))`,
        )) === true,
      )
      const trMetas = await cdp.evaluate(
        `[...document.querySelectorAll('.block .pick__meta')].map((e) => e.textContent.trim())`,
      )
      check(
        '两个文件各自显示译文条数（没有整体错位）',
        trMetas.length === 2 && trMetas[0].includes('2') && trMetas[1].includes('1'),
        JSON.stringify(trMetas),
      )

      await shot(cdp, 'probe-assist-translate.png')

      // ---- P0 回归：翻译任务点文件名必须真能展开看到译文 ----
      // 用户实测：箭头翻了、expandedId 也变了，展开区却什么都不渲染。根因是展开区
      // 曾经只有 `v-if="expandedId === r.fileId && r.summary"` 一支，而翻译任务根本
      // 不产生 summary（它恒为 null）。这条断言卡的就是「有反馈但没内容」这个中间态。
      const trRow = await centerOf(`document.querySelectorAll('.block .pick__row')[0]`)
      if (!trRow) throw new Error('翻译段：找不到第一个文件名行')
      await cdp.click(trRow.x, trRow.y)
      await sleep(260)

      const trExpand = await cdp.evaluate(`(() => {
        const res = document.querySelector('.block .result')
        if (!res) return null
        return {
          onClick: document.querySelectorAll('.block .pick__row')[0].className.includes('is-on'),
          stat: res.querySelector('.result__stat')?.textContent?.trim() ?? '',
          srcs: [...res.querySelectorAll('.pair__src')].map((e) => e.textContent.trim()),
          dsts: [...res.querySelectorAll('.pair__dst')].map((e) => e.textContent.trim()),
        }
      })()`)
      check('翻译任务点文件名真的展开了内容（不是「有反馈但空白」）', !!trExpand, JSON.stringify(trExpand))
      check('展开的行进入了选中态', trExpand?.onClick === true, String(trExpand?.onClick))
      check('展开区给出译文条数', (trExpand?.stat ?? '').includes('2'), String(trExpand?.stat))
      check(
        '逐条列出译文（就是这次取回的内容）',
        trExpand?.dsts.length === 2 &&
          trExpand.dsts[0].includes('Hello everyone') &&
          trExpand.dsts[1].includes('GPUs'),
        JSON.stringify(trExpand?.dsts ?? []),
      )
      check(
        '原文一并列出，便于对照（不是只有译文）',
        trExpand?.srcs.length === 2 && trExpand.srcs.every((s) => s.length > 0),
        JSON.stringify(trExpand?.srcs ?? []),
      )
      check(
        '原文与译文按位置一一对齐（不发散、不串行）',
        trExpand?.srcs.length === trExpand?.dsts.length,
        `src ${trExpand?.srcs.length} / dst ${trExpand?.dsts.length}`,
      )

      // 留一张实拍：这条断言修的就是「点开却什么都不渲染」，截图是最直接的证据
      await shot(cdp, 'probe-assist-translate-expanded.png')

      // 切到第二个文件：展开区要跟着换，且条数是它自己的 1 条（不是沿用上一个）
      const trRow2 = await centerOf(`document.querySelectorAll('.block .pick__row')[1]`)
      if (!trRow2) throw new Error('翻译段：找不到第二个文件名行')
      await cdp.click(trRow2.x, trRow2.y)
      await sleep(260)
      const trExpand2 = await cdp.evaluate(`(() => {
        const res = document.querySelectorAll('.block .result')[0]
        return res ? [...res.querySelectorAll('.pair__dst')].map((e) => e.textContent.trim()) : null
      })()`)
      check(
        '切到另一个文件时展开区跟着换（条数取它自己的）',
        Array.isArray(trExpand2) && trExpand2.length === 1 && trExpand2[0].includes('expensive'),
        JSON.stringify(trExpand2),
      )

      // 再点一次收起：不留残影
      // 位置要重新取 —— 上一步 row 1 收起、row 2 展开已经让这一行的位置变过了
      const trRow2b = await centerOf(`document.querySelectorAll('.block .pick__row')[1]`)
      if (!trRow2b) throw new Error('翻译段：找不到第二个文件名行（收起前）')
      await cdp.click(trRow2b.x, trRow2b.y)
      await sleep(220)
      check(
        '再点一次收起展开区',
        (await cdp.evaluate(`document.querySelectorAll('.block .result').length`)) === 0,
      )

      // ---- P0 回归：单文件 + 翻译，第 3 步必须能看到译文（用户报「整片空白」） ----
      // 第 3 步原本只有两块预览：单文件走 `summary`（校对产物），多文件走 `multi && ...`。
      // 翻译任务不产生 summary（恒为 null），单文件时又 !multi —— 两块都不成立，
      // 界面整片空白；可状态条已经报了「读取成功：1 个文件共 N 条译文」，
      // 看起来像渲染坏了。这条断言卡的就是这个「报了成功却什么都没显示」的中间态。
      await goto(cdp, BASE + '/?window=assist&demo=1&theme=light&task=translate&files=1')
      await sleep(300)
      const oneFileCount = await cdp.evaluate(`document.querySelectorAll('.pick__box').length`)
      check('单文件翻译：演示数据只有一个文件（单文件分支才生效）', oneFileCount === 0, `文件选择区 ${oneFileCount} 行`)

      const copyOne = await centerOfBtn('复制提示词')
      if (!copyOne) throw new Error('单文件翻译段：找不到「复制提示词」按钮')
      await cdp.click(copyOne.x, copyOne.y)
      await sleep(350)
      const toApplyOne = await centerOfBtn('去取回')
      if (!toApplyOne) throw new Error('单文件翻译段：找不到「去取回」按钮')
      await cdp.click(toApplyOne.x, toApplyOne.y)
      await sleep(350)

      // 第一个演示文件有 2 条字幕；单文件输出里不该再出现【文件 k/N】分隔行
      await cdp.evaluate(`(() => {
        window.__xbaosClip.text = [
          '1. Hello everyone.',
          '2. Today we talk about GPUs.',
        ].join('\\n')
        return true
      })()`)
      const readOne = await centerOfBtn('读取剪贴板')
      if (!readOne) throw new Error('单文件翻译段：找不到「读取剪贴板」按钮')
      await cdp.click(readOne.x, readOne.y)
      await sleep(500)

      const oneStatus = await cdp.evaluate(`document.querySelector('.astatus')?.textContent ?? ''`)
      check('单文件翻译：状态条报读取成功', oneStatus.includes('读取成功'), oneStatus.slice(0, 60))
      check(
        '单文件翻译：出现「载入译文」按钮',
        (await cdp.evaluate(
          `[...document.querySelectorAll('.pane__actions .btn')].some((b) => b.textContent.includes('载入译文'))`,
        )) === true,
      )

      const onePreview = await cdp.evaluate(`(() => ({
        dsts: [...document.querySelectorAll('.pair__dst')].map((e) => e.textContent.trim()),
        srcs: [...document.querySelectorAll('.pair__src')].map((e) => e.textContent.trim()),
        head: document.querySelector('.diffs__head')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        pickRows: document.querySelectorAll('.block .pick__row').length,
      }))()`)
      check(
        '单文件翻译：第 3 步真的列出了译文（不是「报了成功却整片空白」）',
        onePreview.dsts.length === 2,
        JSON.stringify(onePreview.dsts),
      )
      check(
        '单文件翻译：原文一并列出便于对照',
        onePreview.srcs.length === 2 && onePreview.srcs.every((s) => s.length > 0),
        JSON.stringify(onePreview.srcs),
      )
      check(
        '单文件翻译：预览头写明条数与目标语言',
        onePreview.head.includes('2') && onePreview.head.includes('英语'),
        onePreview.head,
      )
      // 守卫用 `!multi` 而不是 `results.length === 1`：否则「2 个文件只勾 1 个」时
      // 这一块会和下面的可展开列表同时渲染，同一份译文出现两遍
      check('单文件翻译：不出现多文件的可展开列表', onePreview.pickRows === 0, String(onePreview.pickRows))

      await shot(cdp, 'probe-assist-translate-single.png')

      // ---- P0 回归：深色下步骤条高亮序号的对比度
      // 曾经把序号文字写死成 #ffffff，但深色主题下 --color-accent 是浅灰
      // #d6d6d6，「浅灰底 + 白字」对比度只有约 1.5:1，等于看不见。
      // 修法是改用 --color-text-inverse（反色令牌）。
      await goto(cdp, BASE + '/?window=assist&demo=1&theme=dark')
      const stepNo = await cdp.evaluate(`(() => {
        const no = document.querySelector('.steps__item.is-active .steps__no')
        if (!no) return null
        const cs = getComputedStyle(no)
        return { color: cs.color, bg: cs.backgroundColor }
      })()`)
      check('深色下能取到高亮序号', !!stepNo && !!stepNo.color)
      if (stepNo) {
        const channel = (v) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
        }
        // 注意：这段跑在探针进程里（不是 evaluate 字符串），正则只能写单反斜杠
        const lum = (rgb) => {
          const [r, g, b] = rgb.match(/\d+/g).map(Number).map(channel)
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const a = lum(stepNo.color)
        const b = lum(stepNo.bg)
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        check(
          '深色下高亮序号对比度足够（不再写死白字）',
          ratio >= 3,
          `对比度 ${ratio.toFixed(2)}:1（字 ${stepNo.color} / 底 ${stepNo.bg}）`,
        )
      }
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride')
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: injected.identifier,
      })
    }
  },

  /** 深色 / 浅色下的主要页面 */
  async pages(cdp) {
    const jobs = [
      // 默认外观已改为浅色，所以深浅要靠 ?theme= 显式指定，
      // 否则「-dark」的截图名与实际画面不符。
      ['probe-home-light.png', '/?demo=1&theme=light'],
      ['probe-home-dark.png', '/?demo=1&theme=dark'],
      ['probe-editor-light.png', '/?demo=1&view=editor&theme=light'],
      ['probe-editor-dark.png', '/?demo=1&view=editor&theme=dark'],
      ['probe-models-dark.png', '/?demo=1&view=models&theme=dark'],
      ['probe-about-light.png', '/?demo=1&view=about&theme=light'],
      ['probe-settings-light.png', '/?demo=1&view=settings&theme=light'],
    ]
    for (const [file, pathname] of jobs) {
      await goto(cdp, BASE + pathname)
      await shot(cdp, file)
    }
    check('主要页面截图', true, `${jobs.length} 张`)

    // 版本号链路：package.json → vite 的 define / Electron 注入 → 侧边栏与关于页。
    // 任何一环断掉（比如忘了在 vite.config.ts 里 define），界面就退化成兜底值 0.0.0，
    // 而截图看上去一切正常 —— 只有比对才看得出来。
    const pkgVersion = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version
    await goto(cdp, BASE + '/?demo=1&view=about&theme=light')
    const sidebarVersion = await cdp.evaluate(
      `document.querySelector('.sidebar__version')?.textContent?.trim() ?? ''`,
    )
    const aboutVersion = await cdp.evaluate(
      `document.querySelector('.hero__version')?.textContent?.replace(/\\s+/g, '') ?? ''`,
    )
    check(
      '侧边栏版本号来自 package.json，不是兜底值',
      sidebarVersion === `v${pkgVersion}`,
      `界面 ${sidebarVersion}，package.json v${pkgVersion}`,
    )
    check('关于页与侧边栏显示同一个版本号', aboutVersion.includes(pkgVersion), aboutVersion)
  },

  /** 单击字幕文本 → 应当直接进入编辑，且光标落在点击处 */
  async 'click-text'(cdp) {
    await goto(cdp, BASE + '/?demo=1&view=editor')

    // 第 3 条字幕的文本区域
    const box = await cdp.evaluate(`(() => {
      const row = document.querySelectorAll('.subtable__body .row')[2]
      if (!row) return null
      const cell = row.querySelector('.cell--text')
      const r = cell.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: cell.textContent.trim() }
    })()`)
    if (!box) throw new Error('找不到第 3 条字幕行')

    // 点在文本横向 40% 处，而不是正中，便于验证光标是否落在点击位置
    const clickX = Math.round(box.x + box.w * 0.4)
    const clickY = Math.round(box.y + box.h / 2)
    await cdp.click(clickX, clickY)
    await sleep(350)

    const state = await cdp.evaluate(`(() => {
      const ta = document.querySelector('.row__editor')
      const active = document.activeElement
      return {
        editorExists: !!ta,
        focused: active === ta,
        tag: active ? active.tagName : null,
        selectionStart: ta ? ta.selectionStart : null,
        selectionEnd: ta ? ta.selectionEnd : null,
        value: ta ? ta.value : null,
      }
    })()`)

    check('单击文本进入编辑态', state.editorExists === true)
    check('编辑框自动获得焦点', state.focused === true, `activeElement=${state.tag}`)
    check(
      '光标落在点击位置而非末尾',
      state.selectionStart !== null &&
        state.selectionStart > 0 &&
        state.selectionStart < state.value.length,
      `光标 ${state.selectionStart} / 共 ${state.value.length} 字`,
    )
    check(
      '编辑框内容与该条字幕一致',
      state.value !== null && box.text.startsWith(state.value.slice(0, 4)),
      `“${state.value}”`,
    )

    // 就近截一小块，看编辑态的视觉
    await shot(cdp, 'probe-click-edit.png', {
      x: box.x - 140,
      y: box.y - 26,
      width: 700,
      height: 150,
      scale: 2,
    })

    // 编辑内容后失焦，检查「已改动」标记
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('.row__editor')
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ta.value + '［已改］')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.blur()
    })()`)
    await sleep(300)
    const edited = await cdp.evaluate(`(() => {
      const rows = document.querySelectorAll('.subtable__body .row')
      return rows[2].classList.contains('is-edited')
    })()`)
    check('改动后条目亮起「已改动」标记', edited === true)
    await shot(cdp, 'probe-edited-mark.png', {
      x: box.x - 140,
      y: box.y - 26,
      width: 700,
      height: 150,
      scale: 2,
    })
  },

  /** 单击时间码仍然进编辑，行内空白处只选中不编辑 */
  async 'click-timecode'(cdp) {
    await goto(cdp, BASE + '/?demo=1&view=editor')
    const box = await cdp.evaluate(`(() => {
      const row = document.querySelectorAll('.subtable__body .row')[0]
      const cell = row.querySelector('.cell--time .timecode__display')
      const r = cell.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    await cdp.click(Math.round(box.x), Math.round(box.y))
    await sleep(300)
    const state = await cdp.evaluate(`(() => ({
      timeInput: !!document.querySelector('.timecode__input'),
      textEditor: !!document.querySelector('.row__editor'),
    }))()`)
    check('点时间码进入时间码编辑，而不是文本编辑', state.timeInput && !state.textEditor)
  },

  /** 右下角通知卡片：四边等宽，左侧不应有强调饰线 */
  async 'toast-plain'(cdp) {
    await goto(cdp, BASE + '/?demo=1')

    // 提示只在点「载入演示数据」时出现，?demo=1 本身不会触发
    const clicked = await cdp.evaluate(`(() => {
      const btn = document.querySelector('.dropzone__dev')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!clicked) throw new Error('找不到「载入演示数据」按钮')
    await sleep(400)

    const state = await cdp.evaluate(`(() => {
      const el = document.querySelector('.toast')
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        left: parseFloat(cs.borderLeftWidth),
        right: parseFloat(cs.borderRightWidth),
        top: parseFloat(cs.borderTopWidth),
        text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      }
    })()`)

    check('通知卡片已出现', state !== null, state ? `“${state.text}”` : '页面里没有 .toast')
    if (state) {
      check(
        '左侧饰线已去掉（四边等宽）',
        state.left === state.right && state.left === state.top,
        `左 ${state.left}px / 右 ${state.right}px / 上 ${state.top}px`,
      )
      await shot(cdp, 'probe-toast.png', {
        x: Math.max(0, Math.round(state.rect.x - 10)),
        y: Math.max(0, Math.round(state.rect.y - 10)),
        width: Math.round(state.rect.w + 20),
        height: Math.round(state.rect.h + 20),
        scale: 2,
      })
    }
  },

  /**
   * 倍速菜单：常规与小窗口下都必须完整可见、六个档位齐全。
   * 菜单原先就地绝对定位，被侧栏滚动容器的 overflow 裁掉，
   * 顶部两个档位（0.5x / 0.75x）在截图里直接消失。
   */
  async 'speed-menu'(cdp) {
    await goto(cdp, BASE + '/?demo=1&view=editor')

    const sizes = [
      { w: 1480, h: 940, tag: '常规窗口' },
      { w: 1000, h: 600, tag: '小窗口' },
    ]

    for (const size of sizes) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: size.w,
        height: size.h,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await sleep(300)

      const opened = await cdp.evaluate(`(() => {
        const btn = document.querySelector('.player__text-btn--speed')
        if (!btn) return false
        btn.click()
        return true
      })()`)
      if (!opened) throw new Error('找不到倍速按钮')
      await sleep(250)

      const state = await cdp.evaluate(`(() => {
        const menu = document.querySelector('.player__speed-menu')
        if (!menu) return null
        const r = menu.getBoundingClientRect()
        const items = [...menu.querySelectorAll('.player__speed-item')].map((el) => {
          const b = el.getBoundingClientRect()
          return { text: el.textContent.trim(), top: b.top, bottom: b.bottom, left: b.left, right: b.right }
        })
        return {
          parentIsBody: menu.parentElement === document.body,
          position: getComputedStyle(menu).position,
          rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height },
          vw: window.innerWidth,
          vh: window.innerHeight,
          items,
        }
      })()`)

      check(`[${size.tag}] 倍速菜单已弹出`, state !== null)
      if (state) {
        check(
          `[${size.tag}] 菜单已脱离滚动容器`,
          state.parentIsBody && state.position === 'fixed',
          `挂在 body 下=${state.parentIsBody}，position=${state.position}`,
        )
        check(
          `[${size.tag}] 菜单整体落在视口内`,
          state.rect.left >= 0 &&
            state.rect.top >= 0 &&
            state.rect.right <= state.vw &&
            state.rect.bottom <= state.vh,
          `菜单 ${Math.round(state.rect.left)},${Math.round(state.rect.top)} → ` +
            `${Math.round(state.rect.right)},${Math.round(state.rect.bottom)}；视口 ${state.vw}×${state.vh}`,
        )
        check(`[${size.tag}] 六个倍速档位齐全`, state.items.length === 6, `实际 ${state.items.length} 项`)

        const clipped = state.items.filter(
          (i) => i.top < 0 || i.bottom > state.vh || i.left < 0 || i.right > state.vw,
        )
        check(
          `[${size.tag}] 没有任何档位被切掉`,
          clipped.length === 0,
          clipped.length ? `被切：${clipped.map((i) => i.text).join('、')}` : '全部完整',
        )

        await shot(cdp, `probe-speed-${size.w}.png`, {
          x: Math.max(0, Math.round(state.rect.left - 180)),
          y: Math.max(0, Math.round(state.rect.top - 34)),
          width: Math.round(Math.min(state.vw, state.rect.w + 190)),
          height: Math.round(Math.min(state.vh, state.rect.h + 76)),
          scale: 2,
        })
      }

      // 收起，免得影响下一个尺寸
      await cdp.evaluate(`document.querySelector('.player__text-btn--speed')?.click()`)
      await sleep(150)
    }

    await cdp.send('Emulation.clearDeviceMetricsOverride')
  },

  /**
   * 长内容弹窗：小窗口下必须收进视口，且超出部分能滚动看到。
   * 原先面板的 max-height 参照了一个由内容撑开的网格行轨道，
   * 自引用导致约束不住，面板顶出屏幕、内部滚动也永远不触发。
   */
  async 'modal-small-window'(cdp) {
    const sizes = [
      { w: 1480, h: 940, tag: '常规窗口' },
      { w: 1000, h: 560, tag: '小窗口' },
    ]

    for (const size of sizes) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: size.w,
        height: size.h,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await goto(cdp, BASE + '/?demo=1&dialog=format-help')
      await sleep(400)

      const state = await cdp.evaluate(`(() => {
        const panel = document.querySelector('.modal__panel')
        const body = document.querySelector('.modal__body')
        const foot = document.querySelector('.modal__foot')
        if (!panel || !body) return null
        const p = panel.getBoundingClientRect()
        const f = foot ? foot.getBoundingClientRect() : null
        return {
          vh: window.innerHeight,
          panel: { top: p.top, bottom: p.bottom, h: p.height },
          footBottom: f ? f.bottom : null,
          scrollH: body.scrollHeight,
          clientH: body.clientHeight,
          before: body.scrollTop,
        }
      })()`)

      check(`[${size.tag}] 弹窗已打开`, state !== null)
      if (!state) continue

      check(
        `[${size.tag}] 面板完整收在视口内`,
        state.panel.top >= 0 && state.panel.bottom <= state.vh,
        `面板 ${Math.round(state.panel.top)} → ${Math.round(state.panel.bottom)}，视口高 ${state.vh}`,
      )
      check(
        `[${size.tag}] 底部页脚可见（关闭按钮没被顶出屏幕）`,
        state.footBottom !== null && state.footBottom <= state.vh,
        `页脚底边 ${state.footBottom === null ? '无页脚' : Math.round(state.footBottom)}`,
      )

      if (state.scrollH > state.clientH) {
        const after = await cdp.evaluate(`(() => {
          const body = document.querySelector('.modal__body')
          body.scrollTop = 99999
          return body.scrollTop
        })()`)
        check(
          `[${size.tag}] 超出内容可以滚动查看`,
          after > state.before,
          `内容 ${state.scrollH}px / 可视 ${state.clientH}px，滚动后 scrollTop=${Math.round(after)}`,
        )
      } else {
        check(
          `[${size.tag}] 内容未被截断（无需滚动）`,
          true,
          `内容 ${state.scrollH}px ≤ 可视 ${state.clientH}px`,
        )
      }

      await shot(cdp, `probe-modal-${size.h}.png`)
    }

    await cdp.send('Emulation.clearDeviceMetricsOverride')
  },

  /** 批 3 编辑操作：添加 / 合并 / 分割 / 撤销 / 重做，全走真实点击与按键 */
  async 'editor-ops'(cdp) {
    await goto(cdp, BASE + '/?demo=1&view=editor')

    const rowCount = () =>
      cdp.evaluate('document.querySelectorAll(".subtable__body .row").length')

    const before = await rowCount()

    // ---- 添加：默认加在当前条之后。先选中第 1 条保证有落点
    const firstRow = await cdp.evaluate(`(() => {
      const row = document.querySelectorAll('.subtable__body .row')[0]
      const r = row.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    await cdp.click(firstRow.x, firstRow.y)
    await sleep(150)

    const addBtn = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.subtable__toolbar .op')]
        .find((b) => b.textContent.includes('添加'))
      btn.click()
      return true
    })()`)
    check('点击添加按钮', addBtn === true)
    await sleep(250)
    const afterAdd = await rowCount()
    check('添加后行数 +1', afterAdd === before + 1, `${before} -> ${afterAdd}`)

    // 新条目自动进入编辑态（空文本）
    const snap250 = await cdp.evaluate(`(() => ({
      editors: document.querySelectorAll('.row__editor').length,
      activeTag: document.activeElement?.tagName ?? null,
    }))()`)
    await sleep(400)
    const newEditor = await cdp.evaluate(`(() => {
      const ta = document.querySelector('.row__editor')
      return { exists: !!ta, value: ta ? ta.value : null, focused: document.activeElement === ta }
    })()`)
    check('新条目为空文本并进入编辑', newEditor.exists && newEditor.value === '',
      `250ms=${JSON.stringify(snap250)} 650ms=${JSON.stringify(newEditor)}`)
    check('编辑框获得焦点', newEditor.focused === true, `250ms active=${snap250.activeTag}`)

    // ---- 合并：先单击第 6 行的行空白（只选中该行），再勾选相邻两条，保证连续
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('.row__editor')
      if (ta) ta.blur()
    })()`)
    await sleep(200)

    await cdp.evaluate(`(() => {
      const rows = document.querySelectorAll('.subtable__body .row')
      const cell = rows[5].querySelector('.cell--index')
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })()`)
    await sleep(150)

    await cdp.evaluate(`(() => {
      const boxes = document.querySelectorAll('.subtable__body .row .row__check')
      boxes[6].click()
      boxes[7].click()
    })()`)
    await sleep(200)

    const mergeState = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.subtable__toolbar .op')]
        .find((b) => b.textContent.includes('合并'))
      const enabled = btn && !btn.disabled
      if (btn) btn.click()
      return { enabled }
    })()`)
    check('合并按钮在连续选中时可用', mergeState.enabled === true)
    await sleep(250)
    const afterMerge = await rowCount()
    check('合并三条后行数 -2', afterMerge === afterAdd - 2, `${afterAdd} -> ${afterMerge}`)

    // ---- 撤销：Ctrl+Z 应回到合并前
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90,
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90,
    })
    await sleep(250)
    const afterUndo = await rowCount()
    check('Ctrl+Z 撤销合并', afterUndo === afterAdd, `${afterMerge} -> ${afterUndo}`)

    // ---- 重做：Ctrl+Y 恢复合并
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: 2, key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89,
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 2, key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89,
    })
    await sleep(250)
    const afterRedo = await rowCount()
    check('Ctrl+Y 重做合并', afterRedo === afterMerge, `${afterUndo} -> ${afterRedo}`)

    // ---- 撤销合并 + 撤销添加，回到初始
    for (let k = 0; k < 2; k += 1) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90,
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90,
      })
      await sleep(200)
    }
    check('撤销合并和添加回到初始行数', (await rowCount()) === before)

    // ---- 分割：单击第 4 条文本中点进入编辑（光标落在点击处），再用**真实鼠标**
    // 点击分割按钮。必须用真实事件：JS 的 btn.click() 不会转移焦点，
    // 而真实点击会先 blur 掉 textarea —— 分割按钮失效的根因就藏在这条路径里。
    const midRow = await cdp.evaluate(`(() => {
      const row = document.querySelectorAll('.subtable__body .row')[3]
      const cell = row.querySelector('.cell--text')
      const r = cell.getBoundingClientRect()
      return {
        x: r.x + r.width * 0.4,
        y: r.y + r.height / 2,
        text: row.querySelector('.row__text').textContent,
      }
    })()`)
    await cdp.click(midRow.x, midRow.y)
    await sleep(350)

    const editing = await cdp.evaluate(`(() => ({
      editors: document.querySelectorAll('.row__editor').length,
      focused: document.activeElement?.classList?.contains('row__editor') ?? false,
    }))()`)
    check('点击文本进入编辑且输入框有焦点', editing.editors === 1 && editing.focused === true)

    const splitBtn = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.subtable__toolbar .op')]
        .find((b) => b.textContent.includes('分割'))
      const r = btn.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: btn.disabled }
    })()`)
    check('分割按钮可用', splitBtn.disabled === false)
    await cdp.click(splitBtn.x, splitBtn.y)
    await sleep(300)
    const afterSplit = await rowCount()
    check('分割后行数 +1', afterSplit === before + 1, `${before} -> ${afterSplit}`)

    const halves = await cdp.evaluate(`(() => {
      const rows = document.querySelectorAll('.subtable__body .row')
      return [rows[3], rows[4]].map((r) => r.querySelector('.row__text').textContent)
    })()`)
    check('分割两半拼接等于原文', halves.join('') === midRow.text,
      JSON.stringify(halves))

    await shot(cdp, 'probe-editor-ops.png')
  },

  /**
   * 准确率优化相关的设置：词库勾选、预算显示、推理深度、音质前处理开关。
   * 这些选项必须真的落到 localStorage 里 —— 只改组件内部状态的话，
   * 识别时读不到，功能等于没做（模型页的假下载就是这么来的）。
   */
  async 'import-narrow'(cdp) {
    // 响应式回归：DropZone 文字列曾被 flex 压到零宽，中文一字一行竖排，
    // 整条虚线框被自己的竖排文字撑到半屏高。两个断言管住两道防线：
    // 窄窗收单栏（媒体查询）与文字列保底宽度（flex-wrap + min-width）。
    await goto(cdp, BASE + '/')
    await sleep(300)

    const measure = `(() => {
      const main = document.querySelector('.io__main')
      const side = document.querySelector('.io__side')
      const title = document.querySelector('.dropzone__title')
      if (!main || !side || !title) return null
      const m = main.getBoundingClientRect()
      const s = side.getBoundingClientRect()
      const t = title.getBoundingClientRect()
      return {
        twoCol: Math.abs(s.top - m.top) < 80,
        mainW: Math.round(m.width),
        titleH: Math.round(t.height),
        titleW: Math.round(t.width),
      }
    })()`

    for (const size of [
      { w: 1480, h: 940, wide: true },
      { w: 1000, h: 720, wide: false },
    ]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: size.w,
        height: size.h,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await sleep(300)
      const m = await cdp.evaluate(measure)
      if (size.wide) {
        check(`宽窗保持两栏 — ${size.w}px`, m?.twoCol === true, JSON.stringify(m))
        check(`宽窗主列宽度充足 — ${size.w}px`, (m?.mainW ?? 0) > 600, String(m?.mainW))
      } else {
        check(`窄窗收成单栏 — ${size.w}px`, m?.twoCol === false, JSON.stringify(m))
        check(`窄窗文字不竖排 — ${size.w}px`, (m?.titleH ?? 99) < 60 && (m?.titleW ?? 0) >= 150, JSON.stringify(m))
      }
    }
    await shot(cdp, 'probe-import-narrow.png')
    await cdp.send('Emulation.clearDeviceMetricsOverride')
  },

  async 'glass-setting'(cdp) {
    await cdp.send('Page.enable')
    await goto(cdp, BASE + '/?demo=1&view=settings&theme=light')

    /*
     * 本场景自己会把开关关掉，而浏览器 profile 里的 localStorage 会留到下次运行 ——
     * 不复位的话「默认开启」这条断言从第二次跑起必然假失败。
     */
    await cdp.evaluate(`(() => {
      const raw = JSON.parse(localStorage.getItem('xbaos.settings.v6') || '{}')
      raw.glassEnabled = true
      localStorage.setItem('xbaos.settings.v6', JSON.stringify(raw))
    })()`)
    await goto(cdp, BASE + '/?demo=1&view=settings&theme=light')
    await sleep(600)

    // 浏览器预览没有 Electron 桥：毛玻璃必须保持纯色回退，html 上不能有 glass 类
    const state = await cdp.evaluate(`(() => {
      const sw = document.querySelector('.glass-switch')
      return {
        glassClass: document.documentElement.classList.contains('glass'),
        switchCount: sw ? 1 : 0,
        checked: sw?.querySelector('input')?.checked ?? null,
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      }
    })()`)
    check('浏览器预览不挂 glass 类（纯色回退）', state.glassClass === false, String(state.glassClass))
    check('设置页存在毛玻璃开关', state.switchCount === 1, String(state.switchCount))
    check('毛玻璃默认开启', state.checked === true, String(state.checked))
    check('回退时 html 底色不透明（浅色 #ededed）', state.htmlBg === 'rgb(237, 237, 237)', state.htmlBg)

    // 点开关 → 写回设置存储（浏览器模式没有主进程桥，只能验到设置层）
    const center = await cdp.evaluate(`(() => {
      const r = document.querySelector('.glass-switch').getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    await cdp.click(center.x, center.y)
    await sleep(300)
    const saved = await cdp.evaluate(
      `JSON.parse(localStorage.getItem('xbaos.settings.v6') || '{}').glassEnabled`,
    )
    check('关闭开关写入设置存储', saved === false, String(saved))

    /*
     * 浏览器里主进程不会给玻璃（也没有材质），但**令牌链必须自洽**：
     * 手动挂上 glass 类，量标题栏遮罩的实际计算值 —— 只挂类而遮罩仍是实色，
     * 等于材质被盖死，用户永远看不到透明。浅色怕色带（要贴近界面底色），
     * 深色怕看不见（要更薄），两套数值都要落到半透明才算对。
     */
    const veilOf = (theme) =>
      cdp.evaluate(`(() => {
        const root = document.documentElement
        const prev = root.dataset.theme || ''
        const alpha = (c) => {
          const rgba = c.match(/rgba?\\(([^)]+)\\)/)
          if (rgba) { const p = rgba[1].split(','); return p.length === 4 ? Number(p[3]) : 1 }
          const slash = c.match(/\\/\\s*([\\d.]+)\\s*\\)/)
          return slash ? Number(slash[1]) : 1
        }
        const alphaOf = (sel) => {
          const el = sel && document.querySelector(sel)
          return el ? alpha(getComputedStyle(el).backgroundColor) : null
        }
        const read = () => ({
          alpha: alphaOf('.titlebar'),
          borderAlpha: alpha(getComputedStyle(document.querySelector('.titlebar')).borderBottomColor),
          htmlBg: getComputedStyle(root).backgroundColor,
          // 外壳必须不铺底（两层半透明相叠透过率相乘，材质等于没做）
          appAlpha: alphaOf('.app'),
          // 两级壳层：外壳遮罩 + 内容区遮罩，乘起来才是内容区实际的材质透出量
          shellAlpha: alphaOf('.app__main'),
          regionAlpha: alphaOf('.view__body'),
          // 侧栏/状态条（面板色，直接压在材质上或外壳上）
          sidebarAlpha: alphaOf('.sidebar'),
          statusAlpha: alphaOf('.statusbar'),
          // 卡片必须仍然不透明，否则正文可读性没了
          cardAlpha: alphaOf('.block, .panel, .step'),
          viewColor: getComputedStyle(document.querySelector('.titlebar__view')).color,
          nameShadow: getComputedStyle(document.querySelector('.titlebar__name')).textShadow,
        })
        root.dataset.theme = ${JSON.stringify(theme)}
        root.classList.remove('glass')
        const solid = read()
        root.classList.add('glass')
        const glass = read()
        root.classList.remove('glass')
        // 量完把外观还原成进来时的样子，别让后面的截图串了主题
        if (prev) root.dataset.theme = prev
        else root.removeAttribute('data-theme')
        return { solid, glass }
      })()`)

    const light = await veilOf('light')
    check('浅色：玻璃层确实半透明', light.glass.alpha > 0.5 && light.glass.alpha < 0.85, JSON.stringify(light))
    check('浅色：玻璃层比实色层通透', light.glass.alpha < light.solid.alpha, JSON.stringify(light))
    check('浅色：挂类后 html 底放开透明（材质才透得出来）', light.glass.htmlBg === 'rgba(0, 0, 0, 0)', light.glass.htmlBg)
    check('浅色：底部描边同步变淡', light.glass.borderAlpha < 1, JSON.stringify(light.glass))

    const dark = await veilOf('dark')
    check('深色：玻璃层更薄（比浅色更透，否则看不出效果）', dark.glass.alpha < light.glass.alpha, `dark=${dark.glass.alpha} light=${light.glass.alpha}`)
    check('深色：玻璃层确实半透明', dark.glass.alpha > 0.25 && dark.glass.alpha < 0.65, JSON.stringify(dark))

    // ---- 标题栏下方整块界面：有玻璃味但不能喧宾夺主 ----
    check('外壳不铺底（两层半透明相叠等于没材质）', light.glass.appAlpha === 0, String(light.glass.appAlpha))
    check(
      '内容区两级遮罩（外壳 + 内容区，各一层）',
      light.glass.shellAlpha < 1 &&
        light.glass.regionAlpha < 1 &&
        light.glass.regionAlpha !== light.glass.shellAlpha,
      `shell=${light.glass.shellAlpha} region=${light.glass.regionAlpha}`,
    )
    check(
      '内容区实际材质透出量约一成（乘法结果，不是单个数值）',
      (1 - light.glass.shellAlpha) * (1 - light.glass.regionAlpha) > 0.03 &&
        (1 - light.glass.shellAlpha) * (1 - light.glass.regionAlpha) < 0.15,
      `透出 ${(((1 - light.glass.shellAlpha) * (1 - light.glass.regionAlpha)) * 100).toFixed(1)}%`,
    )
    check('侧栏同为极淡玻璃', light.glass.sidebarAlpha > 0.85 && light.glass.sidebarAlpha < 0.98, String(light.glass.sidebarAlpha))
    check('状态条同为极淡玻璃', light.glass.statusAlpha > 0.85 && light.glass.statusAlpha < 0.98, String(light.glass.statusAlpha))
    check('卡片保持不透明（正文可读性优先）', light.glass.cardAlpha === 1, String(light.glass.cardAlpha))
    check(
      '深色壳层同样是两级',
      dark.glass.shellAlpha < 1 &&
        dark.glass.regionAlpha < 1 &&
        dark.glass.regionAlpha !== dark.glass.shellAlpha,
      `shell=${dark.glass.shellAlpha} region=${dark.glass.regionAlpha}`,
    )

    // ---- 标题栏文字：提档 + 光晕，否则半透明底上会「不清楚」 ----
    check('窗口标题从 tertiary 提档（玻璃下不再发灰）', light.glass.viewColor !== light.solid.viewColor, `${light.solid.viewColor} → ${light.glass.viewColor}`)
    check('品牌名带文字光晕', light.glass.nameShadow !== 'none' && !!light.glass.nameShadow, String(light.glass.nameShadow))
    check('深色下文字光晕同样存在', dark.glass.nameShadow !== 'none' && !!dark.glass.nameShadow, String(dark.glass.nameShadow))

    // ---- 附属窗口（AI 辅助 / 录音）：同一套规则，标题栏 + 外壳都要半透明 ----
    const measureGlass = () =>
      cdp.evaluate(`(() => {
        const root = document.documentElement
        root.classList.add('glass')
        const alpha = (sel) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const c = getComputedStyle(el).backgroundColor
          const rgba = c.match(/rgba?\\(([^)]+)\\)/)
          if (rgba) { const p = rgba[1].split(','); return p.length === 4 ? Number(p[3]) : 1 }
          const slash = c.match(/\\/\\s*([\\d.]+)\\s*\\)/)
          return slash ? Number(slash[1]) : 1
        }
        const out = {
          bar: alpha('.abar') ?? alpha('.rbar'),
          shell: alpha('.assist') ?? alpha('.rec'),
          shellEl: document.querySelector('.assist') ? '.assist' : '.rec',
        }
        root.classList.remove('glass')
        return out
      })()`)

    for (const [win, label] of [['assist', 'AI 辅助窗口'], ['record', '录音窗口']]) {
      await goto(cdp, `${BASE}/?window=${win}&demo=1&theme=light`)
      await sleep(600)
      const m = await measureGlass()
      check(`${label}：标题栏也做了玻璃`, m.bar !== null && m.bar < 0.9, JSON.stringify(m))
      check(`${label}：外壳有一层极淡玻璃`, m.shell !== null && m.shell > 0.85 && m.shell < 0.98, JSON.stringify(m))
    }

    // ---- 内容页页脚条（导入页底部那条）：也在内容列里，必须跟内容同一套色系 ----
    await goto(cdp, `${BASE}/?demo=1&theme=light`)
    await sleep(800)
    const foot = await cdp.evaluate(`(() => {
      const root = document.documentElement
      root.classList.add('glass')
      const raw = (sel) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el).backgroundColor : null
      }
      const alpha = (c) => {
        if (!c) return null
        const rgba = c.match(/rgba?\\(([^)]+)\\)/)
        if (rgba) { const p = rgba[1].split(','); return p.length === 4 ? Number(p[3]) : 1 }
        const slash = c.match(/\\/\\s*([\\d.]+)\\s*\\)/)
        return slash ? Number(slash[1]) : 1
      }
      const out = {
        footRaw: raw('.view__foot'),
        footAlpha: alpha(raw('.view__foot')),
        shellAlpha: alpha(raw('.app__main')),
        bodyAlpha: alpha(raw('.view__body')),
        borderRaw: document.querySelector('.view__foot')
          ? getComputedStyle(document.querySelector('.view__foot')).borderTopColor
          : null,
      }
      root.classList.remove('glass')
      return out
    })()`)
    // 页脚条**不铺自己的底**，只吃外壳那一层 → 材质透出量是内容区的两三倍，玻璃才看得见
    check(
      '导入页页脚条不铺底（材质直接透出来）',
      foot.footAlpha === 0 || foot.footRaw === 'rgba(0, 0, 0, 0)',
      JSON.stringify(foot),
    )
    check(
      '页脚条的材质透出量明显高于内容区',
      foot.shellAlpha !== null && foot.bodyAlpha !== null && 1 - foot.shellAlpha > (1 - foot.shellAlpha) * (1 - foot.bodyAlpha) * 2,
      `外壳透 ${((1 - foot.shellAlpha) * 100).toFixed(0)}% / 内容区透 ${(((1 - foot.shellAlpha) * (1 - foot.bodyAlpha)) * 100).toFixed(1)}%`,
    )

    await goto(cdp, BASE + '/?demo=1&view=settings&theme=light')
    await sleep(500)
    await shot(cdp, 'probe-glass-setting.png')

    /*
     * 再出一张「玻璃模式」的截图：浏览器里没有系统材质，这里垫一块代表材质的
     * 纯色当替身，就能看出「遮罩 + 材质色」叠起来到底什么观感 —— 光看计算值
     * 判断不了「深浅两套色调是否协调」。浅色用浅材质、深色用深材质分别出图。
     */
    for (const [theme, mat, name, view] of [
      ['light', '#8e9aa6', 'probe-glass-light.png', '&view=settings'],
      ['light', '#8e9aa6', 'probe-glass-import.png', ''],
      ['dark', '#2b333c', 'probe-glass-dark.png', '&view=settings'],
    ]) {
      await goto(cdp, `${BASE}/?demo=1&theme=${theme}${view}`)
      await sleep(500)
      await cdp.evaluate(`(() => {
        document.documentElement.classList.add('glass')
        const sheet = document.createElement('div')
        sheet.id = 'probe-material'
        sheet.style.cssText = 'position:fixed;inset:0;z-index:-1;background:${mat}'
        document.body.appendChild(sheet)
        return true
      })()`)
      await sleep(300)
      await shot(cdp, name)
      await cdp.evaluate(`(() => {
        document.documentElement.classList.remove('glass')
        document.getElementById('probe-material')?.remove()
        return true
      })()`)
    }
  },

  async 'accuracy-settings'(cdp) {
    // 先清掉历史设置再进页面：这套断言依赖默认值，而探针用的是持久化
    // profile，上一次运行留下的词库勾选会让「默认开启」之类的断言假失败。
    // 识别相关设置已从设置页移到导入页（默认视图），这里直接开导入页。
    await goto(cdp, BASE + '/')
    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
    await goto(cdp, BASE + '/')

    // ---- 默认值回归：外观默认跟随系统、推理深度默认增强 ----
    const theme = await cdp.evaluate(`document.documentElement.dataset.theme || 'auto'`)
    check('默认外观跟随系统', theme === 'auto', theme)

    // 设置页的「外观」也要跟着默认值走（选中的应是「跟随系统」）
    await goto(cdp, BASE + '/?view=settings')
    await sleep(300)
    const activeTheme = await cdp.evaluate(`(() => {
      const el = document.querySelector('.choice-row .choice.is-active')
      return el ? el.textContent.trim() : ''
    })()`)
    check('设置页外观默认选中「跟随系统」', activeTheme.includes('跟随系统'), activeTheme)
    await shot(cdp, 'probe-settings-theme.png')
    await goto(cdp, BASE + '/')
    await sleep(300)

    const activeDepth = await cdp.evaluate(`(() => {
      const el = document.querySelector('.choice.is-active')
      return el ? el.textContent.trim() : ''
    })()`)
    check('默认推理深度为增强', activeDepth === '增强', activeDepth)

    /**
     * 取元素中心的坐标，并先滚动到视口内。导入页很长，
     * 高级选项折叠在下方，不滚动的话点击落在视口外等于没点。
     */
    const centerOf = (js) =>
      cdp.evaluate(`(() => {
        const el = ${js}
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)

    const readSettings = () =>
      cdp.evaluate(`(() => {
        const keys = Object.keys(localStorage)
        const key = keys.find((k) => k.startsWith('xbaos.settings')) || 'xbaos.settings.v6'
        try {
          return { ...JSON.parse(localStorage.getItem(key) || '{}'), __key: key }
        } catch {
          return { __key: key }
        }
      })()`)

    const lexCount = await cdp.evaluate(`document.querySelectorAll('.lex').length`)
    check('词库列表渲染 5 个内置词库', lexCount === 5, `实际 ${lexCount}`)

    const before = await cdp.evaluate(`document.querySelector('.lex-budget').textContent.trim()`)
    check('预算显示初始为 0', before.startsWith('0'), before)

    // 勾选第一个词库（真实鼠标点击 label）
    const firstLex = await centerOf(`document.querySelector('.lex')`)
    if (!firstLex) throw new Error('找不到词库条目')
    await cdp.click(firstLex.x, firstLex.y)
    await sleep(300)

    const activeCount = await cdp.evaluate(`document.querySelectorAll('.lex.is-active').length`)
    check('勾选后高亮', activeCount === 1, `实际 ${activeCount}`)

    const afterLex = await cdp.evaluate(`document.querySelector('.lex-budget').textContent.trim()`)
    check('预算占用随之变化', afterLex !== before, `${before} -> ${afterLex}`)

    const stored = await readSettings()
    check(
      '词库勾选写入设置存储',
      Array.isArray(stored.lexiconIds) && stored.lexiconIds.includes('tech'),
      `${stored.__key} -> ${JSON.stringify(stored.lexiconIds)}`,
    )

    // 切到「深度」档
    const deepBtn = await centerOf(
      `[...document.querySelectorAll('.choice')].find((b) => b.textContent.trim() === '深度')`,
    )
    await cdp.click(deepBtn.x, deepBtn.y)
    await sleep(300)

    const storedDepth = (await readSettings()).reasoningDepth
    check('推理深度写入设置存储', storedDepth === 'deep', String(storedDepth))

    // 滑动指示块：切换后要滑到「深度」那一格（量的是几何，不是「有没有这个元素」
    // —— 元素在但没跟着动，等于没做这个动画）
    const thumb = await cdp.evaluate(`(() => {
      const seg = document.querySelector('.seg')
      const thumb = seg?.querySelector('.seg-thumb')
      const active = seg?.querySelector('.choice.is-active')
      if (!seg || !thumb || !active) return null
      const t = thumb.getBoundingClientRect()
      const a = active.getBoundingClientRect()
      return {
        onActive: Math.abs(t.left - a.left) < 2 && Math.abs(t.width - a.width) < 2,
        left: Math.round(t.left),
        activeLeft: Math.round(a.left),
      }
    })()`)
    check('分段控件选中标记滑动到了新的一格', thumb?.onActive === true, JSON.stringify(thumb))

    const hint = await cdp.evaluate(`(() => {
      const blocks = [...document.querySelectorAll('.field__hint')]
      const el = blocks.find((b) => b.textContent.includes('五遍') || b.textContent.includes('两遍精选'))
      return el ? el.textContent.replace(/\\s+/g, '') : ''
    })()`)
    check('深度档说明随之更新', hint.length > 0, hint.slice(0, 30))

    // 展开「高级选项」，静音切分开关在里面
    await cdp.evaluate(`(() => {
      const d = document.querySelector('.adv')
      if (d) d.open = true
      return true
    })()`)
    await sleep(200)

    const vadBox = await cdp.evaluate(`(() => {
      // 高级选项里的开关不止一个，必须按文字定位，不能取「第一个」
      const label = [...document.querySelectorAll('.switch')]
        .find((l) => l.textContent.includes('静音检测与长音频切分'))
      const input = label?.querySelector('input[type=checkbox]')
      return input ? { checked: input.checked } : { checked: null }
    })()`)
    check('静音切分默认开启', vadBox.checked === true, String(vadBox.checked))

    const vadCenter = await centerOf(
      `[...document.querySelectorAll('.switch')]
        .find((l) => l.textContent.includes('静音检测与长音频切分'))
        ?.querySelector('input[type=checkbox]')`,
    )
    await cdp.click(vadCenter.x, vadCenter.y)
    await sleep(300)
    const vadAfter = (await readSettings()).vadEnabled
    check('静音切分开关写入设置存储', vadAfter === false, String(vadAfter))

    // 复位：别把关闭态留给后面的场景（localStorage 在同一浏览器会话里是共享的）
    await cdp.click(vadCenter.x, vadCenter.y)
    await sleep(200)

    // ---- 实验增强三件套已从 UI 隐藏（2026-10-11 实测降质）----
    // 只允许剩下 3 个开关（归一化 / 高通 / 静音切分），且隐藏的三项必须
    // 真的找不到 —— 哪天有人把它们加回 UI，这里要拦住。
    const switches = await cdp.evaluate(`(() => {
      return {
        list: [...document.querySelectorAll('.switch')].map((l) => ({
          text: l.textContent.trim(),
          checked: l.querySelector('input[type=checkbox]')?.checked ?? null,
        })),
        sceneSelect: !!document.querySelector('.scsel__value'),
      }
    })()`)
    const texts = switches.list.map((s) => s.text)
    check('可见开关恰好 3 个', switches.list.length === 3, JSON.stringify(texts))
    for (const hidden of ['按录音场景切分', '束搜索', '低置信度段落复核']) {
      check(`实验开关已隐藏 — ${hidden}`, !texts.some((t) => t.includes(hidden)))
    }
    for (const s of switches.list) {
      check(`保留开关默认开启 — ${s.text}`, s.checked === true, String(s.checked))
    }
    check('场景下拉不再渲染', switches.sceneSelect === false)

    // 存档里的旧开关残留也会被 load() 强制复位（隐藏后没有入口能再打开）
    const forced = await readSettings()
    check(
      '实验功能在存档中被强制关闭',
      forced.vadSceneEnabled === false &&
        forced.beamSearch === false &&
        forced.lowConfRescue === false &&
        forced.beamSize === 1,
      JSON.stringify({
        vadSceneEnabled: forced.vadSceneEnabled,
        beamSearch: forced.beamSearch,
        lowConfRescue: forced.lowConfRescue,
        beamSize: forced.beamSize,
      }),
    )

    await shot(cdp, 'probe-import-accuracy.png')

    // ---- 设置页新增章节：字幕规格 / 模型存储位置 ----
    await goto(cdp, BASE + '/?view=settings')
    await sleep(300)

    const specInput = (index) => `[...document.querySelectorAll('.block')]
      .filter((b) => b.querySelector('.block__title')?.textContent.includes('字幕规格'))
      .flatMap((b) => [...b.querySelectorAll('input[type=number]')])[${index}]`

    const specValues = await cdp.evaluate(`(() => {
      const inputs = [...document.querySelectorAll('.block')]
        .filter((b) => b.querySelector('.block__title')?.textContent.includes('字幕规格'))
        .flatMap((b) => [...b.querySelectorAll('input[type=number]')])
      return inputs.map((i) => Number(i.value))
    })()`)
    check(
      '字幕规格四项默认值 16 / 42 / 1 / 7',
      JSON.stringify(specValues) === JSON.stringify([16, 42, 1, 7]),
      JSON.stringify(specValues),
    )

    const readSpecHint = () =>
      cdp.evaluate(`(() => {
        const p = [...document.querySelectorAll('.punct-intro')].find((e) =>
          e.textContent.includes('按当前设置'),
        )
        return p ? p.textContent.replace(/\\s+/g, '') : ''
      })()`)
    const specHint = await readSpecHint()
    check(
      '字幕规格给出实时换算',
      specHint.includes('16') && specHint.includes('42'),
      specHint.slice(0, 60),
    )

    // 改中文单行上限 → 落盘 + 换算跟着动（提示词与导出折行都靠这套上限）
    await cdp.evaluate(`(() => {
      const input = ${specInput(0)}
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '20')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(300)
    const specStored = await readSettings()
    check('改动字幕规格写入设置存储', specStored.maxCharsPerLine === 20, String(specStored.maxCharsPerLine))
    const specHint2 = await readSpecHint()
    check('换算提示跟随更新', specHint2.includes('20'), specHint2.slice(0, 60))

    // 模型存储位置区块：用户拍板「换目录后不再扫旧目录」，界面必须讲清楚
    const dirBlock = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('.block')].find(
        (x) => x.querySelector('.block__title')?.textContent.includes('模型存储位置'),
      )
      if (!b) return null
      return {
        path: !!b.querySelector('.path-box'),
        buttons: [...b.querySelectorAll('.row-actions .btn')].map((x) => x.textContent.trim()),
        warn: (b.querySelector('.hint')?.textContent || '').includes('只会'),
      }
    })()`)
    check('设置页有模型存储位置区块', !!dirBlock && dirBlock.path)
    check(
      '提供更改位置与打开文件夹',
      !!dirBlock &&
        dirBlock.buttons.includes('更改位置') &&
        dirBlock.buttons.includes('打开文件夹'),
      JSON.stringify(dirBlock?.buttons),
    )
    check('写明换目录后旧目录不再扫描', !!dirBlock && dirBlock.warn)

    await shot(cdp, 'probe-settings-spec.png')

    // ---- 模型管理页的「更改存储位置」应把人直接送到设置页对应章节 ----
    // 换目录、恢复默认归设置页管，但用户想改存储位置时第一反应是来模型页。
    await goto(cdp, BASE + '/?view=models')
    await sleep(400)
    const goBtn = await centerOf(
      `[...document.querySelectorAll('.own__actions .btn')].find((b) => b.textContent.includes('更改存储位置'))`,
    )
    check('模型页有更改存储位置入口', !!goBtn)
    if (goBtn) {
      await cdp.click(goBtn.x, goBtn.y)
      await sleep(900)
      const landed = await cdp.evaluate(`(() => {
        const sec = document.getElementById('models-dir')
        if (!sec) return null
        const r = sec.getBoundingClientRect()
        return {
          title: sec.querySelector('.block__title')?.textContent?.trim() ?? '',
          top: Math.round(r.top),
          viewH: window.innerHeight,
        }
      })()`)
      check(
        '点击后落到设置页的模型存储位置章节',
        !!landed && landed.title.includes('模型存储位置'),
        JSON.stringify(landed),
      )
      check(
        '并且自动滚动到了该章节（落在视口内）',
        !!landed && landed.top < landed.viewH && landed.top > -landed.viewH,
        JSON.stringify(landed),
      )
    }

    // 复原：把设置清空，避免影响其它场景与下次运行
    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
  },

  /**
   * 合并为一条时间轴。
   *
   * 这一整套断言对应三个真实反馈：
   *   1. 合并模式下编辑器里必须是「一条拼接产物」，不能点队列里的音频就把
   *      预览换成某一个文件（上一版就是这个行为，用户看到的是空文件，
   *      误以为「什么都没识别出来」）；
   *   2. 批量处理模式选定后要钉死，防止先识别再切模式把旧结果卷进合并；
   *   3. 合并产物要是一条真实的时间轴 —— 字幕能编辑、导出只出一个文件。
   */
  async 'merge-timeline'(cdp) {
    const centerOf = (js) =>
      cdp.evaluate(`(() => {
        const el = ${js}
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)

    await goto(cdp, BASE + '/?demo=1')
    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
    await goto(cdp, BASE + '/?demo=1')
    await sleep(400)

    const modeCards = await cdp.evaluate(`document.querySelectorAll('.block__body--modes .mode').length`)
    check('批量处理方式渲染两张模式卡', modeCards === 2, `实际 ${modeCards}`)

    // 选「合并为一条时间轴」（真实鼠标点击）
    const mergeCard = await centerOf(
      `[...document.querySelectorAll('.mode')].find((b) => b.textContent.includes('合并为一条时间轴'))`,
    )
    if (!mergeCard) throw new Error('找不到「合并为一条时间轴」卡片')
    await cdp.click(mergeCard.x, mergeCard.y)
    await sleep(300)

    // 点选即锁太严苛（用户点错了没法回头），改为「开始识别」后才锁
    const lockedAfterPick = await cdp.evaluate(`document.querySelectorAll('.mode.is-locked').length`)
    check('点选模式后不锁定（点错可以反悔）', lockedAfterPick === 0, `实际 ${lockedAfterPick}`)

    const activeIsMerge = await cdp.evaluate(`(() => {
      const el = document.querySelector('.mode.is-active')
      return el ? el.textContent.includes('合并为一条时间轴') : false
    })()`)
    check('选中合并卡后进入合并模式', activeIsMerge === true, String(activeIsMerge))

    // 合并模式下队列条目应被标记为不可切换（点了不换预览）
    const rowsInfo = await cdp.evaluate(`({
      total: document.querySelectorAll('.queue__row').length,
      statics: document.querySelectorAll('.queue__row.is-static').length,
    })`)
    check(
      '合并模式下队列条目全部标记为不可切换',
      rowsInfo.total > 0 && rowsInfo.statics === rowsInfo.total,
      `${rowsInfo.statics}/${rowsInfo.total}`,
    )

    // 未锁定时点另一张卡：应真实切换模式
    const sepCard = await centerOf(
      `[...document.querySelectorAll('.mode')].find((b) => b.textContent.includes('各自独立处理'))`,
    )
    await cdp.click(sepCard.x, sepCard.y)
    await sleep(300)
    const nowSeparate = await cdp.evaluate(`(() => {
      const el = document.querySelector('.mode.is-active')
      return el ? el.textContent.includes('各自独立处理') : false
    })()`)
    check('未锁定时点另一张卡可以切换模式', nowSeparate === true, String(nowSeparate))

    // 切回合并，准备走识别流程
    const backMerge = await centerOf(
      `[...document.querySelectorAll('.mode')].find((b) => b.textContent.includes('合并为一条时间轴'))`,
    )
    await cdp.click(backMerge.x, backMerge.y)
    await sleep(300)
    check(
      '切回合并模式',
      await cdp.evaluate(`(() => {
        const el = document.querySelector('.mode.is-active')
        return el ? el.textContent.includes('合并为一条时间轴') : false
      })()`),
    )

    await shot(cdp, 'probe-home-mode-selected.png')

    // 走一遍演示识别（每个文件约 2.2 秒）
    const startBtn = await centerOf(
      `[...document.querySelectorAll('.view__foot .btn')].find((b) => b.textContent.includes('开始识别'))`,
    )
    await cdp.click(startBtn.x, startBtn.y)
    await sleep(300)

    // 「开始识别」这一刻起队列与产物归属定死，模式随之锁死
    const lockedAfterStart = await cdp.evaluate(`document.querySelectorAll('.mode.is-locked').length`)
    check('点击开始识别后才锁定模式', lockedAfterStart === 2, `实际 ${lockedAfterStart}`)

    // 演示识别的耗时按文件数估，但机器忙时会明显更慢 —— 固定 sleep 在全量跑时
    // 曾把这条判成假失败，还一路把后面的断言带走。改成轮询等待。
    const entered = await waitFor(cdp, `!!document.querySelector('.editor')`, 120_000)
    check('识别完成后进入编辑器', entered)

    // 编辑器出现 ≠ 表格已经填好，表格那一帧也要等一下再数
    await waitFor(cdp, `document.querySelectorAll('.subtable__body .row').length > 0`, 15_000)
    const mergedRows = await cdp.evaluate(`document.querySelectorAll('.subtable__body .row').length`)
    check('合并视图把各段字幕拼成一条时间轴', mergedRows > 0, `实际 ${mergedRows}`)

    const bar = await cdp.evaluate(`(() => {
      const el = document.querySelector('.mergebar')
      return el ? el.textContent.replace(/\\s+/g, '') : ''
    })()`)
    check('编辑器给出合并模式说明', bar.includes('合并时间轴'), bar.slice(0, 40))

    // 左侧应只有一条产物 + 分段清单，且都不可点（点不开、换不掉预览）
    const clickableInTree = await cdp.evaluate(
      `document.querySelectorAll('.filetree__item button, .filetree__item[type=button]').length`,
    )
    check('合并模式下文件树没有可点的条目', clickableInTree === 0, `实际 ${clickableInTree}`)

    await shot(cdp, 'probe-editor-merge.png')

    // 回导入页，点一个队列音频再进预览：内容必须还是那条合并时间轴
    const homeNav = await centerOf(
      `[...document.querySelectorAll('.sidebar__item')].find((b) => b.textContent.includes('导入'))`,
    )
    await cdp.click(homeNav.x, homeNav.y)
    await sleep(400)

    const thirdRow = await centerOf(`document.querySelectorAll('.queue__row')[2]`)
    await cdp.click(thirdRow.x, thirdRow.y)
    await sleep(300)

    const previewBtn = await centerOf(
      `[...document.querySelectorAll('.view__foot .btn')].find((b) => b.textContent.includes('去预览'))`,
    )
    await cdp.click(previewBtn.x, previewBtn.y)
    await sleep(400)

    const rowsAfter = await cdp.evaluate(`document.querySelectorAll('.subtable__body .row').length`)
    const barAfter = await cdp.evaluate(`(() => {
      const el = document.querySelector('.mergebar')
      return el ? el.textContent.replace(/\\s+/g, '') : ''
    })()`)
    check(
      '点队列里的音频不会换掉合并预览',
      rowsAfter === mergedRows && barAfter.includes('合并时间轴'),
      `${mergedRows} -> ${rowsAfter}`,
    )

    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
  },

  /**
   * 编辑器工具面板的撤回、底部按钮布局、清空队列后的模式复位。
   *
   * 这几件事都属于「看着对、实际不对」的类型：工具改完之后撤不回来，界面上
   * 完全看不出来（按钮点了有反应、内容也真的变了）；按钮少了或顺序错了，也
   * 只有对着设计稿才看得出来；「清空队列后模式没复位」则要走到「导入字幕文件」
   * 那一步才会暴露 —— 中间隔着好几步，最容易漏。
   */
  async 'editor-tools-undo'(cdp) {
    const centerOf = (js) =>
      cdp.evaluate(`(() => {
        const el = ${js}
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)

    const clickByText = async (selector, text) => {
      const pos = await centerOf(
        `[...document.querySelectorAll('${selector}')].find((b) => b.textContent.includes('${text}'))`,
      )
      if (!pos) throw new Error(`找不到「${text}」（${selector}）`)
      await cdp.click(pos.x, pos.y)
      await sleep(300)
    }

    const readCell = (cls) =>
      cdp.evaluate(`(() => {
        const cell = document.querySelector('.subtable__body .row .cell--${cls}')
        return cell ? cell.textContent.replace(/\\s+/g, '') : null
      })()`)

    await goto(cdp, BASE + '/?demo=1')
    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
    await goto(cdp, BASE + '/?demo=1&view=editor&theme=light')
    await sleep(500)

    // ---- 底部按钮布局 ----
    const labels = await cdp.evaluate(
      `[...document.querySelectorAll('.editor__foot button')].map((b) => b.textContent.replace(/\\s+/g, ''))`,
    )
    check(
      '底部不再有「另存为」（与导出功能重复）',
      !labels.some((t) => t.includes('另存为')),
      labels.join(' / '),
    )
    const aiAt = labels.findIndex((t) => t.includes('AI校对'))
    const exportAt = labels.findIndex((t) => t.includes('导出字幕'))
    check('「AI 校对」排在「导出字幕」之前（保存按钮的位置留给它）', aiAt >= 0 && aiAt < exportAt, labels.join(' / '))
    check('音频识别的条目、未导出过 → 不显示「保存」', !labels.includes('保存'), labels.join(' / '))

    // ---- 撤销/重做这一行的排版 ----
    //
    // 侧栏内宽是固定的 231px。曾经把「每个文件最多保留 15 步」挤在按钮右侧，
    // 两段文字抢宽度时 flex 默认会把按钮压到 min-content —— 中文的 min-content
    // 只有**一个字宽**，「撤销」于是被压成竖排两行、按钮也跟着变高。
    // 当时余量只有 2px，无头浏览器里恰好没换行，所以「量高度」这种断言根本抓不住；
    // 真正要钉死的是「按钮不许收缩」这条属性本身。
    const histLayout = await cdp.evaluate(`(() => {
      const btns = [...document.querySelectorAll('.history__btn')]
      const row = document.querySelector('.history__row')
      const note = document.querySelector('.history__note')
      const box = (el) => el.getBoundingClientRect()
      return {
        shrink: btns.map((el) => getComputedStyle(el).flexShrink),
        nowrap: btns.map((el) => getComputedStyle(el).whiteSpace),
        overflow: btns.map((el) => el.scrollWidth - el.clientWidth),
        heights: btns.map((el) => Math.round(box(el).height)),
        noteBelow: !!row && !!note && Math.round(box(note).top) >= Math.round(box(row).bottom),
      }
    })()`)
    check(
      '撤销/重做按钮禁止收缩（否则中文标签会被压成竖排）',
      histLayout.shrink.length === 2 && histLayout.shrink.every((v) => v === '0'),
      `flex-shrink = ${histLayout.shrink.join(', ')}`,
    )
    check(
      '撤销/重做按钮单行显示、内容不溢出',
      histLayout.nowrap.every((v) => v === 'nowrap') &&
        histLayout.overflow.every((v) => v <= 1) &&
        histLayout.heights.every((h) => h === 28),
      `nowrap = ${histLayout.nowrap.join(', ')}  溢出 = ${histLayout.overflow.join(', ')}  高 = ${histLayout.heights.join(', ')}`,
    )
    check('「最多保留 15 步」独占一行（不与按钮抢宽度）', histLayout.noteBelow, String(histLayout.noteBelow))

    // 留一张这一行的实拍：光看断言数字看不出「是不是竖排」
    const histBox = await cdp.evaluate(`(() => {
      const r = document.querySelector('.history').getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }
    })()`)
    await shot(cdp, 'probe-history-row.png', { ...histBox, scale: 2 })

    // ---- 整体偏移 → 撤销 ----
    const before = await readCell('time')
    check('能读到第一条的时间码', !!before, String(before))

    await clickByText('.tool', '整体偏移')
    await clickByText('.inline .btn', '应用')
    const afterOffset = await readCell('time')
    check('整体偏移改变了时间码', afterOffset !== before, `${before} -> ${afterOffset}`)

    await clickByText('.history__btn', '撤销')
    const afterUndo = await readCell('time')
    check(
      '工具造成的改动可以撤销（以前这类工具根本不入撤回栈）',
      afterUndo === before,
      `${before} -> ${afterOffset} -> ${afterUndo}`,
    )

    // ---- 词表替换：先配词表，再一键批量纠正 ----
    const firstText = await readCell('text')
    const needle = [...(firstText ?? '')].slice(0, 2).join('')
    if (needle.length < 2) throw new Error(`演示数据第一条太短，构造不出词表：${firstText}`)

    await cdp.evaluate(`(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('xbaos.settings')) ?? 'xbaos.settings.v6'
      const raw = localStorage.getItem(key)
      const s = raw ? JSON.parse(raw) : {}
      s.dictReplacements = ${JSON.stringify(`${needle}=已按词表纠正`)}
      localStorage.setItem(key, JSON.stringify(s))
      return true
    })()`)
    await goto(cdp, BASE + '/?demo=1&view=editor&theme=light')
    await sleep(500)

    await clickByText('.tool', '词表替换')
    const afterDict = await readCell('text')
    check(
      '词表替换按设置里的词表改写了文本',
      (afterDict ?? '').includes('已按词表纠正'),
      `${firstText} -> ${afterDict}`,
    )

    await clickByText('.history__btn', '撤销')
    const afterDictUndo = await readCell('text')
    check('词表替换可以撤销', afterDictUndo === firstText, `${afterDict} -> ${afterDictUndo}`)

    await shot(cdp, 'probe-editor-tools.png')

    // ---- 设置页必须有词表维护入口（以前这个按钮只弹提示、设置里根本没有词表）----
    const navSettings = await centerOf(
      `[...document.querySelectorAll('.sidebar__item')].find((b) => b.textContent.includes('设置'))`,
    )
    if (!navSettings) throw new Error('找不到侧栏「设置」入口')
    await cdp.click(navSettings.x, navSettings.y)
    await sleep(500)

    const dictBlock = await cdp.evaluate(`({
      hasArea: !!document.querySelector('.dict__area'),
      hasTitle: [...document.querySelectorAll('.block__title')].some((t) => t.textContent.includes('替换词表')),
      showsCount: document.body.textContent.includes('条规则'),
    })`)
    check(
      '设置页有「自定义替换词表」输入区',
      dictBlock.hasArea && dictBlock.hasTitle,
      JSON.stringify(dictBlock),
    )
    check('设置页实时显示解析出的规则条数', dictBlock.showsCount === true)

    // ---- 合并模式 → 清空队列 → 模式必须复位 ----
    const navHome = await centerOf(
      `[...document.querySelectorAll('.sidebar__item')].find((b) => b.textContent.includes('导入'))`,
    )
    await cdp.click(navHome.x, navHome.y)
    await sleep(400)
    await clickByText('.mode', '合并为一条时间轴')
    const selected = await cdp.evaluate(`(() => {
      const el = document.querySelector('.mode.is-active')
      return el ? el.textContent.replace(/\\s+/g, '') : ''
    })()`)
    check('能选中「合并为一条时间轴」', selected.includes('合并为一条时间轴'), selected)

    // 无桥环境下清空走 window.confirm，先让它自动通过
    await cdp.evaluate(`(() => { window.confirm = () => true; return true })()`)
    await clickByText('button.btn--ghost', '清空')
    await sleep(400)

    const clearedRows = await cdp.evaluate(`document.querySelectorAll('.queue__row').length`)
    check('清空队列后队列为空', clearedRows === 0, String(clearedRows))

    // 空队列时模式卡片整个不渲染（v-if="supportedFiles.length > 1"），所以
    // 重新载入一份演示数据再看模式落在哪个选项 —— 这是「清空有没有复位模式」
    // 唯一可观察的角度。复位掉了，下一次导入字幕文件才不会掉进空的合并视图。
    const devBtn = await centerOf(`document.querySelector('.dropzone__dev')`)
    if (!devBtn) throw new Error('找不到演示数据按钮（.dropzone__dev）')
    await cdp.click(devBtn.x, devBtn.y)
    await sleep(500)

    const afterReload = await cdp.evaluate(`({
      rows: document.querySelectorAll('.queue__row').length,
      active: (document.querySelector('.mode.is-active')?.textContent ?? '').replace(/\\s+/g, ''),
      locked: document.querySelectorAll('.mode.is-locked').length,
    })`)
    check('重新载入演示数据后队列恢复', afterReload.rows > 0, String(afterReload.rows))
    check(
      '清空队列后模式复位为「各自独立处理」',
      afterReload.active.includes('独立处理'),
      `mode=${afterReload.active}`,
    )
    check('清空后模式锁定也一并解除', afterReload.locked === 0, String(afterReload.locked))

    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
  },

  /**
   * 字幕文件的一整轮：清空队列 → 导入 SRT → 导出 → 快捷保存。
   *
   * 这条链路原本在浏览器预览里测不了（要真实文件系统），所以给页面注入一个
   * 最小化的 Electron 桥桩：桩只回答「文件系统在哪」，业务逻辑一行都不替代。
   * 这样 store 里那两条**真实**路径（`addSubtitleFromPath` / `doExport`）
   * 就能完整跑一遍，而不是绕过它们去直接改数据。
   *
   * 覆盖两个真踩到的坑：
   *   - 合并模式 → 清空队列 → 直接导入 SRT：文件读进来了，编辑器里却什么都看不见；
   *   - 导出之后想改两个字，只能重走一遍导出对话框（选目录 / 选格式 / 处理重名）。
   */
  async 'editor-subtitle-roundtrip'(cdp) {
    const SRT = [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      '第一句探针字幕',
      '',
      '2',
      '00:00:02,000 --> 00:00:04,000',
      '第二句探针字幕',
      '',
    ].join('\n')
    // 源文件名刻意不带语言后缀：带的话导出时再追加一层后缀会变成
    // roundtrip.zh.zh-en.srt，断言和现实都会被这层叠加搅乱
    const SRT_PATH = 'D:\\probe\\roundtrip.srt'

    const centerOf = (js) =>
      cdp.evaluate(`(() => {
        const el = ${js}
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)

    const clickByText = async (selector, text) => {
      const pos = await centerOf(
        `[...document.querySelectorAll('${selector}')].find((b) => b.textContent.includes('${text}'))`,
      )
      if (!pos) throw new Error(`找不到「${text}」（${selector}）`)
      await cdp.click(pos.x, pos.y)
      await sleep(350)
    }

    const footLabels = () =>
      cdp.evaluate(
        `[...document.querySelectorAll('.editor__foot button')].map((b) => b.textContent.replace(/\\s+/g, ''))`,
      )

    /**
     * 在页面里操作 Pinia store。
     *
     * 路径：Vue 应用实例 → Pinia → 具名 store。之所以不从 DOM 走，是因为
     * 「导入文件」在浏览器里没有入口（要真实路径），而 store 层正是这个 bug
     * 真正待过的地方；DOM 只用来断言**渲染结果**，两者配合才叫端到端。
     */
    const usePinia = (name, body) =>
      cdp.evaluate(`(async () => {
        const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('${name}')
        if (!s) throw new Error('拿不到 ${name} store')
        ${body}
      })()`)

    const useStore = (body) => usePinia('project', body)
    const useSettings = (body) => usePinia('settings', body)

    /*
     * 关窗回调是在 App 挂载时注册的，而挂载早于下面那次「装桩」的 evaluate。
     * 所以先注入一段**每次导航前都跑**的最小骨架，把 app 那几个方法提前放好 ——
     * 否则 App 挂载时 window.xbaos 还不存在，__closeRequest 永远是 null，
     * 「主进程来问」这条链路在探针里根本走不到。
     * 下面那次装桩改成 Object.assign 合并，不要整个替换掉（会把回调句柄冲掉）。
     */
    await cdp.send('Page.enable')
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__progress = window.__progress || []
        window.__closeAcks = window.__closeAcks || 0
        window.__forceClose = window.__forceClose || 0
        window.__closeRequest = null
        window.xbaos = {
          app: {
            setProgress: (v) => window.__progress.push(v),
            onCloseRequest: (cb) => {
              window.__closeRequest = cb
              return () => { window.__closeRequest = null }
            },
            ackCloseRequest: () => { window.__closeAcks += 1 },
            forceClose: () => { window.__forceClose += 1 },
          },
        }
      `,
    })

    await goto(cdp, BASE + '/?demo=1')
    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
    await goto(cdp, BASE + '/?demo=1&view=editor&theme=light')
    await sleep(600)

    await cdp.evaluate(`(() => {
      window.__probeSrt = ${JSON.stringify(SRT)}
      window.__writes = []
      // 预警弹窗的记录。桩只回答「用户点了哪个按钮」，业务判断一行都不替代
      window.__confirms = []
      window.__focusCalls = 0
      // 合并而不是替换：上面那段预注入的骨架里存着 App 挂载时注册的关窗回调
      Object.assign(window.xbaos, {
        isElectron: false,
        fs: {
          readTextAuto: async () => ({ text: window.__probeSrt, encoding: 'utf-8' }),
          writeSubtitle: async (p, content, enc) => {
            window.__writes.push({ p, content, enc })
            return { ok: true }
          },
          exists: async () => false,
          reveal: async () => {},
          stat: async () => ({ ok: true, isFile: true, size: 128 }),
        },
        // 原生确认框：记下参数，一律返回第 0 个按钮（「继续」）
        dialog: {
          confirm: async (options) => {
            window.__confirms.push(options)
            return 0
          },
        },
        // 辅助窗口：桌面端由主进程开真窗口，这里只需要「开成功」与「拉最前」有回音
        assist: {
          open: async () => ({ ok: true }),
          focus: async () => {
            window.__focusCalls += 1
            return { ok: true }
          },
        },
        // app（关窗闸门 / 任务栏进度）由上面那段预注入的骨架提供，这里不重复定义，
        // 更不能把 window.__closeRequest 清掉 —— App 挂载时拿到的回调句柄就在那里
      })
      window.__progress = []
      window.__closeAcks = 0
      window.__forceClose = 0
      return true
    })()`)

    // ---- 合并模式 → 清空队列 → 直接导入 SRT ----
    check('未导出过 → 底部没有「保存」', !(await footLabels()).includes('保存'))
    check('初始批量模式是「各自独立处理」', (await useStore(`return s.batchMode`)) === 'separate')
    check('能切到「合并时间轴」', (await useStore(`return s.setBatchMode('merge')`)) === true)

    await useStore(`s.clearAll(); return true`)
    const cleared = await useStore(`return {
      mode: s.batchMode,
      files: s.files.length,
      merged: !!s.mergedFile,
      locked: s.batchModeLocked,
    }`)
    check(
      '清空队列后批量模式复位（不会再掉进空的合并视图）',
      cleared.mode === 'separate' && cleared.locked === false,
      JSON.stringify(cleared),
    )
    check('清空队列后合并产物一并释放', cleared.merged === false && cleared.files === 0)

    const imported = await useStore(`return await s.addSubtitleFromPath(${JSON.stringify(SRT_PATH)})`)
    check('清空队列后能导入字幕文件', imported === true)

    const afterImport = await useStore(`return {
      isMerge: s.isMerge,
      files: s.files.length,
      segments: s.files[0]?.segments.length ?? 0,
      format: s.files[0]?.subtitleFormat ?? null,
      hasPath: !!s.viewFileId,
    }`)
    check(
      '导入后仍是独立处理（文件没被卷进合并）',
      afterImport.isMerge === false && afterImport.hasPath === true,
      JSON.stringify(afterImport),
    )
    check(
      '字幕条目真的进了队列',
      afterImport.files === 1 && afterImport.segments === 2 && afterImport.format === 'srt',
      JSON.stringify(afterImport),
    )

    await sleep(500)
    const rendered = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.subtable__body .row')]
      return {
        rows: rows.length,
        first: rows[0] ? rows[0].textContent.replace(/\\s+/g, '') : '',
      }
    })()`)
    check('编辑器里真的把字幕显示出来了（原来这里是空白）', rendered.rows === 2, JSON.stringify(rendered))
    check('显示的就是导入进来的内容', rendered.first.includes('第一句探针字幕'), rendered.first)

    await shot(cdp, 'probe-subtitle-roundtrip.png')

    // ---- 反例：还没有译文时点「AI 翻译」不该被预警拦下来 ----
    // （预警只针对「会覆盖已有内容」，没有内容可覆盖就不该多一步）
    await cdp.evaluate(`(window.__confirms = [], true)`)
    await clickByText('.editor__foot button', 'AI 翻译')
    await sleep(300)
    check(
      '没有译文时不弹预警，直接开窗',
      (await cdp.evaluate(`window.__confirms.length`)) === 0,
      JSON.stringify(await cdp.evaluate(`window.__confirms.map((c) => c.title)`)),
    )
    await usePinia('ui', `s.setAssistActive(false); return true`)
    await sleep(200)

    // ---- 导出 → 记住落点 → 底部出现「保存」 ----
    check('导出前没有落点记录', (await useStore(`return s.exportRecords.size`)) === 0)

    await clickByText('.editor__foot button', '导出字幕')
    const hasDialog = await cdp.evaluate(`!!document.querySelector('.modal__panel')`)
    check('点「导出字幕」打开了导出对话框', hasDialog === true)

    await clickByText('.modal__foot .btn--primary', '导出')
    await sleep(600)

    const writes = await cdp.evaluate(`window.__writes`)
    check(
      '导出真的写出了字幕内容',
      writes.length === 1 && String(writes[0]?.content).includes('第一句探针字幕'),
      `写入 ${writes.length} 次`,
    )

    const remembered = await useStore(`return {
      ofActive: s.exportRecordsOf(s.viewFileId)[0]?.path ?? null,
      size: s.exportRecords.size,
    }`)
    check('导出后记住了字幕落点', !!remembered.ofActive, String(remembered.ofActive))
    check('落点与真正写出的文件一致', remembered.ofActive === writes[0]?.p, `${remembered.ofActive} vs ${writes[0]?.p}`)

    const labels = await footLabels()
    check('导出后底部出现「保存」按钮', labels.includes('保存'), labels.join(' / '))
    check('「保存」排在「导出字幕」左侧', labels.indexOf('保存') < labels.indexOf('导出字幕'), labels.join(' / '))

    // 保存必须写回上次导出的那个位置，而不是随手挑一个
    await clickByText('.editor__foot button', '保存')
    await sleep(400)
    const writes2 = await cdp.evaluate(`window.__writes`)
    check(
      '「保存」覆盖写回了上次导出的文件',
      writes2.length === 2 && writes2[1]?.p === SRT_PATH,
      String(writes2[1]?.p),
    )

    /* ---- 关窗闸门（P0-1）
     *
     * 刚刚「保存」过，当前内容与落盘的一致 —— 这时关窗**不该**打扰用户。
     * 桩只提供「主进程问了」这个入口，该不该拦由业务代码判断。
     */
    const closeClean = await cdp.evaluate(`(async () => {
      window.__confirms = []; window.__forceClose = 0; window.__closeAcks = 0
      window.__closeRequest()
      await new Promise((r) => setTimeout(r, 300))
      return { confirms: window.__confirms.length, forced: window.__forceClose, acks: window.__closeAcks }
    })()`)
    check(
      '内容已是最新保存版本 → 关窗直接放行，不打扰',
      closeClean.confirms === 0 && closeClean.forced === 1,
      JSON.stringify(closeClean),
    )
    check('裁决前先回执（撤掉主进程的看门狗）', closeClean.acks === 1, String(closeClean.acks))

    // ---- 识别进度推进任务栏 ----
    await usePinia('project', `s.recognizing = true; s.progress = 42; return true`)
    await sleep(200)
    const barOn = await cdp.evaluate(`window.__progress.slice()`)
    check(
      '识别中把进度推到任务栏（0–1）',
      barOn.includes(0.42),
      JSON.stringify(barOn),
    )
    await usePinia('project', `s.recognizing = false; return true`)
    await sleep(200)
    const barOff = await cdp.evaluate(`window.__progress.slice(-1)[0]`)
    check('识别结束后清除任务栏进度', barOff === -1, String(barOff))

    // ---- 多语言导出：注入译文 → 双语 → 分别导出 ----
    const fileId = await useStore(`return s.viewFileId`)
    const applied = await useStore(
      `return s.applyTranslation(${JSON.stringify(fileId)}, 'en', ['First probe line', 'Second probe line'])`,
    )
    check('译文写回成功（走真实的 applyTranslation）', applied === true)

    /* ---- 关窗闸门：内容变脏之后必须拦一下 ----
     * 上面刚写回译文，此刻内容与落盘的那一版已经不同了。
     */
    const closeDirty = await cdp.evaluate(`(async () => {
      window.__confirms = []; window.__forceClose = 0
      window.__closeRequest()
      await new Promise((r) => setTimeout(r, 300))
      return {
        title: window.__confirms[0]?.title ?? '',
        msg: window.__confirms[0]?.message ?? '',
        forced: window.__forceClose,
      }
    })()`)
    check(
      '有未保存内容时关窗先弹确认框',
      closeDirty.title === '还有未保存的内容',
      JSON.stringify(closeDirty),
    )
    check('确认框说清了「关闭后不会保留」', /不会保留/.test(closeDirty.msg), closeDirty.msg)
    check('桩点了「仍要关闭」→ 才真的放行', closeDirty.forced === 1, String(closeDirty.forced))

    const closeCancel = await cdp.evaluate(`(async () => {
      window.__confirms = []; window.__forceClose = 0
      const real = window.xbaos.dialog.confirm
      window.xbaos.dialog.confirm = async (o) => { window.__confirms.push(o); return 1 }
      window.__closeRequest()
      await new Promise((r) => setTimeout(r, 300))
      window.xbaos.dialog.confirm = real
      return { forced: window.__forceClose }
    })()`)
    check('点了「取消」就不关（工作留着）', closeCancel.forced === 0, String(closeCancel.forced))

    const trState = await useSettings(`return { lang: s.translationLang }`)
    check('翻译完成后记住了工作语言', trState.lang === 'en', JSON.stringify(trState))

    // ---- 预警：已有译文时再做 AI 操作必须先确认 ----
    // 走的是系统原生对话框（用户注意力此刻可能在 AI 助手的网页上，应用内浮层会被
    // 整个盖住）。桩只回答「用户点了哪个按钮」，该不该拦一行都不替代。
    await cdp.evaluate(`(window.__confirms = [], true)`)
    await clickByText('.editor__foot button', 'AI 翻译')
    await sleep(320)
    const trWarns = await cdp.evaluate(
      `window.__confirms.map((c) => ({ title: c.title, message: c.message, detail: c.detail }))`,
    )
    check(
      '已有译文时点「AI 翻译」先弹确认框',
      trWarns.length === 1 && trWarns[0].title === '这些字幕已有译文',
      JSON.stringify(trWarns.map((c) => c.title)),
    )
    check(
      '翻译预警点名了现有译文语言与回退办法（用户要知道动的是哪一份）',
      /en/.test(String(trWarns[0]?.detail ?? '')) && /撤回/.test(String(trWarns[0]?.detail ?? '')),
      String(trWarns[0]?.detail ?? ''),
    )

    // ---- 辅助窗口存在期间：主界面压暗 + 快捷拉回 ----
    await sleep(300)
    const lock = await cdp.evaluate(`(() => {
      const el = document.querySelector('.assistlock')
      if (!el) return null
      const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('回到 AI 窗口'))
      return {
        hasBtn: !!btn,
        bg: getComputedStyle(el).backgroundColor,
        z: getComputedStyle(el).zIndex,
        covers: (() => {
          const r = el.getBoundingClientRect()
          return r.width >= window.innerWidth - 1 && r.height >= document.documentElement.clientHeight - 1
        })(),
      }
    })()`)
    check('开 AI 窗口后主界面出现锁定遮罩', !!lock, JSON.stringify(lock))
    check('遮罩真的铺满可视区（不是 0 尺寸摆设）', lock?.covers === true, JSON.stringify(lock))
    check('遮罩上有「回到 AI 窗口」的快捷入口', lock?.hasBtn === true, JSON.stringify(lock))
    // 遮罩要的是「半透明压暗」而不是「不透明色块」：既挡住主界面的操作，
    // 又让用户看得见底下的界面还在（关了 AI 窗口就恢复）。Chromium 会把
    // color-mix() 序列化成 `color(srgb r g b / a)`，两种形态都得认。
    const alphaOf = (css) => {
      const slash = /\/\s*([\d.]+)\s*\)/.exec(css ?? '')
      if (slash) return parseFloat(slash[1])
      const comma = /^rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(css ?? '')
      if (comma) return parseFloat(comma[1])
      return /^rgb\(/.test(css ?? '') ? 1 : NaN
    }
    const lockAlpha = alphaOf(lock?.bg)
    check(
      '遮罩是半透明压暗（既拦住操作，又看得见底下的界面）',
      lockAlpha > 0 && lockAlpha < 1,
      `alpha=${lockAlpha} bg=${lock?.bg ?? 'null'}`,
    )

    await shot(cdp, 'probe-assist-lock.png')

    await clickByText('.assistlock button', '回到 AI 窗口')
    await sleep(260)
    const focusCalls = await cdp.evaluate(`window.__focusCalls`)
    check('点「回到 AI 窗口」会把辅助窗口拉回最前', focusCalls === 1, `focus ${focusCalls} 次`)

    // 校对路径的文案不同：它整体重建字幕（译文一并消失），而不是替换其中一份
    await usePinia('ui', `s.setAssistActive(false); return true`)
    await sleep(250)
    check(
      'AI 窗口关闭后遮罩解除（主界面恢复可用）',
      (await cdp.evaluate(`!!document.querySelector('.assistlock')`)) === false,
    )

    await cdp.evaluate(`(window.__confirms = [], true)`)
    await clickByText('.editor__foot button', 'AI 校对')
    await sleep(320)
    const rvWarns = await cdp.evaluate(`window.__confirms.map((c) => ({ title: c.title, detail: c.detail }))`)
    check(
      '已有译文时点「AI 校对」先弹确认框',
      rvWarns.length === 1 && rvWarns[0].title === '继续校对会清除已有译文',
      JSON.stringify(rvWarns.map((c) => c.title)),
    )
    check(
      '校对预警说明了回退办法（可撤销 / 校完再译一次）',
      /撤回/.test(rvWarns[0]?.detail ?? ''),
      String(rvWarns[0]?.detail ?? ''),
    )
    await usePinia('ui', `s.setAssistActive(false); return true`)
    await sleep(250)

    await cdp.evaluate(`(window.__writes = [], true)`)
    await clickByText('.editor__foot button', '导出字幕')
    await sleep(400)

    const langUI = await cdp.evaluate(`(() => {
      const radios = [...document.querySelectorAll('.modal__panel .radio')]
      const langRadios = radios.filter((r) => /^(仅原文|双语|仅译文|分别导出)$/.test((r.querySelector('.radio__label')?.textContent ?? '').trim()))
      return {
        options: langRadios.map((r) => ({
          text: r.querySelector('.radio__label').textContent.trim(),
          off: r.classList.contains('is-off'),
          disabled: !!r.querySelector('input')?.disabled,
        })),
        selected: langRadios.filter((r) => r.querySelector('input')?.checked)
          .map((r) => r.querySelector('.radio__label').textContent.trim()),
        planRows: [...document.querySelectorAll('.modal__panel .plan__target')].map((e) => e.textContent.trim()),
      }
    })()`)
    check('导出对话框列出了 4 种语言维度', langUI.options.length === 4, JSON.stringify(langUI.options))
    check(
      '有译文后语言选项不再置灰（不是「没做，是没得选」）',
      langUI.options.every((o) => !o.off && !o.disabled),
      JSON.stringify(langUI.options),
    )
    check('有译文时默认选中「双语」', langUI.selected.join('') === '双语', JSON.stringify(langUI.selected))
    check(
      '双语默认产出一个 *.zh-en.srt',
      langUI.planRows.join('|') === 'roundtrip.zh-en.srt',
      langUI.planRows.join('|'),
    )
    await shot(cdp, 'probe-export-lang.png')

    const clickLangOption = async (text) => {
      const pos = await centerOf(
        `[...document.querySelectorAll('.modal__panel .radio')].find((r) => r.textContent.includes('${text}'))`,
      )
      if (!pos) throw new Error(`找不到语言选项「${text}」`)
      await cdp.click(pos.x, pos.y)
      await sleep(320)
    }

    await clickLangOption('分别导出')
    const separateRows = await cdp.evaluate(
      `[...document.querySelectorAll('.modal__panel .plan__target')].map((e) => e.textContent.trim())`,
    )
    check(
      '选「分别导出」后清单变成两个文件（按语言后缀命名）',
      separateRows.join('|') === 'roundtrip.zh.srt|roundtrip.en.srt',
      separateRows.join('|'),
    )

    await clickByText('.modal__foot .btn--primary', '导出')
    await sleep(700)

    const writes3 = await cdp.evaluate(`window.__writes`)
    check('分别导出真的写出了两个文件', writes3.length === 2, `写入 ${writes3.length} 次`)
    const pick = (suffix) => writes3.find((w) => String(w.p).endsWith(suffix))
    const zhFile = pick('.zh.srt')
    const enFile = pick('.en.srt')
    check(
      '原文文件只有中文',
      !!zhFile && zhFile.content.includes('第一句探针字幕') && !zhFile.content.includes('First probe line'),
      JSON.stringify(zhFile?.content ?? null),
    )
    check(
      '译文文件只有英文（没有把两种语言混在一起）',
      !!enFile && enFile.content.includes('First probe line') && !enFile.content.includes('第一句探针字幕'),
      JSON.stringify(enFile?.content ?? null),
    )
    check(
      '两个文件共用同一条时间轴（时间码一致）',
      !!zhFile && !!enFile && zhFile.content.includes('00:00:00,000 --> 00:00:02,000') && enFile.content.includes('00:00:00,000 --> 00:00:02,000'),
    )

    const recs = await useStore(
      `return s.exportRecordsOf(s.viewFileId).map((r) => ({ bundle: r.bundle, lang: r.lang, name: r.path.split('\\\\').pop() }))`,
    )
    check(
      '落点记录记住了两个文件及各自的语言',
      recs.length === 2 && recs[0].bundle === 'source' && recs[1].bundle === 'translation' && recs[1].lang === 'en',
      JSON.stringify(recs),
    )

    // 保存必须把**两个**文件都照原样重写，不能把英文那份改成中文
    await cdp.evaluate(`(window.__writes = [], true)`)
    await clickByText('.editor__foot button', '保存')
    await sleep(600)
    const writes4 = await cdp.evaluate(`window.__writes`)
    check('「保存」把两个文件都写回去了', writes4.length === 2, `写入 ${writes4.length} 次`)
    const enBack = writes4.find((w) => String(w.p).endsWith('.en.srt'))
    check(
      '保存保留双语形态：英文文件写回去还是英文',
      !!enBack && enBack.content.includes('First probe line') && !enBack.content.includes('第一句探针字幕'),
      JSON.stringify(enBack?.content ?? null),
    )

    // ---- 清空队列 → 落点释放、保存按钮隐藏 ----
    await useStore(`s.clearAll(); return true`)
    await sleep(500)
    check('清空队列后落点记录被释放', (await useStore(`return s.exportRecords.size`)) === 0)
    const labels2 = await footLabels()
    check('清空队列后「保存」按钮隐藏', !labels2.includes('保存'), labels2.join(' / '))

    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
  },

  /**
   * 「AI 校对」入口的可见性回归。
   *
   * 它是个很容易被当成普通灰按钮忽略掉的新能力，所以断言它确实用了专属强调色
   * （不是中性灰、更不是危险红），并且深浅两套主题各自取到对应的令牌值。
   */
  async 'ai-entry'(cdp) {
    const readButton = () =>
      cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('.editor__foot button')].find((b) =>
          b.textContent.includes('AI 校对'),
        )
        if (!btn) return null
        const cs = getComputedStyle(btn)
        const root = getComputedStyle(document.documentElement)
        return {
          bg: cs.backgroundColor,
          color: cs.color,
          height: Math.round(btn.getBoundingClientRect().height),
          tokenAi: root.getPropertyValue('--color-ai').trim(),
          tokenDanger: root.getPropertyValue('--color-danger').trim(),
        }
      })()`)

    const hexToRgb = (hex) => {
      const c = hex.replace('#', '')
      return `rgb(${parseInt(c.slice(0, 2), 16)}, ${parseInt(c.slice(2, 4), 16)}, ${parseInt(c.slice(4, 6), 16)})`
    }

    await goto(cdp, BASE + '/?demo=1&view=editor&theme=light')
    const light = await readButton()
    check('编辑器底部有「AI 校对」入口', !!light)
    if (!light) return

    check(
      '浅色下入口用的是 AI 专属强调色',
      light.bg === hexToRgb(light.tokenAi),
      `bg=${light.bg} token=${light.tokenAi}`,
    )
    check(
      '入口色不是危险红（红在本项目里是删除语义）',
      light.tokenAi !== light.tokenDanger && light.bg !== hexToRgb(light.tokenDanger),
      `ai=${light.tokenAi} danger=${light.tokenDanger}`,
    )
    check('入口文字为白字', light.color === 'rgb(255, 255, 255)', light.color)

    // 底部一排控件统一到同一高度。曾经 AI 入口故意加高（--control-height-lg），
    // 结果与左右两侧的 20/32/38px 混排，视觉上参差不齐；现已按设计要求对齐。
    const grayHeight = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.editor__foot button')].find(
        (b) => !b.classList.contains('btn--ai'),
      )
      return btn ? Math.round(btn.getBoundingClientRect().height) : 0
    })()`)
    check(
      '入口与同排常规按钮等高（底部控件已统一）',
      light.height === grayHeight && grayHeight > 0,
      `${light.height}px vs ${grayHeight}px`,
    )

    // P0 回归：底部这一排曾经混着 20/32/38px 三种高度。整排扫一遍，
    // 只盯着 AI 入口与一个灰按钮是不够的（漏掉导出/保存/状态徽章）。
    // 注：「N 个文件处理完成」徽章已从这一排移除（底部状态栏已有同一个数），
    // 所以选择器里不再带 .editor__pending —— 换成 .editor__stat 继续覆盖徽章类控件。
    const footHeights = await cdp.evaluate(`(() => {
      const expect =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')) || 0
      const els = [...document.querySelectorAll('.editor__foot .btn')]
      return { expect, heights: els.map((e) => Math.round(e.getBoundingClientRect().height)) }
    })()`)
    check(
      '底部一排控件高度完全统一',
      footHeights.heights.length > 0 &&
        footHeights.heights.every((h) => Math.abs(h - footHeights.expect) <= 1),
      `期望 ${footHeights.expect}px，实测 ${footHeights.heights.join('/')}px`,
    )

    await goto(cdp, BASE + '/?demo=1&view=editor&theme=dark')
    const dark = await readButton()
    check(
      '深色下入口取到深色主题的 AI 色（确实按主题切换）',
      !!dark && dark.bg === hexToRgb(dark.tokenAi) && dark.tokenAi !== light.tokenAi,
      `dark=${dark?.bg} token=${dark?.tokenAi}；浅色 token=${light.tokenAi}`,
    )

    await shot(cdp, 'probe-ai-entry.png')

    // 点击链路要真的通：浏览器预览下没有 Electron 桥，应当弹出「不支持」的提示。
    // 这一条防的是「按钮点了毫无反应」——点击没接上时它同样会「安静地什么都不做」。
    await goto(cdp, BASE + '/?demo=1&view=editor&theme=light')
    const box = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.editor__foot button')].find((b) =>
        b.textContent.includes('AI 校对'),
      )
      if (!btn) return null
      btn.scrollIntoView({ block: 'center' })
      const r = btn.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (box) {
      await cdp.click(box.x, box.y)
      await sleep(400)
      const toast = await cdp.evaluate(`(() => {
        const el = document.querySelector('.toast')
        return el ? el.textContent.replace(/\\s+/g, '') : null
      })()`)
      check(
        '点击入口有明确反馈（预览模式提示不支持）',
        !!toast && toast.includes('不支持'),
        toast ?? '点击后没有任何提示',
      )
    }
  },

  /**
   * 更新提示与更新弹窗（?update=... 注入状态）。
   *
   * 覆盖三条产品要求：版本一致不提示 / 有新版在左下角提示且能点开看详情 /
   * 连不上官网时在提示位置显示三位 HTTP 错误码。
   *
   * 浏览器预览里既没有 Electron 桥也上不了外网，所以状态靠 ?update= 注入 ——
   * 注入只喂 apply() 一个结果对象，走的是与真实链路完全相同的 store 与组件，
   * 不是另写一套假界面。真实网络分支的验收在 Electron 探针里。
   */
  /**
   * 模型探测：文件名无关性、「使用中」的判据、启动引导。
   *
   * 浏览器里没有 Electron 桥，而这三件事的判定都在主进程，所以注入一个只回答
   * 这几个问题的替身桥。三条断言各对应一个真实踩过的坑：
   *   1. 模型改了名（`whisper-small(1).bin`）之后还必须看得见、切得动；
   *   2. 设置里记的那个模型文件被删掉后，界面上不能再挂着「使用中」；
   *   3. 一个模型都没有时，启动要直接把人送到模型页，且只送一次。
   *
   * 替身里 `models.resolve` 的返回值由测试给定、不当场真算：这里验的是**界面
   * 有没有按主进程的判定渲染**，判定规则本身在 unit 守门里守。
   */
  async 'model-detect'(cdp) {
    await cdp.send('Page.enable')

    /** 页面报错/警告——setup 抛错时 Vue 只警告不中断，不抓就什么都看不到 */
    const pageLogs = []
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' ')
      if (p.type === 'error' || p.type === 'warning') pageLogs.push(p.type + ': ' + text.slice(0, 240))
    })
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails
      pageLogs.push(
        'EXCEPTION: ' + String(d?.exception?.description ?? d?.text ?? '').slice(0, 300),
      )
    })

    /*
     * 注入替身桥。
     *
     * 每次重新注入前先撤掉上一条 —— addScriptToEvaluateOnNewDocument 是累积的，
     * 留着旧的会在之后每次导航时先执行一遍，两份不同的模型列表叠在一起，
     * 断言就会时对时错。
     *
     * 路径一律用正斜杠：这只影响界面显示的字符串，还能躲开「模板字符串里再套
     * 一层反斜杠转义」那种极易写错的地方。
     */
    let injectedId = null
    const stub = async (models, resolved) => {
      if (injectedId) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injectedId })
      }
      const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          window.__models = ${JSON.stringify(models)}
          window.__resolved = ${JSON.stringify(resolved)}
          window.xbaos = {
            isElectron: true,
            info: () =>
              Promise.resolve({
                version: '0.1.0',
                platform: 'win32',
                arch: 'x64',
                isPackaged: true,
                isDev: false,
                models: window.__models,
                modelsDir: '/probe/models',
                defaultModel: 'ggml-small.bin',
                engine: { exe: 'stub', source: 'packaged', available: true },
                paths: { userData: '/probe', downloadDir: '/probe/models' },
              }),
            models: {
              resolve: () => Promise.resolve(window.__resolved),
              openDir: () => Promise.resolve({ ok: true }),
              remove: () => Promise.resolve({ ok: true }),
              getDir: () =>
                Promise.resolve({ dir: '/probe/models', defaultDir: '/probe/models', custom: '' }),
              setDir: () => Promise.resolve({ ok: true }),
              onProgress: () => () => {},
            },
            /*
             * app 这几个方法必须给全，不能只给用得到的那个。
             *
             * 形如「window.xbaos?.assist?.onResult(...)」的写法在 assist 整个不存在时
             * 会被可选链短路；但 app 存在、只是少了 onCloseRequest，就会变成
             * 「undefined(...)」直接抛 TypeError —— App 的 mounted 钩子一挂，
             * **同一轮 flush 里后续组件的 mounted 全都不会执行**，表现是
             * 「页面渲染出来了、初始化逻辑却一个都没跑」，极难反向定位。
             */
            app: {
              setProgress: () => {},
              flash: () => {},
              onCloseRequest: () => () => {},
              ackCloseRequest: () => {},
              forceClose: () => {},
            },
            dialog: { confirm: () => Promise.resolve(1) },
          }
        })()`,
      })
      injectedId = identifier
    }

    /**
     * 只留 settings 一项可写，其余清空。
     *
     * `checkUpdateOnStart: false` 是必须的：替身桥没提供 update 那一块，
     * 开着会自动打一次更新检查。而 `localStorage.clear()` 是另一个必须的 ——
     * 「已提醒过」的标记留在里面，后面那个「启动要跳转」的断言就永远测不到。
     */
    const seedSettings = (patch) =>
      cdp.evaluate(`(() => {
        localStorage.clear()
        localStorage.setItem(
          'xbaos.settings.v6',
          JSON.stringify(Object.assign({ checkUpdateOnStart: false }, ${JSON.stringify(patch)})),
        )
        return true
      })()`)

    const modelPage = () =>
      cdp.evaluate(`(() => {
        const builtins = [...document.querySelectorAll('.model')].map((el) => {
          const nameEl = el.querySelector('.model__name')
          return {
            name: nameEl ? nameEl.textContent.trim() : '',
            active: !!el.querySelector('.tag--ok'),
          }
        })
        const currentEl = document.querySelector('.own__current')
        return {
          title: document.querySelector('.view__title')
            ? document.querySelector('.view__title').textContent.trim()
            : '',
          builtins,
          activeBuiltin: builtins.filter((b) => b.active).map((b) => b.name),
          extra: [...document.querySelectorAll('.own__item-name')].map((el) => el.textContent.trim()),
          current: currentEl
            ? currentEl.textContent.replace(/\\s+/g, ' ').replace('当前使用：', '').trim()
            : '',
          empty: !!document.querySelector('.own__empty'),
          toasts: [...document.querySelectorAll('.toast')].map((el) =>
            el.textContent.replace(/\\s+/g, ' ').trim(),
          ),
        }
      })()`)

    try {
      // ---- 1) 目录里只有改名后的模型：必须可见、可切换
      const renamedFile = '/probe/models/whisper-small(1).bin'
      await stub(
        [{ name: 'whisper-small(1).bin', path: renamedFile, dir: '/probe/models', source: 'user', size: 500 * 1024 * 1024 }],
        { name: 'whisper-small(1).bin', path: renamedFile, source: 'user' },
      )
      await goto(cdp, BASE + '/?theme=light')
      await seedSettings({ modelFile: 'whisper-small(1).bin' })
      await goto(cdp, BASE + '/?theme=light&view=models')
      await waitFor(cdp, `!!document.querySelector('.own__current')`, 10_000)

      const renamed = await modelPage()
      check(
        '模型页初始化期间没有未捕获错误',
        pageLogs.length === 0,
        pageLogs.slice(0, 2).join(' | '),
      )
      check(
        '改名后的模型列进了「使用自己的模型」',
        renamed.extra.includes('whisper-small(1).bin'),
        JSON.stringify(renamed.extra),
      )
      check('「当前使用」显示实际生效的文件名', renamed.current === 'whisper-small(1).bin', renamed.current)
      check(
        '内置档不会跟着一起标「使用中」',
        renamed.activeBuiltin.length === 0,
        JSON.stringify(renamed.activeBuiltin),
      )

      // ---- 2) 设置里记的模型已被手动删除
      const baseFile = '/probe/models/ggml-base.bin'
      await stub(
        [{ name: 'ggml-base.bin', path: baseFile, dir: '/probe/models', source: 'user', size: 140 * 1024 * 1024 }],
        { name: 'ggml-base.bin', path: baseFile, source: 'user' },
      )
      await seedSettings({ modelFile: 'ggml-small.bin' })
      await goto(cdp, BASE + '/?theme=light&view=models')
      await waitFor(cdp, `!!document.querySelector('.own__current')`, 10_000)

      const gone = await modelPage()
      check(
        '选中的模型被删后，它不再显示「使用中」',
        !gone.activeBuiltin.includes('Whisper small'),
        JSON.stringify(gone.activeBuiltin),
      )
      check(
        '「使用中」落到实际回退到的那个模型上',
        gone.activeBuiltin.includes('Whisper base'),
        JSON.stringify(gone.activeBuiltin),
      )
      check('「当前使用」如实显示回退后的文件名', gone.current === 'ggml-base.bin', gone.current)
      check(
        '内置目录之外的常规文件名不算「额外」条目',
        gone.extra.length === 0 && gone.empty,
        JSON.stringify({ extra: gone.extra, empty: gone.empty }),
      )

      // ---- 3) 一个模型都没有：启动直接送到模型页
      await stub([], null)
      await seedSettings({ modelFile: '' })
      await goto(cdp, BASE + '/?theme=light')

      const none = await modelPage()
      check('没有模型时启动自动跳到模型页', none.title === '模型管理', none.title)
      check(
        '并弹出提示说明要先配置模型',
        none.toasts.some((t) => t.includes('还没有可用的识别模型')),
        JSON.stringify(none.toasts),
      )
      check('模型页如实显示「未检测到可用模型」', none.current === '未检测到可用模型', none.current)

      // 提醒过一次之后不再反复拦人
      await goto(cdp, BASE + '/?theme=light')
      const second = await modelPage()
      check('提醒过一次后不再反复拦人', second.title === '导入音频', second.title)
    } finally {
      if (injectedId) {
        await cdp
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injectedId })
          .catch(() => {})
      }
    }
  },

  async 'update-entry'(cdp) {
    await cdp.send('Page.enable')

    /** 左下角提示条；不存在时返回 null（= 不提示） */
    const hint = () =>
      cdp.evaluate(`(() => {
        const el = document.querySelector('.sidebar__update')
        if (!el) return null
        return {
          text: el.textContent.replace(/\\s+/g, ''),
          error: el.classList.contains('is-error'),
        }
      })()`)

    const boxOf = (sel) =>
      cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)})
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)

    const clickOf = async (sel, label) => {
      const box = await cdp.evaluate(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) =>
          b.textContent.includes(${JSON.stringify(label)}),
        )
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)
      if (!box) return false
      // 必须真实鼠标事件：JS .click() 不转移焦点，测不出与 focus 相关的竞态
      await cdp.click(box.x, box.y)
      await sleep(400)
      return true
    }

    const dialog = () =>
      cdp.evaluate(`(() => {
        const el = document.querySelector('.update')
        if (!el) return null
        return {
          subtitle: document.querySelector('.modal__subtitle')?.textContent.trim() ?? '',
          version: el.querySelector('.update__version')?.textContent.replace(/\\s+/g, '') ?? '',
          title: el.querySelector('.update__title')?.textContent.trim() ?? '',
          lead: el.querySelector('.update__lead')?.textContent.trim() ?? '',
          notes: [...el.querySelectorAll('.update__list li')].map((li) => li.textContent.trim()),
          note: el.querySelector('.update__note')?.textContent.replace(/\\s+/g, '') ?? '',
          where: el.querySelector('.update__where')?.textContent.replace(/\\s+/g, '') ?? '',
          buttons: [...document.querySelectorAll('.modal__foot .btn')].map((b) =>
            b.textContent.trim(),
          ),
        }
      })()`)

    try {
      // ---- 有新版：左下角提示 → 点开弹窗
      await goto(cdp, BASE + '/?demo=1&theme=light&update=available')
      const h1 = await hint()
      check('有新版时左下角出现提示', !!h1 && h1.text.includes('有新版本'), h1?.text ?? '没有提示条')
      check('有新版提示不是错误样式', h1?.error === false, String(h1?.error))
      check('提示里带上了新版本号', !!h1 && h1.text.includes('0.2.0'), h1?.text ?? '')

      const hbox = await boxOf('.sidebar__update')
      if (!hbox) throw new Error('找不到左下角更新提示条')
      await cdp.click(hbox.x, hbox.y)
      await sleep(400)

      const d1 = await dialog()
      check('点击左下角提示后打开更新弹窗', !!d1, d1 ? '' : '弹窗没出现')
      if (d1) {
        check('弹窗副标题写明当前与最新版本', d1.subtitle.includes('0.1.0') && d1.subtitle.includes('0.2.0'), d1.subtitle)
        check('弹窗显示最新版本号', d1.version.includes('v0.2.0'), d1.version)
        check('弹窗显示发布日期', d1.version.includes('2026-11-01'), d1.version)
        check('弹窗显示本次发布标题', d1.title === '性能与体验更新', d1.title)
        check('弹窗有一句变更概要', d1.lead.includes('识别速度'), d1.lead)
        check('弹窗逐条列出更新内容', d1.notes.length >= 3, `${d1.notes.length} 条`)
        check('弹窗给出升级方式提示', d1.note.includes('覆盖安装'), d1.note)
        check('弹窗写明安装包在哪个域名提供', d1.where.includes('subtitle.xbaos.com.cn'), d1.where)
        check(
          '弹窗有两个操作按钮且文案正确',
          d1.buttons.length === 2 &&
            d1.buttons.some((t) => t.includes('稍后再说')) &&
            d1.buttons.some((t) => t.includes('前往官网更新')),
          d1.buttons.join(' / '),
        )
      }
      await shot(cdp, 'probe-update-dialog.png')

      // ---- 「稍后再说」：关弹窗，并把左下角提示一起撤下
      check('点得到「稍后再说」', await clickOf('.modal__foot .btn', '稍后再说'))
      check('「稍后再说」关掉了弹窗', (await cdp.evaluate(`!document.querySelector('.update')`)) === true)
      const hAfter = await hint()
      check(
        '「稍后再说」之后左下角提示也撤下（本次运行不再打扰）',
        hAfter === null,
        JSON.stringify(hAfter),
      )

      // ---- 「前往官网更新」：点击后弹窗收起（浏览器预览下走 window.open）
      await goto(cdp, BASE + '/?demo=1&theme=light&update=available')
      const hbox2 = await boxOf('.sidebar__update')
      if (hbox2) {
        await cdp.click(hbox2.x, hbox2.y)
        await sleep(400)
      }
      check('点得到「前往官网更新」', await clickOf('.modal__foot .btn', '前往官网更新'))
      check('点击后弹窗收起', (await cdp.evaluate(`!document.querySelector('.update')`)) === true)

      // ---- 版本一致：不该有任何提示
      await goto(cdp, BASE + '/?demo=1&theme=light&update=latest')
      const hLatest = await hint()
      check('版本与官网一致时左下角不提示', hLatest === null, JSON.stringify(hLatest))

      // ---- 连不上官网：在提示位置显示三位 HTTP 错误码
      await goto(cdp, BASE + '/?demo=1&theme=light&update=http404')
      const h404 = await hint()
      check('连不上官网时提示条改为错误样式', h404?.error === true, JSON.stringify(h404))
      check('错误提示里出现三位 HTTP 状态码 404', !!h404 && h404.text.includes('404'), h404?.text ?? '')

      await goto(cdp, BASE + '/?demo=1&theme=light&update=error')
      const hNet = await hint()
      check(
        '网络层失败时给出可读原因而不是码',
        !!hNet && hNet.text.includes('网络不可达'),
        hNet?.text ?? '没有提示条',
      )
      await shot(cdp, 'probe-update-hint-error.png')
    } finally {
      // 注入的状态只活在内存里，导航即重置；这里清掉设置键，避免影响别的场景
      await cdp.evaluate(`(() => { try { localStorage.clear() } catch (err) { /* 忽略 */ } })()`)
    }
  },

  /**
   * 关于页的协议入口。
   *
   * 这两份文件的性质决定了断言不能只看「点得开」：它们是**用户真的会去读**的东西，
   * 所以真正要守的是三件事 —— ①弹窗里的正文确实渲染出来了（不是空壳）；
   * ②正文**能选中复制**（全局 user-select: none 会被继承进来，双击选词直接失效）；
   * ③「会联网的功能」那张表逐行在，因为它是全篇唯一一处用户会拿去做决策的内容。
   */
  async 'legal-entry'(cdp) {
    await cdp.send('Page.enable')

    const openCard = async (doc) => {
      const box = await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-legal="${doc}"]')
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)
      if (!box) return false
      await cdp.click(box.x, box.y)
      await sleep(220)
      return true
    }

    /** 弹窗里的正文形态。null = 没打开 */
    const legal = () =>
      cdp.evaluate(`(() => {
        const el = document.querySelector('.legal')
        if (!el) return null
        const cs = getComputedStyle(el)
        const head = document.querySelector('.modal__head')
        return {
          title: document.querySelector('.modal__title')?.textContent.trim() ?? '',
          subtitle: document.querySelector('.modal__subtitle')?.textContent.trim() ?? '',
          headings: [...el.querySelectorAll('.legal__h')].map((h) => h.textContent.trim()),
          paras: el.querySelectorAll('.legal__p').length,
          items: el.querySelectorAll('.legal__ul li').length,
          text: el.textContent.replace(/\\s+/g, ' ').trim(),
          selectable: cs.userSelect,
          tableRows: [...el.querySelectorAll('.legal__table tbody tr')].map((tr) =>
            [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\\s+/g, ' ').trim()),
          ),
          headHeight: head ? Math.round(head.getBoundingClientRect().height) : 0,
        }
      })()`)

    const scrollable = () =>
      cdp.evaluate(`(() => {
        const b = document.querySelector('.modal__body')
        if (!b) return null
        return { scrollH: Math.round(b.scrollHeight), clientH: Math.round(b.clientHeight) }
      })()`)

    try {
      await goto(cdp, `${BASE}/?demo=1&theme=light&view=about`)

      // 两个入口都在
      const entries = await cdp.evaluate(`(() =>
        [...document.querySelectorAll('[data-legal]')].map((el) => el.dataset.legal)
      )()`)
      if (entries.length !== 2) {
        const diag = await cdp.evaluate(`(() => ({
          href: location.href,
          view: document.querySelector('.view')?.className ?? 'no-view',
          about: !!document.querySelector('.about'),
          legalNodes: document.querySelectorAll('[data-legal]').length,
          bodySnap: document.body.textContent.slice(0, 200),
        }))()`)
        console.log(`  [诊断] ${JSON.stringify(diag, null, 2)}`)
      }
      check(
        '关于页有用户协议与隐私政策两个入口',
        entries.length === 2 && entries.includes('terms') && entries.includes('privacy'),
        JSON.stringify(entries),
      )

      // ---- 用户协议
      if (!(await openCard('terms'))) throw new Error('点不开用户协议入口')
      const t = await legal()
      check('点入口后打开协议弹窗', t !== null && t.title === '用户协议', JSON.stringify(t?.title))
      check('协议弹窗正文非空（不是空壳）', (t?.headings.length ?? 0) >= 10, `${t?.headings.length} 个章节`)
      check(
        '协议里写明了主体唯一性靠官网锚定',
        !!t?.text.includes('www.xbaos.com.cn'),
        t?.text.includes('www.xbaos.com.cn') ? '已写明' : '没找到官网域名',
      )
      check(
        '协议里写明了未来可能新增联网功能',
        !!t?.text.includes('未来版本') && !!t?.text.includes('联网'),
        '缺失则需要补第七节',
      )
      check(
        '协议正文可以选中复制（全局 user-select:none 不能漏进来）',
        t?.selectable === 'text',
        `user-select=${t?.selectable}`,
      )
      check(
        '协议里没有编造的联系邮箱',
        !/support@|@xbaos\\.com\\.cn/.test(t?.text ?? ''),
        (t?.text ?? '').match(/[\\w.]+@[\\w.]+/)?.[0] ?? '没有邮箱，符合预期',
      )

      // 长文必须能滚（弹窗面板撑出屏幕、又滚不动是最难受的一种）
      const sc = await scrollable()
      check(
        '正文超出时弹窗内部可滚动',
        !!sc && sc.scrollH > sc.clientH,
        JSON.stringify(sc),
      )

      // ESC 关闭
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(200)
      check('ESC 关掉协议弹窗', (await legal()) === null, '弹窗仍在')

      // ---- 隐私政策
      if (!(await openCard('privacy'))) throw new Error('点不开隐私政策入口')
      const p = await legal()
      check('点另一个入口打开隐私政策', p !== null && p.title === '隐私政策', JSON.stringify(p?.title))
      check(
        '隐私政策列出「会联网的功能」对照表',
        (p?.tableRows.length ?? 0) === 2,
        `${p?.tableRows.length} 行`,
      )
      const flat = (p?.tableRows ?? []).flat().join(' | ')
      check(
        '联网表里含检查更新与下载模型两项，且写明触发时机',
        flat.includes('检查更新') && flat.includes('下载模型') && flat.includes('subtitle.xbaos.com.cn'),
        flat.slice(0, 160),
      )
      check(
        '隐私政策写明了卸载不删数据',
        !!p?.text.includes('卸载不会自动删除'),
        '缺失则第四节不完整',
      )
      check(
        '隐私政策正文也可以选中复制',
        p?.selectable === 'text',
        `user-select=${p?.selectable}`,
      )

      await shot(cdp, 'probe-legal-privacy.png')

      // 关于页原来那句「只有在下载模型时才联网」漏了检查更新，必须已经改掉
      const about = await cdp.evaluate(`(() => {
        const el = document.querySelector('.privacy')
        return el ? el.textContent.replace(/\\s+/g, '') : ''
      })()`)
      check(
        '关于页的隐私说明补上了「检查更新」这处联网',
        about.includes('检查更新') && about.includes('下载可选模型'),
        about.slice(0, 120),
      )

      // 再确认一次：整页没有编造的邮箱
      const page = await cdp.evaluate(`document.body.innerText`)
      check(
        '全页没有编造的联系邮箱',
        !/support@|@xbaos\\.com\\.cn/.test(page),
        page.match(/[\\w.]+@[\\w.]+/)?.[0] ?? '没有邮箱',
      )
    } finally {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(120)
    }
  },

  /**
   * 长任务进度的任务栈语义。
   *
   * 全程纯逻辑（直接驱动 ui store），不碰 DOM —— 但它守的是「模型下载和识别
   * 同时跑」时的真实退化：把栈退化成单一槽位的话，先结束的那个任务会顺手把还在
   * 跑的另一个的进度一起清掉，界面上就是「进度条突然没了、但事情还在跑」。
   * 这种事在「一次只干一件事」的手点流程里根本暴露不出来。
   */
  async 'task-progress-stack'(cdp) {
    await goto(cdp, `${BASE}/?demo=1&theme=light`)

    const useUi = (body) =>
      cdp.evaluate(`(() => {
        const ui = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('ui')
        if (!ui) throw new Error('拿不到 ui store')
        ${body}
      })()`)

    const snap = `ui.taskProgress && { owner: ui.taskProgress.owner, percent: ui.taskProgress.percent }`

    // 先起下载、再起识别：后开始的应该占栈顶
    const started = await useUi(`
      ui.beginTask('download', '正在下载')
      ui.updateTask('download', 30)
      ui.beginTask('recognize', '正在识别')
      ui.updateTask('recognize', 55)
      return ${snap}
    `)
    check(
      '后开始的任务占栈顶',
      started?.owner === 'recognize' && started?.percent === 55,
      JSON.stringify(started),
    )

    // 底下那个继续报进度，不能把栈顶抢走
    const pushed = await useUi(`ui.updateTask('download', 80); return ${snap}`)
    check(
      '底下任务报进度不抢栈顶',
      pushed?.owner === 'recognize' && pushed?.percent === 55,
      JSON.stringify(pushed),
    )

    // 栈顶结束 → 回退到还没跑完的那个，而且是它**自己**的进度（不是继承来的）
    const fell = await useUi(`ui.endTask('recognize'); return ${snap}`)
    check(
      '栈顶结束回退到还没跑完的任务',
      fell?.owner === 'download' && fell?.percent === 80,
      JSON.stringify(fell),
    )

    // 清一个不存在的归属者，不能误伤当前任务
    const stray = await useUi(`ui.endTask('nobody'); return ${snap}`)
    check('清不存在的任务不误伤当前任务', stray?.owner === 'download', JSON.stringify(stray))

    // 全部结束才真正清空（App.vue 据此把任务栏置 -1）
    const cleared = await useUi(`ui.endTask('download'); return ui.taskProgress ?? null`)
    check('任务全部结束才真正清空', cleared === null, String(cleared))

    // hasTask：上报方靠它区分「开始」与「更新」
    const flags = await useUi(`
      ui.beginTask('x', '测试')
      const running = ui.hasTask('x')
      const absent = ui.hasTask('y')
      ui.endTask('x')
      return [running, absent, ui.hasTask('x')]
    `)
    check(
      'hasTask 只认在跑的任务',
      flags?.[0] === true && flags?.[1] === false && flags?.[2] === false,
      JSON.stringify(flags),
    )
  },

  /**
   * 「开始识别」按钮收成圆点、飞向底部进度条。
   *
   * 这条动画的职责是**空间指引**（进度条在最底部、只有 3px 高，第一次用的人
   * 根本不知道去哪儿看），所以它必须真的落到进度条上、中途不能跳变。三件事要验：
   *   1. 点下去确实有圆点起飞，且走的是二次贝塞尔弧线（不是直线位移）
   *   2. 飞行期间进度行**已经占好位置**（否则落地时底部会横向挤一下）
   *   3. 落地后圆点撤掉、进度行由透明变可见
   * 另外 `prefers-reduced-motion` 下必须整条跳过，只留进度行。
   */
  async 'recognize-flight'(cdp) {
    await goto(cdp, `${BASE}/?demo=1&view=home&theme=light`)
    await sleep(500)

    const readFoot = () =>
      cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('.view__foot .btn')].find((b) =>
          b.textContent.includes('开始识别'),
        )
        const dot = document.querySelector('.flight')
        const row = document.querySelector('.statusbar__progress')
        return {
          btn: btn
            ? {
                visibility: getComputedStyle(btn).visibility,
                x: Math.round(btn.getBoundingClientRect().left + btn.getBoundingClientRect().width / 2),
                y: Math.round(btn.getBoundingClientRect().top + btn.getBoundingClientRect().height / 2),
              }
            : null,
          dot: !!dot,
          path: dot ? getComputedStyle(dot).offsetPath : '',
          veiled: row ? row.classList.contains('is-veiled') : null,
          rowOpacity: row ? getComputedStyle(row).opacity : null,
        }
      })()`)

    const idle = await readFoot()
    check('没有识别任务时既没有圆点也没有进度行', idle.dot === false && idle.veiled === null, JSON.stringify(idle))
    if (!idle.btn) throw new Error('首页找不到「开始识别」按钮')

    /**
     * 在**页面里**逐帧记录圆点的落点。
     *
     * 为什么不从外面一次次 `evaluate` 采样：一次 CDP 往返就要 15–25ms，
     * 而整段飞行只有 460ms、还刻意起步极快（前 17% 时间走过 44% 路程）。
     * 外面采到的第一个点往往已经在 80% 处了，回看轨迹就像一条直线 ——
     * 那时断言「有没有弧线」已经失去意义（这个坑真踩过）。
     */
    await cdp.evaluate(`(() => {
      window.__flightTrace = []
      window.__flightDone = false
      let seen = false
      const tick = () => {
        const dot = document.querySelector('.flight')
        if (!dot) {
          if (seen) { window.__flightDone = true; return }
          requestAnimationFrame(tick)
          return
        }
        seen = true
        const d = dot.getBoundingClientRect()
        const track = document.querySelector('.statusbar__progress-track')
        const t = track ? track.getBoundingClientRect() : null
        window.__flightTrace.push({
          x: d.left + d.width / 2,
          y: d.top + d.height / 2,
          size: Math.round(d.width),
          left: t ? t.left : null,
          right: t ? t.right : null,
          ty: t ? t.top + t.height / 2 : null,
        })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })()`)

    // 截图与飞行并发：`Page.captureScreenshot` 在这台机器上可能要几百毫秒，
    // 串在前面会把整段飞行耗完。
    const shotPromise = shot(cdp, 'probe-recognize-flight.png')

    await cdp.click(idle.btn.x, idle.btn.y)
    await sleep(40)

    const flying = await readFoot()
    check('点「开始识别」后有圆点起飞', flying.dot === true, JSON.stringify(flying))
    check(
      '飞行期间进度行已经占位，只是透明（落地才不会跳变）',
      flying.veiled === true && flying.rowOpacity === '0',
      `${flying.veiled} / ${flying.rowOpacity}`,
    )
    check(
      '飞行期间「开始识别」按钮隐去但保留占位（visibility 而非 display）',
      flying.btn?.visibility === 'hidden',
      JSON.stringify(flying.btn),
    )

    // 等页面内的采样器报告「圆点已经消失」，再把轨迹一次性取回来
    for (let i = 0; i < 120; i += 1) {
      if (await cdp.evaluate(`window.__flightDone === true`)) break
      await sleep(25)
    }
    await shotPromise
    const trace = await cdp.evaluate(`window.__flightTrace ?? []`)
    const sampled = (trace ?? []).filter((s) => s.left !== null)

    if (sampled.length < 8) {
      check('能采到足够的飞行轨迹点', false, `只采到 ${sampled.length} 个`)
    } else {
      const first = sampled[0]
      const last = sampled[sampled.length - 1]

      // 1) 落点必须在**进度条本体之内**。
      //    注意别拿「进度条中心」去比：圆点是刻意瞄准进度条**左端**的
      //    （进度从左往右长），差半个条宽是设计如此，不是偏差。
      const inTrack =
        last.x >= last.left - 4 && last.x <= last.right + 4 && Math.abs(last.y - last.ty) <= 3
      check(
        '落地时圆点压在底部进度条上',
        inTrack,
        `圆点 ${last.x.toFixed(0)},${last.y.toFixed(0)}｜进度条 x∈[${last.left.toFixed(0)}, ${last.right.toFixed(0)}] y=${last.ty.toFixed(0)}`,
      )

      // 2) 轨迹是弧线，不是直线：取离「首尾连线」最远的那一点量化
      const dx = last.x - first.x
      const dy = last.y - first.y
      const len = Math.hypot(dx, dy) || 1
      const bulge = Math.max(
        ...sampled.map((s) => Math.abs((s.x - first.x) * dy - (s.y - first.y) * dx) / len),
      )
      check(
        '轨迹是上凸的弧线而不是直线位移',
        bulge > 4,
        `最大偏离弦 ${bulge.toFixed(1)}px｜采样 ${sampled.length} 点`,
      )

      // 3) 一路上确实在缩小（收进进度条，而不是原地放大）
      check(
        '圆点边飞边缩小（最后收进进度条里）',
        last.size < first.size,
        `${first.size}px -> ${last.size}px`,
      )

      // 4) 起点确实在按钮那一侧：首个采样的 x 与按钮同侧于进度条。
      //    直接断言「离按钮多近」是不行的 —— 这条动画刻意起步很快，
      //    第一个采样已经是中途了（约 80% 处）。
      const sideFirst = Math.sign(first.x - last.left)
      const sideButton = Math.sign(idle.btn.x - last.left)
      check(
        '起点与按钮在进度条的同一侧（不是从屏幕角落窜出来的）',
        sideFirst !== 0 && sideFirst === sideButton,
        `首采样 x=${first.x.toFixed(0)}｜按钮 x=${idle.btn.x}｜进度条左端 x=${last.left.toFixed(0)}`,
      )
    }

    // 落地后进度行淡入 120ms —— 同样轮询等它，不用固定 sleep
    let rowOpacity = '0'
    for (let i = 0; i < 40; i += 1) {
      const s = await readFoot()
      if (!s.dot) {
        rowOpacity = s.rowOpacity
        if (rowOpacity === '1') break
      }
      await sleep(24)
    }
    const after = await readFoot()
    check('落地后圆点撤掉', after.dot === false, JSON.stringify(after))
    check('落地后进度行由透明变为可见', rowOpacity === '1', `opacity=${rowOpacity}`)

    /* ---- 减少动效偏好：整条飞行跳过，只留进度行 ---- */

    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await goto(cdp, `${BASE}/?demo=1&view=home&theme=light`)
    await sleep(500)
    const reducedIdle = await readFoot()
    await cdp.click(reducedIdle.btn.x, reducedIdle.btn.y)
    await sleep(80)
    const reducedFlying = await readFoot()
    check(
      'prefers-reduced-motion 下不起飞（位移对这类用户是负担）',
      reducedFlying.dot === false,
      JSON.stringify(reducedFlying),
    )
    check(
      'prefers-reduced-motion 下进度行直接可见（信息一点没少）',
      reducedFlying.veiled === false,
      `${reducedFlying.veiled} / ${reducedFlying.rowOpacity}`,
    )
    // 复位：模拟设置是会话级的，不撤掉会影响后面所有场景
    await cdp.send('Emulation.setEmulatedMedia', { features: [] })
  },

  /**
   * 时间轴：泳道层叠、缩放、拖边界、两种 Ctrl+B。
   *
   * 演示数据那几条间距太大，重叠、顶边、刀切一个都碰不到，所以先把当前文件
   * 的条目换成**可控的时间码**再验。这里每一条断言都对应一个真实会犯的错：
   *   - 泳道：重叠的条必须分到不同行，不重叠的要复用第一行（否则界面会一直往下堆）
   *   - Ctrl+滚轮：既要缩放生效，又要 `defaultPrevented` —— 后者才是「没被
   *     Chromium 拿去做整页缩放」的证据，只测前者是测不出来的
   *   - 拖边界：同泳道的邻居必须把它顶住，且松手后能撤销
   *   - 两种 Ctrl+B：编辑态必须让位给输入框，否则一条字幕会被切两次
   */
  async 'timeline-lanes'(cdp) {
    await goto(cdp, `${BASE}/?demo=1&view=editor&theme=light`)
    await sleep(500)

    const store = (body) =>
      cdp.evaluate(`(() => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const project = pinia.get('project')
        const editor = pinia.get('editor')
        ${body}
      })()`)

    const seed = await store(`
      const f = project.files[0]
      if (!f) return 'no-file'
      const mk = (id, start, end, text) => ({ id, start, end, text, origin: text, issues: [] })
      f.durationSec = 30
      f.segments = [
        mk('a', 0, 4, '第一条字幕'),
        mk('b', 3, 7, '与上一条重叠'),
        mk('c', 8, 12, '回到第一行'),
        mk('d', 9, 11, '与第三条重叠'),
        mk('e', 20, 26, '靠后的一条'),
        mk('f', 14, 15.2, '这是一条特别特别特别长的字幕文本，用来验证放不下时会不会被省略号截断'),
      ]
      editor.clearSelection()
      editor.setPlayhead(0)
      return [f.id, f.segments.length]
    `)
    check('注入可控的演示条目', Array.isArray(seed) && seed[1] === 6, JSON.stringify(seed))
    await sleep(350)

    /** 读每条字幕条在屏幕上的位置与截断情况 */
    const readClips = () =>
      cdp.evaluate(`(() => {
        const out = []
        document.querySelectorAll('.tl-clip').forEach((el) => {
          const r = el.getBoundingClientRect()
          const t = el.querySelector('.tl-clip__text')
          out.push({
            id: el.dataset.segId,
            left: Math.round(r.left),
            width: Math.round(r.width),
            top: Math.round(r.top),
            text: t.textContent,
            clipped: t.scrollWidth > t.clientWidth + 1,
          })
        })
        return out
      })()`)

    const clips = await readClips()
    const by = (id) => clips.find((c) => c.id === id)
    check('时间轴渲染出全部条目', clips.length === 6, `渲染了 ${clips.length} 条`)

    check(
      '泳道：互不重叠的条目共用第一行',
      by('a') && by('c') && by('e') && by('a').top === by('c').top && by('c').top === by('e').top,
      JSON.stringify(clips.map((c) => [c.id, c.top])),
    )
    check(
      '泳道：重叠的条目被分到下一行（换轨才能重叠）',
      by('b') && by('d') && by('b').top > by('a').top && by('d').top > by('c').top,
      JSON.stringify(clips.map((c) => [c.id, c.top])),
    )
    check(
      '泳道：两条重叠的条目落在同一层（不是每条都单开一层）',
      by('b') && by('d') && by('b').top === by('d').top,
      JSON.stringify([by('b')?.top, by('d')?.top]),
    )
    check(
      '字幕条上显示文本，放不下的用省略号收掉',
      !!by('f') && by('f').text.length > 0 && by('f').clipped === true,
      JSON.stringify({ text: by('f')?.text?.slice(0, 8), clipped: by('f')?.clipped }),
    )

    await shot(cdp, 'probe-timeline.png')

    /* ---------------- 点击选中 / Ctrl 多选 / 点空白定位 ---------------- */

    const centerOf = (expr) =>
      cdp.evaluate(`(() => {
        const el = ${expr}
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)

    // centerOf 要的是「求值为元素的表达式」，所以选择器得整条塞进 querySelector
    const clipSel = (id) => `.tl-clip[data-seg-id="${id}"]`
    const q = (sel) => `document.querySelector('${sel}')`

    const aBox = await centerOf(q(clipSel('a')))
    if (!aBox) throw new Error('找不到字幕条 a')
    await cdp.click(aBox.x, aBox.y)
    const picked = await store(`return [...editor.selectedIds]`)
    check('点击字幕条即选中', picked.length === 1 && picked[0] === 'a', JSON.stringify(picked))
    check(
      '点击字幕条不会顺带挪动播放头（游标只由点空白处决定）',
      Math.abs((await store(`return editor.playheadSec`)) - 0) < 0.001,
      String(await store(`return editor.playheadSec`)),
    )

    const tableSelected = await cdp.evaluate(
      `document.querySelectorAll('.subtable .row.is-selected').length`,
    )
    check('时间轴上选中会同步到下方字幕列表', tableSelected === 1, String(tableSelected))

    // Ctrl + 单击第二条 → 两条都在选中集合里
    const cBox = await centerOf(q(clipSel('c')))
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: cBox.x,
      y: cBox.y,
      button: 'left',
      clickCount: 1,
      buttons: 1,
      modifiers: 2,
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: cBox.x,
      y: cBox.y,
      button: 'left',
      clickCount: 1,
      buttons: 0,
      modifiers: 2,
    })
    const multi = await store(`return [...editor.selectedIds].sort()`)
    check('Ctrl 单击可多选', multi.length === 2 && multi.join() === 'a,c', JSON.stringify(multi))

    // 点轨道空白（波形区，避开字幕条）：只挪播放头，不动选中
    const blank = await cdp.evaluate(`(() => {
      const r = document.querySelector('.timeline__stage').getBoundingClientRect()
      return { x: Math.round(r.left + r.width * 0.72), y: Math.round(r.top + 16) }
    })()`)
    await cdp.click(blank.x, blank.y)
    const afterBlank = await store(`return { head: Math.round(editor.playheadSec * 10) / 10, sel: [...editor.selectedIds].sort() }`)
    check(
      '点非字幕区域移动播放头，且不改变已有选中',
      afterBlank.head > 20 && afterBlank.sel.length === 2,
      JSON.stringify(afterBlank),
    )

    /* ---------------------------- Ctrl + 滚轮缩放 ---------------------------- */

    /*
     * 缩放与平移都要**分成两步读**：派发 wheel 是同步的，但 Vue 更新 DOM 是
     * 异步的 —— 在同一个 evaluate 里 dispatch 完立刻读 `.timeline__zoom`，
     * 拿到的还是旧值，会误判成「缩放没生效」。
     */
    const zoomBefore = await cdp.evaluate(`document.querySelector('.timeline__zoom').textContent`)
    const zoomPrevented = await cdp.evaluate(`(() => {
      const stage = document.querySelector('.timeline__stage')
      const r = stage.getBoundingClientRect()
      const ev = new WheelEvent('wheel', {
        deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      })
      return !stage.dispatchEvent(ev)
    })()`)
    await sleep(200)
    const zoomAfter = await cdp.evaluate(`document.querySelector('.timeline__zoom').textContent`)
    check('Ctrl + 滚轮缩放时间轴', zoomAfter !== zoomBefore, `${zoomBefore} -> ${zoomAfter}`)
    check(
      'Ctrl + 滚轮被拦下，不会连带缩放整个界面',
      zoomPrevented === true,
      `prevented=${zoomPrevented}`,
    )

    // 普通滚轮：横向平移（放大之后才有得平移）
    const panBefore = await cdp.evaluate(
      `Math.round(document.querySelector('.tl-clip[data-seg-id="e"]').getBoundingClientRect().left)`,
    )
    await cdp.evaluate(`(() => {
      const stage = document.querySelector('.timeline__stage')
      const r = stage.getBoundingClientRect()
      stage.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 240, bubbles: true, cancelable: true,
        clientX: r.left + 60, clientY: r.top + r.height / 2,
      }))
      return true
    })()`)
    await sleep(200)
    const panAfter = await cdp.evaluate(
      `Math.round(document.querySelector('.tl-clip[data-seg-id="e"]').getBoundingClientRect().left)`,
    )
    check('普通滚轮让时间轴左右平移', panAfter < panBefore, `${panBefore} -> ${panAfter}`)

    // 回到适应宽度，后面的坐标换算才好算
    const fitBtn = await centerOf(
      `[...document.querySelectorAll('.timeline__btn')].find((b) => b.title.includes('适应宽度'))`,
    )
    await cdp.click(fitBtn.x, fitBtn.y)
    const zoomBack = await cdp.evaluate(
      `document.querySelector('.timeline__zoom').textContent`,
    )
    check('「适应宽度」把缩放复位', zoomBack === '100%', zoomBack)

    /* ----------------------------- 拖播放头 ----------------------------- */
    // 这一段的每个断言都靠「拖完之后游标落在哪」来判，所以坐标必须由时间反推，
    // 不能写死像素 —— 窗口尺寸一变整段就失去意义。

    const stageBox = () =>
      cdp.evaluate(`(() => {
        const r = document.querySelector('.timeline__stage').getBoundingClientRect()
        return { left: r.left, top: r.top, width: r.width, height: r.height }
      })()`)
    /** 时间 → 屏幕坐标（与组件的 xOf 同一套映射：适应宽度时整段铺满 stage） */
    const pointAt = (stage, sec) => ({
      x: stage.left + stage.width * (sec / 30),
      y: stage.top + 16,
    })
    /**
     * 播放头热区当前的中心。抓播放头**必须**按它自己的实测位置来按：
     * 播放头在 x = 0 时有一半压在 stage 外，用「算出来的坐标」去按会差几个像素，
     * 落到 stage 背景上 → 变成「点空白定位」而不是拖拽（这一条踩过）。
     */
    const hitBox = () =>
      cdp.evaluate(`(() => {
        const el = document.querySelector('.timeline__playhead-hit')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + 16 }
      })()`)

    const mouse = (type, x, y, buttons) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
        buttons,
      })

    const stage0 = await stageBox()

    // 先把游标放到 2 秒，再从播放头把它拖到 24 秒
    await cdp.click(Math.round(pointAt(stage0, 2).x), Math.round(pointAt(stage0, 2).y))
    await sleep(150)
    const selBefore = await store(`return [...editor.selectedIds].sort()`)
    const grab = await hitBox()
    if (!grab) throw new Error('找不到播放头热区')
    const dragTo = pointAt(stage0, 24)
    await mouse('mousePressed', grab.x, grab.y, 1)
    await mouse('mouseMoved', (grab.x + dragTo.x) / 2, dragTo.y, 1)
    const scrubbingDuring = await store(`return editor.scrubbing`)
    const bubbleDuring = await cdp.evaluate(`!!document.querySelector('.timeline__bubble.mono')`)
    await mouse('mouseMoved', dragTo.x, dragTo.y, 1)
    await mouse('mouseReleased', dragTo.x, dragTo.y, 0)
    await sleep(150)
    const dragHead = await store(`return editor.playheadSec`)
    // 容差 0.35 秒：坐标要经过取整，而「适应宽度」的 px/s 是浮点
    check('拖动播放头能调位置（拖到 24 秒附近）', Math.abs(dragHead - 24) < 0.35, String(Math.round(dragHead * 10) / 10))
    check('拖动播放头期间置位共享的 scrubbing 标志', scrubbingDuring === true, String(scrubbingDuring))
    check('拖动播放头时给出时间码气泡', bubbleDuring === true, String(bubbleDuring))
    check('拖动播放头不改动已有选中', (await store(`return [...editor.selectedIds].sort()`)).join() === selBefore.join(), JSON.stringify(selBefore))
    check('松手后 scrubbing 标志复位', (await store(`return editor.scrubbing`)) === false)

    // 往左狠拖 → 夹在 0
    const grabAt24 = await hitBox()
    await mouse('mousePressed', grabAt24.x, grabAt24.y, 1)
    await mouse('mouseMoved', stage0.left - 200, grabAt24.y, 1)
    await mouse('mouseReleased', stage0.left - 200, grabAt24.y, 0)
    await sleep(120)
    check('往左拖出轨道后游标夹在 0', (await store(`return editor.playheadSec`)) === 0, String(await store(`return editor.playheadSec`)))

    // 往右狠拖 → 夹在总时长
    const grabAt0 = await hitBox()
    if (!grabAt0) throw new Error('往左拖之后找不到播放头热区')
    await mouse('mousePressed', grabAt0.x, grabAt0.y, 1)
    await mouse('mouseMoved', stage0.left + stage0.width + 300, grabAt0.y, 1)
    await mouse('mouseReleased', stage0.left + stage0.width + 300, grabAt0.y, 0)
    await sleep(120)
    check('往右拖出轨道后游标夹在总时长', (await store(`return editor.playheadSec`)) === 30, String(await store(`return editor.playheadSec`)))

    // 双击播放头 = 回到开头。
    //
    // 这里**不**用 `Input.dispatchMouseEvent` 凑双击：CDP 注入的鼠标序列在本机
    // Chromium 上不会合成 dblclick（试过「按-放-按-放 + clickCount 2」也不出），
    // 于是断言永远失败而看不出是产品问题还是注入问题。直接派发一个真实的
    // dblclick 事件来验「接线」——坐标命中与拖拽已经在上面几条里验过了。
    //
    // （另：这条断言真正逮住过的 bug 是 `startScrub` 里的 `preventDefault()` ——
    //  它会把真实的 dblclick 一起掐掉，产品里同样点不出来。）
    const grabAtEnd = await hitBox()
    await cdp.evaluate(`(() => {
      const el = document.querySelector('.timeline__playhead-hit')
      if (el) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })()`)
    await sleep(150)
    check(
      '双击播放头回到开头',
      (await store(`return editor.playheadSec`)) === 0,
      `${JSON.stringify(grabAtEnd)} -> ${await store(`return editor.playheadSec`)}`,
    )


    /* ------------------------------ 拖拽边界 ------------------------------ */

    // 把 a 的右边界往右狠拖，同泳道的 c 必须把它顶住（8 秒处）
    const headBeforeDrag = await store(`return editor.playheadSec`)
    const gripBox = await centerOf(q(`${clipSel('a')} .tl-clip__grip--end`))
    if (!gripBox) throw new Error('找不到 a 的右边界热区')
    const farX = await cdp.evaluate(`(() => {
      const r = document.querySelector('.timeline__stage').getBoundingClientRect()
      return Math.round(r.left + r.width * 0.6)
    })()`)
    const gripY = gripBox.y
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: gripBox.x, y: gripY, button: 'left', clickCount: 1, buttons: 1,
    })
    for (const step of [0.2, 0.4, 0.6, 0.8, 1]) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(gripBox.x + (farX - gripBox.x) * step),
        y: gripY,
        button: 'left',
        buttons: 1,
      })
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: farX, y: gripY, button: 'left', clickCount: 1, buttons: 0,
    })
    const dragged = await store(`
      const f = project.files[0]
      const a = f.segments.find((s) => s.id === 'a')
      const c = f.segments.find((s) => s.id === 'c')
      return { aEnd: a.end, cStart: c.start }
    `)
    check(
      '拖右边界被同泳道的下一条顶住（同轨不许重叠）',
      dragged.aEnd === 8 && dragged.cStart === 8,
      JSON.stringify(dragged),
    )
    check(
      '拖动边界不改动播放头（游标只由点空白处与播放决定）',
      Math.abs((await store(`return editor.playheadSec`)) - headBeforeDrag) < 1e-6,
      `${headBeforeDrag} -> ${await store(`return editor.playheadSec`)}`,
    )

    // 拖完必须能撤回来
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(150)
    const undone = await store(`return project.files[0].segments.find((s) => s.id === 'a').end`)
    check('拖拽边界可以撤销', undone === 4, String(undone))

    /* ---------------------------- 拖条身：整条平移 ---------------------------- */

    /*
     * 拖「条身」= 整条平移（起点终点一起动、时长不变），与拖边界是两回事。
     * 它的可动范围由**同一泳道的前后邻居**夹出来 —— 这次拖的是 c（8–12），
     * 本泳道里它后面紧跟着 f（14–15.2），所以往右最多只能到 14，即 c 变成 10–14。
     * 断言精确值而不是「变大了」：夹取算错时正是这种差几秒的结果。
     */
    const cBody = await centerOf(q(clipSel('c')))
    if (!cBody) throw new Error('找不到字幕条 c')
    const cBefore = await store(`
      const c = project.files[0].segments.find((s) => s.id === 'c')
      return { start: c.start, end: c.end }
    `)
    const cFarX = await cdp.evaluate(`(() => {
      const r = document.querySelector('.timeline__stage').getBoundingClientRect()
      return Math.round(r.left + r.width * 0.97)
    })()`)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: cBody.x, y: cBody.y, button: 'left', clickCount: 1, buttons: 1,
    })
    for (const step of [0.3, 0.6, 0.9, 1]) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(cBody.x + (cFarX - cBody.x) * step),
        y: cBody.y,
        button: 'left',
        buttons: 1,
      })
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: cFarX, y: cBody.y, button: 'left', clickCount: 1, buttons: 0,
    })
    const cAfter = await store(`
      const c = project.files[0].segments.find((s) => s.id === 'c')
      return { start: c.start, end: c.end }
    `)
    check(
      '拖条身整条平移：被同泳道的下一条顶住，且时长不变',
      cBefore.start === 8 &&
        cBefore.end === 12 &&
        cAfter.start === 10 &&
        cAfter.end === 14 &&
        cAfter.end - cAfter.start === cBefore.end - cBefore.start,
      JSON.stringify([cBefore, cAfter]),
    )

    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(150)
    check(
      '拖条身可以撤销',
      (await store(`return project.files[0].segments.find((s) => s.id === 'c').start`)) === 8,
    )

    /* ------------------ 拖条身：纵向挪开一点即解除夹取、允许重叠 ------------------ */

    /*
     * 把 a（0–4，第一泳道）往右狠拖：同泳道的 c 从 8 秒起，正常会被顶在 4→8。
     * 但只要纵向把指针挪开一点（这里是 10px）就算「换轨」，夹取解除，a 能落到
     * 10 秒附近与 c 重叠。
     *
     * 10px 这个数是**卡在两次阈值之间**的：比现在（0.3 泳道 ≈7px）大、比原来
     * （0.6 泳道 ≈14px）小。阈值再被调大回去，这一步不会逃逸，a 被夹在 4 秒，
     * 断言随之失败 —— 用它守住「换轨要跟手」这个手感。
     */
    const aBody = await centerOf(q(clipSel('a')))
    if (!aBody) throw new Error('找不到字幕条 a')
    const aTargetX = await cdp.evaluate(`(() => {
      const r = document.querySelector('.timeline__stage').getBoundingClientRect()
      return Math.round(r.left + r.width * (10 / 30))
    })()`)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: aBody.x, y: aBody.y, button: 'left', clickCount: 1, buttons: 1,
    })
    for (const step of [0.2, 0.45, 0.7, 1]) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(aBody.x + (aTargetX - aBody.x) * step),
        y: aBody.y + 10,
        button: 'left',
        buttons: 1,
      })
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: aTargetX, y: aBody.y + 10, button: 'left', clickCount: 1, buttons: 0,
    })
    const escaped = await store(`
      const f = project.files[0]
      const a = f.segments.find((s) => s.id === 'a')
      const c = f.segments.find((s) => s.id === 'c')
      return { aStart: a.start, aEnd: a.end, overlap: a.end > c.start && a.start < c.end }
    `)
    check(
      '纵向挪开一点即解除夹取，字幕可以重叠（换轨阈值已调小）',
      escaped.aStart > 5 && escaped.overlap === true,
      JSON.stringify(escaped),
    )

    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(150)
    check(
      '换轨重叠后可以撤销',
      (await store(`return project.files[0].segments.find((s) => s.id === 'a').start`)) === 0,
    )

    /* -------------------- Ctrl+B：未编辑 → 按播放头 -------------------- */

    const atTwo = await cdp.evaluate(`(() => {
      const r = document.querySelector('.timeline__stage').getBoundingClientRect()
      return { x: Math.round(r.left + r.width * (2 / 30)), y: Math.round(r.top + 16) }
    })()`)
    await cdp.click(atTwo.x, atTwo.y)
    const head = await store(`return Math.round(editor.playheadSec * 10) / 10`)
    check('点轨道把播放头定到 2 秒附近', head === 2, String(head))

    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(200)
    const splitTime = await store(`
      const f = project.files[0]
      // 刀口是「点出来的像素位置」换算回时间的，带小数尾巴，不能拿 === 2 去等
      const near = (v, w) => Math.abs(v - w) < 0.05
      // 标记一律在页面里判成布尔再送回来：staleSlots 是 Vue 的响应式数组（Proxy），
      // 直接返回会被序列化成 {0:'source'} 这样的对象，includes 当场就炸。
      // （注：这段 body 会被插值进模板字符串，注释里不能出现反引号）
      const marked = (s) => s && (s.staleSlots ?? []).includes('source')
      const a1 = f.segments.find((s) => s.start === 0 && near(s.end, 2))
      const a2 = f.segments.find((s) => near(s.start, 2) && near(s.end, 4))
      return {
        count: f.segments.length,
        a1Text: a1 ? a1.text : null,
        a2Text: a2 ? a2.text : null,
        a1Marked: marked(a1),
        a2Marked: marked(a2),
      }
    `)
    check(
      'Ctrl+B 未编辑时按播放头分割：时间按刀口切两半',
      splitTime.count === 7 && !!splitTime.a1Text && !!splitTime.a2Text,
      JSON.stringify(splitTime),
    )
    check(
      '按播放头分割：文本整段复制（不按时间比例猜断点）',
      splitTime.a1Text === '第一条字幕' && splitTime.a2Text === '第一条字幕',
      JSON.stringify([splitTime.a1Text, splitTime.a2Text]),
    )
    check(
      '按播放头分割：两段都标红待确认',
      splitTime.a1Marked === true && splitTime.a2Marked === true,
      JSON.stringify([splitTime.a1Marked, splitTime.a2Marked]),
    )

    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(150)
    check(
      '按播放头分割可以撤销',
      (await store(`return project.files[0].segments.length`)) === 6,
    )

    /* --------------- Ctrl+B：多选时对所有选中条目一次切完 --------------- */

    /*
     * a（0–4）与 b（3–7）在 3–4 这一段是叠着的。把播放头放到 3.5 秒、两条都选中，
     * 一次 Ctrl+B 应该**两条各切一刀**（而不是只切碰巧先命中的那一条）——
     * 同一垂面上叠着好几条时本来就该一起处理，否则切完一条，剩下几条立刻又叠上来。
     */
    await store(`
      editor.setSelection(['a', 'b'])
      editor.setPlayhead(3.5)
      return true
    `)
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(250)
    const multiSplit = await store(`
      const f = project.files[0]
      return {
        count: f.segments.length,
        aHalves: f.segments.filter((s) => s.text === '第一条字幕').length,
        bHalves: f.segments.filter((s) => s.text === '与上一条重叠').length,
      }
    `)
    check(
      'Ctrl+B 选中多条时一次性全部切开（同一垂面同时分割）',
      multiSplit.count === 8 && multiSplit.aHalves === 2 && multiSplit.bHalves === 2,
      JSON.stringify(multiSplit),
    )

    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(200)
    await store(`editor.clearSelection(); return true`)
    check(
      '一次 Ctrl+B 只占一格历史（按一次 Ctrl+Z 就全部还原）',
      (await store(`return project.files[0].segments.length`)) === 6,
    )

    /* --------------------- Ctrl+B：编辑中 → 按文本光标 --------------------- */

    const bBox = await centerOf(q(clipSel('b')))
    await cdp.click(bBox.x, bBox.y)
    // F2 挂在 .subtable 这个可聚焦容器上（不是 window），派发到 window 是收不到的
    await cdp.evaluate(`(() => {
      const host = document.querySelector('.subtable')
      host.focus()
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
      return true
    })()`)
    await sleep(300)

    const editing = await store(`return editor.editingId ? 1 : 0`)
    check('F2 进入编辑态', editing === 1)

    await cdp.evaluate(`(() => {
      const el = document.querySelector('.subtable .row__editor')
      if (!el) return false
      el.focus()
      el.setSelectionRange(2, 2)
      el.dispatchEvent(new Event('select', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }))
      return true
    })()`)
    await sleep(250)
    const splitCaret = await store(`
      const f = project.files[0]
      const parts = f.segments.filter((s) => s.text === '与上' || s.text === '一条重叠')
      return { count: f.segments.length, parts: parts.map((s) => s.text) }
    `)
    check(
      'Ctrl+B 在编辑态仍按文本光标分割（两种语义不打架，只切一次）',
      splitCaret.count === 7 && splitCaret.parts.length === 2,
      JSON.stringify(splitCaret),
    )
    check(
      '编辑态分割真的把文本切开了（不是按时间复制整段）',
      splitCaret.parts.includes('与上') && splitCaret.parts.includes('一条重叠'),
      JSON.stringify(splitCaret.parts),
    )

    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
  },

  /**
   * 本轮「时间轴 + 告警」打磨项的回归。
   *
   * 这里每一段都对应一个**真实会犯的错**，不是「顺手测一下」：
   *   - 时间码框里的 Delete：少一道输入目标判断，整条字幕就被删掉
   *   - 忽略告警：按钮点了红还在、计数还在，等于没做
   *   - 泳道超限：数据层造得出「同时重叠 6 条」，必须在输入那一刻拦下来
   *   - 底栏与状态栏：一个报当前文件、一个报全工程，两个数字必须能被区分
   *   - 文本选中：桌面软件里划到哪蓝到哪，是「手感」问题里最烦的一种
   *   - 查找：原先只有「替换全部」，想改一处只能先全改再改回来
   *   - 表格拖动：把内容搬到另一个时间槽，时间码不动
   */
  async 'editor-polish'(cdp) {
    await goto(cdp, `${BASE}/?demo=1&view=editor&theme=light`)
    await sleep(500)

    const store = (body) =>
      cdp.evaluate(`(() => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const project = pinia.get('project')
        const editor = pinia.get('editor')
        const ui = pinia.get('ui')
        ${body}
      })()`)

    /*
     * 原生对话框桩。
     *
     * 浏览器预览里没有桥，`noticeBlocked` 会退回 window.alert；而 headless
     * Chromium 的 alert 会**阻塞脚本**直到有人把它点掉 —— 那会把整轮探针挂死在
     * 原地（后续断言全部超时）。装一个只记录不阻塞的桩，同时把「弹了什么」
     * 变成可断言的数据。桩只替代「弹窗」这一个动作，被拦的业务逻辑一行都不替代。
     */
    const installDialogStub = () =>
      cdp.evaluate(`(() => {
        window.__blocked = []
        window.xbaos = Object.assign(window.xbaos || {}, {
          dialog: {
            confirm: async (o) => { window.__blocked.push(o); return 0 },
          },
        })
        return true
      })()`)
    await installDialogStub()

    const mk = (id, start, end, text) => ({ id, start, end, text, origin: text, issues: [] })

    const seed = await store(`
      const f = project.viewFile
      if (!f) return 'no-file'
      f.durationSec = 30
      f.segments = [
        ${JSON.stringify(mk('a', 0, 4, '第一条字幕'))},
        ${JSON.stringify(mk('b', 3, 7, '与上一条重叠'))},
        ${JSON.stringify(mk('c', 8, 12, '回到第一行'))},
      ]
      editor.clearSelection()
      editor.setPlayhead(0)
      return [f.id, f.segments.length]
    `)
    check('注入可控条目', Array.isArray(seed) && seed[1] === 3, JSON.stringify(seed))
    await sleep(400)

    /* ------------------ 时间码输入框里的按键归输入框自己 ------------------ */

    /**
     * 在时间码框里输入一个值。
     *
     * 走真实的输入路径（点开 → 塞 value → input 事件 → 回车），而不是直接改
     * store：要验的正是「输入框里的按键会不会被全局快捷键抢走」，绕过输入框
     * 就等于没测。
     */
    const typeTimecode = async (segId, edgeIndex, text) => {
      const sel = '.subtable .row[data-seg-id="' + segId + '"] .cell--time .timecode__display'
      await cdp.evaluate(`(() => {
        const list = document.querySelectorAll('${sel}')
        if (list[${edgeIndex}]) list[${edgeIndex}].click()
        return list.length
      })()`)
      await sleep(200)
      await cdp.evaluate(`(() => {
        const el = document.querySelector('.timecode__input')
        if (!el) return false
        el.focus()
        el.value = ${JSON.stringify(text)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        return true
      })()`)
      await sleep(300)
    }

    await cdp.evaluate(`(() => {
      const el = document.querySelector('.subtable .row .cell--time .timecode__display')
      el.click()
      return true
    })()`)
    await sleep(220)
    check(
      '点击时间码进入输入态',
      (await cdp.evaluate(
        `!!(document.activeElement && document.activeElement.className.indexOf('timecode__input') >= 0)`,
      )) === true,
    )
    await cdp.evaluate(`(() => {
      const el = document.querySelector('.timecode__input')
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Insert', bubbles: true, cancelable: true }))
      return true
    })()`)
    await sleep(200)
    check(
      '时间码框里按 Delete / Backspace / Insert 不会误删或误加字幕',
      (await store(`return project.viewFile.segments.length`)) === 3,
      String(await store(`return project.viewFile.segments.length`)),
    )
    await cdp.evaluate(`(() => {
      const el = document.querySelector('.timecode__input')
      if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      return true
    })()`)
    await sleep(200)

    /* ------------------------------ 忽略告警 ------------------------------ */

    const beforeAck = await store(`
      const row = project.viewFile.segments.find((s) => s.id === 'b')
      return {
        errors: project.errorCount,
        warnings: project.warningCount,
        hasIssue: row.issues.length > 0,
      }
    `)
    const entryBefore = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.subtable .row')].find((el) => el.dataset.segId === 'b')
      const btn = row ? row.querySelector('.row__ack') : null
      return { error: row.classList.contains('has-error'), label: btn ? btn.textContent.trim() : null }
    })()`)
    check(
      '有告警的行给出「忽略告警」入口',
      beforeAck.hasIssue === true && entryBefore.error === true && entryBefore.label === '忽略告警',
      JSON.stringify([beforeAck, entryBefore]),
    )

    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.subtable .row')].find((el) => el.dataset.segId === 'b')
      row.querySelector('.row__ack').click()
      return true
    })()`)
    await sleep(300)
    const afterAck = await store(`
      const row = project.viewFile.segments.find((s) => s.id === 'b')
      return { acked: !!row.acked, errors: project.errorCount, warnings: project.warningCount }
    `)
    check(
      '忽略之后不再计入底部的错误 / 警告条数',
      afterAck.acked === true && afterAck.errors === beforeAck.errors - 1,
      JSON.stringify([beforeAck, afterAck]),
    )
    const entryAfter = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.subtable .row')].find((el) => el.dataset.segId === 'b')
      const btn = row.querySelector('.row__ack')
      return { error: row.classList.contains('has-error'), label: btn ? btn.textContent.trim() : null }
    })()`)
    check(
      '忽略之后红色标记消失，入口变成「已忽略」',
      entryAfter.error === false && entryAfter.label === '已忽略',
      JSON.stringify(entryAfter),
    )

    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.subtable .row')].find((el) => el.dataset.segId === 'b')
      row.querySelector('.row__ack').click()
      return true
    })()`)
    await sleep(300)
    check(
      '再点一次可以恢复，计数也跟着回来',
      (await store(
        `return { acked: !!project.viewFile.segments.find((s) => s.id === 'b').acked, errors: project.errorCount }`,
      )).errors === beforeAck.errors,
    )

    /* ------------------------ 泳道上限：输入拦截 ------------------------ */

    const LANE_SEED = `
      f.segments = [
        ${JSON.stringify(mk('p1', 9, 11, '同时一'))},
        ${JSON.stringify(mk('p2', 9, 11, '同时二'))},
        ${JSON.stringify(mk('p3', 9, 11, '同时三'))},
        ${JSON.stringify(mk('p4', 9, 11, '同时四'))},
        ${JSON.stringify(mk('p5', 9, 11, '同时五'))},
        ${JSON.stringify(mk('p6', 20, 22, '待挪进来的一条'))},
      ]
      editor.clearSelection()
      editor.setPlayhead(0)
      return f.segments.length
    `
    await store(`const f = project.viewFile; ${LANE_SEED}`)
    await sleep(400)
    const laneFill = await cdp.evaluate(`document.querySelectorAll('.tl-clip').length`)
    check('5 条同时重叠正好铺满 5 层泳道', laneFill === 6, String(laneFill))

    // 把 p6 的起点改成 9 → 会变成第 6 条同时出现，必须被挡下来
    await typeTimecode('p6', 0, '00:00:09,000')
    const blockedCalls = await cdp.evaluate(`window.__blocked.length`)
    check('改时间码造成第 6 条同时重叠时弹出原生对话框', blockedCalls >= 1, String(blockedCalls))
    const blockedText = await cdp.evaluate(`JSON.stringify(window.__blocked[0] || {})`)
    check(
      '对话框说明了原因（同一时刻最多 5 条）',
      blockedText.includes('5') && blockedText.includes('同一时刻'),
      blockedText.slice(0, 120),
    )
    check(
      '被拒绝之后时间码保持原值',
      (await store(`return project.viewFile.segments.find((s) => s.id === 'p6').start`)) === 20,
      String(await store(`return project.viewFile.segments.find((s) => s.id === 'p6').start`)),
    )

    // 合法的改动仍然要能落下去（别把整条路堵死）
    await typeTimecode('p6', 0, '00:00:12,000')
    const movedOk = await store(`
      const p6 = project.viewFile.segments.find((s) => s.id === 'p6')
      return { start: p6.start, end: p6.end, blocked: window.__blocked.length }
    `)
    check(
      '不造成超限的时间码改动照常生效（且没弹窗）',
      movedOk.start === 12 && movedOk.blocked === blockedCalls,
      JSON.stringify(movedOk),
    )

    /* ------------------------ 泳道上限：超限显示 ------------------------ */

    await store(`
      const f = project.viewFile
      f.segments = [1, 2, 3, 4, 5, 6].map((n) => ({
        id: 'q' + n,
        start: 9,
        end: 11,
        text: '第' + n + '条',
        origin: '第' + n + '条',
        issues: [],
      }))
      editor.clearSelection()
      return f.segments.length
    `)
    await sleep(400)
    const overflowView = await cdp.evaluate(`(() => {
      const warn = document.querySelector('.timeline__warn')
      return {
        warn: warn ? warn.textContent.replace(/\\s+/g, ' ').trim() : null,
        overflow: document.querySelectorAll('.tl-clip.is-overflow').length,
        total: document.querySelectorAll('.tl-clip').length,
      }
    })()`)
    check(
      '超出上限时工具条给出文字说明',
      !!overflowView.warn && overflowView.warn.indexOf('5') >= 0,
      String(overflowView.warn),
    )
    check(
      '超出的字幕条用警示配色标出，但仍然渲染（能点中、能删除）',
      overflowView.overflow === 1 && overflowView.total === 6,
      JSON.stringify(overflowView),
    )

    /* ---------------- 底部告警分层：当前文件 vs 整个工程 ---------------- */

    await store(`
      const f = project.viewFile
      f.durationSec = 10
      f.segments = [
        ${JSON.stringify(mk('v1', 0, 2, '干净的第一条'))},
        ${JSON.stringify(mk('v2', 3, 5, '干净的第二条'))},
      ]
      // 只留另一个文件带一处重叠，保证「当前文件」与「全工程」的数一定不同
      let other = null
      for (const g of project.supportedFiles) {
        if (g.id === f.id) continue
        if (!other) {
          other = g
          g.durationSec = 10
          g.segments = [
            ${JSON.stringify(mk('o1', 0, 4, '别人的第一条'))},
            ${JSON.stringify(mk('o2', 2, 6, '别人的第二条'))},
          ]
        } else {
          g.segments = []
        }
      }
      return true
    `)
    await sleep(500)
    const counts = await store(`
      const count = (segs) => segs.filter((s) => !s.acked && s.issues.some((i) => i.level === 'error')).length
      return {
        file: count(project.viewFile.segments),
        all: project.errorCount,
        files: project.supportedFiles.length,
      }
    `)
    const footText = (
      await cdp.evaluate(
        `(document.querySelector('.editor__foot .editor__stat--warn') || {}).textContent || ''`,
      )
    ).trim()
    const barText = (
      await cdp.evaluate(`(document.querySelector('.statusbar__issue') || {}).textContent || ''`)
    ).trim()
    check(
      '编辑器底栏报的是**当前文件**的告警数',
      counts.files > 1 && counts.file === 0 && footText.indexOf('0 条错误') === 0,
      JSON.stringify([counts, footText]),
    )
    check(
      '底部状态栏报的是**整个工程**的告警数（两者口径不同）',
      counts.all === 1 && barText.indexOf('1 条错误') === 0,
      JSON.stringify([counts, barText]),
    )

    /* --------------------------- 文本选中策略 --------------------------- */

    const selectable = await cdp.evaluate(`(() => {
      const of = (sel) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el).userSelect : null
      }
      return {
        body: getComputedStyle(document.body).userSelect,
        panel: of('.toolpanel__title'),
        clip: of('.tl-clip__text'),
        status: of('.editor__foot .editor__stat'),
        subtitle: of('.subtable .row .row__text'),
        timecode: of('.subtable .row .timecode__display'),
      }
    })()`)
    check(
      '界面文案默认不可选中（面板标题 / 时间轴字幕条 / 底栏）',
      selectable.body === 'none' &&
        selectable.panel === 'none' &&
        selectable.clip === 'none' &&
        selectable.status === 'none',
      JSON.stringify(selectable),
    )
    check(
      '字幕正文与时间码仍然可以选中复制',
      selectable.subtitle === 'text' && selectable.timecode === 'text',
      JSON.stringify(selectable),
    )

    /* ---------------------------- 查找与替换 ---------------------------- */

    await store(`
      const f = project.viewFile
      f.segments = [
        ${JSON.stringify(mk('f1', 0, 2, '苹果 香蕉 苹果'))},
        ${JSON.stringify(mk('f2', 3, 5, '苹果派'))},
        ${JSON.stringify(mk('f3', 6, 8, '只有香蕉'))},
      ]
      editor.clearSelection()
      return f.segments.length
    `)
    await sleep(300)
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.toolpanel .tool')].find((b) => b.textContent.indexOf('查找替换') >= 0)
      btn.click()
      return true
    })()`)
    await sleep(300)
    await cdp.evaluate(`(() => {
      const el = document.querySelector('.toolpanel .inline .input')
      el.focus()
      el.value = '苹果'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(300)

    /*
     * 按钮要按**标题或可见文字**找。这组按钮的 title 写的是完整说明
     * （「把范围内所有匹配都换掉」），可见文字才是「全部替换」——
     * 只按 title 找会把后者漏掉，而漏掉时 `click` 静默什么也不做，
     * 于是只在后面「内容没变」上隐式暴露（本轮就是这么栽的）。
     * 这里把「有没有点到」一起返回，断言里一并判掉。
     */
    const clickToolBtn = (part) =>
      cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('.toolpanel .inline .btn')]
          .find((b) => ((b.title || '') + ' ' + (b.textContent || '')).indexOf(${JSON.stringify(part)}) >= 0)
        if (!btn) return false
        btn.click()
        return true
      })()`)

    const countText = async () =>
      (await cdp.evaluate(`(document.querySelector('.inline__count') || {}).textContent || ''`)).trim()

    check(
      '查找按**出现次数**统计（一条字幕里出现两次算两处）',
      (await countText()).indexOf('第 1 / 3 处') >= 0,
      await countText(),
    )

    const hitNext = await clickToolBtn('下一个匹配')
    await sleep(250)
    check(
      '「下一个」逐处往下跳，并选中所在字幕',
      hitNext === true &&
        (await countText()).indexOf('第 2 / 3 处') >= 0 &&
        (await store(`return editor.selectedIds[0]`)) === 'f1',
      JSON.stringify([hitNext, await countText(), await store(`return [...editor.selectedIds]`)]),
    )

    const hitPrev = await clickToolBtn('上一个匹配')
    await sleep(250)
    check(
      '「上一个」跳回第 1 处',
      hitPrev === true && (await countText()).indexOf('第 1 / 3 处') >= 0,
      JSON.stringify([hitPrev, await countText()]),
    )

    // 只替换当前这一处
    await cdp.evaluate(`(() => {
      const inputs = [...document.querySelectorAll('.toolpanel .inline .input')]
      inputs[1].focus()
      inputs[1].value = '梨'
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(250)
    const hitOne = await clickToolBtn('只替换当前停的这一处')
    await sleep(350)
    const afterOne = await store(`return project.viewFile.segments.map((s) => s.text)`)
    check(
      '「替换」只动当前这一处，别的匹配原封不动',
      hitOne === true && afterOne[0] === '梨 香蕉 苹果' && afterOne[1] === '苹果派',
      JSON.stringify([hitOne, afterOne]),
    )

    const hitAll = await clickToolBtn('全部替换')
    await sleep(350)
    const afterAll = await store(`return project.viewFile.segments.map((s) => s.text)`)
    check(
      '「全部替换」一次换掉范围内所有匹配',
      hitAll === true && afterAll[0] === '梨 香蕉 梨' && afterAll[1] === '梨派' && afterAll[2] === '只有香蕉',
      JSON.stringify([hitAll, afterAll]),
    )

    /*
     * Ctrl+H 落地的**不是弹窗**，而是展开右侧面板里那块查找区（弹窗会挡住正文，
     * 而查找替换要一边看字幕一边用）。这条同时守住「别再退回
     * `openDialog('find-replace')` 这个不存在的弹窗」—— `ui.dialog` 必须立刻被收回去，
     * 否则它会一直停在一个谁也渲染不出来的值上，之后打开别的弹窗也照样不出来。
     */
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.toolpanel .tool')].find((b) => b.textContent.indexOf('查找替换') >= 0)
      btn.click()
      return true
    })()`)
    await sleep(250)
    const findClosed = await cdp.evaluate(
      `![...document.querySelectorAll('.toolpanel .inline')].some((el) => el.textContent.indexOf('查找替换') >= 0)`,
    )
    await cdp.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true }))`,
    )
    await sleep(300)
    const hotkey = await cdp.evaluate(`(() => {
      const open = [...document.querySelectorAll('.toolpanel .inline')].some((el) => el.textContent.indexOf('查找替换') >= 0)
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
      return { open, dialog: pinia.get('ui').dialog }
    })()`)
    check(
      'Ctrl+H 展开右侧的查找区，而不是指向一个不存在的弹窗',
      findClosed === true && hotkey.open === true && hotkey.dialog === null,
      JSON.stringify([findClosed, hotkey]),
    )

    /* ------------------------ 表格拖动：内容换槽 ------------------------ */

    await store(`
      const f = project.viewFile
      f.segments = [
        ${JSON.stringify(mk('r1', 0, 2, 'AAA'))},
        ${JSON.stringify(mk('r2', 3, 5, 'BBB'))},
        ${JSON.stringify(mk('r3', 6, 8, 'CCC'))},
      ]
      editor.clearSelection()
      return f.segments.length
    `)
    await sleep(350)

    /*
     * 用合成的 DragEvent 驱动（CDP 的 Input.dispatchDragEvent 需要先
     * Input.setInterceptDrags，且要自己构造拖拽数据）。这里要验的是**业务语义**
     * ——「内容搬到目标行的时间码上」—— 而不是浏览器原生的拖拽实现，
     * 所以直接派发 dragstart / dragover / drop 三个事件即可。
     */
    await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.subtable .row')]
      if (rows.length < 3) return false
      const dt = new DataTransfer()
      const handle = rows[0].querySelector('.cell--index')
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      rows[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      rows[2].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
      return true
    })()`)
    await sleep(400)
    const reordered = await store(`
      const list = project.viewFile.segments.map((s) => ({ text: s.text, start: s.start, end: s.end }))
      return list
    `)
    check(
      '拖动行 = 把内容搬到目标行的时间码上（时间码原地不动）',
      reordered[0].text === 'BBB' &&
        reordered[1].text === 'CCC' &&
        reordered[2].text === 'AAA' &&
        reordered[0].start === 0 &&
        reordered[2].start === 6,
      JSON.stringify(reordered),
    )
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await sleep(200)
    check(
      '调整顺序可以撤销',
      (await store(`return project.viewFile.segments.map((s) => s.text).join()`)) === 'AAA,BBB,CCC',
      await store(`return project.viewFile.segments.map((s) => s.text).join()`),
    )

    await cdp.evaluate(`(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('xbaos.settings')).forEach((k) => localStorage.removeItem(k))
      return true
    })()`)
  },
}

/* ---------------------------------------------------------------------- main */

const only = process.argv.slice(2)
const chosen = only.length > 0 ? only : Object.keys(scenarios)

let handle = null
try {
  handle = await launch()
  for (const name of chosen) {
    const fn = scenarios[name]
    if (!fn) {
      console.log(`跳过未知场景: ${name}`)
      continue
    }
    console.log(`\n▶ ${name}`)
    try {
      await fn(handle.cdp)
    } catch (err) {
      // 场景级兜底：一个场景炸了只记一条 FAIL，别把整轮跑死 ——
      // 否则总结行都不打、退出码还是 0（管道里 grep 看不出异常），全量验证白做
      check(`场景 ${name} 中断`, false, String(err?.message ?? err).split('\n')[0])
    }
  }
} finally {
  if (handle) {
    try {
      handle.cdp.ws.close()
    } catch {
      /* 忽略 */
    }
    handle.child.kill()
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
process.exit(failed.length > 0 ? 1 : 0)
