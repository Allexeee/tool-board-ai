import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { applyUpgrade, planUpgrade } from '../../src/core/upgrade.ts'

const toolRoot = resolve('.')

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-up-'))
  initProject(dir)
  const dbPath = join(dir, '.toolbox-al/tracker.db')
  const db = openDb(dbPath)
  return { dir, db, dbPath, configPath: join(dir, '.toolbox-al/config.json') }
}

function sourceWith(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'al-src-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  return dir
}

test('без --yes ничего не меняется и копия не создаётся', () => {
  const { db, dbPath, configPath } = project()
  const before = readFileSync(configPath, 'utf8')

  const result = applyUpgrade(db, {
    dbPath,
    configPath,
    root: toolRoot,
    from: sourceWith('9.9.9'),
    yes: false,
  })

  assert.equal(result.applied, false)
  assert.equal(result.backup, undefined)
  assert.equal(readFileSync(configPath, 'utf8'), before)
})

test('с --yes создаётся копия базы и обновляется версия проекта', () => {
  const { db, dbPath, configPath } = project()

  const result = applyUpgrade(db, {
    dbPath,
    configPath,
    root: toolRoot,
    from: sourceWith('9.9.9'),
    yes: true,
  })

  assert.equal(result.applied, true)
  assert.ok(result.backup && existsSync(result.backup))

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { toolVersion: string; schemaVersion: number }
  assert.equal(config.toolVersion, '9.9.9')
  assert.equal(config.schemaVersion, result.plan.schemaTo)
})

test('схема из будущего отвергается', () => {
  const { db, dbPath, configPath } = project()
  db.prepare("update meta set value = '99' where key = 'schemaVersion'").run()

  assert.throws(() => planUpgrade(db, { root: toolRoot }), /новее/)
  assert.throws(
    () => applyUpgrade(db, { dbPath, configPath, root: toolRoot, yes: true }),
    /новее/,
  )
})

test('источник версий из каталога попадает в план', () => {
  const { db } = project()
  const plan = planUpgrade(db, { root: toolRoot, from: sourceWith('9.9.9') })

  assert.equal(plan.current.source, 'dir')
  assert.equal(plan.current.latest, '9.9.9')
  assert.equal(plan.outdated, true)
})
