import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { createTask } from '../../src/core/tasks.ts'
import { addDecision } from '../../src/core/decisions.ts'
import { taskContext } from '../../src/core/context.ts'

const base = {
  title: 'Правка',
  dod: ['a'],
  size: 'XS' as const,
  skill: 'backend',
  class: 'quick' as const,
  scope: ['src/**'],
}

test('context раскрывает область в файлы с числом строк', () => {
  const db = openDb(':memory:')
  const task = createTask(db, { ...base })
  const root = mkdtempSync(join(tmpdir(), 'al-ctx-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'a\nb\nc')
  writeFileSync(join(root, 'README.md'), 'x')

  const context = taskContext(db, task, root)

  assert.deepEqual(context.files.map((file) => file.path), ['src/a.ts'])
  assert.equal(context.files[0].lines, 3)
})

test('context показывает решения по задаче', () => {
  const db = openDb(':memory:')
  const task = createTask(db, { ...base })
  const root = mkdtempSync(join(tmpdir(), 'al-ctx-dec-'))
  addDecision(db, { question: 'Как?', choice: 'Так', reason: 'r', subjectId: task.id, author: 'owner' })

  const context = taskContext(db, task, root)

  assert.equal(context.decisions.length, 1)
})

test('context предупреждает, когда область пуста', () => {
  const db = openDb(':memory:')
  const task = createTask(db, { ...base })
  const root = mkdtempSync(join(tmpdir(), 'al-ctx-empty-'))
  writeFileSync(join(root, 'README.md'), 'x')

  const context = taskContext(db, task, root)

  assert.equal(context.files.length, 0)
  assert.match(context.warnings.join('\n'), /не совпала/)
})

