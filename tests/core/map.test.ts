import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  MAP_FILE,
  buildMap,
  parseExports,
  parseImports,
  renderMap,
  resolveSpecifier,
  writeMap,
} from '../../src/core/map.ts'

const bin = resolve('bin/toolbox-al.ts')
const temp = () => mkdtempSync(join(tmpdir(), 'al-map-'))

function put(dir: string, path: string, text: string): void {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

function fixture(): string {
  const dir = temp()
  put(
    dir,
    'src/greet.ts',
    [
      'export interface Greeting { text: string }',
      'export function greet(name: string): Greeting {',
      "  return { text: 'привет, ' + name }",
      '}',
      'export const LIMIT = 3',
      '',
    ].join('\n'),
  )
  put(
    dir,
    'src/core/store.ts',
    [
      'import {',
      '  greet,',
      "} from '../greet.ts'",
      "import { readFileSync } from 'node:fs'",
      'export default class Store {',
      '  read(): string {',
      "    return greet('x').text + String(readFileSync('x'))",
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  put(dir, 'node_modules/lib/index.ts', 'export const hidden = 1\n')
  return dir
}

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('карта видит файлы, размер и экспортируемые имена', () => {
  const dir = fixture()
  const map = buildMap(dir)

  assert.deepEqual(map.files.map((file) => file.path), ['src/core/store.ts', 'src/greet.ts'])

  const greet = map.files.find((file) => file.path === 'src/greet.ts')!
  assert.equal(greet.size, statSync(join(dir, 'src/greet.ts')).size)
  assert.deepEqual(greet.exports, ['Greeting', 'greet', 'LIMIT'])

  const store = map.files.find((file) => file.path === 'src/core/store.ts')!
  assert.deepEqual(store.exports, ['Store'])
})

test('импорты связывают модули внутри карты, внешние пакеты отбрасываются', () => {
  const map = buildMap(fixture())

  const store = map.files.find((file) => file.path === 'src/core/store.ts')!
  assert.deepEqual(store.imports, ['src/greet.ts'])
  assert.equal(map.edges, 1)
  assert.equal(resolveSpecifier('src/core/store.ts', '../greet.ts'), 'src/greet.ts')
  assert.equal(resolveSpecifier('src/greet.ts', 'node:fs'), null)
})

test('многострочный импорт и реэкспорт дают одну связь', () => {
  const dir = temp()
  put(dir, 'src/a.ts', 'export const a = 1\nexport type T = string\n')
  put(
    dir,
    'src/b.ts',
    ["import {", '  a,', "} from './a.ts'", "export * from './a.ts'", 'export { a as renamed }', ''].join('\n'),
  )

  const map = buildMap(dir)
  const b = map.files.find((file) => file.path === 'src/b.ts')!
  assert.deepEqual(b.imports, ['src/a.ts'])
  assert.deepEqual(b.exports, ['renamed'])
  assert.equal(map.edges, 1)
})

test('импорт без from не съедает следующий импорт', () => {
  const dir = temp()
  put(dir, 'src/polyfill.ts', 'export {}\n')
  put(dir, 'src/main.ts', "import './polyfill.ts'\nimport { b } from './polyfill.ts'\n")

  const map = buildMap(dir)
  const main = map.files.find((file) => file.path === 'src/main.ts')!
  assert.deepEqual(main.imports, ['src/polyfill.ts'])
})

test('node_modules и .git не попадают в карту', () => {
  const dir = fixture()
  put(dir, '.git/hook.ts', 'export const hidden = 1\n')

  const paths = buildMap(dir).files.map((file) => file.path)
  assert.equal(paths.some((path) => path.startsWith('node_modules')), false)
  assert.equal(paths.some((path) => path.startsWith('.git')), false)
})

test('человеческий вывод печатает путь, размер, экспорт и импорт', () => {
  const text = renderMap(buildMap(fixture()))

  assert.match(text, /модулей: 2, связей: 1/)
  assert.match(text, /src\/greet\.ts\s+\d+(?:\.\d+)? (?:B|KB)/)
  assert.match(text, /экспорт: Greeting, greet, LIMIT/)
  assert.match(text, /импорт: src\/greet\.ts/)
})

test('--write создаёт docs/toolbox-al/map.md с таблицей модулей', () => {
  const dir = fixture()

  writeMap(buildMap(dir), join(dir, MAP_FILE))

  const path = join(dir, 'docs/toolbox-al/map.md')
  assert.ok(existsSync(path))
  const md = readFileSync(path, 'utf8')
  assert.match(md, /^# Карта репозитория/)
  assert.match(md, /\| `src\/greet\.ts` \| \d+(?:\.\d+)? (?:B|KB) \| Greeting, greet, LIMIT \|/)
  assert.match(md, /\| `src\/core\/store\.ts` \|[^\n]*\| `src\/greet\.ts` \|/)
})

test('map печатает карту, а map --write пишет файл и не печатает её целиком', () => {
  const dir = fixture()

  const shown = run(dir, ['map'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /src\/greet\.ts/)
  assert.match(shown.out, /экспорт: Greeting, greet, LIMIT/)
  assert.equal(existsSync(join(dir, MAP_FILE)), false)

  const written = run(dir, ['map', '--write'])
  assert.equal(written.code, 0)
  assert.match(written.out, /карта записана: docs\/toolbox-al\/map\.md \(модулей: 2, связей: 1\)/)
  assert.equal(existsSync(join(dir, MAP_FILE)), true)
})

test('map отвергает каталог вне проекта', () => {
  const dir = fixture()

  const result = run(dir, ['map', '..'])

  assert.equal(result.code, 3)
  assert.match(result.err, /путь вне проекта/)
})

test('parseExports понимает формы экспорта', () => {
  assert.deepEqual(parseExports('export default function boot() {}\n'), ['boot'])
  assert.deepEqual(parseExports('export default 42\n'), ['default'])
  assert.deepEqual(parseExports('const a = 1\nconst b = 2\nexport { a, b as c }\n'), ['a', 'c'])
  assert.deepEqual(parseExports('export type { A, B }\n'), ['A', 'B'])
  assert.deepEqual(parseExports('export * as utils from "./utils.ts"\n'), ['utils'])
  assert.deepEqual(parseImports('const x = await import("./lazy.ts")\n'), ['./lazy.ts'])
})
