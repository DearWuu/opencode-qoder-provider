import { test } from "node:test"
import assert from "node:assert/strict"

import { catalogSignature, createCatalogSync } from "../src/catalog-sync.mjs"

const catalog = (ids: string[]) => ids.map((id) => ({ id, modelID: id.toUpperCase(), name: id }))

let sequence = 0
function uniqueScope() {
  sequence += 1
  return `catalog-sync-test-${process.pid}-${sequence}`
}

test("publish broadcasts a new catalog to every subscriber", async () => {
  const scope = uniqueScope()
  const receivedA: any[] = []
  const receivedB: any[] = []
  const a = createCatalogSync({ scope, location: "a", apply: (entries: any) => receivedA.push(entries) })
  const b = createCatalogSync({ scope, location: "b", apply: (entries: any) => receivedB.push(entries) })

  const result = await a.publish(catalog(["auto", "fast"]))

  assert.deepEqual(result, { broadcast: true, delivered: 2, failed: 0 })
  assert.deepEqual(receivedA, [catalog(["auto", "fast"])])
  assert.deepEqual(receivedB, [catalog(["auto", "fast"])])
  a.dispose()
  b.dispose()
})

test("publishing an unchanged catalog does not reload subscribers again", async () => {
  const scope = uniqueScope()
  let applies = 0
  const a = createCatalogSync({ scope, location: "a", apply: () => { applies += 1 } })

  const first = await a.publish(catalog(["auto", "fast"]))
  const second = await a.publish(catalog(["auto", "fast"]))

  assert.equal(first.broadcast, true)
  assert.equal(second.broadcast, false)
  assert.deepEqual(second, { broadcast: false, delivered: 0, failed: 0 })
  assert.equal(applies, 1)
  a.dispose()
})

test("concurrent duplicate publishes reload subscribers only once", async () => {
  const scope = uniqueScope()
  let applies = 0
  const a = createCatalogSync({ scope, location: "a", apply: () => { applies += 1 } })

  const [first, second] = await Promise.all([
    a.publish(catalog(["auto"])),
    a.publish(catalog(["auto"])),
  ])

  assert.equal(first.broadcast || second.broadcast, true)
  assert.equal(applies, 1)
  a.dispose()
})

test("a failing subscriber does not block the other subscribers", async () => {
  const scope = uniqueScope()
  const received: any[] = []
  const broken = createCatalogSync({
    scope,
    location: "broken",
    apply: () => {
      throw new Error("provider.reload failed")
    },
  })
  const healthy = createCatalogSync({ scope, location: "healthy", apply: (entries: any) => received.push(entries) })

  const result = await broken.publish(catalog(["auto", "fast"]))

  assert.deepEqual(result, { broadcast: true, delivered: 1, failed: 1 })
  assert.deepEqual(received, [catalog(["auto", "fast"])])
  broken.dispose()
  healthy.dispose()
})

test("a disposed location no longer receives or publishes catalogs", async () => {
  const scope = uniqueScope()
  const receivedLive: any[] = []
  const receivedGone: any[] = []
  const gone = createCatalogSync({ scope, location: "gone", apply: (entries: any) => receivedGone.push(entries) })
  const live = createCatalogSync({ scope, location: "live", apply: (entries: any) => receivedLive.push(entries) })

  gone.dispose()
  const result = await live.publish(catalog(["auto", "fast"]))
  const own = await gone.publish(catalog(["auto", "fast", "later"]))

  assert.deepEqual(result, { broadcast: true, delivered: 1, failed: 0 })
  assert.deepEqual(receivedLive, [catalog(["auto", "fast"])])
  assert.deepEqual(receivedGone, [])
  assert.deepEqual(own, { broadcast: false, delivered: 0, failed: 0 })

  live.dispose()
  await live.publish(catalog(["auto", "fast", "later"]))
  assert.deepEqual(receivedLive, [catalog(["auto", "fast"])])
})

test("a changed catalog is broadcast even after an unchanged publish", async () => {
  const scope = uniqueScope()
  const received: any[] = []
  const a = createCatalogSync({ scope, location: "a", apply: (entries: any) => received.push(entries) })

  await a.publish(catalog(["auto"]))
  await a.publish(catalog(["auto"]))
  const changed = await a.publish(catalog(["auto", "fast"]))

  assert.equal(changed.broadcast, true)
  assert.deepEqual(received, [catalog(["auto"]), catalog(["auto", "fast"])])
  a.dispose()
})

test("an empty catalog is rejected", () => {
  const scope = uniqueScope()
  const a = createCatalogSync({ scope, location: "a", apply: () => {} })

  assert.throws(() => a.publish([]), /empty Qoder model catalog/)
  a.dispose()
})

test("separately evaluated module copies share one process-wide registry", async () => {
  const moduleUrl = new URL("../src/catalog-sync.mjs", import.meta.url).href
  const copyOne = await import(`${moduleUrl}?module-instance=1`)
  const copyTwo = await import(`${moduleUrl}?module-instance=2`)
  const scope = uniqueScope()
  const received: string[] = []

  const one = copyOne.createCatalogSync({ scope, location: "one", apply: () => received.push("one") })
  const two = copyTwo.createCatalogSync({ scope, location: "two", apply: () => received.push("two") })
  const result = await one.publish(catalog(["auto"]))

  assert.deepEqual(result, { broadcast: true, delivered: 2, failed: 0 })
  assert.deepEqual(received.sort(), ["one", "two"])
  one.dispose()
  two.dispose()
})

test("catalogSignature distinguishes model ids and their order", () => {
  assert.equal(catalogSignature(catalog(["auto", "fast"])), catalogSignature(catalog(["auto", "fast"])))
  assert.notEqual(catalogSignature(catalog(["auto", "fast"])), catalogSignature(catalog(["fast", "auto"])))
})
