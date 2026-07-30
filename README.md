# 🔥 Cinema

Модуль-картотека «киностудии ГМа» для Foundry VTT (v13/v14). Объединяет пять
инструментов повествования в одном модуле; каждый открывается своей иконкой
из папки **🔥 Burn** (группа в Scene Controls, создаётся модулем
[BurnHub](https://github.com/BurnSIx-hub/burnhub)).

## Инструменты

- **Casting Call** (`casting/`) — раздача персонажей по сценам (бывший `casting-call`).
- **Narrator** (`narrator/`) — полноэкранный текст нарратора (бывший `narrator-text`).
- **Loading Screens** (`els/`) — эпичные загрузочные экраны (бывший `epic-loading-screens`).
- **Session Ratings** (`ratings/`) — «IMDB кампании»: оценки глав игроками (бывший `session-ratings`).
- **NPC Cards** (`npc/`) — карточки NPC с показом и раздачей игрокам (бывший `npc-cards`).

## Особенности слияния

Код прежних модулей перенесён в подпапки почти без изменений. Настройки миров
читаются под **старыми** namespace, поэтому данные существующих миров (оценки
глав, шаблоны карточек и т.д.) подхватываются без миграции. Socket-канал —
общий `module.burn-cinema` (сообщения различаются по типу).

## Роли

Часть инструментов доступна только ГМ (Narrator, Loading Screens), остальные
видят и игроки (Casting Call, Session Ratings, NPC Cards) — фильтрация по флагу
`gmOnly` в регистрации плиток.

## Установка

Сначала поставьте [BurnHub](https://github.com/BurnSIx-hub/burnhub) — без него
модуль не запустится (он объявлен как обязательная зависимость, а в официальном
каталоге пакетов Foundry его нет, поэтому автоматически он не подтянется):

```
https://github.com/BurnSIx-hub/burnhub/releases/latest/download/module.json
```

Затем сам модуль. В Foundry: *Add-on Modules → Install Module →* поле
**Manifest URL**:

```
https://github.com/BurnSIx-hub/burn-cinema/releases/latest/download/module.json
```

Такая установка даёт автообновление при следующих релизах.

Вручную: скачать `module.zip` из
[последнего релиза](https://github.com/BurnSIx-hub/burn-cinema/releases/latest)
и распаковать в `Data/modules/burn-cinema`.

## Лицензия

Код — MIT, см. [LICENSE](LICENSE). Встроенные шрифты (Alegreya, Caveat,
Pacifico) распространяются по SIL Open Font License 1.1 — см.
[NOTICE.md](NOTICE.md).

---
Автор: Vyazn & Claude
