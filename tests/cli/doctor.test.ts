import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { doctorReport } from '../../src/core/doctor.ts'
import { writeOpenCodeFiles } from '../../src/core/opencode.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { ok, setJsonMode } from '../../src/cli/output.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { readConfig } from '../../src/core/config.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { runGit } from '../../src/core/git/git.ts'

test('doctor сообщает о незавершённой настройке', () => {
  const db = openDb(':memory:')
  const report = doctorReport(db)
  assert.ok(report.checks.some((check) => check.name === 'исполнители' && !check.ok))
})

test('doctor предупреждает об активной фиче без каталога', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  db.prepare("update features set status = 'active'").run()

  const report = doctorReport(db)
  assert.ok(report.checks.some((check) => check.name === 'каталоги фич назначены' && !check.ok))
})

test('проверки doctor называются по-разному и целостность базы в порядке', () => {
  const db = openDb(':memory:')
  const report = doctorReport(db)

  const names = report.checks.map((check) => check.name)
  assert.equal(new Set(names).size, names.length, 'имена проверок не повторяются')
  assert.ok(report.checks.some((check) => check.name === 'целостность базы' && check.ok))
})

test('doctor показывает каталог закрытой фичи', () => {
  const db = openDb(':memory:')
  const feature = addFeature(db, { name: 'A', rank: 1 })
  const dir = mkdtempSync(join(tmpdir(), 'al-doc-dir-'))
  db.prepare("update features set status = 'done', worktree = ? where id = ?").run(dir, feature.id)

  const report = doctorReport(db)
  const check = report.checks.find((item) => item.name === 'каталоги закрытых фич')
  assert.ok(check && !check.ok)
  assert.match(check.detail ?? '', new RegExp(feature.id))
})

test('doctor молчит, когда закрытые фичи прибраны', () => {
  const db = openDb(':memory:')
  const feature = addFeature(db, { name: 'A', rank: 1 })
  db.prepare("update features set status = 'done' where id = ?").run(feature.id)

  const report = doctorReport(db)
  const check = report.checks.find((item) => item.name === 'каталоги закрытых фич')
  assert.ok(check?.ok)
})

test('doctor показывает невлитую старую ветку закрытой фичи', () => {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))

  const feature = addFeature(db, { name: 'Оплата', rank: 1 })
  addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  const { worktree } = startFeature(db, { root, featureId: feature.id, config })
  writeFileSync(join(worktree, 'x.txt'), 'x')
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
  runGit(worktree, ['add', '-A'])
  runGit(worktree, ['commit', '-m', 'работа'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old })
  db.prepare("update features set status = 'done' where id = ?").run(feature.id)

  const report = doctorReport(db, { root })
  const check = report.checks.find((item) => item.name === 'ветки закрытых фич')
  assert.ok(check && !check.ok)
  assert.match(check.detail ?? '', /feat\/f1/)
})

test('doctor видит файлы, ждущие переноса', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-doc-new-'))
  writeOpenCodeFiles(dir)
  writeFileSync(join(dir, 'AGENTS.md.new'), 'черновик', 'utf8')

  const report = doctorReport(openDb(':memory:'), { root: dir })
  const check = report.checks.find((item) => item.name === 'обновление файлов')
  assert.ok(check && !check.ok)
})

test('--json печатает ровно один JSON-объект', () => {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    setJsonMode(true)
    ok({ a: 1 }, 'человеку')
  } finally {
    process.stdout.write = original
    setJsonMode(false)
  }

  const output = chunks.join('')
  assert.deepEqual(JSON.parse(output), { a: 1 })
  assert.equal(output.trim().split('\n').length, 1)
})


