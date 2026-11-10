/**
 * 文件职责：固定间隔的异步轮询器，供侧边栏 Credits 面板取数。
 * 上游：panel.tsx 创建并 start/stop、test/poller.test.ts。
 * 下游：无（只依赖注入的 timer）。
 */

/** 侧边栏 Credits 面板的轮询间隔。 */
export const STATS_POLL_INTERVAL_MS = 15_000

/**
 * 按固定间隔反复轮询一个异步数据源。
 *
 * 首次 fetch 立即开始；每次完成（或失败）后安排下一次。timer 可注入，测试因此能快进时间。
 * `stop()` 取消待触发的 timer，之后的完成也不再安排下一轮。
 * `fetch` 的 rejection 不会打断调度：错误上报由数据源自己负责，这里只是 timer 循环。
 *
 * @param {{ fetch: () => Promise<unknown>, intervalMs?: number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void }} input
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createStatsPoller(input) {
  const intervalMs = input.intervalMs ?? STATS_POLL_INTERVAL_MS
  const setTimer = input.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = input.clearTimer ?? ((id) => clearTimeout(id))

  let timer = undefined
  let stopped = true

  function schedule() {
    if (stopped) return
    timer = setTimer(() => {
      void tick()
    }, intervalMs)
  }

  async function tick() {
    if (stopped) return
    try {
      await input.fetch()
    } catch {
      // fetch 回调自己上报错误；轮询器绝不能抛出。
    }
    schedule()
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      void tick()
    },
    stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimer(timer)
        timer = undefined
      }
    },
  }
}
