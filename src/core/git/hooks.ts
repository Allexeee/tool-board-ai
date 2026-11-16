import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = '# toolbox-al: protect main and dev'

function script(protectedBranches: string[]): string {
  const list = ['', ...protectedBranches, ''].join(' ')
  return `#!/bin/sh
${MARKER}
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
case "${list}" in
  *" $branch "*)
    if [ "$AL_ALLOW" != "1" ]; then
      echo "коммит в защищённую ветку $branch запрещён: слияние делает toolbox-al" >&2
      exit 1
    fi
    ;;
esac
exit 0
`
}

export function installHooks(
  gitDir: string,
  options: { protectedBranches: string[] },
): { installed: string[] } {
  const hooksDir = join(gitDir, 'hooks')
  const target = join(hooksDir, 'pre-commit')
  const body = script(options.protectedBranches)

  if (!existsSync(target)) {
    writeFileSync(target, body, { mode: 0o755 })
    try {
      chmodSync(target, 0o755)
    } catch {
      // на Windows права не нужны
    }
    return { installed: ['pre-commit'] }
  }

  const current = readFileSync(target, 'utf8')
  if (current.includes(MARKER)) return { installed: [] }

  writeFileSync(target, current.trimEnd() + '\n\n' + body.replace(/^#!.*\n/, ''), 'utf8')
  return { installed: ['pre-commit'] }
}

export function hookInstalled(gitDir: string): boolean {
  const target = join(gitDir, 'hooks', 'pre-commit')
  return existsSync(target) && readFileSync(target, 'utf8').includes(MARKER)
}
