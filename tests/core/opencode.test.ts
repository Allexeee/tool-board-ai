import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openCodeFilesPresent,
  pluginSource,
  pluginVersion,
  writeOpenCodeFiles,
} from '../../src/core/opencode.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { doctorReport } from '../../src/core/doctor.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'oc-'))

test('файлы создаются и не перезаписываются', () => {
  const root = tmp()
  const first = writeOpenCodeFiles(root)
  assert.ok(first.created.length >= 4)

  const second = writeOpenCodeFiles(root)
  assert.deepEqual(second.created, [])

  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.equal(agents.match(/toolbox-al:begin/g)!.length, 1)
})

test('существующий AGENTS.md сохраняется', () => {
  const root = tmp()
  writeFileSync(join(root, 'AGENTS.md'), '# Мой проект\n\nправила\n')
  writeOpenCodeFiles(root)
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.match(text, /Мой проект/)
  assert.match(text, /toolbox-al:begin/)
})

test('плагин объявляет инструменты и вызывает CLI', () => {
  const source = pluginSource('9.9.9')
  for (const name of ['now', 'inbox', 'task', 'take', 'done', 'block', 'ask', 'dispatch', 'review', 'accept', 'answer']) {
    assert.ok(source.includes(`name: '${name}'`), name)
  }
  assert.match(source, /toolbox-al\.ts/)
  assert.match(source, /tools.*toolbox-al.*bin.*toolbox-al\.ts/s)
  assert.match(source, /Plugin\.define/)
  assert.match(source, /9\.9\.9/)
})

test('скилл объясняет порядок и запрет на git', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode/skills/toolbox-al/SKILL.md'), 'utf8')
  assert.match(skill, /task show/)
  assert.match(skill, /не коммит/i)
  assert.match(skill, /dispatch/)
})

test('init создаёт файлы OpenCode', () => {
  const root = tmp()
  initProject(root)
  assert.deepEqual(openCodeFilesPresent(root), {
    plugin: true,
    skill: true,
    setupSkill: true,
    agentsBlock: true,
  })
  assert.equal(pluginVersion(root), '1.0.1')
})

test('doctor замечает отсутствие плагина', () => {
  const root = tmp()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  assert.equal(
    doctorReport(db, { root }).checks.find((check) => check.name === 'плагин OpenCode')!.ok,
    true,
  )

  const bare = tmp()
  const bareDb = openDb(':memory:')
  assert.equal(
    doctorReport(bareDb, { root: bare }).checks.find((check) => check.name === 'плагин OpenCode')!.ok,
    false,
  )
})
