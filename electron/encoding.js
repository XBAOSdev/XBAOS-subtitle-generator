/**
 * 字幕文件的编码探测与写回。
 *
 * 抽成独立模块的两个理由：
 *   ① 主进程里的逻辑没法写单元测试，这里可以（`tools/unit-check.ts` 直接 import）；
 *   ② 判定规则本身就是一段需要反复读的代码，混在 main.js 的 IPC 堆里没人看得懂。
 *
 * 判定顺序刻意如此，别随手调换：
 *   BOM → UTF-16（含无 BOM 的启发式）→ 严格 UTF-8 → GBK
 * 「严格 UTF-8」指出现 U+FFFD 就判不合格 —— 这是 GBK 文件唯一的可靠信号。
 */

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf)

/**
 * 无 BOM 的 UTF-16 探测。
 *
 * 为什么需要它：某些编辑器把「Unicode」另存时会把 BOM 去掉，而 UTF-16 的字节流
 * 按 UTF-8 读必然出现 U+FFFD，于是被当成 GBK 解出一屏乱码 —— 用户看到的就是
 * 「别的软件打开正常，本软件打开乱码」。
 *
 * 判据是**空字节的奇偶分布**：拉丁文本的 UTF-16LE 奇数位大量是 0x00（`A` = 41 00），
 * 反过来就是 BE。纯中日韩文本没有空字节，靠这条抓不到 —— 所以它只是「能抓就抓」，
 * 不改变后面 UTF-8 / GBK 的主判定。
 */
function sniffBomlessUtf16(buf) {
  if (buf.length < 8 || buf.length % 2 !== 0) return null
  const pairs = buf.length / 2
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < buf.length; i += 2) {
    if (buf[i] === 0) evenZero += 1
    if (buf[i + 1] === 0) oddZero += 1
  }
  // 0.35 是个折中：纯 ASCII 的 UTF-16 会接近 1.0，混排文本会低一些，
  // 而任何一种单字节编码都不会在固定奇偶位产出这么多 0x00
  if (oddZero / pairs >= 0.35) return 'utf16le'
  if (evenZero / pairs >= 0.35) return 'utf16be'
  return null
}

function decodeUtf16(buf, little) {
  const body = Buffer.from(buf.subarray(0))
  if (!little) body.swap16()
  return body.toString('utf16le')
}

/**
 * 按上面的顺序判定编码并解码。
 *
 * @param buf 文件原始字节
 * @returns `text` 与**实际使用的编码**；调用方要把它记下来，覆盖保存时原样写回
 */
export function decodeTextAuto(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: Buffer.from(buf.subarray(3)).toString('utf8'), encoding: 'utf-8-bom' }
  }
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    // UTF-16 源：统一转成带 BOM 的 UTF-8 保存，避免引入第三种写回编码
    return { text: decodeUtf16(buf.subarray(2), buf[0] === 0xff), encoding: 'utf-8-bom' }
  }

  const bomless = sniffBomlessUtf16(buf)
  if (bomless) {
    // 同样归到 utf-8-bom：写回时统一转码，不保留原来的 UTF-16
    return { text: decodeUtf16(buf, bomless === 'utf16le'), encoding: 'utf-8-bom' }
  }

  const asUtf8 = Buffer.from(buf).toString('utf8')
  if (!asUtf8.includes('\uFFFD')) {
    return { text: asUtf8, encoding: 'utf-8' }
  }
  return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' }
}

/* ------------------------------------------------------------------ 写回 */

let gbkTable = null

/**
 * GBK 编码。
 *
 * 主进程拿不到 `iconv`（不想为了一件事引原生依赖），所以这里反过来用系统自带的
 * `TextDecoder('gbk')` 建一张反查表：把所有双字节码位解一遍，谁解出什么字就记下来。
 * 表是一次性的，缓存住即可。
 */
export function encodeGbk(text) {
  if (!gbkTable) {
    const decoder = new TextDecoder('gbk')
    gbkTable = new Map()
    // 单字节区：ASCII 原样
    for (let b = 0; b < 0x80; b++) {
      const ch = decoder.decode(Uint8Array.of(b))
      if (ch.length === 1 && ch !== '\uFFFD') gbkTable.set(ch, Uint8Array.of(b))
    }
    // 双字节区
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue
        const bytes = Uint8Array.of(lead, trail)
        const ch = decoder.decode(bytes)
        if (ch !== '\uFFFD' && !gbkTable.has(ch)) gbkTable.set(ch, bytes)
      }
    }
  }

  const out = []
  for (const ch of text) {
    if (ch < '\x80') {
      out.push(ch.charCodeAt(0))
      continue
    }
    const mapped = gbkTable.get(ch)
    if (mapped) {
      out.push(...mapped)
    } else {
      // GBK 里没有的字符（生僻字、emoji）用问号占位，别让整个导出失败
      out.push(0x3f)
    }
  }
  return Uint8Array.from(out)
}

/** 把文本编码成写盘用的字节；`encoding` 只认三种，其余按 UTF-8 处理 */
export function encodeSubtitle(content, encoding) {
  if (encoding === 'gbk') return encodeGbk(content)
  const body = Buffer.from(content, 'utf8')
  if (encoding === 'utf-8-bom') return Buffer.concat([Buffer.from(UTF8_BOM), body])
  return body
}
