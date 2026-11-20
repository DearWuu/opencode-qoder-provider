/**
 * 文件职责：终端显示宽度测试：charWidth 的区段口径与 truncateToWidth 的截断不变量。
 * 上游：node:test / Bun test。
 * 下游：src/text.mjs 纯宽度函数。
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { charWidth, truncateToWidth } from "../src/text.mjs"

function widthOf(text: string): number {
  let total = 0
  for (const ch of text) total += charWidth(ch)
  return total
}

test("charWidth: East Asian wide chars count 2, ASCII and symbols count 1", () => {
  assert.equal(charWidth("a"), 1)
  assert.equal(charWidth(" "), 1)
  assert.equal(charWidth("中"), 2)
  assert.equal(charWidth("じ"), 2)
  assert.equal(charWidth("한"), 2)
  assert.equal(charWidth("（"), 2)
})

test("mixed wide and narrow strings measure per code point", () => {
  assert.equal(widthOf("中文ab"), 6)
  assert.equal(widthOf("a1中b2文3"), 9)
  assert.equal(truncateToWidth("中文ab", 7), "中文ab")
})

test("a string exactly as wide as the limit passes through unchanged", () => {
  assert.equal(truncateToWidth("中文中", 6), "中文中")
  assert.equal(truncateToWidth("abc", 3), "abc")
})

test("one column over the limit truncates and the ellipsis fills the freed column", () => {
  assert.equal(truncateToWidth("中文中", 5), "中文…")
  assert.equal(truncateToWidth("abcd", 3), "ab…")
})

test("a wide first char with width=1 truncates to the bare ellipsis", () => {
  assert.equal(truncateToWidth("中", 1), "…")
  assert.equal(truncateToWidth("中文", 1), "…")
})

test("width <= 0 always returns an empty string", () => {
  assert.equal(truncateToWidth("abc", 0), "")
  assert.equal(truncateToWidth("中文", 0), "")
  assert.equal(truncateToWidth("abc", -3), "")
})

test("emoji range 0x1f300-0x1faff counts as 2 columns", () => {
  assert.equal(charWidth("😀"), 2) // 0x1f600
  assert.equal(charWidth("🚀"), 2) // 0x1f680
  assert.equal(charWidth("🪐"), 2) // 0x1fa90, near range end
  assert.equal(widthOf("a🚀b"), 4)
  assert.equal(truncateToWidth("🚀🚀", 4), "🚀🚀")
  assert.equal(truncateToWidth("🚀🚀", 3), "🚀…")
})

test("combining marks, ZWJ and variation selectors add zero width", () => {
  assert.equal(charWidth("\u0301"), 0) // combining acute
  assert.equal(charWidth("\u200d"), 0) // ZWJ
  assert.equal(charWidth("\ufe0f"), 0) // VS16
  assert.equal(widthOf("e\u0301"), 1)
  assert.equal(widthOf("📄\ufe0f"), 2) // emoji keeps 2, VS16 adds 0
  assert.equal(truncateToWidth("e\u0301x", 2), "e\u0301x")
})

test("truncated results never exceed the requested display width", () => {
  const samples = [
    "中文混合abc文本",
    "⟳ 刷新…",
    "个人 4 / 570（1%）",
    "共享资源包 1,727 / 5,000（35%）",
    "🚀发射🚀ok",
    "e\u0301\u200d\u0301abc",
  ]
  for (const text of samples) {
    for (let width = 0; width <= 14; width++) {
      const out = truncateToWidth(text, width)
      assert.ok(widthOf(out) <= width, `width ${width} exceeded by ${JSON.stringify(out)}`)
      if (widthOf(text) <= width) assert.equal(out, text)
    }
  }
})
