/**
 * 文件职责：终端显示宽度的纯计算：近似 wcwidth 的字符宽度、按显示宽度截断（加省略号）。
 * 上游：panel.tsx（面板行渲染前逐行截断）、test/text.test.ts 直接锁定行为。
 * 下游：无（纯函数）。
 */

/**
 * 终端显示宽度近似 wcwidth：东亚全角与 emoji 区段计 2 列，组合符/ZWJ/变体选择符计 0 列，其余计 1 列。
 *
 * 刻意保守、宁宽勿窄：把实际占 1 列的字符当 2 列只会让截断提前（丢尾字符），不会让面板行折行——
 * 折行会让宿主少算滚动高度、面板尾部滚不到，是不可接受的失败方向。
 * 传入整串时只看首个码点，调用方必须自己按 for-of 拆码点（代理对由此整体计 2 列）。
 *
 * 调用方：truncateToWidth 内部逐码点调用；test/text.test.ts 直接锁定行为。
 *
 * @param {string} ch 单个码点组成的字符串
 * @returns {number} 终端显示列数（0 / 1 / 2）
 */
export function charWidth(ch) {
  const code = ch.codePointAt(0) ?? 0
  if (
    (code >= 0x0300 && code <= 0x036f) || // 组合附加符
    code === 0x200d || // 零宽连接符 ZWJ
    (code >= 0xfe00 && code <= 0xfe0f) // 变体选择符
  ) {
    return 0
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) || // emoji 主区段
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/**
 * 按显示宽度截断并加省略号；不超宽原样返回，width <= 0 返回空串。
 *
 * 侧边栏内任何折行都会让宿主少算滚动高度、面板尾部滚不到，所以每行渲染前都过本函数保证只占一行。
 * 截断时保留尽量长的前缀、以「…」（1 列）收尾，截断结果总宽度（含省略号）不超过 width。
 *
 * 调用方：panel.tsx（面板行渲染前逐行调用）；test/text.test.ts 直接锁定行为。
 *
 * @param {string} text
 * @param {number} width 可用显示列数
 * @returns {string}
 */
export function truncateToWidth(text, width) {
  if (width <= 0) return ""
  let total = 0
  for (const ch of text) total += charWidth(ch)
  if (total <= width) return text
  let used = 0
  let out = ""
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}
