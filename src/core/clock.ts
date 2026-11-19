/** Время в базе — ISO-8601 UTC: строки сравниваются лексикографически. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

/**
 * Начало текущих суток по локальному времени, в ISO-8601 UTC: граница для
 * счётчика «сделано сегодня». «Сегодня» — локальная дата, поэтому порог
 * считается локальной полночью, а не UTC-полночью.
 */
export function todayStartIso(now: Date = new Date()): string {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.toISOString()
}
