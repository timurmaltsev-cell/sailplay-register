# Регистрация клиентов в SailPlay

Минимальная страница регистрации + Node.js-прокси к API SailPlay.

## Что внутри

- `register.html` — фронт-страница с формой (ФИО, телефон, email, согласие на ПДн).
- `server.js` — крошечный Node.js (Express) сервер. Принимает POST с фронта, дополняет его токеном и `store_department_id` и шлёт запрос в SailPlay.
- `package.json` — зависимости.

> **Важно про безопасность.** API SailPlay использует серверный токен. Класть его в JS на странице нельзя — кто угодно подсмотрит в DevTools и сможет регистрировать кого угодно. Поэтому фронт ходит на ваш backend, а backend — в SailPlay.

## Запуск

Зависимостей нет — сервер использует только встроенные модули Node 18+.

```bash
export SAILPLAY_TOKEN=...                       # ваш токен из ЛК SailPlay
export SAILPLAY_STORE_DEPARTMENT_ID=14864       # ID партнёрского отдела
node server.js
```

Откройте http://localhost:3000/register.html

В Windows PowerShell:
```powershell
$env:SAILPLAY_TOKEN="..."
$env:SAILPLAY_STORE_DEPARTMENT_ID="14864"
node server.js
```

## Эндпойнт SailPlay

Сервер шлёт `POST https://api.sailplay.net/api/v2/users/add/` со следующими полями:

| Поле | Откуда |
|---|---|
| `token` | env `SAILPLAY_TOKEN` |
| `store_department_id` | env `SAILPLAY_STORE_DEPARTMENT_ID` |
| `user_phone` | из формы, нормализуется к `7XXXXXXXXXX` |
| `email` | из формы |
| `first_name`, `last_name` | из формы |

Дополнительные опциональные поля API: `middle_name`, `birth_date` (`YYYY-MM-DD`), `sex` (`1` — мужской, `2` — женский, `3` — иной), `origin_user_id`, `register_date`. Если нужно — добавьте поля в форму и пробросьте в `server.js`.

## Обработка ошибок

Фронт распознаёт типовые коды SailPlay и показывает понятное сообщение:

- `-5100` — пользователь уже существует
- `-5102` — номер телефона уже используется
- `-5103` — email уже используется

Прочие ошибки показываются с текстом из `message` API.

## Источники

- Официальная документация: <https://docs.retailrocket.net/docs/sailplay/clients/basics/>
- Reference: <https://ru.sailplay.dev/reference/users-add>
