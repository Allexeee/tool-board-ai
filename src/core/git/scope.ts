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

function segmentMatches(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (!pattern.includes('*') && !value.includes('*')) return false

  const toRegExp = (glob: string) =>
    new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')

  return toRegExp(pattern).test(value) || toRegExp(value).test(pattern)
}

function overlap(left: string[], i: number, right: string[], j: number): boolean {
  if (i === left.length && j === right.length) return true
  if (i === left.length) return right.slice(j).every((segment) => segment === '**')
  if (j === right.length) return left.slice(i).every((segment) => segment === '**')

  if (left[i] === '**') return overlap(left, i + 1, right, j) || overlap(left, i, right, j + 1)
  if (right[j] === '**') return overlap(left, i, right, j + 1) || overlap(left, i + 1, right, j)

  return segmentMatches(left[i], right[j]) && overlap(left, i + 1, right, j + 1)
}

function pairOverlap(a: string, b: string): boolean {
  return overlap(segments(a), 0, segments(b), 0)
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
