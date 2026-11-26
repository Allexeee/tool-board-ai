import type { BacklogData, BacklogRow } from './backlog.ts'

/** Тёмная тема в духе панели OpenCode: Inter рядом с HTML, моноширинные ID, спокойные таблицы. */
const STYLE = `
@font-face {
  font-family: "Inter";
  src: url("Inter.ttf") format("truetype");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
:root {
  --bg: #0f0f10;
  --panel: #171718;
  --line: #26262a;
  --text: #e7e7e8;
  --muted: #8b8b90;
  --accent: #7aa2f7;
}
* { box-sizing: border-box; }
html { zoom: 0.8; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 "Inter", -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}
.wrap { max-width: 1440px; margin: 0 auto; padding: 32px 28px 72px; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
h1 { font-size: 30px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
.meta { display: flex; align-items: center; gap: 14px; }
.updated { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.refresh {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 14px;
  cursor: pointer;
}
.refresh:hover { border-color: var(--accent); color: var(--accent); }
.refresh:active { transform: translateY(1px); }
.hint { color: var(--muted); font-size: 13px; margin: 6px 0 24px; }
.hint code { font-family: "IBM Plex Mono", "SF Mono", Consolas, monospace; font-size: 13px; }
section { margin-top: 28px; }
h2 { font-size: 20px; font-weight: 600; margin: 0 0 10px; color: var(--text); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 16px; }
th { text-align: left; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 10px 16px; border-bottom: 1px solid var(--line); }
td { padding: 12px 16px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.id { font-family: "IBM Plex Mono", "SF Mono", Consolas, monospace; font-size: 20px; color: var(--text); white-space: nowrap; }
td.status { white-space: nowrap; }
td.note { color: var(--muted); }
td.reason { color: var(--muted); width: 28ch; }
td.reason .clamp2 { max-width: 28ch; }
.clamp2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.empty { color: var(--muted); }
.deferred details > summary {
  cursor: pointer;
  list-style: none;
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 10px;
  color: var(--text);
}
.deferred details > summary::-webkit-details-marker { display: none; }
.deferred details > summary::before {
  content: "▸";
  display: inline-block;
  width: 1.2em;
  color: var(--muted);
}
.deferred details[open] > summary::before { content: "▾"; }
.deferred details > summary:hover { color: var(--accent); }
.deferred details:not([open]) > table { display: none; }
tr.status-new { --row: #7dd3fc; }
tr.status-shaping { --row: #7dd3fc; }
tr.status-approval { --row: #f59e0b; }
tr.status-waiting { --row: #94a3b8; }
tr.status-ready { --row: #34d399; }
tr.status-booked { --row: #34d399; }
tr.status-in_progress { --row: #60a5fa; }
tr.status-review { --row: #a78bfa; }
tr.status-acceptance { --row: #fb923c; }
tr.status-blocked { --row: #f87171; }
tr.status-deferred { --row: #6b7280; }
tr.status-done { --row: #16a34a; }
tr.status-idea { --row: #2dd4bf; }
tr[class*="status-"] td { background: color-mix(in srgb, var(--row) 7%, var(--panel)); }
tr[class*="status-"] td:first-child { box-shadow: inset 3px 0 0 var(--row); }
`

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }
    return map[ch]
  })
}

function fmt(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function table(headers: string[], rows: string[][], classes: string[] = []): string {
  if (rows.length === 0) return '<p class="empty">пусто</p>'
  const head = headers.map((header) => `<th>${esc(header)}</th>`).join('')
  const body = rows
    .map((cells, index) => {
      const cls = classes[index] ? ` class="${classes[index]}"` : ''
      return `<tr${cls}>${cells.join('')}</tr>`
    })
    .join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function rowsFor(rows: BacklogRow[]): string[][] {
  return rows.map((item) => [
    `<td class="id">${esc(item.id)}</td>`,
    `<td>${esc(item.title)}</td>`,
    `<td class="status">${esc(item.status)}</td>`,
    `<td class="note">${esc(item.note)}</td>`,
  ])
}

/** Самодостаточный HTML-снимок бэклога. refreshSeconds > 0 — страница сама подтягивает изменения. */
export function renderBacklogPage(data: BacklogData, refreshSeconds = 5): string {
  const auto = refreshSeconds > 0
  const scripts =
    `<script>
(function () {
  var scrollKey = 'board-backlog-scroll'
  var deferredKey = 'board-deferred-open'
  var revisionMeta = document.querySelector('meta[name="board-revision"]')
  var revision = revisionMeta ? revisionMeta.content : ''
  var busy = false

  function saveScroll() {
    try { sessionStorage.setItem(scrollKey, String(window.scrollY)) } catch (e) {}
  }
  function restoreScroll() {
    try {
      var y = sessionStorage.getItem(scrollKey)
      if (y !== null) window.scrollTo(0, Number(y))
    } catch (e) {}
  }
  function bindDeferred() {
    var details = document.getElementById('deferred')
    if (!details) return
    try { if (sessionStorage.getItem(deferredKey) === '1') details.open = true } catch (e) {}
    details.addEventListener('toggle', function () {
      try { sessionStorage.setItem(deferredKey, details.open ? '1' : '0') } catch (e) {}
    })
  }
  function apply(html, force) {
    var doc = new DOMParser().parseFromString(html, 'text/html')
    var nextMeta = doc.querySelector('meta[name="board-revision"]')
    var nextRevision = nextMeta ? nextMeta.content : ''
    if (!force && nextRevision === revision) return false

    var nextWrap = doc.querySelector('.wrap')
    var currentWrap = document.querySelector('.wrap')
    if (!nextWrap || !currentWrap) return false

    saveScroll()
    var wasOpen = false
    var currentDetails = document.getElementById('deferred')
    if (currentDetails) wasOpen = currentDetails.open

    currentWrap.replaceWith(document.importNode(nextWrap, true))
    revision = nextRevision
    if (revisionMeta) revisionMeta.content = nextRevision
    bindDeferred()
    var nextDetails = document.getElementById('deferred')
    if (nextDetails && wasOpen) nextDetails.open = true
    restoreScroll()
    return true
  }
  function refresh(force) {
    if (busy) return
    busy = true
    fetch(location.href, { cache: 'no-store' })
      .then(function (response) { return response.text() })
      .then(function (html) { apply(html, force === true) })
      .catch(function () { if (force === true) location.reload() })
      .then(function () { busy = false })
  }

  window.boardReload = function () { saveScroll(); refresh(true) }
  window.boardRefresh = refresh
  window.addEventListener('scroll', saveScroll, { passive: true })
  window.addEventListener('pagehide', saveScroll)
  restoreScroll()
  bindDeferred()
})()
</script>` +
    (auto
      ? `<script>
setInterval(function () {
  if (document.visibilityState !== 'visible') return
  window.boardRefresh()
}, ${Math.round(refreshSeconds) * 1000})
</script>`
      : '')
  const parts: string[] = []
  for (const section of data.skills) {
    parts.push(
      `<section><h2>Задачи для ${esc(section.label)}</h2>` +
        table(
          ['ID', 'Заголовок', 'Статус', 'Заметка'],
          rowsFor(section.rows),
          section.rows.map((item) => `status-${item.statusKey}`),
        ) +
        '</section>',
    )
  }
  if (data.skills.length === 0) parts.push('<p class="empty">Открытых карточек нет.</p>')

  if (data.deferred.length > 0) {
    const rows = data.deferred.map((item) => [
      `<td class="id">${esc(item.id)}</td>`,
      `<td>${esc(item.title)}</td>`,
      `<td class="note reason"><div class="clamp2">${esc(item.reason ?? item.note)}</div></td>`,
    ])
    parts.push(
      `<section class="deferred"><details id="deferred"><summary>Отложенные (${data.deferred.length})</summary>${table(
        ['ID', 'Заголовок', 'Причина'],
        rows,
        data.deferred.map(() => 'status-deferred'),
      )}</details></section>`,
    )
  }

  if (data.done.length > 0) {
    const rows = data.done.map((item) => [
      `<td class="id">${esc(item.id)}</td>`,
      `<td>${esc(item.title)}</td>`,
      `<td class="note">${fmt(item.doneAt)}</td>`,
    ])
    parts.push(
      `<section><h2>Готово за последние 12 часов</h2>${table(
        ['ID', 'Заголовок', 'Завершено'],
        rows,
        data.done.map(() => 'status-done'),
      )}</section>`,
    )
  }

  if (data.ideas.length > 0) {
    const rows = data.ideas.map((item) => [
      `<td class="id">${esc(item.id)}</td>`,
      `<td class="idea-text"><div class="clamp2">${esc(item.title)}</div></td>`,
      `<td class="note">${fmt(item.updatedAt)}</td>`,
    ])
    parts.push(
      `<section><h2>Идеи</h2>${table(
        ['ID', 'Идея', 'Изменено'],
        rows,
        data.ideas.map(() => 'status-idea'),
      )}</section>`,
    )
  }

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="board-revision" content="${esc(data.generatedAt)}">
<title>Бэклог</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Бэклог</h1>
  <div class="meta">
    <span class="updated">обновлено ${fmt(data.generatedAt)} · ${
      auto ? `авто ${Math.round(refreshSeconds)} с` : 'F5'
    }</span>
    <button class="refresh" type="button" onclick="boardReload()">Обновить</button>
  </div>
</header>
<p class="hint">Собрано из <code>.board/board.db</code>. Доска пересобирает файл после каждой команды. ${
    auto ? 'Страница обновляется сама' : 'Обновить вручную'
  } — кнопка «Обновить»${auto ? '' : ' или F5'}.</p>
${parts.join('\n')}
</div>
${scripts}
</body>
</html>
`
}
