import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpVersion } from '../../src/core/version.ts'

test('bump minor обновляет package.json, lock и CHANGELOG', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-bump-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.4.7' }, null, 2))
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'x', version: '1.4.7', packages: { '': { version: '1.4.7' } } }, null, 2),
  )
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## v1.4.7 — 25.11.2026\n\n- старое\n')

  const result = bumpVersion(dir, 'minor')
  assert.deepEqual(result, { from: '1.4.7', to: '1.5.0' })
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.5.0')
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
  assert.equal(lock.version, '1.5.0')
  assert.equal(lock.packages[''].version, '1.5.0')
  const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /## v1\.5\.0 — \d{2}\.\d{2}\.\d{4}/)
})

test('bump отвергает не-semver', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-bump-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.4' }))
  assert.throws(() => bumpVersion(dir, 'patch'), /semver/)
})
