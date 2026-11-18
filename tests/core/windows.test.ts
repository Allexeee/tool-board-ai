import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()
const spawners = ['spawnSync', 'execFileSync', 'spawn(', 'execFile(', 'exec(']

// себя страж не проверяет: в этом файле имена вызовов лежат строками
const SELF = 'tests/core/windows.test.ts'

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue
      files(path, out)
    } else if (/\.(ts|txt|md)$/.test(entry)) {
      out.push(path)
    }
  }
  return out
}

function callOptions(text: string, from: number): string {
  const open = text.indexOf('(', from)
  if (open === -1) return ''

  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Вызовы без `windowsHide` в куске кода: одна строка на каждый такой вызов. */
function spawnsWithoutHide(text: string, name: string): string[] {
  const offenders: string[] = []

  for (const spawner of spawners) {
    let at = text.indexOf(spawner)
    while (at !== -1) {
      const before = text[at - 1] ?? ''
      const isMember = before === '.'
      const line = text.slice(text.lastIndexOf('\n', at) + 1, at)
      const isDefinition = /^(function|const|let|var)\s*$/.test(line.slice(-12))
      const isImport = /\bimport\b/.test(line)
      if (!isMember && !isDefinition && !isImport) {
        const options = callOptions(text, at)
        if (options && !options.includes('windowsHide')) {
          offenders.push(`${name}: ${spawner} без windowsHide`)
        }
      }
      at = text.indexOf(spawner, at + 1)
    }
  }

  return offenders
}

/** Где живут запускающие процессы файлы: инструмент и его тесты. */
function scannedFiles(): string[] {
  return [
    ...files(join(root, 'src')),
    ...files(join(root, 'bin')),
    // тесты тоже запускают процессы десятками: окно мигает ровно от них
    ...files(join(root, 'tests')).filter((path) => {
      const name = relative(root, path).replace(/\\/g, '/')
      return name !== SELF
    }),
  ]
}

test('дочерние процессы запускаются без окна консоли', () => {
  const offenders = scannedFiles().flatMap((path) =>
    spawnsWithoutHide(
      withoutComments(readFileSync(path, 'utf8')),
      relative(root, path).replace(/\\/g, '/'),
    ),
  )

  assert.deepEqual(offenders, [])
})

test('страж видит вызов без windowsHide', () => {
  // защита от немого стража: если разбор сломается, тест выше станет пустым
  const offenders = spawnsWithoutHide(
    "const r = spawnSync('git', ['status'], { cwd: '.', encoding: 'utf8' })\n" +
      "execFileSync('git', ['add', '.'], { stdio: 'ignore' })\n" +
      "spawnSync('git', ['log'], { windowsHide: true })\n",
    'sample.ts',
  )

  assert.equal(offenders.length, 2)
  assert.match(offenders[0]!, /sample\.ts: spawnSync без windowsHide/)
  assert.match(offenders[1]!, /sample\.ts: execFileSync без windowsHide/)
})

test('плагин OpenCode прячет окно при вызове CLI', () => {
  const plugin = readFileSync(join(root, 'src', 'core', 'opencode-plugin.txt'), 'utf8')
  const call = plugin.slice(plugin.indexOf('await run('))

  assert.match(call.slice(0, call.indexOf('\n')), /windowsHide: true/)
})
