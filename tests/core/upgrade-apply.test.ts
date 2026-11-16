import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { applyUpgrade, planUpgrade, toolRoot, toolVersion } from '../../src/core/upgrade.ts'

const toolRootPath = toolRoot

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
    projectRoot: toolRootPath,
    toolRoot: toolRootPath,
    from: sourceWith('99.0.0'),
    yes: false,
  })

  assert.equal(result.applied, false)
  assert.equal(result.backup, undefined)
  assert.equal(readFileSync(configPath, 'utf8'), before)
})

test('с --yes создаётся копия базы и обновляется закреплённая версия', () => {
  const { db, dbPath, configPath } = project()

  const result = applyUpgrade(db, {
    dbPath,
    configPath,
    projectRoot: toolRootPath,
    toolRoot: toolRootPath,
    from: sourceWith('99.0.0'),
    yes: true,
  })

  assert.equal(result.applied, true)
  assert.ok(result.backup && existsSync(result.backup))

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { toolVersion: string }
  assert.equal(config.toolVersion, '99.0.0')
})

test('схема из будущего отвергается', () => {
  const { db, dbPath, configPath } = project()
  db.prepare("update meta set value = '99' where key = 'schemaVersion'").run()

  assert.throws(() => planUpgrade(db, { toolRoot: toolRootPath, configPath }), /новее/)
  assert.throws(
    () =>
      applyUpgrade(db, { dbPath, configPath, projectRoot: toolRootPath, toolRoot: toolRootPath, yes: true }),
    /новее/,
  )
})

test('источник версий из каталога и закреплённая версия проекта', () => {
  const { db, configPath } = project()
  const plan = planUpgrade(db, { toolRoot: toolRootPath, configPath, from: sourceWith('99.0.0') })

  assert.equal(plan.current.source, 'dir')
  assert.equal(plan.current.latest, '99.0.0')
  assert.equal(plan.outdated, true)
})

test('версия проекта не подменяет версию инструмента', () => {
  const { dir, db, configPath } = project()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.1' }))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@e.x', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@e.x', '-c', 'user.name=T', 'tag', 'v5.0.0'], { cwd: dir })

  const plan = planUpgrade(db, { toolRoot: toolRootPath, configPath })

  assert.equal(plan.current.current, toolVersion(toolRootPath))
  assert.notEqual(plan.current.current, '0.0.1')
})

test('обновление не откатывает версию назад', () => {
  const { db, configPath } = project()
  const plan = planUpgrade(db, { toolRoot: toolRootPath, configPath, from: sourceWith('0.0.1') })

  assert.equal(plan.outdated, false)
  void resolve
})
