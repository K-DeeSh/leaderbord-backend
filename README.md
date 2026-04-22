# Vibecoding Games — Backend

Единый бекенд для сбора результатов трёх игр: **CTO Simulator**, **Last Mile Collapse**, **Nu Pogodi (Warehouse Catcher)**.

Node.js + Express + SQLite. Без внешних зависимостей — всё хранится локально в `data/scores.db`.

## Запуск

```bash
npm install
npm run dev   # режим разработки с авто-перезагрузкой
npm start     # без watch
```

Сервер запускается на `http://localhost:3001`.

## API

### Сессии (античит)

**`POST /api/session/start`**

Вызывается в начале каждой игры. Возвращает одноразовый токен, который нужно передать вместе со счётом.

```json
// Request
{ "game_id": "cto_simulator" }

// Response
{ "token": "8adf4850ca2bd80a..." }
```

### Результаты

**`POST /api/scores`**

Сохраняет результат игры. Поле `token` обязательно для попадания в лидерборд.

```json
{
  "game_id": "cto_simulator",
  "login": "player",
  "score": 650,
  "token": "8adf4850ca2bd80a...",

  // Опциональные поля (зависят от игры):
  "victory": true,
  "archetype": "Мастер игнора",
  "difficulty": "normal",
  "turns": 47,
  "duration_seconds": null,
  "metrics": { "health": 80, "morale": 60, "techDebt": 20, "money": 55, "reputation": 70 },
  "stats": { "ignoreCount": 30, "delegateCount": 17 }
}
```

Ответ: `{ "id": 42, "suspicious": false }`

**`GET /api/leaderboard/:gameId`**

Топ по одной игре. Показывает только честные результаты.

- `gameId`: `cto_simulator` | `last_mile_collapse` | `nu_pogodi`
- `?limit=10` — количество записей (макс. 100)
- `?all=1` — показать в том числе подозрительные (для отладки)

```json
[
  {
    "login": "player",
    "score": 650,
    "archetype": "Мастер игнора",
    "difficulty": "normal",
    "turns": 47,
    "victory": 1,
    "created_at": "2026-04-22 16:41:10"
  }
]
```

**`GET /api/leaderboard`**

Топ по всем трём играм сразу (JSON).

**`GET /leaderboard`**

HTML-страница с таблицами всех трёх игр. Открыть в браузере.

## Античит

Каждый результат проходит три проверки:

| Проверка | Что делает |
|---|---|
| **Токен** | Без сессионного токена — запись помечается как подозрительная |
| **Время** | Бекенд измеряет elapsed time сам. Минимум: 20с для CTO/Last Mile, 5с для Nu Pogodi |
| **Счёт** | Проверяется математический максимум: CTO ≤ 1000, Last Mile ≤ 250, Nu Pogodi ≤ elapsed×100 |

Подозрительные записи **сохраняются** в БД с полем `suspicious_reason` (`no_token`, `too_fast:3s`, `score_too_high` и т.д.), но **не показываются** в лидерборде.

## Структура

```
backend/
├── src/
│   ├── index.ts    # Express сервер, порт 3001
│   ├── routes.ts   # Все API endpoints + HTML лидерборд
│   └── db.ts       # Инициализация SQLite, миграции
├── data/
│   └── scores.db   # База данных (создаётся автоматически)
├── package.json
└── tsconfig.json
```

## Переменные окружения

| Переменная | Дефолт | Описание |
|---|---|---|
| `PORT` | `3001` | Порт сервера |
