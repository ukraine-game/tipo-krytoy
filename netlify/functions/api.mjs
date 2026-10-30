// AFK Bank — безпечна економічна гра для Netlify Functions.
// Усі зміни балансу, перекази, покупки та кулдауни перевіряються на сервері.
import { randomBytes, randomInt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import D from './data.json' with { type: 'json' };

const DAILY = 50_000;
const MAX_BALANCE_ACTION = 2_000_000_000;
const PW_MIN = 6;
const NICK_MAX = 16;
const SESSION_DAYS = 30;
const FOCUS_MS = 30_000;
const FOCUS_COOLDOWN_HOURS = 2;
const GAME_COOLDOWN_SECONDS = 20;
const ROLE_CREATE_COST = 10_000;
const BANK_MIN = 1_000;
const BANK_MAX = 2_000_000_000;
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
      bank_blocked boolean NOT NULL DEFAULT false,
      garage_protect boolean NOT NULL DEFAULT false,
      custom_role_id int,
      business_claim_at timestamptz,
      created timestamptz NOT NULL DEFAULT now()
    )`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS focus_at timestamptz`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS focus_end timestamptz`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_blocked boolean NOT NULL DEFAULT false`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS garage_protect boolean NOT NULL DEFAULT false`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id int`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_claim_at timestamptz`;

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

    await q`CREATE TABLE IF NOT EXISTS bank_deals (
      id serial PRIMARY KEY,
      lender_id int NOT NULL REFERENCES users(id),
      borrower_id int NOT NULL REFERENCES users(id),
      initiator_id int NOT NULL REFERENCES users(id),
      recipient_id int NOT NULL REFERENCES users(id),
      principal bigint NOT NULL,
      rate numeric(5,2) NOT NULL,
      days int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      due_at timestamptz,
      paid_at timestamptz,
      paid_amount bigint
    )`;
    await q`CREATE INDEX IF NOT EXISTS bank_deals_people_idx ON bank_deals(lender_id, borrower_id, status)`;
    await q`CREATE INDEX IF NOT EXISTS bank_deals_recipient_idx ON bank_deals(recipient_id, status)`;

    await q`CREATE TABLE IF NOT EXISTS game_challenges (
      id serial PRIMARY KEY,
      user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game text NOT NULL,
      answer text NOT NULL,
      prompt text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      completed_at timestamptz
    )`;
    await q`ALTER TABLE game_challenges ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb`;
    await q`CREATE INDEX IF NOT EXISTS game_challenges_user_idx ON game_challenges(user_id, created_at DESC)`;

    await q`CREATE TABLE IF NOT EXISTS game_matches (
      id serial PRIMARY KEY,
      game text NOT NULL CHECK (game IN ('cookie','guess')),
      creator_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opponent_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','rejected')),
      creator_score int NOT NULL DEFAULT 0,
      opponent_score int NOT NULL DEFAULT 0,
      secret_number int,
      turn_user_id int REFERENCES users(id),
      winner_id int REFERENCES users(id),
      settled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      ends_at timestamptz
    )`;
    await q`CREATE INDEX IF NOT EXISTS game_matches_creator_idx ON game_matches(creator_id,status,created_at DESC)`;
    await q`CREATE INDEX IF NOT EXISTS game_matches_opponent_idx ON game_matches(opponent_id,status,created_at DESC)`;

    await q`CREATE TABLE IF NOT EXISTS market_listings (
      id serial PRIMARY KEY,
      seller_id int NOT NULL REFERENCES users(id),
      asset_type text NOT NULL CHECK (asset_type IN ('car','house','biz')),
      asset_key text NOT NULL,
      car_id int,
      price bigint NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      buyer_id int REFERENCES users(id),
      sold_at timestamptz
    )`;
    await q`CREATE INDEX IF NOT EXISTS market_active_idx ON market_listings(status, created_at DESC)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS market_one_active_car_idx ON market_listings(car_id) WHERE status='active' AND asset_type='car' AND car_id IS NOT NULL`;

    await q`CREATE TABLE IF NOT EXISTS custom_roles (
      id serial PRIMARY KEY,
      creator_id int NOT NULL REFERENCES users(id),
      name text NOT NULL,
      price bigint NOT NULL DEFAULT 10000,
      listed boolean NOT NULL DEFAULT false,
      owner_id int NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE INDEX IF NOT EXISTS custom_roles_listed_idx ON custom_roles(listed, created_at DESC)`;

    await q`CREATE TABLE IF NOT EXISTS promo_codes (
      code text PRIMARY KEY,
      reward bigint NOT NULL,
      max_uses int NOT NULL DEFAULT 1,
      uses int NOT NULL DEFAULT 0,
      expires_at timestamptz,
      created_by int REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE TABLE IF NOT EXISTS promo_redemptions (
      code text NOT NULL REFERENCES promo_codes(code),
      user_id int NOT NULL REFERENCES users(id),
      redeemed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(code, user_id)
    )`;

    await q`CREATE TABLE IF NOT EXISTS inbox (
      id serial PRIMARY KEY,
      user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender text NOT NULL,
      message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    )`;
    await q`CREATE INDEX IF NOT EXISTS inbox_user_idx ON inbox(user_id, id DESC)`;
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
    id, nick, avatar, role, bal, ok, stam, car, house, biz, bank_blocked, garage_protect, business_claim_at, custom_role_id,
    GREATEST(0, EXTRACT(EPOCH FROM (daily_at + interval '24 hours' - now())) * 1000)::float8 AS c_daily,
    GREATEST(0, EXTRACT(EPOCH FROM (focus_at + interval '2 hours' - now())) * 1000)::float8 AS c_focus,
    GREATEST(0, EXTRACT(EPOCH FROM (focus_end - now())) * 1000)::float8 AS focus_run,
    (focus_end IS NOT NULL AND focus_end <= now()) AS focus_pending
    FROM users WHERE id = ${id}`;
  if (!u) throw new E('Акаунт не знайдено. Увійди знову.', 401);
  const ownedCars = await q`SELECT id, name, value FROM cars WHERE user_id = ${id} ORDER BY id`;
  const [customRole] = u.custom_role_id ? await q`SELECT name FROM custom_roles WHERE id = ${u.custom_role_id} AND owner_id = ${id}` : [null];
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
    bankBlocked: Boolean(u.bank_blocked),
    garageProtect: Boolean(u.garage_protect),
    customRole: customRole?.name || null,
    businessClaimAt: u.business_claim_at,
    cars: ownedCars.map(car => ({ id: car.id, name: car.name, value: Number(car.value) })),
    cd: {
      daily: Number(u.c_daily || 0),
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

async function settleExpiredMatch(q, matchId) {
  const rows = await q`WITH done AS (
    UPDATE game_matches SET
      status='completed',
      winner_id=CASE
        WHEN game='cookie' AND creator_score>opponent_score THEN creator_id
        WHEN game='cookie' AND opponent_score>creator_score THEN opponent_id
        ELSE NULL END,
      settled=true
    WHERE id=${matchId} AND status='active' AND settled=false AND ends_at IS NOT NULL AND ends_at<=now()
    RETURNING winner_id
  ), reward AS (
    UPDATE users SET ok=ok+5 WHERE id=(SELECT winner_id FROM done) RETURNING id
  ) SELECT winner_id FROM done`;
  return rows[0] || null;
}

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
        AND (daily_at IS NULL OR daily_at <= now() - interval '24 hours')
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
    const alreadyOwned = await q`SELECT id FROM cars WHERE user_id=${userId} AND name=${vehicle.name} LIMIT 1`;
    if (alreadyOwned.length) throw new E('Цей автомобіль уже є у твоєму гаражі');
    const inserted = await q`WITH payment AS (
      UPDATE users SET bal = bal - ${vehicle.value}
      WHERE id = ${userId} AND bal >= ${vehicle.value}
        AND NOT EXISTS(SELECT 1 FROM cars WHERE user_id=${userId} AND name=${vehicle.name})
      RETURNING id
    )
    INSERT INTO cars(user_id, name, value, jackpot)
      SELECT id, ${vehicle.name}, ${vehicle.value}, false FROM payment
      RETURNING id`;
    if (!inserted.length) throw new E('Недостатньо грошей або цей автомобіль уже є у твоєму гаражі');
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
      ? await q`UPDATE users SET bal = bal - ${price}, house = ${item[0]} WHERE id = ${userId} AND bal >= ${price} AND house IS NULL RETURNING id`
      : await q`UPDATE users SET bal = bal - ${price}, biz = ${item[0]} WHERE id = ${userId} AND bal >= ${price} AND biz IS NULL RETURNING id`;
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

  async gamesStart(userId, payload) {
    const q = await getSql();
    const game = String(payload.game || '');
    if (!['math','memory','number','coin','roulette'].includes(game)) throw new E('Невідома мінігра');
    const recent = await q`SELECT id FROM game_challenges WHERE user_id = ${userId} AND created_at > now() - interval '2 seconds' LIMIT 1`;
    if (recent.length) throw new E('Зроби коротку паузу перед наступним раундом');
    let answer = '', prompt = '', metadata = {}, seconds = 120;
    if (game === 'math') {
      const a = randomInt(4, 31), b = randomInt(3, 19), op = ['+','-','×'][randomInt(0,3)];
      const left = op === '-' ? Math.max(a,b) : a;
      const right = op === '-' ? Math.min(a,b) : b;
      answer = String(op === '+' ? left+right : op === '-' ? left-right : left*right);
      prompt = `${left} ${op} ${right} = ?`;
    } else if (game === 'memory') {
      const sequence = Array.from({length:6},()=>String(randomInt(0,10))).join('');
      answer = sequence;
      prompt = sequence;
      seconds = 4;
    } else if (game === 'number') {
      answer = String(randomInt(1,21));
      prompt = 'Вгадай число від 1 до 20';
    } else if (game === 'coin') {
      const prediction = String(payload.prediction || '');
      if (!['heads','tails'].includes(prediction)) throw new E('Обери орла або решку перед кидком');
      answer = randomInt(0,2) ? 'heads' : 'tails';
      prompt = '50/50';
      metadata = { prediction };
      seconds = 45;
    } else if (game === 'roulette') {
      const level = int(payload.level, 1, 4, 'Обери рівень рулетки від 1 до 4');
      const prediction = String(payload.prediction ?? '').trim().toLowerCase();
      const valid = level===1 ? ['red','black'].includes(prediction)
        : level===2 ? ['even','odd'].includes(prediction)
        : level===3 ? ['low','high'].includes(prediction)
        : /^([0-9]|[1-2][0-9]|3[0-6])$/.test(prediction);
      if (!valid) throw new E('Перевір вибір для цього рівня рулетки');
      answer = String(randomInt(0,37));
      prompt = '0–36';
      metadata = { level, prediction };
      seconds = 60;
    }
    const [row] = await q`INSERT INTO game_challenges(user_id, game, answer, prompt, metadata, expires_at)
      VALUES(${userId}, ${game}, ${answer}, ${prompt}, ${JSON.stringify(metadata)}::jsonb, now() + interval '2 minutes') RETURNING id`;
    return { challenge: { id: row.id, game, prompt, seconds, level: metadata.level || null } };
  },

  async gamesFinish(userId, payload) {
    const q = await getSql();
    const id = int(payload.id, 1, 2_000_000_000, 'Завдання не знайдено');
    const submitted = String(payload.answer ?? '').trim().replace(/\s+/g,'').toLowerCase();
    const [challenge] = await q`UPDATE game_challenges SET completed_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND completed_at IS NULL AND expires_at > now()
      RETURNING game, answer, prompt, metadata`;
    if (!challenge) throw new E('Завдання вже використане або час вийшов');
    const meta = typeof challenge.metadata === 'string' ? JSON.parse(challenge.metadata || '{}') : (challenge.metadata || {});
    let correct = submitted === String(challenge.answer).toLowerCase();
    let points = 0;
    let result = {};
    if (challenge.game === 'coin') {
      correct = String(meta.prediction) === String(challenge.answer);
      points = correct ? 2 : 0;
      result = { side: challenge.answer, prediction: meta.prediction };
    } else if (challenge.game === 'roulette') {
      const n = Number(challenge.answer), level = Number(meta.level), prediction = String(meta.prediction);
      const reds = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
      const color = n===0 ? 'green' : (reds.has(n) ? 'red' : 'black');
      const outcome = level===1 ? color : level===2 ? (n===0?'zero':(n%2?'odd':'even')) : level===3 ? (n===0?'zero':(n<=18?'low':'high')) : String(n);
      correct = prediction === outcome;
      points = correct ? ({1:2,2:3,3:5,4:8}[level] || 0) : 0;
      result = { number:n, color, outcome, level, prediction };
    } else {
      points = correct ? ({math:5,memory:6,number:4}[challenge.game] || 0) : 0;
    }
    if (points) await q`UPDATE users SET ok = ok + ${points} WHERE id = ${userId}`;
    return { correct, points, result, me: await getMe(userId) };
  },

  async matchCreate(userId, payload) {
    const q = await getSql();
    const game = String(payload.game || '');
    if (!['cookie','guess'].includes(game)) throw new E('Невідомий тип матчу');
    const nick = String(payload.nick || '').trim().toLocaleLowerCase('uk-UA');
    if (!nick) throw new E('Вкажи нік суперника');
    const [opponent] = await q`SELECT id,nick FROM users WHERE nick_lc=${nick} AND id<>${userId}`;
    if (!opponent) throw new E('Гравця не знайдено');
    await q`UPDATE game_matches SET status='rejected' WHERE status='pending' AND created_at < now()-interval '24 hours' AND (creator_id=${userId} OR opponent_id=${userId})`;
    const [existing] = await q`SELECT id FROM game_matches WHERE status IN ('pending','active') AND (creator_id=${userId} OR opponent_id=${userId} OR creator_id=${opponent.id} OR opponent_id=${opponent.id}) LIMIT 1`;
    if (existing) throw new E('Один із гравців уже має незавершений матч');
    const [row] = await q`INSERT INTO game_matches(game,creator_id,opponent_id)
      VALUES(${game},${userId},${opponent.id}) RETURNING id`;
    await q`INSERT INTO inbox(user_id,sender,message) VALUES(${opponent.id},'AFK Games',${`Гравець запросив тебе в ${game==='cookie'?'Печеньку':'Вгадай число'} · матч №${row.id}. Відкрий розділ Мініігри, щоб відповісти.`})`;
    return { id:row.id, opponent:opponent.nick };
  },

  async matchRespond(userId, payload) {
    const q = await getSql();
    const id = int(payload.id,1,2_000_000_000,'Матч не знайдено');
    const action = String(payload.action || '');
    if (!['accept','reject'].includes(action)) throw new E('Невідома дія');
    if (action === 'reject') {
      const rows=await q`UPDATE game_matches SET status='rejected' WHERE id=${id} AND opponent_id=${userId} AND status='pending' RETURNING creator_id`;
      if (!rows.length) throw new E('Запрошення вже оброблено');
      await q`INSERT INTO inbox(user_id,sender,message) VALUES(${rows[0].creator_id},'AFK Games',${`Запрошення в матч №${id} відхилено.`})`;
      return { ok:true };
    }
    const rows=await q`UPDATE game_matches SET status='active',started_at=now(),
        ends_at=CASE WHEN game='cookie' THEN now()+interval '60 seconds' ELSE now()+interval '10 minutes' END,
        secret_number=CASE WHEN game='guess' THEN floor(random()*30)::int+1 ELSE NULL END,
        turn_user_id=CASE WHEN game='guess' THEN creator_id ELSE NULL END
      WHERE id=${id} AND opponent_id=${userId} AND status='pending'
      RETURNING creator_id,opponent_id,game,ends_at`;
    if (!rows.length) throw new E('Запрошення вже оброблено');
    await q`INSERT INTO inbox(user_id,sender,message) VALUES(${rows[0].creator_id},'AFK Games',${`Матч №${id} прийнято. Гра почалася!`})`;
    return { ok:true, game:rows[0].game, endsAt:rows[0].ends_at };
  },

  async matchList(userId) {
    const q = await getSql();
    await q`UPDATE game_matches SET status='rejected' WHERE status='pending' AND created_at < now()-interval '24 hours' AND (creator_id=${userId} OR opponent_id=${userId})`;
    const expired = await q`SELECT id FROM game_matches WHERE status='active' AND ends_at<=now() AND (creator_id=${userId} OR opponent_id=${userId})`;
    for (const row of expired) await settleExpiredMatch(q,row.id);
    const rows = await q`SELECT m.*,c.nick AS creator,o.nick AS opponent,w.nick AS winner
      FROM game_matches m JOIN users c ON c.id=m.creator_id JOIN users o ON o.id=m.opponent_id
      LEFT JOIN users w ON w.id=m.winner_id
      WHERE (m.creator_id=${userId} OR m.opponent_id=${userId})
      ORDER BY m.created_at DESC LIMIT 30`;
    return { me: await getMe(userId), matches:rows.map(m=>({
      id:m.id,game:m.game,status:m.status,creator:m.creator,opponent:m.opponent,winner:m.winner,
      incoming:Number(m.opponent_id)===userId,creatorMe:Number(m.creator_id)===userId,
      creatorScore:Number(m.creator_score),opponentScore:Number(m.opponent_score),
      myScore:Number(m.creator_id)===userId?Number(m.creator_score):Number(m.opponent_score),
      otherScore:Number(m.creator_id)===userId?Number(m.opponent_score):Number(m.creator_score),
      myTurn:Number(m.turn_user_id)===userId,endsAt:m.ends_at,
      ended:m.status==='completed',secretFound:Boolean(m.winner_id)
    }))};
  },

  async cookieTap(userId, payload) {
    const q = await getSql();
    const id = int(payload.id,1,2_000_000_000,'Матч не знайдено');
    const rows=await q`UPDATE game_matches SET
        creator_score=creator_score+CASE WHEN creator_id=${userId} THEN 1 ELSE 0 END,
        opponent_score=opponent_score+CASE WHEN opponent_id=${userId} THEN 1 ELSE 0 END
      WHERE id=${id} AND status='active' AND ends_at>now() AND (creator_id=${userId} OR opponent_id=${userId})
      RETURNING creator_score,opponent_score`;
    if(!rows.length) throw new E('Матч завершено або ти не є його учасником');
    return { creatorScore:Number(rows[0].creator_score),opponentScore:Number(rows[0].opponent_score) };
  },

  async guessMatch(userId, payload) {
    const q = await getSql();
    const id = int(payload.id,1,2_000_000_000,'Матч не знайдено');
    const guess = int(payload.guess,1,30,'Введи число від 1 до 30');
    const rows=await q`UPDATE game_matches SET
        status=CASE WHEN secret_number=${guess} THEN 'completed' ELSE status END,
        winner_id=CASE WHEN secret_number=${guess} THEN ${userId} ELSE NULL END,
        settled=CASE WHEN secret_number=${guess} THEN true ELSE settled END,
        turn_user_id=CASE WHEN secret_number=${guess} THEN turn_user_id
          WHEN turn_user_id=creator_id THEN opponent_id ELSE creator_id END
      WHERE id=${id} AND game='guess' AND status='active' AND ends_at>now()
        AND turn_user_id=${userId} AND (creator_id=${userId} OR opponent_id=${userId})
      RETURNING secret_number,status,turn_user_id`;
    if(!rows.length) throw new E('Зараз не твій хід або матч уже завершено');
    const row=rows[0],won=row.status==='completed';
    if(won) await q`UPDATE users SET ok=ok+5 WHERE id=${userId}`;
    return { won, hint:won?'correct':guess<Number(row.secret_number)?'higher':'lower', myTurn:Number(row.turn_user_id)===userId, me:await getMe(userId) };
  },

  async businessClaim(userId) {
    const q = await getSql();
    const [user] = await q`SELECT biz FROM users WHERE id = ${userId}`;
    const business = D.biz.find(row => row[0] === user?.biz);
    if (!business) throw new E('Спочатку придбай бізнес');
    const income = Number(business[2] || 0);
    const updated = await q`UPDATE users SET bal = bal + ${income}, business_claim_at = now()
      WHERE id = ${userId} AND (business_claim_at IS NULL OR business_claim_at <= now() - interval '24 hours')
      RETURNING id`;
    if (!updated.length) throw new E('Дохід бізнесу можна забирати раз на 24 години');
    return { income, me: await getMe(userId) };
  },

  async bankList(userId) {
    const q = await getSql();
    const [user] = await q`SELECT bank_blocked FROM users WHERE id = ${userId}`;
    const rows = await q`SELECT d.*, l.nick AS lender, b.nick AS borrower,
      CASE WHEN d.status='active' AND d.due_at < now() THEN 'overdue' ELSE d.status END AS display_status
      FROM bank_deals d JOIN users l ON l.id=d.lender_id JOIN users b ON b.id=d.borrower_id
      WHERE d.lender_id=${userId} OR d.borrower_id=${userId}
      ORDER BY d.created_at DESC LIMIT 50`;
    const deals = rows.map(d => {
      const principal = Number(d.principal), rate = Number(d.rate), interest = Math.ceil(principal * rate / 100);
      const baseDue = principal + interest;
      const daysLate = d.status === 'active' && new Date(d.due_at) < new Date() ? Math.max(1, Math.ceil((Date.now()-new Date(d.due_at).getTime())/86400000)) : 0;
      const penalty = Math.min(Math.ceil(principal*.30), Math.ceil(principal*.01*daysLate));
      return { id:d.id, lender:d.lender, borrower:d.borrower, principal, rate, days:d.days,
        status:d.display_status, initiatedByMe:Number(d.initiator_id)===userId, recipientMe:Number(d.recipient_id)===userId,
        dueAt:d.due_at, totalDue:baseDue+penalty, penalty, daysLate };
    });
    return { deals, bankBlocked:Boolean(user?.bank_blocked) };
  },

  async bankCreate(userId, payload) {
    const q = await getSql();
    const kind = payload.kind === 'offer' ? 'offer' : payload.kind === 'request' ? 'request' : '';
    if (!kind) throw new E('Невідомий тип банківської заявки');
    const nick = String(payload.nick||'').trim().toLocaleLowerCase('uk-UA');
    const amount = int(payload.amount, BANK_MIN, BANK_MAX, 'Сума має бути від 1 000 до 2 000 000 000 грн');
    const rate = Number(payload.rate);
    if (!Number.isFinite(rate) || rate < .1 || rate > 70) throw new E('Відсоток має бути від 0,1 до 70');
    const days = int(payload.days,1,10,'Строк має бути від 1 до 10 днів');
    const [actor] = await q`SELECT id, bank_blocked, bal FROM users WHERE id=${userId}`;
    if (actor.bank_blocked) throw new E('Тобі заблоковано доступ до банку');
    const [target] = await q`SELECT id, nick, bank_blocked, bal FROM users WHERE nick_lc=${nick} AND id<>${userId}`;
    if (!target) throw new E('Гравця не знайдено');
    if (target.bank_blocked) throw new E('Іншому гравцю заблоковано доступ до банку');
    const lenderId = kind === 'offer' ? userId : target.id;
    const borrowerId = kind === 'offer' ? target.id : userId;
    if (kind === 'offer' && Number(actor.bal) < amount) throw new E('На балансі недостатньо коштів для такої пропозиції');
    if (kind === 'request' && Number(target.bal) < amount) throw new E('У кредитора недостатньо коштів');
    const [row] = await q`INSERT INTO bank_deals(lender_id,borrower_id,initiator_id,recipient_id,principal,rate,days)
      VALUES(${lenderId},${borrowerId},${userId},${target.id},${amount},${rate},${days}) RETURNING id`;
    await q`INSERT INTO inbox(user_id,sender,message) VALUES(${target.id},'AFK Bank',${`Нова банківська ${kind === 'offer' ? 'пропозиція' : 'заявка'} №${row.id}: ${amount.toLocaleString('uk-UA')} грн, ${rate}% на ${days} дн.`})`;
    return { id:row.id, me:await getMe(userId) };
  },

  async bankRespond(userId, payload) {
    const q = await getSql();
    const id = int(payload.id,1,2_000_000_000,'Заявку не знайдено');
    const action = String(payload.action||'');
    const [deal] = await q`SELECT * FROM bank_deals WHERE id=${id} AND recipient_id=${userId} AND status='pending'`;
    if (!deal) throw new E('Заявка вже недоступна або призначена іншому гравцю');
    const [respondingUser] = await q`SELECT bank_blocked FROM users WHERE id=${userId}`;
    if (action !== 'reject' && respondingUser?.bank_blocked) throw new E('Тобі заблоковано доступ до банку');
    if (action === 'reject') {
      const rejected=await q`UPDATE bank_deals SET status='rejected' WHERE id=${id} AND status='pending' RETURNING id`;
      if(!rejected.length) throw new E('Заявку вже оброблено');
      await q`INSERT INTO inbox(user_id,sender,message) VALUES(${deal.initiator_id},'AFK Bank',${`Банківську заявку №${id} відхилено.`})`;
      return { me:await getMe(userId) };
    }
    if (action === 'counter') {
      const amount = int(payload.amount,BANK_MIN,BANK_MAX,'Сума має бути від 1 000 до 2 000 000 000 грн');
      const rate = Number(payload.rate);
      if (!Number.isFinite(rate)||rate<.1||rate>70) throw new E('Відсоток має бути від 0,1 до 70');
      const days = int(payload.days,1,10,'Строк має бути від 1 до 10 днів');
      const countered=await q`UPDATE bank_deals SET status='countered' WHERE id=${id} AND status='pending' RETURNING id`;
      if(!countered.length) throw new E('Заявку вже оброблено');
      const [newDeal] = await q`INSERT INTO bank_deals(lender_id,borrower_id,initiator_id,recipient_id,principal,rate,days)
        VALUES(${deal.lender_id},${deal.borrower_id},${userId},${deal.initiator_id},${amount},${rate},${days}) RETURNING id`;
      await q`INSERT INTO inbox(user_id,sender,message) VALUES(${deal.initiator_id},'AFK Bank',${`Отримано контрпропозицію №${newDeal.id}: ${amount.toLocaleString('uk-UA')} грн, ${rate}% на ${days} дн.`})`;
      return { id:newDeal.id, me:await getMe(userId) };
    }
    if (action !== 'accept') throw new E('Невідома дія');
    const [actor] = await q`SELECT bank_blocked FROM users WHERE id=${userId}`;
    const [lender] = await q`SELECT bank_blocked FROM users WHERE id=${deal.lender_id}`;
    if (actor?.bank_blocked || lender?.bank_blocked) throw new E('Банківська операція заблокована');
    const moved = await q`WITH locked AS (
        SELECT id,lender_id,borrower_id,principal,days FROM bank_deals WHERE id=${id} AND recipient_id=${userId} AND status='pending' FOR UPDATE
      ), debit AS (
        UPDATE users SET bal=bal-(SELECT principal FROM locked)
        WHERE id=(SELECT lender_id FROM locked) AND bank_blocked=false AND bal >= (SELECT principal FROM locked)
        RETURNING id
      ), activated AS (
        UPDATE bank_deals SET status='active', due_at=now() + (days * interval '1 day')
        WHERE id=${id} AND status='pending' AND EXISTS(SELECT 1 FROM debit) RETURNING lender_id,borrower_id,principal
      ), credit AS (
        UPDATE users SET bal=bal+(SELECT principal FROM activated)
        WHERE id=(SELECT borrower_id FROM activated) RETURNING id
      ) SELECT count(*)::int AS moved FROM credit`;
    if (!moved[0]?.moved) throw new E('Кредитор не має достатньо коштів або заявка вже оброблена');
    const otherId = Number(deal.lender_id) === userId ? Number(deal.borrower_id) : Number(deal.lender_id);
    await q`INSERT INTO inbox(user_id,sender,message) VALUES(${otherId},'AFK Bank',${`Банківську заявку №${id} прийнято. Кредит активний.`})`;
    await q`INSERT INTO inbox(user_id,sender,message) VALUES(${userId},'AFK Bank',${`Ти прийняв заявку №${id}. Кредит активний.`})`;
    return { me:await getMe(userId) };
  },

  async bankPay(userId, payload) {
    const q = await getSql();
    const id = int(payload.id,1,2_000_000_000,'Кредит не знайдено');
    const [deal] = await q`SELECT lender_id,principal,rate,due_at FROM bank_deals WHERE id=${id} AND borrower_id=${userId} AND status='active'`;
    if (!deal) throw new E('Активний кредит не знайдено');
    const principal=Number(deal.principal), interest=Math.ceil(principal*Number(deal.rate)/100);
    const daysLate=new Date(deal.due_at)<new Date()?Math.max(1,Math.ceil((Date.now()-new Date(deal.due_at).getTime())/86400000)):0;
    const penalty=Math.min(Math.ceil(principal*.30),Math.ceil(principal*.01*daysLate));
    const due=principal+interest+penalty;
    const result=await q`WITH locked AS (
        SELECT id,lender_id FROM bank_deals WHERE id=${id} AND borrower_id=${userId} AND status='active' FOR UPDATE
      ), debit AS (
        UPDATE users SET bal=bal-${due} WHERE id=${userId} AND bal>=${due} AND EXISTS(SELECT 1 FROM locked) RETURNING id
      ), credit AS (
        UPDATE users SET bal=bal+${due} WHERE id=(SELECT lender_id FROM locked) AND EXISTS(SELECT 1 FROM debit) RETURNING id
      ), closed AS (
        UPDATE bank_deals SET status='paid',paid_at=now(),paid_amount=${due}
        WHERE id=${id} AND status='active' AND EXISTS(SELECT 1 FROM credit) RETURNING id
      ) SELECT count(*)::int AS paid FROM closed`;
    if (!result[0]?.paid) throw new E('Недостатньо коштів або кредит уже погашено');
    await q`INSERT INTO inbox(user_id,sender,message) VALUES(${deal.lender_id},'AFK Bank',${`Кредит №${id} погашено. На твій баланс зараховано ${due.toLocaleString('uk-UA')} грн.`})`;
    return { paid:due, me:await getMe(userId) };
  },

  async marketList(userId) {
    const q=await getSql();
    const [user]=await q`SELECT house,biz,garage_protect FROM users WHERE id=${userId}`;
    const listings=await q`SELECT m.id,m.asset_type,m.asset_key,m.price,m.created_at,u.nick AS seller,
      c.name AS car_name FROM market_listings m JOIN users u ON u.id=m.seller_id
      LEFT JOIN cars c ON c.id=m.car_id WHERE m.status='active' AND m.seller_id<>${userId} ORDER BY m.created_at DESC LIMIT 100`;
    const cars=await q`SELECT id,name FROM cars WHERE user_id=${userId} ORDER BY id`;
    const ownListings=await q`SELECT id,asset_type,asset_key,price FROM market_listings WHERE seller_id=${userId} AND status='active' ORDER BY id DESC`;
    return { ownListings:ownListings.map(x=>({id:x.id,type:x.asset_type,name:x.asset_key,price:Number(x.price)})), listings:listings.map(x=>({id:x.id,type:x.asset_type,key:x.asset_key,name:x.car_name||x.asset_key,price:Number(x.price),seller:x.seller})),
      own:{cars:cars.map(x=>({id:x.id,name:x.name})),house:user.house,biz:user.biz,protected:Boolean(user.garage_protect)} };
  },

  async marketCreate(userId,payload) {
    const q=await getSql();
    const type=String(payload.type||'');
    const price=int(payload.price,1,MAX_BALANCE_ACTION,'Вкажи коректну ціну');
    if (!['car','house','biz'].includes(type)) throw new E('Невідомий тип майна');
    const [user]=await q`SELECT house,biz,garage_protect FROM users WHERE id=${userId}`;
    if (type === 'car' && user.garage_protect) throw new E('Захист гаража увімкнений. Вимкни його перед продажем автомобіля');
    let key='',carId=null;
    if(type==='car'){
      carId=int(payload.assetId,1,2_000_000_000,'Автомобіль не знайдено');
      const [car]=await q`SELECT id,name FROM cars WHERE id=${carId} AND user_id=${userId}`;
      if(!car) throw new E('Автомобіль не належить тобі');
      key=car.name;
    } else {
      key=type==='house'?String(user.house||''):String(user.biz||'');
      if(!key) throw new E('У тебе немає такого майна');
    }
    const [already]=await q`SELECT id FROM market_listings WHERE seller_id=${userId} AND asset_type=${type} AND asset_key=${key} AND status='active' LIMIT 1`;
    if(already) throw new E('Це майно вже виставлене на ринок');
    const [row]=await q`INSERT INTO market_listings(seller_id,asset_type,asset_key,car_id,price)
      VALUES(${userId},${type},${key},${carId},${price}) RETURNING id`;
    return {id:row.id};
  },

  async marketBuy(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Оголошення не знайдено');
    const [listing]=await q`SELECT * FROM market_listings WHERE id=${id} AND status='active' AND seller_id<>${userId}`;
    if(!listing) throw new E('Оголошення вже недоступне');
    if(listing.asset_type==='house' || listing.asset_type==='biz'){
      const [buyer]=await q`SELECT house,biz FROM users WHERE id=${userId}`;
      if(listing.asset_type==='house' && buyer.house) throw new E('Спочатку звільни слот нерухомості (продай наявний об’єкт)');
      if(listing.asset_type==='biz' && buyer.biz) throw new E('Спочатку звільни слот бізнесу');
    }
    const moved=await q`WITH locked AS (
        SELECT * FROM market_listings WHERE id=${id} AND status='active' AND seller_id<>${userId}
          AND ((asset_type='car' AND EXISTS(SELECT 1 FROM cars c JOIN users s ON s.id=c.user_id WHERE c.id=market_listings.car_id AND c.user_id=market_listings.seller_id AND s.garage_protect=false))
            OR (asset_type='house' AND EXISTS(SELECT 1 FROM users u WHERE u.id=market_listings.seller_id AND u.house=market_listings.asset_key))
            OR (asset_type='biz' AND EXISTS(SELECT 1 FROM users u WHERE u.id=market_listings.seller_id AND u.biz=market_listings.asset_key))) FOR UPDATE
      ), debit AS (
        UPDATE users SET bal=bal-(SELECT price FROM locked),
          house=CASE WHEN (SELECT asset_type FROM locked)='house' THEN (SELECT asset_key FROM locked) ELSE house END,
          biz=CASE WHEN (SELECT asset_type FROM locked)='biz' THEN (SELECT asset_key FROM locked) ELSE biz END,
          business_claim_at=CASE WHEN (SELECT asset_type FROM locked)='biz' THEN NULL ELSE business_claim_at END
        WHERE id=${userId} AND bal >= (SELECT price FROM locked)
          AND ((SELECT asset_type FROM locked)<>'house' OR house IS NULL)
          AND ((SELECT asset_type FROM locked)<>'biz' OR biz IS NULL)
        RETURNING id
      ), credit AS (
        UPDATE users SET bal=bal+(SELECT price FROM locked),
          house=CASE WHEN (SELECT asset_type FROM locked)='house' AND house=(SELECT asset_key FROM locked) THEN NULL ELSE house END,
          biz=CASE WHEN (SELECT asset_type FROM locked)='biz' AND biz=(SELECT asset_key FROM locked) THEN NULL ELSE biz END,
          car=CASE WHEN (SELECT asset_type FROM locked)='car' AND car=(SELECT asset_key FROM locked) THEN NULL ELSE car END
        WHERE id=(SELECT seller_id FROM locked) AND EXISTS(SELECT 1 FROM debit) RETURNING id
      ), carmove AS (
        UPDATE cars SET user_id=${userId} WHERE id=(SELECT car_id FROM locked) AND EXISTS(SELECT 1 FROM credit) AND (SELECT asset_type FROM locked)='car' RETURNING id
      ), sold AS (
        UPDATE market_listings SET status='sold',buyer_id=${userId},sold_at=now()
        WHERE id=${id} AND status='active' AND EXISTS(SELECT 1 FROM credit) RETURNING id
      ) SELECT count(*)::int AS bought FROM sold`;
    if(!moved[0]?.bought) throw new E('Недостатньо коштів або оголошення щойно купили');
    return {me:await getMe(userId)};
  },

  async garageProtect(userId) {
    const q=await getSql();
    const [row]=await q`UPDATE users SET garage_protect=NOT garage_protect WHERE id=${userId} RETURNING garage_protect`;
    if (row.garage_protect) await q`UPDATE market_listings SET status='cancelled' WHERE seller_id=${userId} AND asset_type='car' AND status='active'`;
    return {protected:Boolean(row.garage_protect),me:await getMe(userId)};
  },

  async roleList(userId) {
    const q=await getSql();
    const [user]=await q`SELECT custom_role_id FROM users WHERE id=${userId}`;
    const roles=await q`SELECT r.id,r.name,r.price,u.nick AS seller FROM custom_roles r JOIN users u ON u.id=r.owner_id
      WHERE r.listed=true AND r.owner_id<>${userId} ORDER BY r.created_at DESC LIMIT 100`;
    const own=await q`SELECT id,name,price,listed FROM custom_roles WHERE owner_id=${userId} ORDER BY id DESC`;
    const active=user.custom_role_id ? (await q`SELECT name FROM custom_roles WHERE id=${user.custom_role_id}`)[0]?.name : null;
    return {roles:roles.map(r=>({...r,price:Number(r.price)})),own:own.map(r=>({...r,price:Number(r.price)})),active};
  },

  async roleCreate(userId,payload) {
    const q=await getSql();
    const name=String(payload.name||'').trim();
    if(name.length<2||name.length>24||! /^[\p{L}\p{N} _.-]+$/u.test(name)) throw new E('Назва ролі має містити 2–24 символи');
    const created=await q`WITH debit AS (UPDATE users SET bal=bal-${ROLE_CREATE_COST} WHERE id=${userId} AND bal>=${ROLE_CREATE_COST} RETURNING id)
      INSERT INTO custom_roles(creator_id,name,owner_id) SELECT id,${name},id FROM debit RETURNING id`;
    if(!created.length) throw new E(`Створення ролі коштує ${ROLE_CREATE_COST.toLocaleString('uk-UA')} грн`);
    await q`UPDATE users SET custom_role_id=${created[0].id} WHERE id=${userId}`;
    return {me:await getMe(userId)};
  },

  async roleSell(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Роль не знайдено');
    const price=int(payload.price,1,MAX_BALANCE_ACTION,'Вкажи коректну ціну');
    const result=await q`UPDATE custom_roles SET price=${price},listed=true WHERE id=${id} AND owner_id=${userId} RETURNING id`;
    if(!result.length) throw new E('Ця роль не належить тобі');
    return {};
  },

  async roleBuy(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Роль не знайдено');
    const result=await q`WITH locked AS (SELECT id,owner_id,price FROM custom_roles WHERE id=${id} AND listed=true AND owner_id<>${userId} FOR UPDATE),
      debit AS (UPDATE users SET bal=bal-(SELECT price FROM locked),custom_role_id=${id} WHERE id=${userId} AND bal >= (SELECT price FROM locked) RETURNING id),
      credit AS (UPDATE users SET bal=bal+(SELECT price FROM locked) WHERE id=(SELECT owner_id FROM locked) AND EXISTS(SELECT 1 FROM debit) RETURNING id),
      moved AS (UPDATE custom_roles SET owner_id=${userId},listed=false WHERE id=${id} AND EXISTS(SELECT 1 FROM credit) RETURNING id)
      SELECT count(*)::int AS bought FROM moved`;
    if(!result[0]?.bought) throw new E('Недостатньо коштів або роль уже придбали');
    return {me:await getMe(userId)};
  },

  async marketCancel(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Оголошення не знайдено');
    const result=await q`UPDATE market_listings SET status='cancelled' WHERE id=${id} AND seller_id=${userId} AND status='active' RETURNING id`;
    if(!result.length) throw new E('Оголошення не знайдено або його вже закрито');
    return {};
  },

  async roleActivate(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Роль не знайдено');
    const result=await q`UPDATE users SET custom_role_id=${id} WHERE id=${userId} AND EXISTS(SELECT 1 FROM custom_roles WHERE id=${id} AND owner_id=${userId}) RETURNING id`;
    if(!result.length) throw new E('Ця роль не належить тобі');
    return {me:await getMe(userId)};
  },

  async promoRedeem(userId,payload) {
    const q=await getSql();
    const code=String(payload.code||'').trim().toUpperCase();
    if(!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new E('Перевір промокод');
    const result=await q`WITH available AS (UPDATE promo_codes SET uses=uses+1 WHERE code=${code} AND uses<max_uses AND (expires_at IS NULL OR expires_at>now())
        AND NOT EXISTS(SELECT 1 FROM promo_redemptions r WHERE r.code=promo_codes.code AND r.user_id=${userId}) RETURNING code,reward),
      redemption AS (INSERT INTO promo_redemptions(code,user_id) SELECT code,${userId} FROM available ON CONFLICT DO NOTHING RETURNING code),
      reward AS (UPDATE users SET bal=bal+(SELECT reward FROM available) WHERE id=${userId} AND EXISTS(SELECT 1 FROM redemption) RETURNING id)
      SELECT count(*)::int AS redeemed,(SELECT reward FROM available) AS reward FROM reward`;
    if(!result[0]?.redeemed) throw new E('Промокод недійсний, використаний або вже вичерпав ліміт');
    return {reward:Number(result[0].reward),me:await getMe(userId)};
  },

  async messages(userId) {
    const q=await getSql();
    const rows=await q`SELECT id,sender,message,created_at,read_at FROM inbox WHERE user_id=${userId} ORDER BY id DESC LIMIT 50`;
    await q`UPDATE inbox SET read_at=now() WHERE user_id=${userId} AND read_at IS NULL`;
    return {messages:rows};
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
    const [target] = payload.op === 'promo_create' ? [null] : await q`SELECT id, nick, role FROM users WHERE nick_lc = ${targetNick}`;
    if (payload.op !== 'promo_create' && !target) throw new E('Гравця не знайдено');
    if (target?.role === 'owner' && actor.role !== 'owner') throw new E('Власник має найвищі права', 403);

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
    } else if (payload.op === 'give_vehicle') {
      const vehicle = CAR_CATALOG.find(car => car.name === String(payload.value||''));
      if (!vehicle) throw new E('Автомобіль не знайдено в каталозі');
      await q`INSERT INTO cars(user_id,name,value,jackpot) VALUES(${target.id},${vehicle.name},${vehicle.value},false)`;
      logText = `give_vehicle ${target.nick} ${vehicle.name}`;
    } else if (payload.op === 'give_business') {
      const business = D.biz.find(row => row[0] === String(payload.value||''));
      if (!business) throw new E('Бізнес не знайдено в каталозі');
      await q`UPDATE users SET biz=${business[0]},business_claim_at=NULL WHERE id=${target.id}`;
      logText = `give_business ${target.nick} ${business[0]}`;
    } else if (payload.op === 'block_bank' || payload.op === 'unblock_bank') {
      const blocked = payload.op === 'block_bank';
      await q`UPDATE users SET bank_blocked=${blocked} WHERE id=${target.id}`;
      logText = `${payload.op} ${target.nick}`;
    } else if (payload.op === 'msg_send') {
      const message = String(payload.value||'').trim().slice(0,1000);
      if (!message) throw new E('Повідомлення порожнє');
      await q`INSERT INTO inbox(user_id,sender,message) VALUES(${target.id},${actor.nick},${message})`;
      logText = `msg_send ${target.nick}`;
    } else if (payload.op === 'promo_create') {
      const code = String(payload.value||'').trim().toUpperCase();
      const reward = int(payload.n,1,MAX_BALANCE_ACTION,'Некоректна винагорода');
      const maxUses = int(payload.maxUses||1,1,100000,'Ліміт використань має бути від 1 до 100 000');
      if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new E('Промокод: 3–32 символи A–Z, 0–9, _ або -');
      await q`INSERT INTO promo_codes(code,reward,max_uses,created_by) VALUES(${code},${reward},${maxUses},${userId})`;
      logText = `promo_create ${code} +${reward} (${maxUses} uses)`;
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
      return J({ ok: true, database: databaseKind, version: '4.0.0' });
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
