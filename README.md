# AFK Bank — розгортання на Netlify

1. Залий папку в GitHub-репозиторій (drag-and-drop не підходить: функції мають npm-залежність).
2. Netlify → Add new site → Import from Git → обери репозиторій (налаштування візьмуться з netlify.toml).
3. У проєкті Netlify відкрий Extensions → **Netlify DB** (Neon) → Install/Enable. Це створить змінну NETLIFY_DATABASE_URL. Таблиці створюються автоматично при першому запиті.
4. (Необов'язково) Site configuration → Environment variables → `OWNER_NICK` = нік власника. Без неї власником стане перший зареєстрований акаунт.
5. Deploy. Локально: `npm i && npx netlify dev`.
