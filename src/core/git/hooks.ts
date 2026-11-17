import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = '# toolbox-al: protect branches'
const LEGACY = '# toolbox-al: protect main and dev'
const BEGIN = '# toolbox-al:begin'
const END = '# toolbox-al:end'

function script(protectedBranches: string[]): string {
  const list = ['', ...protectedBranches, ''].join(' ')
  return `#!/bin/sh
${MARKER}
${BEGIN}
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
case "${list}" in
  *" $branch "*)
    if [ "$AL_ALLOW" != "1" ]; then
      echo "коммит в защищённую ветку $branch запрещён: делайте это через toolbox-al" >&2
      exit 1
    fi
    ;;
esac
exit 0
${END}
`
}

function blockOf(text: string): string | null {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin === -1 || end === -1 || end < begin) return null
  return text.slice(begin, end + END.length)
}

function writeHook(target: string, body: string): void {
  writeFileSync(target, body, { mode: 0o755 })
  try {
    chmodSync(target, 0o755)
  } catch {
    // на Windows права не важны
  }
}

export function installHooks(
  gitDir: string,
  options: { protectedBranches: string[] },
): { installed: string[] } {
  const hooksDir = join(gitDir, 'hooks')
  const body = script(options.protectedBranches)
  const installed: string[] = []

  for (const name of ['pre-commit', 'pre-merge-commit']) {
    const target = join(hooksDir, name)

    if (!existsSync(target)) {
      writeHook(target, body)
      installed.push(name)
      continue
    }

    const current = readFileSync(target, 'utf8')

    // наш блок переписываем целиком: список веток мог измениться
    const block = blockOf(current)
    if (block !== null && current.includes(MARKER)) {
      const nextBody = blockOf(body) ?? body
      const next = current.replace(block, nextBody)
      if (next !== current) writeHook(target, next)
      continue
    }

    if (current.includes(MARKER)) {
      // старый формат без маркеров: не трогаем чужой хук
      continue
    }

    writeHook(target, current.trimEnd() + '\n\n' + body.replace(/^#!.*\n/, ''))
    installed.push(name)
  }

  return { installed }
}

export type HookStatus = 'current' | 'legacy' | 'missing'

export function hookStatus(gitDir: string): HookStatus {
  const targets = ['pre-commit', 'pre-merge-commit'].map((name) => join(gitDir, 'hooks', name))
  const texts = targets.filter((target) => existsSync(target)).map((target) => readFileSync(target, 'utf8'))
  if (texts.some((text) => text.includes(LEGACY)) && !texts.every((text) => text.includes(MARKER))) return 'legacy'
  return texts.length === 2 && texts.every((text) => text.includes(MARKER)) ? 'current' : 'missing'
}

export function hookInstalled(gitDir: string): boolean {
  const targets = ['pre-commit', 'pre-merge-commit'].map((name) => join(gitDir, 'hooks', name))
  return targets.every((target) => existsSync(target) && readFileSync(target, 'utf8').includes(MARKER))
}

