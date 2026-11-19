/** Время в базе — ISO-8601 UTC: строки сравниваются лексикографически. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

/** Начало текущих суток в UTC: граница для счётчика «сделано сегодня». */
export function todayStartIso(now: Date = new Date()): string {
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  return start.toISOString()
}
