import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', input })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-ideas-'))
  run(dir, ['init'])
  return dir
}

test('idea edit меняет текст, realize убирает из списка', () => {
  const dir = project()
  run(dir, ['idea', 'add', 'Старое'])

  const edited = run(dir, ['idea', 'edit', 'I1', '--text', 'Новое'])
  assert.equal(edited.code, 0, edited.err)
  assert.match(edited.out, /Новое/)

  const realized = run(dir, ['idea', 'realize', 'I1'])
  assert.equal(realized.code, 0, realized.err)

  const list = run(dir, ['idea', 'list'])
  assert.doesNotMatch(list.out, /Новое/)

  const all = run(dir, ['idea', 'list', '--all'])
  assert.match(all.out, /Новое/)
})

test('idea remove удаляет свободную и отказывает продвинутой', () => {
  const dir = project()
  run(dir, ['idea', 'add', 'Свободная'])
  run(dir, ['idea', 'add', 'В работу'])

  const removed = run(dir, ['idea', 'remove', 'I1'])
  assert.equal(removed.code, 0, removed.err)

  run(dir, ['idea', 'promote', 'I2'])
  const denied = run(dir, ['idea', 'remove', 'I2'])
  assert.notEqual(denied.code, 0)
  assert.match(denied.err, /запрос/)
})

test('text-file не вытесняет текст молча и не принимается чужими командами', () => {
  const dir = project()
  writeFileSync(join(dir, 'idea.txt'), 'из файла', 'utf8')

  const displaced = run(dir, ['idea', 'add', 'из аргумента', '--text-file', 'idea.txt'])
  assert.equal(displaced.code, 0, displaced.err)
  assert.match(displaced.err, /позиционный текст проигнорирован/)
  assert.match(displaced.out, /из файла/)

  const foreign = run(dir, ['task', 'add', 'Задача', '--text-file', 'idea.txt'])
  assert.notEqual(foreign.code, 0)
  assert.match(foreign.err, /не принимается командой task/)
})

test('idea add и edit читают текст из файла в UTF-8', () => {
  const dir = project()
  writeFileSync(join(dir, 'idea.txt'), 'Длинная идея\nв две строки', 'utf8')

  const added = run(dir, ['idea', 'add', '--text-file', 'idea.txt'])
  assert.equal(added.code, 0, added.err)
  assert.match(added.out, /Длинная идея\nв две строки/)

  writeFileSync(join(dir, 'edit.txt'), 'Правка из файла', 'utf8')
  const edited = run(dir, ['idea', 'edit', 'I1', '--text-file', 'edit.txt'])
  assert.equal(edited.code, 0, edited.err)
  assert.match(edited.out, /Правка из файла/)
})

test('idea add --text-file - читает stdin', () => {
  const dir = project()

  const added = run(dir, ['idea', 'add', '--text-file', '-'], 'Идея из stdin')
  assert.equal(added.code, 0, added.err)
  assert.match(added.out, /Идея из stdin/)
})

test('пустой файл и пустой stdin — ошибка, а не пустая идея', () => {
  const dir = project()
  writeFileSync(join(dir, 'empty.txt'), '  \n', 'utf8')

  const fromFile = run(dir, ['idea', 'add', '--text-file', 'empty.txt'])
  assert.notEqual(fromFile.code, 0)
  assert.match(fromFile.err, /пуст/)

  const fromStdin = run(dir, ['idea', 'add', '--text-file', '-'], '')
  assert.notEqual(fromStdin.code, 0)
  assert.match(fromStdin.err, /пуст/)

  const list = run(dir, ['idea', 'list'])
  assert.match(list.out, /идей нет/)
})

test('idea --text-file важнее --text и говорит об этом', () => {
  const dir = project()
  writeFileSync(join(dir, 'idea.txt'), 'Из файла', 'utf8')

  const added = run(dir, ['idea', 'add', '--text', 'Из строки', '--text-file', 'idea.txt'])
  assert.equal(added.code, 0, added.err)
  assert.match(added.out, /Из файла/)
  assert.doesNotMatch(added.out, /Из строки/)
  assert.match(added.err, /--text/)
})
