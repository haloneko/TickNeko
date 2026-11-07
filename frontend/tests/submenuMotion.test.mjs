import assert from 'node:assert/strict'
import { test } from 'node:test'
import { placeSubmenu } from '../src/features/workflow/editor/submenuMotion.ts'

const viewport = { width: 1280, height: 720 }
const main = { left: 300, right: 484, top: 150, bottom: 496 }
const row = { left: 305, right: 479, top: 195, bottom: 227 }

test('opens alongside the hovered row using actual content dimensions', () => {
  assert.deepEqual(placeSubmenu(row, main, { width: 208, height: 93 }, viewport),
    { left: 488, top: 191, width: 208, height: 93, side: 'right' })
})

test('switching between short and long groups changes the shared frame target', () => {
  const small = placeSubmenu(row, main, { width: 176, height: 42 }, viewport)
  const large = placeSubmenu({ ...row, top: 400, bottom: 432 }, main,
    { width: 230, height: 289 }, viewport)
  assert.equal(small.left, large.left)
  assert.equal(large.width, 230)
  assert.equal(large.height, 289)
  assert.equal(large.top, 396)
})

test('flips left at the right edge and opens upward near the bottom', () => {
  const result = placeSubmenu({ left: 1093, right: 1267, top: 650, bottom: 682 },
    { left: 1088, right: 1272, top: 350, bottom: 700 }, { width: 176, height: 289 }, viewport)
  assert.equal(result.side, 'left')
  assert.equal(result.left, 908)
  assert.equal(result.top, 397)
  assert.ok(result.left >= 8 && result.top >= 8)
  assert.ok(result.left + result.width <= viewport.width - 8)
  assert.ok(result.top + result.height <= viewport.height - 8)
})

test('very long labels and large groups stay within a narrow viewport', () => {
  const screen = { width: 360, height: 300 }
  const result = placeSubmenu({ left: 90, right: 265, top: 220, bottom: 252 },
    { left: 85, right: 269, top: 10, bottom: 290 }, { width: 900, height: 1200 }, screen)
  assert.equal(result.width, 344)
  assert.equal(result.height, 284)
  assert.equal(result.left, 8)
  assert.equal(result.top, 8)
})
