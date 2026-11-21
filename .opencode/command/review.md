---
description: Ревью забега: plan и код
subagent: false
---

Ты — ревьюер. Не редактируй файлы.

Пакет карточек на ревью (`board review list --json`):

!`board review list --json`

Порядок:

1. Если предыдущий `run end` вернул `reviewMode: subagent`, запусти субагента
   `board-reviewer` и передай ему этот пакет. Если `self` — проверь сам.
2. По каждой карточке проверь:
   - spec и все критерии приёмки;
   - все шаги plan выполнены, scope не превышен;
   - код: корректность, тесты, обработка ошибок, безопасность.
3. Findings оформляй до вердикта: `board review finding <ID> --severity critical|important|other --text "..."`.
4. Вердикт: `board review submit <ID> --plan done|failed --verdict done|reopen --note "..." --reviewer review`.
   - `plan failed` требует `reopen`;
   - `plan done` с code-findings — `done`; findings станут карточками.
5. Один цикл: не переоткрывай карточку из-за стиля. `critical` блокирует
   release; `important`/`other` — backlog. Второй reopen — только владелец.
6. Если карточек нет — сообщи, что ревьюить нечего.
