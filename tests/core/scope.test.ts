import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeAllows } from '../../src/core/scope.ts'

test('scopeAllows: базовые glob-паттерны', () => {
  assert.equal(scopeAllows('src/a.ts', ['src/**']), true)
  assert.equal(scopeAllows('src\\a.ts', ['src/**']), true)
  assert.equal(scopeAllows('content/a.md', ['src/**']), false)
  assert.equal(scopeAllows('docs/a.md', ['**/*.md']), true)
  assert.equal(scopeAllows('src/deep/a.ts', ['src/*']), false)
})

test('scopeAllows: каталог без glob совпадает с файлом и префиксом каталога', () => {
  assert.equal(scopeAllows('src', ['src']), true)
  assert.equal(scopeAllows('src/deep/a.ts', ['src']), true)
  assert.equal(scopeAllows('srcx/a.ts', ['src']), false)
})

test('scopeAllows: * внутри сегмента и ? один символ', () => {
  assert.equal(scopeAllows('src/a.ts', ['src/*.ts']), true)
  assert.equal(scopeAllows('src/a1.ts', ['src/a?.ts']), true)
  assert.equal(scopeAllows('src/a.ts', ['src/a?.ts']), false)
  assert.equal(scopeAllows('src/deep/a.ts', ['src/**/a.ts']), true)
  assert.equal(scopeAllows('a/b/c/x.md', ['**/x.md']), true)
})

test('scopeAllows: нормализует ./ и пустой scope ничего не разрешает', () => {
  assert.equal(scopeAllows('./src/a.ts', ['src/**']), true)
  assert.equal(scopeAllows('src/a.ts', ['./src/**']), true)
  assert.equal(scopeAllows('src/a.ts', []), false)
})
