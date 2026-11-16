import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkVersions, versionsFromDirectory, writeUpgradeJournal } from '../../src/core/upgrade.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'al-ver-'))

test('версия из package.json каталога', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }))
  assert.deepEqual(versionsFromDirectory(dir), ['2.0.0'])
})

test('манифест с версиями сортируется по убыванию', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ versions: ['1.2.0', '1.10.0', '1.3.0'] }))
  assert.deepEqual(versionsFromDirectory(dir), ['1.10.0', '1.3.0', '1.2.0'])
})

test('пустой каталог даёт пустой список', () => {
  assert.deepEqual(versionsFromDirectory(tmp()), [])
})

test('checkVersions берёт каталог, когда указан from', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '3.1.0' }))

  const result = checkVersions(tmp(), { from: dir })
  assert.equal(result.source, 'dir')
  assert.equal(result.latest, '3.1.0')
  assert.deepEqual(result.available, ['3.1.0'])
})

test('checkVersions без git-тегов возвращает пустой источник', () => {
  const result = checkVersions(tmp())
  assert.equal(result.source, 'none')
  assert.equal(result.latest, null)
})

test('журнал обновления записывает версии, схему и копию базы', () => {
  const root = mkdtempSync(join(tmpdir(), 'al-journal-'))
  const file = writeUpgradeJournal(root, {
    from: '1.0.0',
    to: '1.1.0',
    schemaFrom: 3,
    schemaTo: 4,
    backup: 'tracker.db.backup-x',
    files: ['src/core/upgrade.ts'],
    now: new Date('2026-11-17T10:00:00Z'),
  })

  const text = readFileSync(file, 'utf8')
  assert.match(text, /1\.0\.0 → 1\.1\.0/)
  assert.match(text, /3 → 4/)
  assert.match(text, /tracker\.db\.backup-x/)
  assert.match(file, /upgrades/)
})
