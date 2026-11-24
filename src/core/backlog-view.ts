import type { BacklogData } from './backlog.ts'

/** Тёмная тема в духе панели OpenCode: фон, моноширинные ID, спокойные таблицы. */
const STYLE = `
:root {
  --bg: #0f0f10;
  --panel: #171718;
  --line: #26262a;
  --text: #e7e7e8;
  --muted: #8b8b90;
  --accent: #7aa2f7;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}
.wrap { max-width: 980px; margin: 0 auto; padding: 28px 24px 64px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
h1 { font-size: 26px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
.updated { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 22px; }
.hint code, td code { font-family: "SF Mono", Consolas, monospace; font-size: 12px; }
section { margin-top: 26px; }
h2 { font-size: 15px; font-weight: 600; margin: 0 0 10px; color: var(--text); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th { text-align: left; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 9px 14px; border-bottom: 1px solid var(--line); }
td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.id { font-family: "SF Mono", Consolas, monospace; font-size: 12px; color: var(--accent); white-space: nowrap; }
td.status { white-space: nowrap; }
td.note { color: var(--muted); }
.empty { color: var(--muted); }
`

const SCRIPT = `
const fmt = (iso) => {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
}

function table(headers, rows, cls) {
  if (rows.length === 0) return '<p class="empty">пусто</p>'
  const head = headers.map((h) => '<th>' + esc(h) + '</th>').join('')
  const body = rows.map((cells) => '<tr>' + cells.map((c, i) => '<td class="' + (cls[i] || '') + '">' + esc(c) + '</td>').join('') + '</tr>').join('')
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
}

function render(data) {
  const parts = ['<h1>Бэклог</h1><p class="hint">Живая сборка из <code>.board/board.db</code>. Обновляется сама.</p>']
  for (const section of data.skills) {
    parts.push('<section><h2>Задачи для ' + esc(section.label) + '</h2>' +
      table(['ID', 'Заголовок', 'Статус', 'Заметка'], section.rows.map((r) => [r.id, r.title, r.status, r.note]), ['id', '', 'status', 'note']) + '</section>')
  }
  if (data.skills.length === 0) parts.push('<p class="empty">Открытых карточек нет.</p>')
  if (data.deferred.length > 0) {
    parts.push('<section><h2>Отложенные</h2>' +
      table(['ID', 'Заголовок', 'Причина'], data.deferred.map((r) => [r.id, r.title, r.note]), ['id', '', 'note']) + '</section>')
  }
  if (data.done.length > 0) {
    parts.push('<section><h2>Готово за последние 12 часов</h2>' +
      table(['ID', 'Заголовок', 'Завершено'], data.done.map((r) => [r.id, r.title, fmt(r.doneAt)]), ['id', '', 'note']) + '</section>')
  }
  document.getElementById('content').innerHTML = parts.join('')
  document.getElementById('updated').textContent = 'обновлено ' + fmt(data.generatedAt)
  document.title = 'Бэклог'
}

async function tick() {
  try {
    const response = await fetch('/data.json', { cache: 'no-store' })
    if (response.ok) render(await response.json())
  } catch {}
}

tick()
setInterval(tick, 2000)
`

/** HTML страницы бэклога: контент перерисовывается опросом /data.json. */
export function renderBacklogHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Бэклог</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header><h1>Бэклог</h1><span class="updated" id="updated"></span></header>
<div id="content"></div>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`
}

export function backlogJson(data: BacklogData): string {
  return JSON.stringify(data)
}
