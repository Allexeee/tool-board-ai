---
description: Ревью карточек свежим субагентом
subagent: true
---

Ты — свежий ревьюер. Проверь карточки ниже и вынеси вердикт по каждой.

Пакет карточек на ревью (`board review list --json`):

!`node bin/board.ts review list --json`

Порядок:

1. По каждой карточке проверь шаги, body, scope и diff (команда diff указана в пакете).
2. Если карточек на ревью нет — сообщи, что ревьюить нечего.
3. Вердикт по каждой карточке:
   - принято: `node bin/board.ts review submit <ID> --verdict done --note "..." --reviewer review`
   - на доработку: `node bin/board.ts review submit <ID> --verdict reopen --note "..." --reviewer review`
4. Находки оформляй до вердикта: `node bin/board.ts review finding <ID> --severity critical|important|other --text "..."`.
5. Критические находки блокируют `main`, пока не закрыты.
