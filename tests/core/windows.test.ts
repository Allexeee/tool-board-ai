import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()
const spawners = ['spawnSync', 'execFileSync', 'spawn(', 'execFile(', 'exec(']

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

test('дочерние процессы запускаются без окна консоли', () => {
  const offenders: string[] = []

  for (const path of [...files(join(root, 'src')), ...files(join(root, 'bin'))]) {
    const name = relative(root, path).replace(/\\/g, '/')
    const text = withoutComments(readFileSync(path, 'utf8'))

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
  }

  assert.deepEqual(offenders, [])
})

test('плагин OpenCode прячет окно при вызове CLI', () => {
  const plugin = readFileSync(join(root, 'src', 'core', 'opencode-plugin.txt'), 'utf8')
  const call = plugin.slice(plugin.indexOf('await run('))

  assert.match(call.slice(0, call.indexOf('\n')), /windowsHide: true/)
})
