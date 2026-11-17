import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, migrate } from '../../src/core/db.ts'
import { SCHEMA_VERSION } from '../../src/core/schema.ts'
import { addFeature, getFeature, setFeatureCheck } from '../../src/core/features.ts'

test('миграция v3 добавляет ветку, worktree, merged_at и релизы', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), SCHEMA_VERSION)

  const featureColumns = (db.prepare('pragma table_info(features)').all() as Array<{ name: string }>).map((c) => c.name)
  assert.ok(featureColumns.includes('branch'))
  assert.ok(featureColumns.includes('worktree'))
  assert.ok(featureColumns.includes('check_cmd'))

  const stageColumns = (db.prepare('pragma table_info(stages)').all() as Array<{ name: string }>).map((c) => c.name)
  assert.ok(stageColumns.includes('merged_at'))

  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map(
    (r) => r.name,
  )
  assert.ok(tables.includes('releases'))
})

test('check фичи сохраняется', () => {
  const db = openDb(':memory:')
  const feature = addFeature(db, { name: 'A', rank: 1 })
  setFeatureCheck(db, feature.id, 'npm test')
  assert.equal(getFeature(db, feature.id)!.checkCmd, 'npm test')
})
