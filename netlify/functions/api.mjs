// AFK Bank — безпечна економічна гра для Netlify Functions.
// Усі зміни балансу, перекази, покупки та кулдауни перевіряються на сервері.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import D from './data.json' with { type: 'json' };

const DAILY = 50_000;
const MAX_BALANCE_ACTION = 2_000_000_000;
const PW_MIN = 6;
const NICK_MAX = 16;
const SESSION_DAYS = 30;
const FOCUS_MS = 30_000;
const FOCUS_COOLDOWN_HOURS = 2;
const LV = [20,40,60,80,100,120,150,200,250,300,350,450,550,650,800,1000,1200,1400,1600];

class E extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const J = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const level = xp => 1 + LV.filter(value => xp >= value).length;
const multiplier = xp => 2 ** (level(xp) - 1);
const int = (value, min, max, message) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new E(message);
  return n;
};
const isAdmin = role => role === 'owner' || role === 'admin';
const AVATAR_RE = /^(p\d{1,2}|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+)$/;

// Keep compatibility with existing Netlify DB (NETLIFY_DATABASE_URL),
// while supporting the current Netlify Database package (NETLIFY_DB_URL).
let sql;
let databaseKind = '';
let initPromise;
async function getSql() {
  if (sql) return sql;

  if (process.env.NETLIFY_DATABASE_URL) {
    const { neon } = await import('@netlify/neon');
    sql = neon();
    databaseKind = 'legacy-netlify-db';
    return sql;
  }

  if (process.env.NETLIFY_DB_URL || process.env.NETLIFY) {
    const { getDatabase } = await import('@netlify/database');
    const database = getDatabase();
    sql = database.sql.bind(database);
    databaseKind = 'netlify-database';
    return sql;
  }

  if (process.env.DATABASE_URL) {
    const { neon } = await import('@netlify/neon');
    sql = neon(process.env.DATABASE_URL);
    databaseKind = 'postgres-connection-string';
    return sql;
  }

  throw new E('Базу даних не налаштовано. У Netlify відкрий Data & Storage → Database та створи або підключи базу даних.', 503);
}

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const q = await getSql();
    await q`CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      nick text NOT NULL,
      nick_lc text UNIQUE NOT NULL,
      avatar text NOT NULL DEFAULT 'p0',
      salt text NOT NULL,
      pw text NOT NULL,
      role text NOT NULL DEFAULT 'user',
      bal bigint NOT NULL DEFAULT 0,
      ok int NOT NULL DEFAULT 0,
      daily_at timestamptz,
      stam boolean NOT NULL DEFAULT false,
      car text,
      house text,
      biz text,
      focus_at timestamptz,
      focus_end timestamptz,
      created timestamptz NOT NULL DEFAULT now()
    )`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS focus_at timestamptz`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS focus_end timestamptz`;

    await q`CREATE TABLE IF NOT EXISTS sessions (
      h text PRIMARY KEY,
      user_id int NOT NULL,
      created timestamptz NOT NULL DEFAULT now(),
      expires timestamptz
    )`;
    await q`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires timestamptz`;
    await q`UPDATE sessions SET expires = created + (${SESSION_DAYS} * interval '1 day') WHERE expires IS NULL`;
    await q`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)`;
    await q`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires)`;

    // Retain these legacy tables so accounts created by the previous version
    // keep their data. New gameplay no longer uses paid random cases.
    await q`CREATE TABLE IF NOT EXISTS inv (
      user_id int NOT NULL,
      key text NOT NULL,
      qty int NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, key)
    )`;
    await q`CREATE TABLE IF NOT EXISTS cars (
      id serial PRIMARY KEY,
      user_id int NOT NULL,
      name text NOT NULL,
      value int NOT NULL,
      jackpot boolean NOT NULL DEFAULT false
    )`;
    await q`CREATE TABLE IF NOT EXISTS alog (
      id serial PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT now(),
      admin text NOT NULL,
      text text NOT NULL
    )`;
    await q`CREATE INDEX IF NOT EXISTS cars_user_id_idx ON cars(user_id)`;
    await q`CREATE INDEX IF NOT EXISTS alog_created_idx ON alog(id DESC)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner_idx ON users(role) WHERE role = 'owner'`;
  })().catch(error => {
    initPromise = undefined;
    throw error;
  });
  return initPromise;
}

async function getMe(id) {
  const q = await getSql();
  const [u] = await q`SELECT
    id, nick, avatar, role, bal, ok, stam, car, house, biz,
    GREATEST(0, EXTRACT(EPOCH FROM (daily_at + interval '24 hours' - now())) * 1000)::float8 AS c_daily,
    GREATEST(0, EXTRACT(EPOCH FROM (focus_at + interval '2 hours' - now())) * 1000)::float8 AS c_focus,
    GREATEST(0, EXTRACT(EPOCH FROM (focus_end - now())) * 1000)::float8 AS focus_run,
    (focus_end IS NOT NULL AND focus_end <= now()) AS focus_pending
    FROM users WHERE id = ${id}`;
  if (!u) throw new E('Акаунт не знайдено. Увійди знову.', 401);
  const ownedCars = await q`SELECT id, name, value FROM cars WHERE user_id = ${id} ORDER BY id`;
  const xp = Number(u.ok);
  return {
    nick: u.nick,
    avatar: u.avatar,
    role: u.role,
    bal: Number(u.bal),
    ok: xp,
    level: level(xp),
    mult: multiplier(xp),
    stam: Boolean(u.stam),
    car: u.car,
    house: u.house,
    biz: u.biz,
    cars: ownedCars.map(car => ({ id: car.id, name: car.name, value: Number(car.value) })),
    cd: {
      daily: u.stam ? 0 : Number(u.c_daily || 0),
      focus: u.stam ? 0 : Number(u.c_focus || 0),
      run: Number(u.focus_run || 0),
      pending: Boolean(u.focus_pending)
    }
  };
}

async function auth(payload) {
  if (!payload.tk) throw new E('Потрібен вхід', 401);
  const q = await getSql();
  const [session] = await q`SELECT user_id FROM sessions WHERE h = ${hash(payload.tk)} AND expires > now()`;
  if (!session) throw new E('Сесія завершилася. Увійди знову.', 401);
  return session.user_id;
}

async function createSession(userId) {
  const q = await getSql();
  const token = randomBytes(32).toString('hex');
  await q`INSERT INTO sessions(h, user_id, expires) VALUES(${hash(token)}, ${userId}, now() + interval '30 days')`;
  return token;
}

const passwordHash = (password, salt) => scryptSync(password, salt, 32).toString('hex');

const CAR_CATALOG = (Array.isArray(D.cars) ? D.cars : []).map(car => ({
  name: String(car.name),
  value: Number(car.value)
})).filter(car => car.name && Number.isSafeInteger(car.value) && car.value > 0);

const PublicActions = {
  async register(payload) {
    const q = await getSql();
    const nick = String(payload.nick || '').trim();
    const password = String(payload.pw || '');
    const avatar = String(payload.avatar || 'p0');

    if (nick.length < 2 || nick.length > NICK_MAX) throw new E(`Нік має містити 2–${NICK_MAX} символів`);
    if (!/^[\p{L}\p{N}_.\- ]+$/u.test(nick)) throw new E('Нік може містити літери, цифри, пробіл, _ . -');
    if (password.length < PW_MIN || password.length > 72) throw new E(`Пароль має містити від ${PW_MIN} до 72 символів`);
    if (!AVATAR_RE.test(avatar) || avatar.length > 60_000) throw new E('Недійсна аватарка');

    const nickLc = nick.toLocaleLowerCase('uk-UA');
    const [existingNick] = await q`SELECT id FROM users WHERE nick_lc = ${nickLc}`;
    if (existingNick) throw new E('Цей нік уже зайнятий', 409);

    const [ownerRow] = await q`SELECT id FROM users WHERE role = 'owner' LIMIT 1`;
    const configuredOwner = String(process.env.OWNER_NICK || '').trim().toLocaleLowerCase('uk-UA');
    const shouldBeOwner = configuredOwner ? nickLc === configuredOwner : !ownerRow;
    const role = shouldBeOwner ? 'owner' : 'user';
    const salt = randomBytes(16).toString('hex');
    let inserted;

    try {
      inserted = await q`INSERT INTO users(nick, nick_lc, avatar, salt, pw, role)
        VALUES(${nick}, ${nickLc}, ${avatar}, ${salt}, ${passwordHash(password, salt)}, ${role})
        RETURNING id`;
    } catch (error) {
      if (error?.code === '23505') {
        const [duplicate] = await q`SELECT id FROM users WHERE nick_lc = ${nickLc}`;
        if (duplicate) throw new E('Цей нік уже зайнятий', 409);
        // Two people may register at once before an owner exists.
        if (shouldBeOwner && !configuredOwner) {
          inserted = await q`INSERT INTO users(nick, nick_lc, avatar, salt, pw, role)
            VALUES(${nick}, ${nickLc}, ${avatar}, ${salt}, ${passwordHash(password, salt)}, 'user') RETURNING id`;
        } else {
          throw new E('Не вдалося призначити власника. Перевір OWNER_NICK у Netlify.', 409);
        }
      } else {
        throw error;
      }
    }

    const userId = inserted[0].id;
    return { tk: await createSession(userId), me: await getMe(userId) };
  },

  async login(payload) {
    const q = await getSql();
    const nickLc = String(payload.nick || '').trim().toLocaleLowerCase('uk-UA');
    const password = String(payload.pw || '');
    const [user] = await q`SELECT id, salt, pw FROM users WHERE nick_lc = ${nickLc}`;
    let valid = false;
    if (user && password.length <= 72) {
      const candidate = Buffer.from(passwordHash(password, user.salt), 'hex');
      const stored = Buffer.from(user.pw, 'hex');
      valid = candidate.length === stored.length && timingSafeEqual(candidate, stored);
    }
    if (!valid) throw new E('Невірний нік або пароль', 401);
    return { tk: await createSession(user.id), me: await getMe(user.id) };
  }
};

const Actions = {
  async me(userId) { return { me: await getMe(userId) }; },

  async logout(userId, payload) {
    const q = await getSql();
    await q`DELETE FROM sessions WHERE h = ${hash(payload.tk)}`;
    return {};
  },

  async daily(userId) {
    const q = await getSql();
    const current = await getMe(userId);
    const reward = DAILY * current.mult;
    const updated = await q`UPDATE users SET
      bal = bal + ${reward},
      ok = ok + ${current.role === 'owner' || current.role === 'admin' ? 0 : 1},
      daily_at = now()
      WHERE id = ${userId}
        AND (stam OR daily_at IS NULL OR daily_at <= now() - interval '24 hours')
      RETURNING id`;
    if (!updated.length) throw new E('⏳ Щоденний бонус ще недоступний');
    return { reward, me: await getMe(userId) };
  },

  async focusStart(userId) {
    const q = await getSql();
    const started = await q`UPDATE users SET focus_end = now() + interval '30 seconds'
      WHERE id = ${userId}
        AND focus_end IS NULL
        AND (stam OR focus_at IS NULL OR focus_at <= now() - interval '2 hours')
      RETURNING id`;
    if (!started.length) throw new E('⏳ Фокус-сесія ще недоступна або попередню не завершено');
    return { me: await getMe(userId) };
  },

  async focusClaim(userId) {
    const q = await getSql();
    const claimed = await q`UPDATE users SET
      focus_at = now(), focus_end = NULL, ok = ok + 5
      WHERE id = ${userId} AND focus_end IS NOT NULL AND focus_end <= now()
      RETURNING id`;
    if (!claimed.length) throw new E('Фокус-сесія ще триває');
    return { points: 5, me: await getMe(userId) };
  },

  async buyCar(userId, payload) {
    const q = await getSql();
    const name = String(payload.name || '');
    const vehicle = CAR_CATALOG.find(car => car.name === name);
    if (!vehicle) throw new E('Автомобіль не знайдено в каталозі');
    const [alreadyOwned] = await q`SELECT id FROM cars WHERE user_id = ${userId} AND name = ${vehicle.name} LIMIT 1`;
    if (alreadyOwned) throw new E('Цей автомобіль уже є у твоєму гаражі');
    const inserted = await q`WITH payment AS (
      UPDATE users SET bal = bal - ${vehicle.value}
      WHERE id = ${userId} AND bal >= ${vehicle.value}
      RETURNING id
    )
    INSERT INTO cars(user_id, name, value, jackpot)
      SELECT id, ${vehicle.name}, ${vehicle.value}, false FROM payment
      RETURNING id`;
    if (!inserted.length) throw new E('❌ Недостатньо грошей для покупки');
    return { me: await getMe(userId) };
  },

  async selectCar(userId, payload) {
    const q = await getSql();
    const id = int(payload.id, 1, 2_000_000_000, 'Автомобіль не знайдено');
    const updated = await q`UPDATE users SET car = cars.name
      FROM cars WHERE cars.id = ${id} AND cars.user_id = ${userId} AND users.id = ${userId}
      RETURNING users.id`;
    if (!updated.length) throw new E('Автомобіль не знайдено у твоєму інвентарі');
    return { me: await getMe(userId) };
  },

  async buy(userId, payload) {
    const q = await getSql();
    const kind = payload.w === 'house' ? 'house' : payload.w === 'biz' ? 'biz' : '';
    if (!kind) throw new E('Невідомий тип покупки');
    const catalog = kind === 'house' ? D.houses : D.biz;
    const item = catalog.find(row => row[0] === payload.n);
    if (!item) throw new E('Об’єкт не знайдено');
    const [, price] = item;
    const column = kind === 'house' ? 'house' : 'biz';
    // Column names are selected only from the fixed allow-list above.
    const result = column === 'house'
      ? await q`UPDATE users SET bal = bal - ${price}, house = ${item[0]} WHERE id = ${userId} AND bal >= ${price} RETURNING id`
      : await q`UPDATE users SET bal = bal - ${price}, biz = ${item[0]} WHERE id = ${userId} AND bal >= ${price} RETURNING id`;
    if (!result.length) throw new E('❌ Недостатньо грошей');
    return { me: await getMe(userId) };
  },

  async pay(userId, payload) {
    const q = await getSql();
    const amount = int(payload.amt, 1, MAX_BALANCE_ACTION, 'Сума має бути цілим числом від 1 до 2 000 000 000');
    const to = String(payload.to || '').trim().toLocaleLowerCase('uk-UA');
    const result = await q`WITH recipient AS (
      SELECT id FROM users WHERE nick_lc = ${to} AND id <> ${userId}
    ), sender AS (
      UPDATE users SET bal = bal - ${amount}
      WHERE id = ${userId} AND bal >= ${amount} AND EXISTS (SELECT 1 FROM recipient)
      RETURNING id
    ), receiver AS (
      UPDATE users SET bal = bal + ${amount}
      WHERE id = (SELECT id FROM recipient) AND EXISTS (SELECT 1 FROM sender)
      RETURNING id
    ) SELECT count(*)::int AS sent FROM sender`;
    if (!result[0]?.sent) throw new E('❌ Не вдалося: перевір нік отримувача та свій баланс');
    const [sender] = await q`SELECT role FROM users WHERE id = ${userId}`;
    if (!isAdmin(sender?.role)) await q`UPDATE users SET ok = ok + 1 WHERE id = ${userId}`;
    return { me: await getMe(userId) };
  },

  async top() {
    const q = await getSql();
    const rows = await q`SELECT nick, avatar, bal FROM users ORDER BY bal DESC, id ASC LIMIT 3`;
    return { top: rows.map(row => ({ nick: row.nick, avatar: row.avatar, bal: Number(row.bal) })) };
  },

  async admin(userId, payload) {
    const q = await getSql();
    const [actor] = await q`SELECT nick, role FROM users WHERE id = ${userId}`;
    if (!actor || !isAdmin(actor.role)) throw new E('🔒 Лише для адміністраторів', 403);
    if (payload.op === 'log') {
      const log = await q`SELECT at, admin, text FROM alog ORDER BY id DESC LIMIT 20`;
      return { log };
    }

    const targetNick = String(payload.nick || '').trim().toLocaleLowerCase('uk-UA');
    const [target] = await q`SELECT id, nick, role FROM users WHERE nick_lc = ${targetNick}`;
    if (!target) throw new E('Гравця не знайдено');
    if (target.role === 'owner' && actor.role !== 'owner') throw new E('Власник має найвищі права', 403);

    let logText = '';
    if (payload.op === 'givemoney') {
      const amount = int(payload.n, 1, MAX_BALANCE_ACTION, 'Некоректна сума');
      await q`UPDATE users SET bal = bal + ${amount} WHERE id = ${target.id}`;
      logText = `givemoney ${target.nick} +${amount}`;
    } else if (payload.op === 'setmoney') {
      const amount = int(payload.n, 0, MAX_BALANCE_ACTION, 'Некоректна сума');
      await q`UPDATE users SET bal = ${amount} WHERE id = ${target.id}`;
      logText = `setmoney ${target.nick} =${amount}`;
    } else if (payload.op === 'stamina') {
      const [updated] = await q`UPDATE users SET stam = NOT stam WHERE id = ${target.id} RETURNING stam`;
      logText = `stamina ${target.nick} ${updated.stam ? 'ON' : 'OFF'}`;
    } else if (payload.op === 'giveadmin' || payload.op === 'takeadmin') {
      if (actor.role !== 'owner') throw new E('Призначати адміністраторів може лише власник', 403);
      if (target.role === 'owner') throw new E('Не можна змінити роль власника', 403);
      const nextRole = payload.op === 'giveadmin' ? 'admin' : 'user';
      await q`UPDATE users SET role = ${nextRole} WHERE id = ${target.id}`;
      logText = `${payload.op} ${target.nick}`;
    } else {
      throw new E('Невідома адміністративна дія');
    }

    await q`INSERT INTO alog(admin, text) VALUES(${actor.nick}, ${logText})`;
    return { ok: logText, me: await getMe(userId) };
  }
};

function publicDatabaseError(error) {
  const code = error?.code;
  if (error instanceof E) return { message: error.message, status: error.status };
  if (code === '23505') return { message: 'Такий запис уже існує. Перевір нік і спробуй ще раз.', status: 409 };
  if (code === '42P01' || code === '42703') return { message: 'Структура бази даних ще не готова. Перевір останній Deploy на Netlify та повтори спробу.', status: 503 };
  if (code === '28P01' || code === '3D000' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return { message: 'Netlify не може підключитися до бази даних. Перевір Data & Storage → Database у налаштуваннях сайту.', status: 503 };
  }
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    return { message: 'Не встановлено пакет бази даних. Перевір package.json та повторно запусти Deploy.', status: 503 };
  }
  return { message: 'Не вдалося виконати запит до бази даних. Перевір Deploy logs у Netlify.', status: 500 };
}

export default async function handler(request) {
  try {
    if (request.method === 'GET') {
      await init();
      return J({ ok: true, database: databaseKind, version: '2.0.0' });
    }
    if (request.method !== 'POST') return J({ err: 'Метод не підтримується' }, 405);

    const length = Number(request.headers.get('content-length') || 0);
    if (length > 100_000) throw new E('Запит завеликий', 413);
    let payload;
    try { payload = await request.json(); }
    catch { throw new E('Некоректний формат запиту', 400); }

    await init();
    if (PublicActions[payload.a]) return J(await PublicActions[payload.a](payload));
    if (!Actions[payload.a]) throw new E('Невідома дія', 404);
    const userId = await auth(payload);
    return J(await Actions[payload.a](userId, payload));
  } catch (error) {
    const safe = publicDatabaseError(error);
    if (!(error instanceof E)) {
      console.error('AFK Bank API error:', { code: error?.code, name: error?.name, message: error?.message });
    }
    return J({ err: safe.message }, safe.status);
  }
}

export const config = { path: '/api' };
