import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createVariableParams,
  draftValue,
  parseValue,
  listPayload,
  dictPayload,
  listToJsonText,
  listFromJson,
  dictToJsonText,
  dictFromJson,
} from '../src/features/variables/variableEdits.ts'

test('JSON drafts retain false, zero, null and nested values', () => {
  for (const value of [false, 0, null, [false, 0], { nested: null }]) {
    assert.deepEqual(parseValue(draftValue(value)), value)
  }
  assert.equal(parseValue(draftValue('false')), 'false')
  assert.equal(parseValue(draftValue('')), '')
})

test('list full save preserves order, duplicates, types and explicit clearing', () => {
  assert.deepEqual(listPayload(['a', 'a', '', false, 0, null].map(draftValue)), {
    items: ['a', 'a', '', false, 0, null],
  })
  assert.deepEqual(listPayload([]), { items: [] })
})

test('dict full save omits removed fields and rejects duplicates', () => {
  const fields = [
    { field: 'keep', value: draftValue(false) },
    { field: '__proto__', value: draftValue(0) },
  ]
  const payload = dictPayload(fields)
  assert.deepEqual(Object.keys(payload.fields), ['keep', '__proto__'])
  assert.equal(payload.fields.__proto__, 0)
  assert.deepEqual(dictPayload([]), { fields: {} })
  assert.throws(() => dictPayload([fields[0], fields[0]]), /字段名重复/)
  assert.throws(() => dictPayload([{ field: '', value: draftValue('') }]), /字段名不能为空/)
})

test('invalid JSON fails before forming a request', () => {
  const bad = { text: '{oops', format: 'json' }
  assert.throws(() => listPayload([bad]), /JSON 格式不正确/)
  assert.throws(() => dictPayload([{ field: 'x', value: bad }]), /JSON 格式不正确/)
})

test('overflowing JSON numbers are rejected before transport can turn them into null', () => {
  assert.throws(() => parseValue({ text: '1e400', format: 'json' }), /有限值/)
  assert.throws(() => parseValue({ text: '{"value":1e400}', format: 'json' }), /有限值/)
})

test('list form ⇄ JSON roundtrip keeps types, order and duplicates', () => {
  const items = ['a', '', false, 0, null, [1, 2], { k: 'v' }].map(draftValue)
  const items2 = listFromJson(listToJsonText(items)).map(draftValue)
  assert.deepEqual(items2, items)
  // 空列表往返也是合法的
  assert.deepEqual(listFromJson(listToJsonText([])), [])
})

test('dict form ⇄ JSON roundtrip keeps types and field names', () => {
  const fields = [
    { field: 'keep', value: draftValue('x') },
    { field: 'n', value: draftValue(0) },
    { field: 'flag', value: draftValue(false) },
    { field: 'nested', value: draftValue({ deep: [1, null] }) },
  ]
  const fields2 = Object.entries(dictFromJson(dictToJsonText(fields))).map(([field, value]) => ({
    field,
    value: draftValue(value),
  }))
  assert.deepEqual(fields2, fields)
  assert.deepEqual(dictFromJson(dictToJsonText([])), {})
})

test('JSON view rejects wrong collection types before a request', () => {
  assert.throws(() => listFromJson('{"a":1}'), /必须是数组/)
  assert.throws(() => dictFromJson('[1,2]'), /必须是对象/)
  assert.throws(() => dictFromJson('null'), /必须是对象/)
  assert.throws(() => listFromJson('{oops'), /JSON 格式不正确/)
})

test('new-variable params carry identity and type, one shape per scope', () => {
  // 账号级：省略归属（后端按当前登录用户填），字段名与后端 query 参数一致
  assert.deepEqual(
    [...createVariableParams({ scope: 'account', key: '日签', typeId: 'dict' })],
    [
      ['scope', 'account'],
      ['key', '日签'],
      ['type_id', 'dict'],
    ],
  )
  // 账号级给了归属就带上（管理员替人建时用得上），且不带图 id
  const owned = createVariableParams({ scope: 'account', key: 'k', typeId: 'str', ownerId: 'u-1' })
  assert.equal(owned.get('owner_id'), 'u-1')
  assert.equal(owned.get('workflow_id'), null)
  // 图级：认图不认归属；缺图 id 也照发（后端 422），绝不悄悄换成 owner_id
  assert.deepEqual(
    [...createVariableParams({ scope: 'graph', key: '计数', typeId: 'json', workflowId: 'g-1' })],
    [
      ['scope', 'graph'],
      ['key', '计数'],
      ['type_id', 'json'],
      ['workflow_id', 'g-1'],
    ],
  )
  const noGraph = createVariableParams({ scope: 'graph', key: '计数', typeId: 'json' })
  assert.equal(noGraph.get('workflow_id'), '')
  assert.equal(noGraph.get('owner_id'), null)
})
