import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

test('package.json: MIT, автор и репозиторий', () => {
  const pkg = JSON.parse(read('package.json')) as {
    license?: string
    author?: string
    repository?: { url?: string }
  }
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.author && pkg.author.length > 0)
  assert.match(pkg.repository?.url ?? '', /tool-board-ai/)
  assert.match(read('LICENSE'), /MIT License/)
})

test('package-lock: версия совпадает с package.json', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string }
  const lock = JSON.parse(read('package-lock.json')) as {
    version: string
    packages: Record<string, { version?: string }>
  }
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages['']?.version, pkg.version)
})

test('CI гоняет тесты на Windows и Ubuntu', () => {
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /windows-latest/)
  assert.match(ci, /ubuntu-latest/)
  assert.match(ci, /npm test/)
  assert.match(ci, /typecheck/)
})
