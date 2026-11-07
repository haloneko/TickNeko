import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTEXT_MENU_EXIT_MS, deferMenuRemoval } from '../src/features/workflow/editor/menuMotion.ts'

test('closing retains the menu until the exit animation has finished', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let removed = 0
  deferMenuRemoval(() => removed++, false)
  t.mock.timers.tick(CONTEXT_MENU_EXIT_MS)
  assert.equal(removed, 0)
  t.mock.timers.tick(32)
  assert.equal(removed, 1)
})

test('reopening cancels the old removal instead of closing the new menu', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let removed = 0
  const cancel = deferMenuRemoval(() => removed++, false)
  t.mock.timers.tick(50)
  cancel()
  t.mock.timers.tick(1000)
  assert.equal(removed, 0)
  deferMenuRemoval(() => removed++, false)
  t.mock.timers.tick(CONTEXT_MENU_EXIT_MS + 32)
  assert.equal(removed, 1)
})

test('reduced motion removes immediately and schedules no trailing callback', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let removed = 0
  const cancel = deferMenuRemoval(() => removed++, true)
  assert.equal(removed, 1)
  cancel()
  t.mock.timers.tick(1000)
  assert.equal(removed, 1)
})
