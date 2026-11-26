import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectWhatsNew,
  markAnnouncedVersion,
  readAnnouncedVersion,
  readVersionNotes,
  whatsNewLines,
} from '../../src/core/whats-new.ts'

function notesDir(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'board-whats-new-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'notes')
  mkdirSync(dir, { recursive: true })
  return dir
}

test('readVersionNotes: только пункты списка, без заголовка', (t) => {
  const dir = notesDir(t)
  writeFileSync(
    join(dir, '1.6.0.md'),
    '# v1.6.0\n\n- Первое.\n* Второе.  \n- Третье.\n\nТехнический текст.\n',
  )
  assert.deepEqual(readVersionNotes('1.6.0', dir), ['Первое.', 'Второе.', 'Третье.'])
  assert.deepEqual(readVersionNotes('9.9.9', dir), [])
})

test('collectWhatsNew: только релизы в диапазоне (from, to]', (t) => {
  const dir = notesDir(t)
  writeFileSync(join(dir, '1.4.0.md'), '- Старое.\n')
  writeFileSync(join(dir, '1.5.0.md'), '- Пятёрка.\n')
  writeFileSync(join(dir, '1.6.0.md'), '- Шестёрка.\n- Ещё пункт.\n')
  writeFileSync(join(dir, '1.7.0.md'), '- Будущее.\n')

  const data = collectWhatsNew('1.4.0', '1.6.0', dir)
  assert.deepEqual(
    data.whatsNew.map((entry) => entry.version),
    ['1.5.0', '1.6.0'],
  )
  assert.equal(data.whatsNew[1].points.length, 2)

  const install = collectWhatsNew(null, '1.6.0', dir)
  assert.deepEqual(
    install.whatsNew.map((entry) => entry.version),
    ['1.4.0', '1.5.0', '1.6.0'],
  )
})

test('collectWhatsNew: неизвестная версия и пустой диапазон не обещают лишнего', (t) => {
  const dir = notesDir(t)
  writeFileSync(join(dir, '1.6.0.md'), '- Шестёрка.\n')

  assert.deepEqual(collectWhatsNew('1.5.0', null, dir).whatsNew, [])
  assert.deepEqual(collectWhatsNew('1.6.0', '1.6.0', dir).whatsNew, [])
})

test('whatsNewLines: человеческий блок и понятное сообщение об отсутствии изменений', () => {
  assert.deepEqual(whatsNewLines({ from: '1.5.0', to: '1.6.0', whatsNew: [] }), [
    'Что нового: изменений нет.',
  ])

  const lines = whatsNewLines({
    from: '1.5.0',
    to: '1.6.0',
    whatsNew: [
      { version: '1.5.0', points: ['Старое.'] },
      { version: '1.6.0', points: ['Новое.'] },
    ],
  })
  assert.equal(lines[0], 'Что нового для вас (1.5.0 → 1.6.0):')
  assert.ok(lines.includes('v1.6.0'))
  assert.ok(lines.includes('  • Новое.'))
  assert.ok(!lines.join('\n').includes('CLI'))
})

test('markAnnouncedVersion: отметка переживает повторное чтение и мусор', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-announced-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(readAnnouncedVersion(root), null)
  markAnnouncedVersion(root, '1.6.0')
  assert.equal(readAnnouncedVersion(root), '1.6.0')
  assert.match(readFileSync(join(root, '.board', 'whats-new.json'), 'utf8'), /1\.6\.0/)

  markAnnouncedVersion(root, 'не версия')
  assert.equal(readAnnouncedVersion(root), '1.6.0')
})

test('npm-пакет включает docs/whats-new', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { files: string[] }
  assert.ok(pkg.files.includes('docs/whats-new'), 'файлы пакета без заметок')
})
