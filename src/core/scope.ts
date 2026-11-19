/**
 * Матчер области видимости карточки §7.2: путь входит в scope, если совпадает
 * хотя бы с одним glob-паттерном. Паттерны — пути репозитория с `/`;
 * `**` — любые сегменты, `*` — внутри сегмента, `?` — ровно один символ.
 * Паттерн без glob-символов совпадает с файлом или с любым файлом под
 * каталогом с таким именем.
 */

/** Обратные слэши, `./`, лишние и крайние слэши приводятся к чистому пути. */
function normalize(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

const GLOB = /[*?]/

/** Один сегмент паттерна: `*` не пересекает `/`, `?` — один символ. */
function segmentRegex(segment: string): string {
  return segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
}

/** Совпадает ли хвост пути `path[j..]` с хвостом паттерна `pattern[i..]`. */
function matchSegments(pattern: string[], i: number, path: string[], j: number): boolean {
  if (i === pattern.length) return j === path.length

  if (pattern[i] === '**') {
    return (
      matchSegments(pattern, i + 1, path, j) ||
      (j < path.length && matchSegments(pattern, i, path, j + 1))
    )
  }

  if (j === path.length) return false
  return (
    new RegExp(`^${segmentRegex(pattern[i])}$`).test(path[j]) &&
    matchSegments(pattern, i + 1, path, j + 1)
  )
}

function matches(path: string, pattern: string): boolean {
  if (!GLOB.test(pattern)) {
    return path === pattern || path.startsWith(`${pattern}/`)
  }
  return matchSegments(pattern.split('/'), 0, path.split('/'), 0)
}

export function scopeAllows(path: string, patterns: string[]): boolean {
  const normalized = normalize(path)
  return patterns.some((pattern) => {
    const cleaned = normalize(pattern)
    return cleaned !== '' && matches(normalized, cleaned)
  })
}
