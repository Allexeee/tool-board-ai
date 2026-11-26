import test from 'node:test'
import assert from 'node:assert/strict'
import { getCard, resolveCardId } from '../../src/core/cards.ts'
import { listGroups, renameGroup } from '../../src/core/groups.ts'
import { addRef, listRefs } from '../../src/core/refs.ts'
import { addStep, listSteps } from '../../src/core/steps.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

test('renameGroup: переносит карточки, шаги и ссылки, сохраняет legacy', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const seo = seedCard(board.db, { group: 'SEO', title: 'SEO', status: 'ready' })
  seedCard(board.db, { group: 'SITE', title: 'SITE', status: 'ready' })
  addStep(board.db, { cardId: seo.id, text: 'шаг', actor: 'owner' })
  addRef(board.db, {
    cardId: seo.id,
    kind: 'link',
    value: 'https://example.com',
    actor: 'owner',
  })

  const result = renameGroup(board.db, {
    old: 'SEO',
    next: 'SITE',
    merge: true,
    actor: 'owner',
  })
  assert.deepEqual(result.cards, [{ from: 'SEO-1', to: 'SITE-2' }])

  const moved = getCard(board.db, 'SITE-2')!
  assert.deepEqual(moved.legacyIds, ['SEO-1'])
  assert.equal(listSteps(board.db, 'SITE-2').length, 1)
  assert.equal(listRefs(board.db, 'SITE-2').length, 1)
  assert.equal(resolveCardId(board.db, 'SEO-1'), 'SITE-2')
  assert.deepEqual(
    listGroups(board.db).map((group) => [group.prefix, group.count]),
    [['SITE', 2]],
  )
})

test('renameGroup: карточку в работе переименовать нельзя', (t) => {
  const board = makeBoard()
  t.after(board.close)
  seedCard(board.db, { group: 'SEO', status: 'in_progress' })

  assert.throws(
    () => renameGroup(board.db, { old: 'SEO', next: 'SITE', actor: 'owner' }),
    /в работе/,
  )
})
