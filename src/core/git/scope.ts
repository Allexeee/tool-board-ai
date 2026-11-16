import type { TaskScope } from '../validate.ts'

function normalize(pattern: string): string {
  return pattern
    .replace(/^:\(glob\)/, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

function segments(pattern: string): string[] {
  return normalize(pattern).split('/').filter(Boolean)
}

const isWildcard = (segment: string) => segment.includes('*')

function pairOverlap(a: string, b: string): boolean {
  const left = segments(a)
  const right = segments(b)
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index++) {
    const x = left[index]
    const y = right[index]
    if (x === y) continue
    if (isWildcard(x) || isWildcard(y)) continue
    return false
  }

  return true
}

export function scopesOverlap(a: TaskScope, b: TaskScope): boolean {
  if (a === 'exclusive' || b === 'exclusive') return true

  for (const left of a) {
    for (const right of b) {
      if (pairOverlap(left, right)) return true
    }
  }

  return false
}
