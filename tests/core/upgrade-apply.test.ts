import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { applyUpgrade, planUpgrade, pruneBackups, toolRoot, toolVersion } from '../../src/core/upgrade.ts'

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
  const { dir, db, dbPath, configPath } = project()
  const before = readFileSync(configPath, 'utf8')

  const result = applyUpgrade(db, {
    dbPath,
    configPath,
    projectRoot: dir,
    toolRoot: toolRootPath,
    from: sourceWith('99.0.0'),
    yes: false,
  })

  assert.equal(result.applied, false)
  assert.equal(result.backup, undefined)
  assert.equal(readFileSync(configPath, 'utf8'), before)
})

test('--from не закрепляет версию, которой нет на диске', () => {
  const { dir, db, dbPath, configPath } = project()

  const result = applyUpgrade(db, {
    dbPath,
    configPath,
    projectRoot: dir,
    toolRoot: toolRootPath,
    from: sourceWith('99.0.0'),
    yes: true,
  })

  assert.equal(result.applied, true)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { toolVersion: string }
  assert.equal(config.toolVersion, toolVersion(toolRootPath))
  assert.notEqual(config.toolVersion, '99.0.0')

  const plugin = readFileSync(join(dir, '.opencode/plugins/toolbox-al/index.ts'), 'utf8')
  assert.match(plugin, new RegExp(`toolbox-al-plugin-version: ${toolVersion(toolRootPath)}`))
})

test('с --yes создаётся копия базы и обновляется закреплённая версия', () => {
  const { dir, db, dbPath, configPath } = project()

  const result = applyUpgrade(db, {
    dbPath,
    configPath,
    projectRoot: dir,
    toolRoot: toolRootPath,
    from: sourceWith('99.0.0'),
    yes: true,
  })

  assert.equal(result.applied, true)
  assert.ok(result.backup && existsSync(result.backup))

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { toolVersion: string }
  assert.equal(config.toolVersion, toolVersion(toolRootPath))
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

test('копии базы не копятся: остаются пять последних', () => {
  const { dbPath } = project()
  const dir = dirname(dbPath)

  for (let i = 1; i <= 6; i++) {
    writeFileSync(`${dbPath}.backup-2026-01-0${i}T00-00-00-000Z`, `старая ${i}`)
  }

  const removed = pruneBackups(dbPath)

  assert.equal(removed.length, 1)
  assert.equal(existsSync(`${dbPath}.backup-2026-01-01T00-00-00-000Z`), false)
  const left = readdirSync(dir).filter((file) => file.startsWith('tracker.db.backup-'))
  assert.equal(left.length, 5)
})

test('после обновления свежая копия на месте и журнал на неё ссылается', () => {
  const { dir, db, dbPath, configPath } = project()

  const result = applyUpgrade(db, {
    dbPath,
    configPath,
    projectRoot: dir,
    toolRoot: toolRootPath,
    from: sourceWith('99.0.0'),
    yes: true,
  })

  assert.ok(result.backup && existsSync(result.backup))
  const journals = readdirSync(join(dir, '.toolbox-al/upgrades'))
  assert.equal(journals.length, 1)
  assert.match(readFileSync(join(dir, '.toolbox-al/upgrades', journals[0]), 'utf8'), /backup-/)
})


