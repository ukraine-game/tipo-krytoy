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
const GAME_STAKE_MIN = 10;
const GAME_STAKE_MAX = 1_000_000;
const ROLE_CREATE_COST = 200_000;
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
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_robbery_date text`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_notify_seconds int NOT NULL DEFAULT 3600`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_last_notice_at timestamptz`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS game_points bigint NOT NULL DEFAULT 0`;

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
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','choosing','active','completed','rejected')),
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
    await q`ALTER TABLE game_matches DROP CONSTRAINT IF EXISTS game_matches_status_check`;
    await q`ALTER TABLE game_matches ADD CONSTRAINT game_matches_status_check CHECK (status IN ('pending','choosing','active','completed','rejected'))`;
    await q`ALTER TABLE game_matches ADD COLUMN IF NOT EXISTS creator_secret int`;
    await q`ALTER TABLE game_matches ADD COLUMN IF NOT EXISTS opponent_secret int`;
    await q`ALTER TABLE game_matches ADD COLUMN IF NOT EXISTS stake bigint NOT NULL DEFAULT 0`;
    await q`CREATE INDEX IF NOT EXISTS game_matches_creator_idx ON game_matches(creator_id,status,created_at DESC)`;
    await q`CREATE INDEX IF NOT EXISTS game_matches_opponent_idx ON game_matches(opponent_id,status,created_at DESC)`;
    await q`CREATE TABLE IF NOT EXISTS solo_guess_sessions (
      id serial PRIMARY KEY,
      user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      difficulty text NOT NULL CHECK (difficulty IN ('easy','medium','hard','impossible')),
      range_max int NOT NULL,
      answer int NOT NULL,
      attempts int NOT NULL DEFAULT 0,
      max_attempts int NOT NULL,
      xp_reward int NOT NULL,
      solved boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      completed_at timestamptz
    )`;
    await q`ALTER TABLE solo_guess_sessions ADD COLUMN IF NOT EXISTS stake bigint NOT NULL DEFAULT 0`;
    await q`ALTER TABLE solo_guess_sessions ADD COLUMN IF NOT EXISTS payout_multiplier numeric(4,2) NOT NULL DEFAULT 1.00`;
    await q`CREATE INDEX IF NOT EXISTS solo_guess_user_idx ON solo_guess_sessions(user_id,created_at DESC)`;

    await q`CREATE TABLE IF NOT EXISTS blackjack_sessions (
      id serial PRIMARY KEY,
      mode text NOT NULL CHECK (mode IN ('solo','friend')),
      creator_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opponent_id int REFERENCES users(id) ON DELETE CASCADE,
      stake bigint NOT NULL CHECK (stake >= 10),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','completed','rejected','expired')),
      state jsonb NOT NULL,
      version int NOT NULL DEFAULT 0,
      payout_creator bigint NOT NULL DEFAULT 0,
      payout_opponent bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      completed_at timestamptz
    )`;
    await q`CREATE INDEX IF NOT EXISTS blackjack_creator_idx ON blackjack_sessions(creator_id,status,created_at DESC)`;
    await q`CREATE INDEX IF NOT EXISTS blackjack_opponent_idx ON blackjack_sessions(opponent_id,status,created_at DESC)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS blackjack_solo_one_active_idx ON blackjack_sessions(creator_id) WHERE mode='solo' AND status='active'`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS blackjack_friend_creator_open_idx ON blackjack_sessions(creator_id) WHERE mode='friend' AND status IN ('pending','active')`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS blackjack_friend_opponent_open_idx ON blackjack_sessions(opponent_id) WHERE mode='friend' AND status IN ('pending','active')`;

    await q`CREATE TABLE IF NOT EXISTS mines_sessions (
      id serial PRIMARY KEY,
      user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stake bigint NOT NULL CHECK (stake >= 10),
      bomb_count int NOT NULL CHECK (bomb_count IN (3,5,10,20)),
      state jsonb NOT NULL,
      version int NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','won','lost','expired')),
      payout bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      completed_at timestamptz
    )`;
    await q`CREATE INDEX IF NOT EXISTS mines_user_idx ON mines_sessions(user_id,status,created_at DESC)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS mines_one_active_per_user_idx ON mines_sessions(user_id) WHERE status='active'`;

    await q`CREATE TABLE IF NOT EXISTS slot_spins (
      id serial PRIMARY KEY,
      user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stake bigint NOT NULL,
      payout bigint NOT NULL DEFAULT 0,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE INDEX IF NOT EXISTS slot_spins_user_idx ON slot_spins(user_id,created_at DESC)`;

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

    // Bot-parity expansion: business portfolio, treasury, politics, garage tiers and loan grace period.
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_banned boolean NOT NULL DEFAULT false`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_ban_reason text`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS garage_type text`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS garage_checked_at timestamptz`;
    await q`ALTER TABLE bank_deals ADD COLUMN IF NOT EXISTS grace_until timestamptz`;
    await q`ALTER TABLE bank_deals ADD COLUMN IF NOT EXISTS reminder_at timestamptz`;
    await q`ALTER TABLE bank_deals ADD COLUMN IF NOT EXISTS loan_source text NOT NULL DEFAULT 'player'`;
    await q`ALTER TABLE custom_roles ALTER COLUMN price SET DEFAULT 200000`;
    await q`UPDATE users SET garage_type='Надійний', garage_checked_at=COALESCE(garage_checked_at,now()) WHERE garage_protect=true AND garage_type IS NULL`;
    await q`CREATE TABLE IF NOT EXISTS game_state (key text PRIMARY KEY, value text NOT NULL)`;
    await q`INSERT INTO game_state(key,value) VALUES('treasury','100000000') ON CONFLICT(key) DO NOTHING`;
    const [seedV6]=await q`INSERT INTO game_state(key,value) VALUES('v6_treasury_seed_done','1') ON CONFLICT(key) DO NOTHING RETURNING key`;
    if(seedV6) await q`UPDATE game_state SET value='100000000' WHERE key='treasury' AND value='10000000'`;
    await q`INSERT INTO game_state(key,value) VALUES('business_tax','5') ON CONFLICT(key) DO NOTHING`;
    await q`INSERT INTO game_state(key,value) VALUES('president_id','') ON CONFLICT(key) DO NOTHING`;
    await q`CREATE TABLE IF NOT EXISTS business_assets (
      id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL, price bigint NOT NULL, hourly_profit bigint NOT NULL,
      purchased_at timestamptz NOT NULL DEFAULT now(), last_paid_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(user_id,name)
    )`;
    await q`CREATE INDEX IF NOT EXISTS business_assets_user_idx ON business_assets(user_id)`;
    await q`CREATE TABLE IF NOT EXISTS house_assets (
      user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL, price bigint NOT NULL, quantity int NOT NULL DEFAULT 1 CHECK(quantity>=0),
      PRIMARY KEY(user_id,name)
    )`;
    for (const car of D.cars || []) {
      await q`UPDATE cars SET value=${car.value} WHERE name=${car.name} AND value IS DISTINCT FROM ${car.value}`;
    }

    for (const row of D.houses || []) {
      await q`INSERT INTO house_assets(user_id,name,price,quantity)
        SELECT id,${row[0]},${row[1]},1 FROM users WHERE house=${row[0]}
        ON CONFLICT(user_id,name) DO NOTHING`;
    }

    await q`CREATE TABLE IF NOT EXISTS business_payouts (
      id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id), business_name text NOT NULL,
      hours int NOT NULL, gross bigint NOT NULL, tax bigint NOT NULL, net bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE TABLE IF NOT EXISTS president_elections (
      id serial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'active', winner_id int REFERENCES users(id), reason text NOT NULL DEFAULT 'weekly'
    )`;
    await q`ALTER TABLE president_elections ADD COLUMN IF NOT EXISTS week_key text`;
    await q`CREATE INDEX IF NOT EXISTS president_elections_status_idx ON president_elections(status,ends_at)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS president_elections_week_key_idx ON president_elections(week_key) WHERE week_key IS NOT NULL`;
    await q`CREATE TABLE IF NOT EXISTS president_candidates (
      election_id int NOT NULL REFERENCES president_elections(id) ON DELETE CASCADE,
      user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      party_name text NOT NULL, party_description text NOT NULL, fee bigint NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(election_id,user_id)
    )`;
    await q`CREATE TABLE IF NOT EXISTS president_limits (
      user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action text NOT NULL, last_at timestamptz NOT NULL,
      PRIMARY KEY(user_id,action)
    )`;
    await q`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint text NOT NULL UNIQUE, subscription jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id)`;
    await q`CREATE TABLE IF NOT EXISTS president_votes (
      election_id int NOT NULL REFERENCES president_elections(id) ON DELETE CASCADE,
      voter_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      candidate_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      voted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(election_id,voter_id)
    )`;
    await q`CREATE TABLE IF NOT EXISTS president_motions (
      id serial PRIMARY KEY, president_id int NOT NULL REFERENCES users(id),
      status text NOT NULL DEFAULT 'active', started_at timestamptz NOT NULL DEFAULT now()
    )`;
    await q`CREATE TABLE IF NOT EXISTS president_motion_votes (
      motion_id int NOT NULL REFERENCES president_motions(id) ON DELETE CASCADE,
      voter_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      voted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(motion_id,voter_id)
    )`;
    // Sentinel lender represents the in-game bank; it cannot log in.
    await q`INSERT INTO users(id,nick,nick_lc,avatar,salt,pw,role,bal,ok)
      VALUES(0,'AFK Bank','afk-bank-system','p0','system','system','system',0,0) ON CONFLICT(id) DO NOTHING`;
    await q`SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM users),1), true)`;
    // Import legacy single active business once, preserving existing accounts and balances.
    for (const row of D.biz || []) {
      await q`INSERT INTO business_assets(user_id,name,price,hourly_profit,purchased_at,last_paid_at)
        SELECT id,${row[0]},${row[1]},${row[2]},now(),COALESCE(business_claim_at,now())
        FROM users WHERE biz=${row[0]} ON CONFLICT(user_id,name) DO NOTHING`;
    }

    await q`CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner_idx ON users(role) WHERE role = 'owner'`;

  })().catch(error => {
    initPromise = undefined;
    throw error;
  });
  return initPromise;
}


const GARAGES = {
  'Звичайний': { price: 50000, risk: 0.10 },
  'Середній': { price: 250000, risk: 0.02 },
  'Надійний': { price: 1000000, risk: 0.00001 }
};
const BANK_LOAN_MAX = 100_000_000;
const roundPython = value => {
  const floor=Math.floor(value), frac=value-floor;
  if (Math.abs(frac-0.5)<1e-9) return floor%2===0?floor:floor+1;
  return Math.round(value);
};
const totalDue = (principal,rate) => roundPython(Number(principal)*(1+Number(rate)/100));
const bankRate = amount => Number((0.1 + (Math.max(1000,Math.min(BANK_LOAN_MAX,Number(amount)))-1000)*9.9/(BANK_LOAN_MAX-1000)).toFixed(4));
async function stateGet(q,key,fallback='') {
  const [row]=await q`SELECT value FROM game_state WHERE key=${key}`;
  return row ? row.value : fallback;
}
async function stateSet(q,key,value) {
  await q`INSERT INTO game_state(key,value) VALUES(${key},${String(value)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
}
function kyivParts(date=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  return {year:Number(parts.year),month:Number(parts.month),day:Number(parts.day),weekday:parts.weekday,hour:Number(parts.hour),minute:Number(parts.minute),second:Number(parts.second)};
}
function kyivDateKey(date=new Date()) { const p=kyivParts(date); return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`; }
function kyivWeekKey(date=new Date()) {
  const p=kyivParts(date), utc=new Date(Date.UTC(p.year,p.month-1,p.day));
  const dow=(utc.getUTCDay()+6)%7; utc.setUTCDate(utc.getUTCDate()-dow);
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth()+1).padStart(2,'0')}-${String(utc.getUTCDate()).padStart(2,'0')}`;
}
async function sendPush(q,userId,title,body) {
  const publicKey=process.env.VAPID_PUBLIC_KEY, privateKey=process.env.VAPID_PRIVATE_KEY;
  if(!publicKey||!privateKey||!process.env.VAPID_SUBJECT||Number(userId)<=0) return;
  try {
    const webpush=(await import('web-push')).default;
    webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@example.com',publicKey,privateKey);
    const rows=await q`SELECT id,endpoint,subscription FROM push_subscriptions WHERE user_id=${userId}`;
    await Promise.all(rows.map(async row=>{
      try { await webpush.sendNotification(row.subscription,JSON.stringify({title,body,url:'/',tag:`afk-${Date.now()}-${randomBytes(4).toString('hex')}`}),{TTL:3600}); }
      catch(error) { if([404,410].includes(error?.statusCode)) await q`DELETE FROM push_subscriptions WHERE id=${row.id}`; }
    }));
  } catch(error) { console.error('AFK push delivery failed:',error?.message||error); }
}
async function inbox(q,userId,sender,message) {
  if (Number(userId)>0) {
    const text=String(message).slice(0,4000);
    await q`INSERT INTO inbox(user_id,sender,message) VALUES(${userId},${sender},${text})`;
    // The inbox row is durable and visible to the fast in-app poll. Push is best-effort;
    // cap its wait without leaving a timer alive after a fast delivery.
    let pushTimer;
    try {
      await Promise.race([sendPush(q,userId,String(sender),text),new Promise(resolve=>{pushTimer=setTimeout(resolve,250);})]);
    } finally {
      if(pushTimer) clearTimeout(pushTimer);
    }
  }
}
async function settleBusinessIncome(q,userId) {
  // All owned businesses accrue independently while the player is offline.
  // The conditional UPDATE prevents duplicate credit when requests overlap.
  const [taxRow]=await q`SELECT value FROM game_state WHERE key='business_tax'`;
  const taxPercent=Math.max(0,Math.min(15,Number(taxRow?.value??5)));
  const rows=await q`WITH due AS (
      SELECT id,last_paid_at, GREATEST(0,floor(EXTRACT(EPOCH FROM (now()-last_paid_at))/3600)::int) AS hours
      FROM business_assets WHERE user_id=${userId}
    ), claimed AS (
      UPDATE business_assets b SET last_paid_at=b.last_paid_at+(d.hours*interval '1 hour')
      FROM due d WHERE b.id=d.id AND b.user_id=${userId} AND d.hours>0 AND b.last_paid_at=d.last_paid_at
      RETURNING b.id,b.name,b.hourly_profit
    ), calc AS (
      SELECT c.id,c.name,d.hours,(c.hourly_profit*d.hours)::bigint AS gross,
        floor((c.hourly_profit*d.hours)::numeric*${taxPercent}/100)::bigint AS tax,
        ((c.hourly_profit*d.hours)::bigint-floor((c.hourly_profit*d.hours)::numeric*${taxPercent}/100)::bigint) AS net
      FROM claimed c JOIN due d ON d.id=c.id
    ), credited AS (
      UPDATE users SET bal=bal+COALESCE((SELECT sum(net) FROM calc),0)
      WHERE id=${userId} AND EXISTS(SELECT 1 FROM calc) RETURNING id
    ), taxed AS (
      UPDATE game_state SET value=(value::bigint+COALESCE((SELECT sum(tax) FROM calc),0))::text
      WHERE key='treasury' AND EXISTS(SELECT 1 FROM credited) RETURNING key
    ), audited AS (
      INSERT INTO business_payouts(user_id,business_name,hours,gross,tax,net)
      SELECT ${userId},name,hours,gross,tax,net FROM calc WHERE EXISTS(SELECT 1 FROM credited)
      RETURNING business_name,hours,gross,tax,net
    ) SELECT business_name,hours,gross,tax,net FROM audited`;
  if(!rows.length) return 0;
  const totalNet=rows.reduce((sum,x)=>sum+Number(x.net),0);
  const totalTax=rows.reduce((sum,x)=>sum+Number(x.tax),0);
  const totalHours=rows.reduce((sum,x)=>sum+Number(x.hours),0);
  const names=rows.map(x=>x.business_name);
  const [prefs]=await q`SELECT business_notify_seconds,business_last_notice_at FROM users WHERE id=${userId}`;
  const notifySeconds=Math.max(0,Math.min(86400,Number(prefs?.business_notify_seconds??3600)));
  const lastNotice=prefs?.business_last_notice_at?new Date(prefs.business_last_notice_at).getTime():0;
  const shouldNotify=notifySeconds>0&&(!lastNotice||Date.now()-lastNotice>=notifySeconds*1000);
  if(shouldNotify){
    const touched=await q`UPDATE users SET business_last_notice_at=now() WHERE id=${userId} AND business_notify_seconds=${notifySeconds} RETURNING id`;
    if(touched.length) await inbox(q,userId,'AFK Business',`Бізнеси (${names.join(', ')}) принесли ${totalNet.toLocaleString('uk-UA')} грн. Нараховано ${totalHours} бізнес-годин; до казни спрямовано ${totalTax.toLocaleString('uk-UA')} грн податку (${taxPercent}%).`);
  }
  return totalNet;
}
async function processGarageForUser(q,userId) {
  const [u]=await q`SELECT car,garage_type,garage_checked_at FROM users WHERE id=${userId}`;
  if(!u?.car||!u.garage_type||!GARAGES[u.garage_type]) return;
  const [d]=await q`SELECT floor(EXTRACT(EPOCH FROM (date_trunc('day',now())-date_trunc('day',COALESCE(${u.garage_checked_at},now()))))/86400)::int AS days`;
  const days=Math.max(0,Number(d?.days||0));
  if(!days) return;
  const type=u.garage_type, risk=GARAGES[type].risk;
  let stolen=false;
  for(let i=0;i<Math.min(days,3650);i++) if(randomInt(0,1_000_000)<Math.floor(risk*1_000_000)){stolen=true;break;}
  const touched=await q`UPDATE users SET garage_checked_at=now() WHERE id=${userId} AND garage_checked_at IS NOT DISTINCT FROM ${u.garage_checked_at} RETURNING id`;
  if(!touched.length||!stolen) return;
  const [car]=await q`SELECT id FROM cars WHERE user_id=${userId} AND name=${u.car} ORDER BY id LIMIT 1`;
  if(car) await q`DELETE FROM cars WHERE id=${car.id}`;
  const [replacement]=await q`SELECT name FROM cars WHERE user_id=${userId} ORDER BY id LIMIT 1`;
  await q`UPDATE users SET car=${replacement?.name||null} WHERE id=${userId}`;
  await inbox(q,userId,'AFK Garage',`🚨 Автомобіль «${u.car}» викрали з гаража «${type}». ${replacement?`Активним став ${replacement.name}.`:'У гаражі більше немає автомобілів.'}`);
}
async function processDailyRobbery(q,userId) {
  const today=kyivDateKey();
  const [u]=await q`SELECT bal,house,last_robbery_date FROM users WHERE id=${userId}`;
  if(!u||u.last_robbery_date===today) return 0;
  const [claimed]=await q`UPDATE users SET last_robbery_date=${today} WHERE id=${userId} AND last_robbery_date IS DISTINCT FROM ${today} RETURNING bal,house`;
  if(!claimed||Number(claimed.bal)<=1_000_000||claimed.house) return 0;
  if(randomInt(0,100)>=15) return 0;
  const loss=Math.min(Number(claimed.bal),randomInt(100_000,800_001));
  await q`UPDATE users SET bal=GREATEST(0,bal-${loss}) WHERE id=${userId}`;
  await inbox(q,userId,'AFK Нічна подія',`🌙 Цієї ночі ти спав на вокзалі й тебе пограбували. Втрачено ${loss.toLocaleString('uk-UA')} грн. Придбай житло, щоб уникнути такого ризику.`);
  return loss;
}

async function processBankDeadlines(q) {
  const due=await q`UPDATE bank_deals SET status='grace',grace_until=now()+interval '24 hours'
    WHERE status='active' AND due_at<=now() RETURNING id,borrower_id,lender_id,principal,rate,loan_source,grace_until`;
  for(const d of due) await inbox(q,d.borrower_id,'AFK Bank',`⏰ Настав строк погашення кредиту №${d.id}. У тебе є ще 24 години пільгового періоду, щоб погасити ${totalDue(d.principal,d.rate).toLocaleString('uk-UA')} грн.`);
  const reminders=await q`UPDATE bank_deals SET reminder_at=NULL WHERE status='grace' AND reminder_at IS NOT NULL AND reminder_at<=now() RETURNING id,borrower_id,principal,rate,grace_until`;
  for(const d of reminders) await inbox(q,d.borrower_id,'AFK Bank',`⏰ Нагадування про кредит №${d.id}: до сплати ${totalDue(d.principal,d.rate).toLocaleString('uk-UA')} грн. Пільговий період триває до ${new Date(d.grace_until).toLocaleString('uk-UA')}.`);
  const expired=await q`UPDATE bank_deals SET status='processing' WHERE status='grace' AND grace_until<=now() RETURNING id,borrower_id,lender_id,principal,rate,loan_source`;
  for(const d of expired){
    const dueAmount=totalDue(d.principal,d.rate);
    const [borrower]=await q`SELECT bal FROM users WHERE id=${d.borrower_id}`;
    const bal=Math.max(0,Number(borrower?.bal||0));
    const full=bal>=dueAmount;
    const taken=full?dueAmount:bal;
    if(taken>0) await q`UPDATE users SET bal=GREATEST(0,bal-${taken}) WHERE id=${d.borrower_id}`;
    if(Number(d.lender_id)>0&&taken>0) await q`UPDATE users SET bal=bal+${taken} WHERE id=${d.lender_id}`;
    if(!full&&d.loan_source==='bank'){
      await q`UPDATE users SET bank_banned=true,bank_ban_reason='Кредит не погашено протягом 24-годинного пільгового періоду.' WHERE id=${d.borrower_id}`;
    }
    await q`UPDATE bank_deals SET status=${full?'paid':'defaulted'},paid_at=now(),paid_amount=${taken} WHERE id=${d.id} AND status='processing'`;
    await inbox(q,d.borrower_id,'AFK Bank',full?`✅ Кредит №${d.id} автоматично погашено з балансу.`:`⚠️ Кредит №${d.id} не погашено повністю. Списано доступні ${taken.toLocaleString('uk-UA')} грн.${d.loan_source==='bank'?' Нові кредити від банку заблоковано.':' Кредитору передано доступну суму.'}`);
    if(Number(d.lender_id)>0) await inbox(q,d.lender_id,'AFK Bank',`Кредит №${d.id} закрито зі статусом ${full?'погашено':'неповне погашення'}. Отримано ${taken.toLocaleString('uk-UA')} грн.`);
  }
}
async function refreshPolitics(q) {
  const now=new Date(), local=kyivParts(now), weekKey=kyivWeekKey(now), minuteOfDay=local.hour*60+local.minute;
  const electionStart=13*60+10, electionEnd=14*60+20;
  const [dueSchedule]=await q`UPDATE president_elections SET status='active'
    WHERE id=(SELECT id FROM president_elections WHERE status='scheduled' AND started_at<=now() ORDER BY started_at LIMIT 1)
    RETURNING id,reason,ends_at`;
  if(dueSchedule){
    const users=await q`SELECT id FROM users WHERE id>0`;
    const label=dueSchedule.reason==='weekly'?'Щотижневі':'Запущені адміністратором';
    for(const u of users) await inbox(q,u.id,'AFK Elections',`🗳️ Почалися вибори Президента (${label})! Перейди до розділу «Країна та вибори». Завершення: ${new Date(dueSchedule.ends_at).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Kyiv'})}.`);
  }
  let [active]=await q`SELECT * FROM president_elections WHERE status='active' ORDER BY id DESC LIMIT 1`;

  // Close pre-6.0 ad-hoc elections so they cannot block the new weekly schedule.
  if(active && active.reason==='weekly' && !active.week_key && local.weekday==='Mon' && minuteOfDay>=electionStart) {
    await q`UPDATE president_elections SET status='finished' WHERE id=${active.id} AND status='active'`;
    active=null;
  }

  if(active && (new Date(active.ends_at)<=now || (minuteOfDay>=electionEnd && active.week_key===weekKey))) {
    const tally=await q`SELECT c.user_id AS candidate_id,count(v.voter_id)::int AS votes FROM president_candidates c LEFT JOIN president_votes v ON v.election_id=c.election_id AND v.candidate_id=c.user_id WHERE c.election_id=${active.id} GROUP BY c.user_id`;
    const maxVotes=Math.max(0,...tally.map(x=>Number(x.votes)));
    const tied=maxVotes>0?tally.filter(x=>Number(x.votes)===maxVotes):[];
    const winner=tied.length?tied[randomInt(0,tied.length)]:null;
    await q`UPDATE president_elections SET status='finished',winner_id=${winner?.candidate_id||null} WHERE id=${active.id} AND status='active'`;
    await stateSet(q,'president_id',winner?.candidate_id||'');
    if(active.reason==='weekly') await stateSet(q,'last_election_week',weekKey);
    const [winnerUser]=winner?await q`SELECT nick FROM users WHERE id=${winner.candidate_id}`:[null];
    const users=await q`SELECT id FROM users WHERE id>0`;
    const resultText=winner?`🇺🇦 Вибори завершено! Президент — ${winnerUser?.nick||'кандидат'}. ${tied.length>1?'За однакової кількості голосів переможця обрала випадкова жеребкування.':''}`:'🇺🇦 Вибори завершено без голосів. Посада президента тимчасово вакантна.';
    for(const u of users) await inbox(q,u.id,'AFK Elections',resultText);
    active=null;
  }

  // One election each Monday, Kyiv time: candidature and voting run 13:10–14:20.
  if(!active && local.weekday==='Mon' && minuteOfDay>=electionStart && minuteOfDay<electionEnd) {
    const lastWeek=await stateGet(q,'last_election_week','');
    const [scheduled]=await q`SELECT id FROM president_elections WHERE status='scheduled' LIMIT 1`;
    if(lastWeek!==weekKey&&!scheduled) {
      const secondsRemaining=(electionEnd-minuteOfDay)*60-local.second;
      const [created]=await q`INSERT INTO president_elections(started_at,ends_at,reason,week_key,status)
        VALUES(now(),now()+(${Math.max(1,secondsRemaining)}*interval '1 second'),'weekly',${weekKey},'scheduled') ON CONFLICT DO NOTHING RETURNING id`;
      if(created) { await refreshPolitics(q); [active]=await q`SELECT * FROM president_elections WHERE id=${created.id}`; }
    }
  }
}
async function scheduledMaintenance() {
  await init(); const q=await getSql();
  // Handle election and game boundaries before per-user maintenance.
  await refreshPolitics(q);
  await q`WITH expired AS (
    UPDATE game_matches SET status='rejected',settled=true
    WHERE status='pending' AND settled=false AND created_at<now()-interval '24 hours'
    RETURNING creator_id,stake
  ), refund AS (
    UPDATE users SET bal=users.bal+expired.stake
    FROM expired WHERE users.id=expired.creator_id
    RETURNING users.id
  ) SELECT COUNT(*)::int AS refunded FROM refund`;
  await settleExpiredSoloGuesses(q);
  await settleExpiredCoinWagers(q);
  await expireBlackjackSessions(q,null);
  await settleExpiredMines(q,null);
  const expiredMatches=await q`SELECT id FROM game_matches WHERE status IN ('choosing','active') AND settled=false AND ends_at IS NOT NULL AND ends_at<=now() ORDER BY id LIMIT 250`;
  for(const match of expiredMatches) await settleExpiredMatch(q,match.id);
  const users=await q`SELECT id FROM users WHERE id>0 ORDER BY id`;
  for(const u of users){await settleBusinessIncome(q,u.id);await processGarageForUser(q,u.id);await processDailyRobbery(q,u.id)}
  await processBankDeadlines(q);await refreshPolitics(q);
}

async function getMe(id) {
  const q = await getSql();
  await settleBusinessIncome(q,id);
  await processGarageForUser(q,id);
  await processDailyRobbery(q,id);
  await processBankDeadlines(q);
  await refreshPolitics(q);
  const [u] = await q`SELECT
    id, nick, avatar, role, bal, ok, game_points, stam, car, house, biz, bank_blocked, bank_banned, bank_ban_reason, garage_protect, garage_type, garage_checked_at, business_claim_at, custom_role_id,
    GREATEST(0, EXTRACT(EPOCH FROM (daily_at + interval '24 hours' - now())) * 1000)::float8 AS c_daily,
    GREATEST(0, EXTRACT(EPOCH FROM (focus_at + interval '2 hours' - now())) * 1000)::float8 AS c_focus,
    GREATEST(0, EXTRACT(EPOCH FROM (focus_end - now())) * 1000)::float8 AS focus_run,
    (focus_end IS NOT NULL AND focus_end <= now()) AS focus_pending
    FROM users WHERE id = ${id}`;
  if (!u) throw new E('Акаунт не знайдено. Увійди знову.', 401);
  const ownedCars = await q`SELECT id, name, value FROM cars WHERE user_id = ${id} ORDER BY id`;
  const ownedHouses = await q`SELECT name,quantity,price FROM house_assets WHERE user_id=${id} AND quantity>0 ORDER BY name`;
  const [customRole] = u.custom_role_id ? await q`SELECT name FROM custom_roles WHERE id = ${u.custom_role_id} AND owner_id = ${id}` : [null];
  const xp = Number(u.ok);
  const isPresident = Number(await stateGet(q,'president_id','0')) === Number(id);
  return {
    id: Number(u.id),
    nick: u.nick,
    avatar: u.avatar,
    role: u.role,
    isPresident,
    bal: Number(u.bal),
    ok: xp,
    gamePoints: Number(u.game_points||0),
    level: level(xp),
    mult: multiplier(xp),
    stam: Boolean(u.stam),
    car: u.car,
    house: u.house,
    biz: u.biz,
    bankBlocked: Boolean(u.bank_blocked || u.bank_banned),
    bankBanReason: u.bank_ban_reason || null,
    garageProtect: Boolean(u.garage_protect || u.garage_type),
    garageType: u.garage_type || null,
    customRole: customRole?.name || null,
    businessClaimAt: u.business_claim_at,
    cars: ownedCars.map(car => ({ id: car.id, name: car.name, value: Number(car.value) })),
    houses: ownedHouses.map(home=>({name:home.name,quantity:Number(home.quantity),price:Number(home.price)})),
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

async function settleExpiredPendingMatches(q, firstUserId, secondUserId=firstUserId) {
  await q`WITH expired AS (
    UPDATE game_matches SET status='rejected',settled=true
    WHERE status='pending' AND settled=false
      AND created_at < now()-interval '24 hours'
      AND (creator_id IN (${firstUserId},${secondUserId}) OR opponent_id IN (${firstUserId},${secondUserId}))
    RETURNING creator_id,stake
  ), refund AS (
    UPDATE users SET bal=users.bal+expired.stake
    FROM expired WHERE users.id=expired.creator_id
    RETURNING users.id
  ) SELECT COUNT(*)::int AS refunded FROM refund`;
}

async function settleExpiredCoinWagers(q, userId=null) {
  await q`WITH expired AS (
    UPDATE game_challenges SET completed_at=now()
    WHERE game='coin' AND completed_at IS NULL AND expires_at<=now()
      AND metadata->>'stake' IS NOT NULL
      AND (${userId}::int IS NULL OR user_id=${userId})
    RETURNING user_id,metadata
  ), refund AS (
    UPDATE users SET bal=users.bal+(expired.metadata->>'stake')::bigint
    FROM expired WHERE users.id=expired.user_id
    RETURNING users.id
  ) SELECT COUNT(*)::int AS refunded FROM refund`;
}

async function settleExpiredSoloGuesses(q, userId=null) {
  await q`WITH expired AS (
    UPDATE solo_guess_sessions SET completed_at=now()
    WHERE completed_at IS NULL AND expires_at<=now()
      AND (${userId}::int IS NULL OR user_id=${userId})
    RETURNING user_id,stake,attempts
  ), refund AS (
    UPDATE users SET bal=users.bal+expired.stake
    FROM expired WHERE users.id=expired.user_id AND expired.attempts=0
    RETURNING users.id
  ) SELECT COUNT(*)::int AS refunded FROM refund`;
}

async function settleExpiredMines(q, userId=null) {
  await q`WITH expired AS (
    UPDATE mines_sessions SET status='expired',completed_at=now(),version=version+1
    WHERE status='active' AND expires_at<=now()
      AND (${userId}::int IS NULL OR user_id=${userId})
    RETURNING user_id,stake,state
  ), refund AS (
    UPDATE users SET
      bal=users.bal+CASE WHEN COALESCE(jsonb_array_length(expired.state->'opened'),0)=0 THEN expired.stake ELSE 0 END,
      game_points=users.game_points+CASE WHEN COALESCE(jsonb_array_length(expired.state->'opened'),0)>0 THEN 1 ELSE 0 END
    FROM expired WHERE users.id=expired.user_id
    RETURNING users.id
  ) SELECT COUNT(*)::int AS expired,(SELECT COUNT(*) FROM refund)::int AS settled FROM expired`;
}

async function settleExpiredMatch(q, matchId) {
  const rows = await q`WITH done AS (
    UPDATE game_matches SET
      status='completed',
      winner_id=CASE
        WHEN game='cookie' AND creator_score>opponent_score THEN creator_id
        WHEN game='cookie' AND opponent_score>creator_score THEN opponent_id
        WHEN game='guess' AND status='active' AND turn_user_id=creator_id THEN opponent_id
        WHEN game='guess' AND status='active' AND turn_user_id=opponent_id THEN creator_id
        ELSE NULL END,
      settled=true
    WHERE id=${matchId} AND status IN ('choosing','active') AND settled=false AND ends_at IS NOT NULL AND ends_at<=now()
    RETURNING id,game,creator_id,opponent_id,winner_id,creator_score,opponent_score,stake
  ), accounts AS (
    UPDATE users SET
      bal=users.bal+CASE
        WHEN done.winner_id=users.id THEN done.stake*2
        WHEN done.winner_id IS NULL THEN done.stake
        ELSE 0 END,
      ok=users.ok+CASE WHEN done.winner_id=users.id THEN 5 ELSE 0 END,
      game_points=users.game_points+1
    FROM done
    WHERE users.id IN (done.creator_id,done.opponent_id)
    RETURNING users.id
  ) SELECT * FROM done`;
  const row=rows[0];
  if(row){
    const [creator]=await q`SELECT nick FROM users WHERE id=${row.creator_id}`;
    const [opponent]=await q`SELECT nick FROM users WHERE id=${row.opponent_id}`;
    const winner=Number(row.winner_id)===Number(row.creator_id)?creator?.nick:Number(row.winner_id)===Number(row.opponent_id)?opponent?.nick:null;
    const summary=row.game==='cookie'?`Рахунок ${row.creator_score}:${row.opponent_score}. `:'';
    const pot=Number(row.stake||0)*2;
    const stakeInfo=Number(row.stake||0)>0?(winner?` Виграш: ${pot.toLocaleString('uk-UA')} грн.`:` Обом повернуто по ${Number(row.stake).toLocaleString('uk-UA')} грн.`):'';
    const message=winner?`🏁 Матч №${matchId} завершено. ${summary}Переможець: ${winner}.${stakeInfo}`:`Матч №${matchId} завершено внічию. ${summary}${stakeInfo}`;
    await inbox(q,Number(row.creator_id),'AFK Games',message);
    await inbox(q,Number(row.opponent_id),'AFK Games',message);
  }
  return row || null;
}

const CAR_CATALOG = (Array.isArray(D.cars) ? D.cars : []).map(car => ({
  name: String(car.name),
  value: Number(car.value)
})).filter(car => car.name && Number.isSafeInteger(car.value) && car.value > 0);
// These are transparent, fixed-content car collections: the exact vehicle and price
// are shown before purchase. There is no random drop, paid spin, or chance-based reward.
const CASE_CATALOG = [
  {id:'ordinary',name:'Звичайний комплект',rarity:'Звичайний',price:5000,car:'Ford Focus I',art:'ordinary',description:'Міський автомобіль для старту'},
  {id:'rare',name:'Рідкісний комплект',rarity:'Рідкісний',price:10000,car:'Toyota Corolla (E150)',art:'rare',description:'Надійний седан для щоденних поїздок'},
  {id:'epic',name:'Епічний комплект',rarity:'Епічний',price:20000,car:'Audi A6 (C7)',art:'epic',description:'Представницький автомобіль'},
  {id:'mythic',name:'Міфічний комплект',rarity:'Міфічний',price:50000,car:'Mercedes-AMG C 63 (W205)',art:'mythic',description:'Потужний спортивний седан'},
  {id:'legendary',name:'Легендарний комплект',rarity:'Легендарний',price:100000,car:'Aston Martin Vantage',art:'legendary',description:'Преміальний спортивний автомобіль'}
].map(item=>({...item,vehicle:CAR_CATALOG.find(car=>car.name===item.car)}));

const BJ_SUITS = ['♠','♥','♦','♣'];
const BJ_RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const BJ_SYMBOLS = [
  {symbol:'🍒',weight:31,multiplier:11.0,label:'Вишні'},
  {symbol:'🍋',weight:25,multiplier:12.5,label:'Лимон'},
  {symbol:'🍇',weight:18,multiplier:16.0,label:'Виноград'},
  {symbol:'🔔',weight:13,multiplier:22.5,label:'Дзвін'},
  {symbol:'💎',weight:8,multiplier:40.0,label:'Діамант'},
  {symbol:'7️⃣',weight:4,multiplier:100.0,label:'Сімка'},
  {symbol:'💰',weight:1,multiplier:500.0,label:'ДЖЕКПОТ'}
];

function parseJson(value, fallback={}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}
function shuffledDeck() {
  const deck=[];
  for(const suit of BJ_SUITS) for(const rank of BJ_RANKS) deck.push({rank,suit});
  for(let i=deck.length-1;i>0;i--){const j=randomInt(0,i+1);[deck[i],deck[j]]=[deck[j],deck[i]];}
  return deck;
}
function cardValue(card) {
  if(card.rank==='A') return 11;
  if(['K','Q','J'].includes(card.rank)) return 10;
  return Number(card.rank);
}
function blackjackTotal(cards=[]) {
  let total=cards.reduce((sum,card)=>sum+cardValue(card),0);
  let aces=cards.filter(card=>card.rank==='A').length;
  while(total>21&&aces>0){total-=10;aces--;}
  return total;
}
function isNatural(cards=[]) { return cards.length===2&&blackjackTotal(cards)===21; }
function createBlackjackState(mode) {
  const deck=shuffledDeck();
  const take=()=>deck.pop();
  const creator=[take(),take()];
  const opponent=mode==='friend'?[take(),take()]:null;
  const dealer=[take(),take()];
  return {
    deck,
    dealer,
    dealerNatural:isNatural(dealer),
    players:{
      creator:{cards:creator,done:isNatural(creator)},
      opponent:opponent?{cards:opponent,done:isNatural(opponent)}:null
    }
  };
}
function settleBlackjackState(state, mode) {
  const dealer=state.dealer;
  if(!state.dealerNatural){
    while(blackjackTotal(dealer)<17 && state.deck.length) dealer.push(state.deck.pop());
  }
  const dealerScore=blackjackTotal(dealer),dealerBust=dealerScore>21;
  const payouts={creator:0,opponent:0};
  const results={creator:null,opponent:null};
  for(const role of (mode==='friend'?['creator','opponent']:['creator'])){
    const hand=state.players[role]?.cards||[];
    const score=blackjackTotal(hand),natural=isNatural(hand),bust=score>21;
    let outcome='lose',multiplier=0;
    if(natural&&state.dealerNatural){outcome='push';multiplier=1;}
    else if(natural){outcome='blackjack';multiplier=2.5;}
    else if(state.dealerNatural){outcome='lose';multiplier=0;}
    else if(bust){outcome='lose';multiplier=0;}
    else if(dealerBust||score>dealerScore){outcome='win';multiplier=2;}
    else if(score===dealerScore){outcome='push';multiplier=1;}
    payouts[role]=multiplier;
    results[role]={outcome,score,natural,multiplier};
  }
  state.results={dealerScore,dealerBust,players:results};
  return payouts;
}
function publicBlackjackState(state, completed=false) {
  if(!state) return null;
  return {
    dealer:completed?state.dealer:[state.dealer?.[0]||null,{hidden:true}],
    dealerTotal:completed?blackjackTotal(state.dealer):cardValue(state.dealer?.[0]||{rank:'0'}),
    players:{
      creator:state.players?.creator?{cards:state.players.creator.cards,done:Boolean(state.players.creator.done),total:blackjackTotal(state.players.creator.cards)}:null,
      opponent:state.players?.opponent?{cards:state.players.opponent.cards,done:Boolean(state.players.opponent.done),total:blackjackTotal(state.players.opponent.cards)}:null
    },
    results:completed?state.results:null
  };
}
function blackjackRowView(row,userId) {
  const creatorMe=Number(row.creator_id)===Number(userId);
  const state=parseJson(row.state,null);
  return {
    id:Number(row.id),mode:row.mode,status:row.status,stake:Number(row.stake),
    creator:row.creator_nick||null,opponent:row.opponent_nick||null,
    incoming:Number(row.opponent_id)===Number(userId),creatorMe,
    state:state&&!['pending','rejected'].includes(row.status)?publicBlackjackState(state,['completed','expired'].includes(row.status)):null,
    payout:Number((creatorMe?row.payout_creator:row.payout_opponent)||0),
    refunded:row.status==='expired'||(row.status==='rejected'&&creatorMe)?Number(row.stake):0,
    creatorPayout:Number(row.payout_creator||0),opponentPayout:Number(row.payout_opponent||0),
    expiresAt:row.expires_at,createdAt:row.created_at
  };
}
function minesMultiplier(bombs,hits) {
  if(hits<=0) return 1;
  let probability=1;
  for(let i=0;i<hits;i++) probability *= (25-bombs-i)/(25-i);
  return Math.max(1.01,Number((0.97/probability).toFixed(2)));
}
function minesRowView(row, reveal=false) {
  const state=parseJson(row.state,{});
  return {
    id:Number(row.id),stake:Number(row.stake),bombCount:Number(row.bomb_count),
    opened:Array.isArray(state.opened)?state.opened:[],
    bombs:reveal&&Array.isArray(state.bombs)?state.bombs:[],
    status:row.status,version:Number(row.version||0),
    multiplier:minesMultiplier(Number(row.bomb_count),Array.isArray(state.opened)?state.opened.length:0),
    payout:Number(row.payout||0),
    expiresAt:row.expires_at
  };
}
function weightedSlotSymbol() {
  const total=BJ_SYMBOLS.reduce((sum,item)=>sum+item.weight,0);
  let value=randomInt(1,total+1);
  for(const item of BJ_SYMBOLS){value-=item.weight;if(value<=0)return item.symbol;}
  return '🍒';
}
function spinSlotReels() {
  const rows=Array.from({length:5},()=>Array.from({length:3},()=>weightedSlotSymbol()));
  const wins=[];
  for(let row=0;row<5;row++){
    const [a,b,c]=rows[row];
    if(a===b&&b===c){
      const symbol=BJ_SYMBOLS.find(item=>item.symbol===a);
      wins.push({row,symbol:a,multiplier:symbol?.multiplier||0,label:symbol?.label||a});
    }
  }
  return {rows,wins};
}

async function expireBlackjackSessions(q,userId) {
  const expired=await q`WITH done AS (
    UPDATE blackjack_sessions SET status=CASE WHEN status='pending' THEN 'rejected' ELSE 'expired' END,
      completed_at=now(),version=version+1
    WHERE status IN ('pending','active') AND expires_at<=now()
      AND (${userId}::int IS NULL OR creator_id=${userId} OR opponent_id=${userId})
    RETURNING creator_id,opponent_id,stake,state,status
  ), refunds AS (
    UPDATE users SET bal=users.bal+CASE
      WHEN users.id=done.creator_id THEN done.stake
      WHEN done.status='expired' AND users.id=done.opponent_id THEN done.stake
      ELSE 0 END
    FROM done WHERE users.id=done.creator_id OR (done.status='expired' AND users.id=done.opponent_id)
    RETURNING users.id
  ) SELECT done.* FROM done CROSS JOIN (SELECT COUNT(*) FROM refunds) AS applied_refunds`;
  return expired;
}
async function completeBlackjackIfReady(q,row) {
  const state=parseJson(row.state,{});
  const roles=row.mode==='friend'?['creator','opponent']:['creator'];
  if(state.dealerNatural){for(const role of roles) if(state.players?.[role]) state.players[role].done=true;}
  if(!roles.every(role=>state.players?.[role]?.done)) return row;
  const multipliers=settleBlackjackState(state,row.mode);
  const stake=Number(row.stake);
  const payoutCreator=Math.floor(stake*(multipliers.creator||0));
  const payoutOpponent=row.mode==='friend'?Math.floor(stake*(multipliers.opponent||0)):0;
  const [saved]=await q`WITH moved AS (
    UPDATE blackjack_sessions SET status='completed',state=${JSON.stringify(state)}::jsonb,
      payout_creator=${payoutCreator},payout_opponent=${payoutOpponent},completed_at=now(),version=version+1
    WHERE id=${row.id} AND status='active' AND version=${Number(row.version||0)}
    RETURNING id,creator_id,opponent_id,payout_creator,payout_opponent,stake
  ), paid AS (
    UPDATE users SET
      bal=users.bal+CASE WHEN users.id=moved.creator_id THEN moved.payout_creator ELSE moved.payout_opponent END,
      ok=users.ok+CASE WHEN (users.id=moved.creator_id AND moved.payout_creator>moved.stake) OR (users.id=moved.opponent_id AND moved.payout_opponent>moved.stake) THEN 5 ELSE 0 END,
      game_points=users.game_points+1
    FROM moved WHERE users.id=moved.creator_id OR users.id=moved.opponent_id
    RETURNING users.id
  ) SELECT moved.* FROM moved CROSS JOIN (SELECT COUNT(*) FROM paid) AS applied_payments`;
  return saved?{...row,...saved,status:'completed',state,payout_creator:payoutCreator,payout_opponent:payoutOpponent,version:Number(row.version||0)+1}:null;
}


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
    const q=await getSql();
    const [u]=await q`SELECT stam,ok,role FROM users WHERE id=${userId}`;
    if(!u) throw new E('Акаунт не знайдено');
    const xp=Number(u.ok), reward=DAILY*multiplier(xp);
    const updated=await q`UPDATE users SET bal=bal+${reward},
      ok=ok+CASE WHEN role IN ('owner','admin') THEN 0 ELSE 1 END, daily_at=now()
      WHERE id=${userId} AND (daily_at IS NULL OR daily_at<=now()-interval '24 hours') RETURNING id`;
    if(!updated.length) throw new E('⏳ Щоденний бонус можна отримати лише раз на 24 години');
    return {reward,me:await getMe(userId)};
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
    return { purchased:{type:'car',name:vehicle.name,price:vehicle.value}, me: await getMe(userId) };
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
    if(kind==='house'){
      const item=D.houses.find(row=>row[0]===payload.n);
      if(!item) throw new E('Об’єкт нерухомості не знайдено');
      const [purchased]=await q`WITH debit AS (
        UPDATE users SET bal=bal-${item[1]},house=COALESCE(house,${item[0]})
        WHERE id=${userId} AND bal>=${item[1]} RETURNING id
      ) INSERT INTO house_assets(user_id,name,price,quantity)
        SELECT id,${item[0]},${item[1]},1 FROM debit
        ON CONFLICT(user_id,name) DO UPDATE SET quantity=house_assets.quantity+1
        RETURNING quantity`;
      if(!purchased) throw new E('Недостатньо коштів');
      return {purchased:{type:'house',name:item[0],price:item[1]},me:await getMe(userId)};
    }
    const item = D.biz.find(row => row[0] === payload.n);
    if (!item) throw new E('Бізнес не знайдено');
    const [existing]=await q`SELECT id FROM business_assets WHERE user_id=${userId} AND name=${item[0]}`;
    if(existing) throw new E('Цей бізнес уже є у твоєму портфелі');
    const [created] = await q`WITH debit AS (
      UPDATE users SET bal=bal-${item[1]} WHERE id=${userId} AND bal>=${item[1]}
        AND NOT EXISTS(SELECT 1 FROM business_assets WHERE user_id=${userId} AND name=${item[0]}) RETURNING id,biz
      ) INSERT INTO business_assets(user_id,name,price,hourly_profit,purchased_at,last_paid_at)
      SELECT id,${item[0]},${item[1]},${item[2]},now(),now() FROM debit RETURNING id`;
    if(!created) throw new E('Недостатньо коштів або цей бізнес уже придбаний');
    await q`UPDATE users SET biz=${item[0]} WHERE id=${userId} AND biz IS NULL`;
    return {purchased:{type:'business',name:item[0],price:item[1],hourlyProfit:item[2]},me:await getMe(userId)};
  },

  async houseActivate(userId,payload){
    const q=await getSql();const name=String(payload.name||'');
    const [row]=await q`UPDATE users SET house=${name} WHERE id=${userId} AND EXISTS(SELECT 1 FROM house_assets WHERE user_id=${userId} AND name=${name} AND quantity>0) RETURNING id`;
    if(!row)throw new E('Цієї нерухомості немає у твоєму інвентарі');
    return {me:await getMe(userId)};
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
    const [sender] = await q`SELECT role,nick FROM users WHERE id = ${userId}`;
    const [receiver] = await q`SELECT id,nick FROM users WHERE nick_lc=${to} AND id<>${userId}`;
    if (!isAdmin(sender?.role)) await q`UPDATE users SET ok = ok + 1 WHERE id = ${userId}`;
    await inbox(q,receiver.id,'AFK Pay',`💸 ${sender.nick} переказав тобі ${amount.toLocaleString('uk-UA')} грн.`);
    await inbox(q,userId,'AFK Pay',`✅ Ти переказав ${amount.toLocaleString('uk-UA')} грн гравцю ${receiver.nick}.`);
    return { me: await getMe(userId) };
  },

  async top() {
    const q = await getSql();
    const rows = await q`SELECT nick, avatar, bal FROM users ORDER BY bal DESC, id ASC LIMIT 10`;
    return { top: rows.map(row => ({ nick: row.nick, avatar: row.avatar, bal: Number(row.bal) })) };
  },

  async inventory(userId) {
    const q=await getSql();
    const [u]=await q`SELECT nick,avatar,role,bal,ok,car,house,biz,custom_role_id FROM users WHERE id=${userId}`;
    const cars=await q`SELECT id,name,value FROM cars WHERE user_id=${userId} ORDER BY id`;
    const businesses=await q`SELECT name,price,hourly_profit FROM business_assets WHERE user_id=${userId} ORDER BY id`;
    const houses=await q`SELECT name,price,quantity FROM house_assets WHERE user_id=${userId} AND quantity>0 ORDER BY name`;
    const [customRole]=u.custom_role_id?await q`SELECT name FROM custom_roles WHERE id=${u.custom_role_id} AND owner_id=${userId}`:[null];
    const titles=await q`SELECT id,name,listed,price FROM custom_roles WHERE owner_id=${userId} ORDER BY id`;
    return {inventory:{cars:cars.map(x=>({id:x.id,name:x.name,value:Number(x.value)})),house:u.house,houses:houses.map(x=>({name:x.name,price:Number(x.price),quantity:Number(x.quantity)})),businesses:businesses.map(x=>({name:x.name,price:Number(x.price),hourlyProfit:Number(x.hourly_profit)})),activeBusiness:u.biz,activeCar:u.car,activeTitle:customRole?.name||null,titles:titles.map(x=>({id:x.id,name:x.name,listed:Boolean(x.listed),price:Number(x.price)}))},me:await getMe(userId)};
  },
  async profileLookup(userId,payload) {
    const q=await getSql();
    const nick=String(payload.nick||'').trim().toLocaleLowerCase('uk-UA');
    if(nick.length<2||nick.length> NICK_MAX) throw new E('Введи нік від 2 до 16 символів');
    const [u]=await q`SELECT id,nick,avatar,role,bal,ok,car,house,biz,custom_role_id FROM users WHERE nick_lc=${nick} AND id>0`;
    if(!u) throw new E('Гравця з таким ніком не знайдено');
    const [title]=u.custom_role_id?await q`SELECT name FROM custom_roles WHERE id=${u.custom_role_id} AND owner_id=${u.id}`:[null];
    const isPresident=Number(await stateGet(q,'president_id','0'))===Number(u.id);
    const cars=await q`SELECT id,name,value FROM cars WHERE user_id=${u.id} ORDER BY id`;
    const houses=await q`SELECT name,price,quantity FROM house_assets WHERE user_id=${u.id} AND quantity>0 ORDER BY name`;
    const businesses=await q`SELECT name,price,hourly_profit FROM business_assets WHERE user_id=${u.id} ORDER BY id`;
    return {profile:{id:Number(u.id),nick:u.nick,avatar:u.avatar,isPresident,role:isPresident?'Президент':u.role==='owner'?'Власник':u.role==='admin'?'Адміністратор':'Гравець',bal:Number(u.bal),level:level(Number(u.ok)),ok:Number(u.ok),car:u.car,house:u.house,biz:u.biz,title:title?.name||null,cars:cars.map(x=>({id:x.id,name:x.name,value:Number(x.value)})),houses:houses.map(x=>({name:x.name,price:Number(x.price),quantity:Number(x.quantity)})),businesses:businesses.map(x=>({name:x.name,price:Number(x.price),hourlyProfit:Number(x.hourly_profit)}))}};
  },
  async caseCatalog(userId) {
    const q=await getSql();
    const owned=await q`SELECT name FROM cars WHERE user_id=${userId}`;
    const ownedNames=new Set(owned.map(x=>x.name));
    return {cases:CASE_CATALOG.filter(x=>x.vehicle).map(x=>({id:x.id,name:x.name,rarity:x.rarity,price:x.price,car:x.car,carValue:x.vehicle.value,art:x.art,description:x.description,owned:ownedNames.has(x.car)}))};
  },

  async caseBuy(userId,payload) {
    const q=await getSql();
    const item=CASE_CATALOG.find(x=>x.id===String(payload.id||''));
    if(!item?.vehicle) throw new E('Комплект не знайдено');
    const [owned]=await q`SELECT id FROM cars WHERE user_id=${userId} AND name=${item.car} LIMIT 1`;
    if(owned) throw new E('Цей автомобіль уже є у твоєму гаражі. Комплект можна придбати лише один раз.');
    const inserted=await q`WITH debit AS (
      UPDATE users SET bal=bal-${item.price} WHERE id=${userId} AND bal>=${item.price}
        AND NOT EXISTS(SELECT 1 FROM cars WHERE user_id=${userId} AND name=${item.car}) RETURNING id
    ) INSERT INTO cars(user_id,name,value,jackpot)
      SELECT id,${item.car},${item.vehicle.value},false FROM debit RETURNING id`;
    if(!inserted.length) throw new E('Недостатньо коштів або цей автомобіль уже придбаний');
    return {car:item.car,case:{id:item.id,name:item.name,rarity:item.rarity,art:item.art,price:item.price,car:item.car,carValue:item.vehicle.value},me:await getMe(userId)};
  },

  async blackjackStart(userId,payload) {
    const q=await getSql();
    await expireBlackjackSessions(q,userId);
    const [existing]=await q`SELECT s.*,c.nick AS creator_nick,o.nick AS opponent_nick
      FROM blackjack_sessions s JOIN users c ON c.id=s.creator_id
      LEFT JOIN users o ON o.id=s.opponent_id
      WHERE (s.creator_id=${userId} OR s.opponent_id=${userId}) AND s.status IN ('pending','active') AND s.expires_at>now()
      ORDER BY s.created_at DESC LIMIT 1`;
    if(existing)return {session:blackjackRowView(existing,userId),resumed:true,me:await getMe(userId)};
    const stake=int(payload.stake,GAME_STAKE_MIN,GAME_STAKE_MAX,`Ставка має бути від ${GAME_STAKE_MIN} до ${GAME_STAKE_MAX.toLocaleString('uk-UA')} грн`);
    const state=createBlackjackState('solo');
    const [created]=await q`WITH debit AS (
      UPDATE users SET bal=bal-${stake} WHERE id=${userId} AND bal>=${stake} RETURNING id
    ), inserted AS (
      INSERT INTO blackjack_sessions(mode,creator_id,stake,status,state,expires_at)
      SELECT 'solo',id,${stake},'active',${JSON.stringify(state)}::jsonb,now()+interval '30 minutes'
      FROM debit RETURNING id
    ) SELECT id FROM inserted`;
    if(!created)throw new E('На балансі недостатньо коштів для такої ставки');
    let [row]=await q`SELECT s.*,c.nick AS creator_nick,NULL::text AS opponent_nick
      FROM blackjack_sessions s JOIN users c ON c.id=s.creator_id WHERE s.id=${created.id}`;
    const completed=await completeBlackjackIfReady(q,row);
    if(completed)row=completed;
    const [fresh]=await q`SELECT s.*,c.nick AS creator_nick,o.nick AS opponent_nick
      FROM blackjack_sessions s JOIN users c ON c.id=s.creator_id LEFT JOIN users o ON o.id=s.opponent_id WHERE s.id=${created.id}`;
    return {session:blackjackRowView(fresh||row,userId),resumed:false,me:await getMe(userId)};
  },

  async blackjackCreate(userId,payload) {
    const q=await getSql();
    await expireBlackjackSessions(q,userId);
    const nick=String(payload.nick||'').trim().toLocaleLowerCase('uk-UA');
    if(!nick)throw new E('Вкажи нік друга');
    const stake=int(payload.stake,GAME_STAKE_MIN,GAME_STAKE_MAX,`Ставка має бути від ${GAME_STAKE_MIN} до ${GAME_STAKE_MAX.toLocaleString('uk-UA')} грн`);
    const [opponent]=await q`SELECT id,nick FROM users WHERE nick_lc=${nick} AND id<>${userId}`;
    if(!opponent)throw new E('Гравця не знайдено');
    const [busy]=await q`SELECT id FROM blackjack_sessions WHERE status IN ('pending','active')
      AND (creator_id IN (${userId},${opponent.id}) OR opponent_id IN (${userId},${opponent.id})) LIMIT 1`;
    if(busy)throw new E('Один із гравців уже має незавершену гру в блек-джек');
    const state=createBlackjackState('friend');
    const [created]=await q`WITH debit AS (
      UPDATE users SET bal=bal-${stake} WHERE id=${userId} AND bal>=${stake} RETURNING id
    ), inserted AS (
      INSERT INTO blackjack_sessions(mode,creator_id,opponent_id,stake,status,state,expires_at)
      SELECT 'friend',${userId},${opponent.id},${stake},'pending',${JSON.stringify(state)}::jsonb,now()+interval '24 hours'
      FROM debit RETURNING id
    ) SELECT id FROM inserted`;
    if(!created)throw new E('На балансі недостатньо коштів для такої ставки');
    await inbox(q,opponent.id,'AFK Games',`Тебе запросили у блек-джек з дилером у матчі №${created.id}. Ставка для кожного: ${stake.toLocaleString('uk-UA')} грн. Прийми запрошення в розділі «Мініігри».`);
    await inbox(q,userId,'AFK Games',`Запрошення на блек-джек надіслано гравцю ${opponent.nick}. Твою ставку ${stake.toLocaleString('uk-UA')} грн зарезервовано.`);
    return {id:Number(created.id),opponent:opponent.nick,stake,me:await getMe(userId)};
  },

  async blackjackRespond(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Гру не знайдено');
    const action=String(payload.action||'');
    if(!['accept','reject','cancel'].includes(action))throw new E('Невідома дія');
    if(action==='reject'||action==='cancel'){
      const [row]=action==='reject'
        ? await q`WITH ended AS (
            UPDATE blackjack_sessions SET status='rejected',completed_at=now(),version=version+1
            WHERE id=${id} AND mode='friend' AND opponent_id=${userId} AND status='pending'
            RETURNING creator_id,stake
          ), refund AS (
            UPDATE users SET bal=bal+ended.stake FROM ended WHERE users.id=ended.creator_id RETURNING users.id
          ) SELECT ended.creator_id,ended.stake FROM ended CROSS JOIN (SELECT COUNT(*) FROM refund) AS applied_refund`
        : await q`WITH ended AS (
            UPDATE blackjack_sessions SET status='rejected',completed_at=now(),version=version+1
            WHERE id=${id} AND mode='friend' AND creator_id=${userId} AND status='pending'
            RETURNING creator_id,stake
          ), refund AS (
            UPDATE users SET bal=bal+ended.stake FROM ended WHERE users.id=ended.creator_id RETURNING users.id
          ) SELECT ended.creator_id,ended.stake FROM ended CROSS JOIN (SELECT COUNT(*) FROM refund) AS applied_refund`;
      if(!row)throw new E('Запрошення вже оброблено або його не можна скасувати');
      const notify=action==='reject'?Number(row.creator_id):Number(row.creator_id);
      await inbox(q,notify,'AFK Games',`Запрошення на блек-джек №${id} відхилено або скасовано. Ставку ${Number(row.stake).toLocaleString('uk-UA')} грн повернуто.`);
      return {ok:true,refunded:Number(row.stake),me:await getMe(userId)};
    }
    const [accepted]=await q`WITH pending AS MATERIALIZED (
      SELECT id,stake FROM blackjack_sessions WHERE id=${id} AND mode='friend' AND opponent_id=${userId} AND status='pending' FOR UPDATE
    ), debit AS (
      UPDATE users SET bal=bal-(SELECT stake FROM pending)
      WHERE id=${userId} AND EXISTS(SELECT 1 FROM pending) AND bal >= (SELECT stake FROM pending)
      RETURNING id
    ), changed AS (
      UPDATE blackjack_sessions SET status='active',expires_at=now()+interval '30 minutes',version=version+1
      WHERE id=(SELECT id FROM pending) AND status='pending' AND EXISTS(SELECT 1 FROM debit)
      RETURNING id
    ) SELECT id FROM changed`;
    if(!accepted)throw new E('Не вдалося прийняти гру. Перевір баланс: потрібна така сама ставка, як у запрошенні.');
    let [row]=await q`SELECT s.*,c.nick AS creator_nick,o.nick AS opponent_nick
      FROM blackjack_sessions s JOIN users c ON c.id=s.creator_id LEFT JOIN users o ON o.id=s.opponent_id WHERE s.id=${id}`;
    const completed=await completeBlackjackIfReady(q,row);
    if(completed)row=completed;
    const [fresh]=await q`SELECT s.*,c.nick AS creator_nick,o.nick AS opponent_nick
      FROM blackjack_sessions s JOIN users c ON c.id=s.creator_id LEFT JOIN users o ON o.id=s.opponent_id WHERE s.id=${id}`;
    await inbox(q,Number(fresh?.creator_id||row.creator_id),'AFK Games',`Запрошення на блек-джек №${id} прийнято. Матч почався!`);
    return {ok:true,session:blackjackRowView(fresh||row,userId),me:await getMe(userId)};
  },

  async blackjackAction(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Гру не знайдено');
    const action=String(payload.action||'');
    if(!['hit','stand'].includes(action))throw new E('Обери: взяти карту або зупинитися');
    const [row]=await q`SELECT s.*,c.nick AS creator_nick,o.nick AS opponent_nick
      FROM blackjack_sessions s JOIN users c ON c.id=s.creator_id LEFT JOIN users o ON o.id=s.opponent_id
      WHERE s.id=${id} AND (s.creator_id=${userId} OR s.opponent_id=${userId}) AND s.status='active' AND s.expires_at>now()`;
    if(!row)throw new E('Гру завершено, час вийшов або ти не є її учасником');
    const state=parseJson(row.state,{});
    const role=Number(row.creator_id)===Number(userId)?'creator':'opponent';
    const hand=state.players?.[role];
    if(!hand||hand.done)throw new E('Твоя рука вже завершена. Чекаємо на дилера або друга.');
    if(action==='hit'){
      if(isNatural(hand.cards))throw new E('Блек-джек із двох карт уже готовий — натисни «Зупинитися»');
      if(!Array.isArray(state.deck)||!state.deck.length)throw new E('У колоді не залишилося карт');
      hand.cards.push(state.deck.pop());
      if(blackjackTotal(hand.cards)>=21)hand.done=true;
    }else hand.done=true;
    const roles=row.mode==='friend'?['creator','opponent']:['creator'];
    if(state.dealerNatural)for(const item of roles)if(state.players[item])state.players[item].done=true;
    if(roles.every(item=>state.players[item]?.done)){
      const next={...row,state};
      const completed=await completeBlackjackIfReady(q,next);
      if(!completed)throw new E('Стан гри вже змінився. Онови картки та повтори дію.');
    }else{
      const [saved]=await q`UPDATE blackjack_sessions SET state=${JSON.stringify(state)}::jsonb,version=version+1
        WHERE id=${id} AND status='active' AND version=${Number(row.version||0)}
          AND (creator_id=${userId} OR opponent_id=${userId}) RETURNING id`;
      if(!saved)throw new E('Стан гри вже змінився. Онови картки та повтори дію.');
    }
    const [fresh]=await q`SELECT s.*,c.nick AS creator_nick,o.nick AS opponent_nick
      FROM blackjack_sessions s JOIN users c ON c.id=s.creator_id LEFT JOIN users o ON o.id=s.opponent_id WHERE s.id=${id}`;
    return {session:blackjackRowView(fresh,userId),me:await getMe(userId)};
  },

  async blackjackList(userId) {
    const q=await getSql();
    await expireBlackjackSessions(q,userId);
    const rows=await q`SELECT s.*,c.nick AS creator_nick,o.nick AS opponent_nick
      FROM blackjack_sessions s JOIN users c ON c.id=s.creator_id LEFT JOIN users o ON o.id=s.opponent_id
      WHERE (s.creator_id=${userId} OR s.opponent_id=${userId})
      ORDER BY s.created_at DESC LIMIT 20`;
    return {sessions:rows.map(row=>blackjackRowView(row,userId)),me:await getMe(userId)};
  },

  async minesCurrent(userId) {
    const q=await getSql();
    await settleExpiredMines(q,userId);
    const [row]=await q`SELECT * FROM mines_sessions WHERE user_id=${userId} AND status='active' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`;
    return {session:row?minesRowView(row,false):null,me:await getMe(userId)};
  },

  async minesStart(userId,payload) {
    const q=await getSql();
    await settleExpiredMines(q,userId);
    const [existing]=await q`SELECT * FROM mines_sessions WHERE user_id=${userId} AND status='active' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`;
    if(existing)return {session:minesRowView(existing,false),resumed:true,me:await getMe(userId)};
    const stake=int(payload.stake,GAME_STAKE_MIN,GAME_STAKE_MAX,`Ставка має бути від ${GAME_STAKE_MIN} до ${GAME_STAKE_MAX.toLocaleString('uk-UA')} грн`);
    const bombCount=int(payload.bombCount,3,20,'Обери 3, 5, 10 або 20 бомб');
    if(![3,5,10,20].includes(bombCount))throw new E('Кількість бомб має бути 3, 5, 10 або 20');
    const bombs=new Set();while(bombs.size<bombCount)bombs.add(randomInt(0,25));
    const state={bombs:[...bombs],opened:[]};
    const [created]=await q`WITH debit AS (
      UPDATE users SET bal=bal-${stake} WHERE id=${userId} AND bal>=${stake} RETURNING id
    ), inserted AS (
      INSERT INTO mines_sessions(user_id,stake,bomb_count,state,expires_at)
      SELECT id,${stake},${bombCount},${JSON.stringify(state)}::jsonb,now()+interval '20 minutes'
      FROM debit RETURNING id
    ) SELECT id FROM inserted`;
    if(!created)throw new E('На балансі недостатньо коштів для такої ставки');
    const [row]=await q`SELECT * FROM mines_sessions WHERE id=${created.id}`;
    return {session:minesRowView(row,false),resumed:false,me:await getMe(userId)};
  },

  async minesPick(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Раунд не знайдено');
    const cell=int(payload.cell,0,24,'Обери клітинку на полі');
    const [row]=await q`SELECT * FROM mines_sessions WHERE id=${id} AND user_id=${userId} AND status='active' AND expires_at>now()`;
    if(!row)throw new E('Раунд завершено або час вийшов');
    const state=parseJson(row.state,{});
    if((state.opened||[]).includes(cell))throw new E('Ця клітинка вже відкрита');
    const hitBomb=(state.bombs||[]).includes(cell);
    state.opened=[...(state.opened||[]),cell];
    let status='active',payout=0;
    if(hitBomb)status='lost';
    else if(state.opened.length>=25-Number(row.bomb_count)){
      status='won';payout=Math.floor(Number(row.stake)*minesMultiplier(Number(row.bomb_count),state.opened.length));
    }
    const [saved]=await q`WITH moved AS (
      UPDATE mines_sessions SET state=${JSON.stringify(state)}::jsonb,status=${status},payout=${payout},
        completed_at=CASE WHEN ${status}='active' THEN NULL ELSE now() END,version=version+1
      WHERE id=${id} AND user_id=${userId} AND status='active' AND version=${Number(row.version||0)}
      RETURNING id,status,payout,stake,bomb_count,state
    ), wallet AS (
      UPDATE users SET bal=bal+CASE WHEN moved.status='won' THEN moved.payout ELSE 0 END,
        game_points=game_points+1
      FROM moved WHERE users.id=${userId} AND moved.status IN ('won','lost')
      RETURNING users.bal
    ) SELECT moved.* FROM moved CROSS JOIN (SELECT COUNT(*) FROM wallet) AS applied_wallet`;
    if(!saved)throw new E('Стан поля вже змінився. Онови гру та повтори дію.');
    const view=minesRowView(saved,saved.status!=='active');
    return {session:view,hitBomb,status:saved.status,stake:Number(saved.stake),payout:Number(saved.payout),net:Number(saved.payout)-Number(saved.stake),me:await getMe(userId)};
  },

  async minesCashout(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Раунд не знайдено');
    const [row]=await q`SELECT * FROM mines_sessions WHERE id=${id} AND user_id=${userId} AND status='active' AND expires_at>now()`;
    if(!row)throw new E('Раунд завершено або час вийшов');
    const state=parseJson(row.state,{});
    if(!(state.opened||[]).length)throw new E('Відкрий хоча б одну безпечну клітинку перед тим, як забрати виграш');
    const payout=Math.floor(Number(row.stake)*minesMultiplier(Number(row.bomb_count),state.opened.length));
    const [saved]=await q`WITH moved AS (
      UPDATE mines_sessions SET status='won',payout=${payout},completed_at=now(),version=version+1
      WHERE id=${id} AND user_id=${userId} AND status='active' AND version=${Number(row.version||0)}
      RETURNING id,status,payout,stake,bomb_count,state
    ), wallet AS (
      UPDATE users SET bal=bal+moved.payout,game_points=game_points+1
      FROM moved WHERE users.id=${userId} RETURNING users.bal
    ) SELECT moved.* FROM moved CROSS JOIN (SELECT COUNT(*) FROM wallet) AS applied_wallet`;
    if(!saved)throw new E('Стан поля вже змінився. Онови гру та повтори дію.');
    return {session:minesRowView(saved,true),payout,stake:Number(saved.stake),net:payout-Number(saved.stake),me:await getMe(userId)};
  },

  async slotSpin(userId,payload) {
    const q=await getSql();
    const stake=int(payload.stake,GAME_STAKE_MIN,GAME_STAKE_MAX,`Ставка має бути від ${GAME_STAKE_MIN} до ${GAME_STAKE_MAX.toLocaleString('uk-UA')} грн`);
    const {rows,wins}=spinSlotReels();
    const lineStakes=Array.from({length:5},(_,i)=>Math.floor(stake/5)+(i<stake%5?1:0));
    let payout=0;
    const paidLines=wins.map(win=>{
      const lineStake=lineStakes[win.row];
      const linePayout=Math.floor(lineStake*win.multiplier);
      payout+=linePayout;
      return {...win,lineStake,payout:linePayout};
    });
    const result={rows,wins:paidLines};
    const [saved]=await q`WITH wallet AS (
      UPDATE users SET bal=bal-${stake}+${payout},
        ok=ok+CASE WHEN ${payout}>${stake} THEN 5 ELSE 0 END,
        game_points=game_points+1
      WHERE id=${userId} AND bal>=${stake} RETURNING id,bal
    ), logged AS (
      INSERT INTO slot_spins(user_id,stake,payout,result)
      SELECT id,${stake},${payout},${JSON.stringify(result)}::jsonb FROM wallet RETURNING id
    ) SELECT wallet.id,wallet.bal,logged.id AS spin_id FROM wallet CROSS JOIN logged`;
    if(!saved)throw new E('На балансі недостатньо коштів для такої ставки');
    return {spinId:Number(saved.spin_id),stake,payout,net:payout-stake,rows,wins:paidLines,me:await getMe(userId)};
  },

  async soloGuessStart(userId,payload) {
    const q=await getSql();
    const levels={
      easy:{max:3,attempts:3,xp:3,payout:1.00},
      medium:{max:5,attempts:5,xp:5,payout:1.00},
      hard:{max:10,attempts:7,xp:8,payout:1.30},
      impossible:{max:50,attempts:10,xp:12,payout:4.00}
    };
    const difficulty=String(payload.difficulty||'');
    const config=levels[difficulty];
    if(!config) throw new E('Обери рівень складності');
    await settleExpiredSoloGuesses(q,userId);
    const [existing]=await q`SELECT id,difficulty,range_max,attempts,max_attempts,xp_reward,stake,payout_multiplier
      FROM solo_guess_sessions
      WHERE user_id=${userId} AND completed_at IS NULL AND expires_at>now()
      ORDER BY created_at DESC LIMIT 1`;
    if(existing) return {id:Number(existing.id),difficulty:existing.difficulty,rangeMax:Number(existing.range_max),
      attempts:Number(existing.attempts),maxAttempts:Number(existing.max_attempts),xpReward:Number(existing.xp_reward),
      stake:Number(existing.stake),payoutMultiplier:Number(existing.payout_multiplier),resumed:true,me:await getMe(userId)};
    const stake=int(payload.stake,GAME_STAKE_MIN,GAME_STAKE_MAX,`Ставка має бути від ${GAME_STAKE_MIN} до ${GAME_STAKE_MAX.toLocaleString('uk-UA')} грн`);
    const answer=randomInt(1,config.max+1);
    const [row]=await q`WITH debit AS (
      UPDATE users SET bal=bal-${stake}
      WHERE id=${userId} AND bal>=${stake}
      RETURNING id
    ), session AS (
      INSERT INTO solo_guess_sessions(user_id,difficulty,range_max,answer,max_attempts,xp_reward,stake,payout_multiplier,expires_at)
      SELECT ${userId},${difficulty},${config.max},${answer},${config.attempts},${config.xp},${stake},${config.payout},now()+interval '10 minutes'
      FROM debit
      RETURNING id
    ) SELECT id FROM session`;
    if(!row) throw new E('На балансі недостатньо коштів для такої ставки');
    return {id:Number(row.id),difficulty,rangeMax:config.max,attempts:0,maxAttempts:config.attempts,xpReward:config.xp,stake,payoutMultiplier:config.payout,resumed:false,me:await getMe(userId)};
  },

  async soloGuessTry(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Раунд не знайдено');
    const guess=int(payload.guess,1,50,'Введи ціле число в межах обраного рівня');
    await settleExpiredSoloGuesses(q,userId);
    const [row]=await q`WITH attempt AS (
      UPDATE solo_guess_sessions SET
        attempts=attempts+1,
        solved=(answer=${guess}),
        completed_at=CASE WHEN answer=${guess} OR attempts+1>=max_attempts THEN now() ELSE NULL END
      WHERE id=${id} AND user_id=${userId} AND completed_at IS NULL AND expires_at>now() AND ${guess}<=range_max
      RETURNING answer,range_max,attempts,max_attempts,xp_reward,solved,completed_at,stake,payout_multiplier
    ), wallet AS (
      UPDATE users SET
        ok=ok+CASE WHEN attempt.solved THEN attempt.xp_reward ELSE 0 END,
        game_points=game_points+CASE WHEN attempt.completed_at IS NOT NULL THEN 1 ELSE 0 END,
        bal=bal+CASE WHEN attempt.solved THEN FLOOR(attempt.stake*attempt.payout_multiplier)::bigint ELSE 0 END
      FROM attempt
      WHERE users.id=${userId}
      RETURNING bal
    )
    SELECT attempt.*,wallet.bal FROM attempt CROSS JOIN wallet`;
    if(!row) throw new E('Раунд завершено, час вийшов або число поза діапазоном. Почни новий раунд.');
    const finished=Boolean(row.completed_at);
    const stake=Number(row.stake||0);
    const payout=row.solved?Math.floor(stake*Number(row.payout_multiplier||1)):0;
    return {correct:Boolean(row.solved),hint:row.solved?'correct':finished?'finished':guess<Number(row.answer)?'higher':'lower',
      attempts:Number(row.attempts),maxAttempts:Number(row.max_attempts),rangeMax:Number(row.range_max),
      answer:finished?Number(row.answer):null,xp:row.solved?Number(row.xp_reward):0,finished,
      stake,payout,net:finished?payout-stake:null,me:await getMe(userId)};
  },

  async soloGuessCancel(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Раунд не знайдено');
    await settleExpiredSoloGuesses(q,userId);
    const [row]=await q`WITH cancelled AS (
      UPDATE solo_guess_sessions SET completed_at=now()
      WHERE id=${id} AND user_id=${userId} AND completed_at IS NULL AND attempts=0
      RETURNING stake
    ), refund AS (
      UPDATE users SET bal=users.bal+cancelled.stake
      FROM cancelled WHERE users.id=${userId}
      RETURNING bal
    )
    SELECT cancelled.stake,refund.bal FROM cancelled CROSS JOIN refund`;
    if(!row) throw new E('Раунд уже почався: після першої спроби скасувати ставку не можна');
    return {refunded:Number(row.stake),me:await getMe(userId)};
  },

  async gamesStart(userId,payload) {
    const q=await getSql();
    const game=String(payload.game||'');
    if(game!=='coin') throw new E('Невідомий тип гри');
    const prediction=String(payload.prediction||'');
    if(!['heads','tails'].includes(prediction)) throw new E('Обери орла або решку перед кидком');
    const stake=int(payload.stake,GAME_STAKE_MIN,GAME_STAKE_MAX,`Ставка має бути від ${GAME_STAKE_MIN} до ${GAME_STAKE_MAX.toLocaleString('uk-UA')} грн`);
    await settleExpiredCoinWagers(q,userId);
    const recent=await q`SELECT id FROM game_challenges WHERE user_id=${userId} AND created_at>now()-interval '2 seconds' LIMIT 1`;
    if(recent.length) throw new E('Зроби коротку паузу перед наступним кидком');
    const answer=randomInt(0,2)?'heads':'tails';
    const [row]=await q`WITH debit AS (
      UPDATE users SET bal=bal-${stake}
      WHERE id=${userId} AND bal>=${stake}
      RETURNING id
    ), challenge AS (
      INSERT INTO game_challenges(user_id,game,answer,prompt,metadata,expires_at)
      SELECT ${userId},'coin',${answer},'50/50',${JSON.stringify({prediction,stake})}::jsonb,now()+interval '2 minutes'
      FROM debit
      RETURNING id
    ) SELECT id FROM challenge`;
    if(!row) throw new E('На балансі недостатньо коштів для такої ставки');
    return {challenge:{id:row.id,game:'coin',prompt:'50/50',seconds:45,stake},me:await getMe(userId)};
  },
  async gamesFinish(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Кидок не знайдено');
    await settleExpiredCoinWagers(q,userId);
    const [row]=await q`WITH completed AS (
      UPDATE game_challenges SET completed_at=now()
      WHERE id=${id} AND user_id=${userId} AND game='coin' AND completed_at IS NULL AND expires_at>now()
      RETURNING answer,metadata
    ), wallet AS (
      UPDATE users SET
        bal=bal+CASE WHEN completed.metadata->>'prediction'=completed.answer
          THEN COALESCE((completed.metadata->>'stake')::bigint,0)*2 ELSE 0 END,
        game_points=game_points+1
      FROM completed
      WHERE users.id=${userId}
      RETURNING bal
    )
    SELECT completed.answer,completed.metadata,wallet.bal
    FROM completed CROSS JOIN wallet`;
    if(!row) throw new E('Кидок уже використано або час вийшов');
    const meta=typeof row.metadata==='string'?JSON.parse(row.metadata||'{}'):(row.metadata||{});
    const correct=String(meta.prediction)===String(row.answer);
    const stake=Number(meta.stake||0),payout=correct?stake*2:0;
    return {correct,points:1,stake,payout,net:payout-stake,
      result:{side:row.answer,prediction:meta.prediction},me:await getMe(userId)};
  },
  async matchCreate(userId, payload) {
    const q = await getSql();
    const game = String(payload.game || '');
    if (!['cookie','guess'].includes(game)) throw new E('Невідомий тип матчу');
    const nick = String(payload.nick || '').trim().toLocaleLowerCase('uk-UA');
    if (!nick) throw new E('Вкажи нік суперника');
    const stake=int(payload.stake,GAME_STAKE_MIN,GAME_STAKE_MAX,`Ставка має бути від ${GAME_STAKE_MIN} до ${GAME_STAKE_MAX.toLocaleString('uk-UA')} грн`);
    const [opponent] = await q`SELECT id,nick FROM users WHERE nick_lc=${nick} AND id<>${userId}`;
    if (!opponent) throw new E('Гравця не знайдено');
    await settleExpiredPendingMatches(q,userId,Number(opponent.id));
    const [existing] = await q`SELECT id FROM game_matches WHERE status IN ('pending','choosing','active') AND (creator_id=${userId} OR opponent_id=${userId} OR creator_id=${opponent.id} OR opponent_id=${opponent.id}) LIMIT 1`;
    if (existing) throw new E('Один із гравців уже має незавершений матч');
    const [row] = await q`WITH debit AS (
      UPDATE users SET bal=bal-${stake}
      WHERE id=${userId} AND bal>=${stake}
      RETURNING id
    ), created AS (
      INSERT INTO game_matches(game,creator_id,opponent_id,stake)
      SELECT ${game},${userId},${opponent.id},${stake}
      FROM debit
      RETURNING id
    ) SELECT id FROM created`;
    if(!row) throw new E('На балансі недостатньо коштів для такої ставки');
    const pot=stake*2;
    await inbox(q,opponent.id,'AFK Games',`Гравець запросив тебе в ${game==='cookie'?'Печеньку':'Вгадай число'} · матч №${row.id}. Ставка для кожного: ${stake.toLocaleString('uk-UA')} грн, переможець забере ${pot.toLocaleString('uk-UA')} грн. Відкрий розділ Мініігри, щоб відповісти.`);
    await inbox(q,userId,'AFK Games',`Запрошення надіслано гравцю ${opponent.nick}. Матч №${row.id} очікує відповіді. Твою ставку ${stake.toLocaleString('uk-UA')} грн зарезервовано.`);
    return { id:row.id, opponent:opponent.nick, stake, pot };
  },

  async matchRespond(userId, payload) {
    const q = await getSql();
    const id = int(payload.id,1,2_000_000_000,'Матч не знайдено');
    const action = String(payload.action || '');
    if (!['accept','reject','cancel'].includes(action)) throw new E('Невідома дія');
    if (action === 'reject' || action === 'cancel') {
      const rows=action==='reject'
        ? await q`WITH rejected AS (
            UPDATE game_matches SET status='rejected',settled=true
            WHERE id=${id} AND opponent_id=${userId} AND status='pending' AND settled=false
            RETURNING creator_id,opponent_id,stake
          ), refund AS (
            UPDATE users SET bal=users.bal+rejected.stake
            FROM rejected WHERE users.id=rejected.creator_id
            RETURNING users.id
          )
          SELECT creator_id,opponent_id,stake FROM rejected`
        : await q`WITH rejected AS (
            UPDATE game_matches SET status='rejected',settled=true
            WHERE id=${id} AND creator_id=${userId} AND status='pending' AND settled=false
            RETURNING creator_id,opponent_id,stake
          ), refund AS (
            UPDATE users SET bal=users.bal+rejected.stake
            FROM rejected WHERE users.id=rejected.creator_id
            RETURNING users.id
          )
          SELECT creator_id,opponent_id,stake FROM rejected`;
      if (!rows.length) throw new E('Запрошення вже оброблено або матч не можна скасувати');
      const text=action==='cancel'?'Ініціатор скасував':'Запрошення відхилено';
      const notifyUser=action==='cancel'?rows[0].opponent_id:rows[0].creator_id;
      await inbox(q,notifyUser,'AFK Games',`${text} матч №${id}. Ставку ${Number(rows[0].stake).toLocaleString('uk-UA')} грн повернуто ініціатору.`);
      return { ok:true, refunded:Number(rows[0].stake), cancelled:action==='cancel' };
    }
    const rows=await q`WITH target AS MATERIALIZED (
      SELECT id,stake,game FROM game_matches
      WHERE id=${id} AND opponent_id=${userId} AND status='pending' AND settled=false
      FOR UPDATE
    ), debit AS (
      UPDATE users SET bal=bal-(SELECT stake FROM target)
      WHERE id=${userId} AND EXISTS(SELECT 1 FROM target) AND bal >= (SELECT stake FROM target)
      RETURNING id
    ), accepted AS (
      UPDATE game_matches SET status=CASE WHEN game='guess' THEN 'choosing' ELSE 'active' END,
        started_at=now(),ends_at=CASE WHEN game='cookie' THEN now()+interval '60 seconds' ELSE now()+interval '15 minutes' END,
        secret_number=NULL,turn_user_id=NULL
      WHERE id=(SELECT id FROM target) AND status='pending' AND EXISTS(SELECT 1 FROM debit)
      RETURNING creator_id,opponent_id,game,ends_at,stake
    ) SELECT * FROM accepted`;
    if (!rows.length) throw new E('Не вдалося прийняти матч. Перевір баланс: потрібна така сама ставка, як у запрошенні.');
    const pot=Number(rows[0].stake)*2;
    await inbox(q,rows[0].creator_id,'AFK Games',rows[0].game==='guess'?`Матч №${id} прийнято. Обидва гравці мають таємно обрати число від 1 до 30. Банк матчу: ${pot.toLocaleString('uk-UA')} грн.`:`Матч №${id} прийнято. Гра почалася! Банк матчу: ${pot.toLocaleString('uk-UA')} грн.`);
    await inbox(q,userId,'AFK Games',`Ти прийняв запрошення на матч №${id}. Ставку ${Number(rows[0].stake).toLocaleString('uk-UA')} грн списано.`);
    return { ok:true, game:rows[0].game, choosing:rows[0].game==='guess', endsAt:rows[0].ends_at, stake:Number(rows[0].stake), pot };
  },

  async matchSetSecret(userId,payload){
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Матч не знайдено');
    const value=int(payload.number,1,30,'Секретне число має бути від 1 до 30');
    const [updated]=await q`UPDATE game_matches SET
      creator_secret=CASE WHEN creator_id=${userId} THEN ${value} ELSE creator_secret END,
      opponent_secret=CASE WHEN opponent_id=${userId} THEN ${value} ELSE opponent_secret END
      WHERE id=${id} AND game='guess' AND status='choosing'
        AND ((creator_id=${userId} AND creator_secret IS NULL) OR (opponent_id=${userId} AND opponent_secret IS NULL))
      RETURNING creator_id,opponent_id,creator_secret,opponent_secret`;
    if(!updated)throw new E('Ти вже обрав число, матч неактивний або ти не учасник');
    let started=false;
    if(updated.creator_secret!==null&&updated.opponent_secret!==null){
      const [round]=await q`UPDATE game_matches SET status='active',turn_user_id=CASE WHEN random()<0.5 THEN creator_id ELSE opponent_id END
        WHERE id=${id} AND status='choosing' AND creator_secret IS NOT NULL AND opponent_secret IS NOT NULL
        RETURNING creator_id,opponent_id,turn_user_id`;
      if(round){started=true;await inbox(q,round.creator_id,'AFK Games',`Обидва секретні числа у матчі №${id} збережено. Гра почалася!`);await inbox(q,round.opponent_id,'AFK Games',`Обидва секретні числа у матчі №${id} збережено. Гра почалася!`);}
    }
    return {ok:true,started,me:await getMe(userId)};
  },

  async matchList(userId) {
    const q = await getSql();
    await settleExpiredPendingMatches(q,userId);
    const expired = await q`SELECT id FROM game_matches WHERE status IN ('choosing','active') AND ends_at<=now() AND (creator_id=${userId} OR opponent_id=${userId})`;
    for (const row of expired) await settleExpiredMatch(q,row.id);
    const rows = await q`SELECT m.*,c.nick AS creator,o.nick AS opponent,w.nick AS winner
      FROM game_matches m JOIN users c ON c.id=m.creator_id JOIN users o ON o.id=m.opponent_id
      LEFT JOIN users w ON w.id=m.winner_id
      WHERE (m.creator_id=${userId} OR m.opponent_id=${userId})
      ORDER BY m.created_at DESC LIMIT 30`;
    const [wallet]=await q`SELECT bal,ok,game_points FROM users WHERE id=${userId}`;
    return { wallet:{bal:Number(wallet?.bal||0),ok:Number(wallet?.ok||0),gamePoints:Number(wallet?.game_points||0)}, matches:rows.map(m=>({
      id:m.id,game:m.game,status:m.status,creator:m.creator,opponent:m.opponent,winner:m.winner,
      incoming:Number(m.opponent_id)===userId,creatorMe:Number(m.creator_id)===userId,
      creatorScore:Number(m.creator_score),opponentScore:Number(m.opponent_score),
      myScore:Number(m.creator_id)===userId?Number(m.creator_score):Number(m.opponent_score),
      otherScore:Number(m.creator_id)===userId?Number(m.opponent_score):Number(m.creator_score),
      myTurn:Number(m.turn_user_id)===userId,mySecretSet:Number(m.creator_id)===userId?m.creator_secret!==null:m.opponent_secret!==null,otherSecretSet:Number(m.creator_id)===userId?m.opponent_secret!==null:m.creator_secret!==null,endsAt:m.ends_at,
      stake:Number(m.stake||0),pot:Number(m.stake||0)*2,ended:m.status==='completed',secretFound:Boolean(m.winner_id)
    }))};
  },

  async cookieTap(userId, payload) {
    const q = await getSql();
    const id = int(payload.id,1,2_000_000_000,'Матч не знайдено');
    const count=int(payload.count??1,1,50,'Некоректна кількість кліків');
    const rows=await q`UPDATE game_matches SET
        creator_score=creator_score+CASE WHEN creator_id=${userId} THEN ${count} ELSE 0 END,
        opponent_score=opponent_score+CASE WHEN opponent_id=${userId} THEN ${count} ELSE 0 END
      WHERE id=${id} AND status='active' AND ends_at>now() AND (creator_id=${userId} OR opponent_id=${userId})
      RETURNING creator_score,opponent_score`;
    if(!rows.length) throw new E('Матч завершено або ти не є його учасником');
    return { creatorScore:Number(rows[0].creator_score),opponentScore:Number(rows[0].opponent_score) };
  },

  async guessMatch(userId, payload) {
    const q = await getSql();
    const id = int(payload.id,1,2_000_000_000,'Матч не знайдено');
    const guess = int(payload.guess,1,30,'Введи число від 1 до 30');
    const [game]=await q`WITH moved AS (
      UPDATE game_matches SET
        status=CASE WHEN (CASE WHEN creator_id=${userId} THEN opponent_secret ELSE creator_secret END)=${guess} THEN 'completed' ELSE 'active' END,
        winner_id=CASE WHEN (CASE WHEN creator_id=${userId} THEN opponent_secret ELSE creator_secret END)=${guess} THEN ${userId} ELSE NULL END,
        settled=CASE WHEN (CASE WHEN creator_id=${userId} THEN opponent_secret ELSE creator_secret END)=${guess} THEN true ELSE false END,
        turn_user_id=CASE WHEN (CASE WHEN creator_id=${userId} THEN opponent_secret ELSE creator_secret END)=${guess}
          THEN ${userId} ELSE CASE WHEN creator_id=${userId} THEN opponent_id ELSE creator_id END END
      WHERE id=${id} AND game='guess' AND status='active'
        AND ends_at>now() AND turn_user_id=${userId}
        AND (creator_id=${userId} OR opponent_id=${userId})
      RETURNING creator_id,opponent_id,creator_secret,opponent_secret,turn_user_id,winner_id,stake
    ), accounts AS (
      UPDATE users SET
        bal=users.bal+CASE WHEN moved.winner_id=users.id THEN moved.stake*2 ELSE 0 END,
        ok=users.ok+CASE WHEN moved.winner_id=users.id THEN 5 ELSE 0 END,
        game_points=users.game_points+1
      FROM moved
      WHERE moved.winner_id IS NOT NULL AND users.id IN (moved.creator_id,moved.opponent_id)
      RETURNING users.id
    )
    SELECT creator_id,opponent_id,turn_user_id,winner_id,stake,
      CASE WHEN winner_id IS NOT NULL THEN 'correct'
        WHEN ${guess} < CASE WHEN creator_id=${userId} THEN opponent_secret ELSE creator_secret END THEN 'higher'
        ELSE 'lower' END AS hint
    FROM moved`;
    if(!game)throw new E('Зараз не твій хід або матч уже завершено');
    const won=Number(game.winner_id)===userId;
    const stake=Number(game.stake||0),payout=won?stake*2:0;
    const nextUser=Number(game.creator_id)===userId?Number(game.opponent_id):Number(game.creator_id);
    if(won){
      await inbox(q,nextUser,'AFK Games',`Суперник вгадав твоє число у матчі №${id}. Матч завершено. Ставки виплачено переможцю.`);
      await inbox(q,userId,'AFK Games',`🎉 Ти переміг у матчі «Вгадай число» №${id}. +5 XP та ${payout.toLocaleString('uk-UA')} грн.`);
    }
    return {won,hint:game.hint,
      myTurn:Number(game.turn_user_id)===userId,stake,payout,net:won?payout-stake:null,me:await getMe(userId)};
  },

  async businessClaim(userId) {
    const q=await getSql();
    const income=await settleBusinessIncome(q,userId);
    const [u]=await q`SELECT biz FROM users WHERE id=${userId}`;
    const assets=await q`SELECT name,price,hourly_profit,last_paid_at FROM business_assets WHERE user_id=${userId} ORDER BY purchased_at`;
    return {income,active:u?.biz||null,assets:assets.map(x=>({name:x.name,price:Number(x.price),hourlyProfit:Number(x.hourly_profit),lastPaidAt:x.last_paid_at})),me:await getMe(userId)};
  },
  async businessBuy(userId,payload) {
    const q=await getSql(); const name=String(payload.name||'');
    const item=(D.biz||[]).find(x=>x[0]===name); if(!item) throw new E('Бізнес не знайдено в каталозі');
    const [existing]=await q`SELECT id FROM business_assets WHERE user_id=${userId} AND name=${name}`;
    if(existing) throw new E('Цей бізнес уже є у твоєму портфелі');
    const [created]=await q`WITH debit AS (
      UPDATE users SET bal=bal-${item[1]} WHERE id=${userId} AND bal>=${item[1]}
        AND NOT EXISTS(SELECT 1 FROM business_assets WHERE user_id=${userId} AND name=${name}) RETURNING id,biz
      ) INSERT INTO business_assets(user_id,name,price,hourly_profit,purchased_at,last_paid_at)
      SELECT id,${name},${item[1]},${item[2]},now(),now() FROM debit RETURNING id`;
    if(!created) throw new E('Недостатньо коштів або бізнес уже придбаний');
    await q`UPDATE users SET biz=${name} WHERE id=${userId} AND biz IS NULL`;
    return {purchased:{type:'business',name,price:item[1],hourlyProfit:item[2]},me:await getMe(userId)};
  },
  async businessActivate(userId,payload) {
    const q=await getSql(); const name=String(payload.name||'');
    const [asset]=await q`SELECT id FROM business_assets WHERE user_id=${userId} AND name=${name}`;
    if(!asset) throw new E('Цей бізнес не належить тобі');
    await settleBusinessIncome(q,userId);
    await q`UPDATE users SET biz=${name} WHERE id=${userId}`;
    await inbox(q,userId,'AFK Business',`Активним у профілі обрано бізнес «${name}». Всі бізнеси твого портфеля продовжують приносити погодинний дохід.`);
    return {me:await getMe(userId)};
  },
  async businessStats(userId) {
    const q=await getSql(); const income=await settleBusinessIncome(q,userId);
    const [u]=await q`SELECT biz,business_notify_seconds FROM users WHERE id=${userId}`;
    const rows=await q`SELECT name,price,hourly_profit,purchased_at,last_paid_at FROM business_assets WHERE user_id=${userId} ORDER BY purchased_at`;
    const tax=Number(await stateGet(q,'business_tax','5'));
    return {income,active:u?.biz||null,tax,notifySeconds:Number(u?.business_notify_seconds??3600),assets:rows.map(x=>({name:x.name,price:Number(x.price),hourlyProfit:Number(x.hourly_profit),lastPaidAt:x.last_paid_at,active:x.name===u?.biz})),catalog:D.biz.map(x=>({name:x[0],price:x[1],hourlyProfit:x[2],category:x[3]||'Інше'})).sort((a,b)=>a.price-b.price),me:await getMe(userId)};
  },
  async businessNotifySet(userId,payload) {
    const q=await getSql();
    const seconds=int(payload.seconds,0,86400,'Обери дозволений інтервал сповіщень');
    if(![0,3600,7200,18000,86400].includes(seconds)) throw new E('Доступні інтервали: 1 година, 2 години, 5 годин, 1 день або ніколи');
    await q`UPDATE users SET business_notify_seconds=${seconds},business_last_notice_at=now() WHERE id=${userId}`;
    const label=seconds===0?'ніколи':seconds===3600?'раз на годину':seconds===7200?'раз на 2 години':seconds===18000?'раз на 5 годин':'раз на день';
    await inbox(q,userId,'AFK Business',`⚙️ Частоту сповіщень про дохід бізнесу змінено: ${label}. Сам дохід продовжує накопичуватися автоматично.`);
    return {notifySeconds:seconds,me:await getMe(userId)};
  },

  async garageInfo(userId) {
    const q=await getSql(); await processGarageForUser(q,userId);
    const [u]=await q`SELECT car,garage_type,garage_checked_at FROM users WHERE id=${userId}`;
    return {car:u?.car||null,type:u?.garage_type||null,catalog:Object.entries(GARAGES).map(([name,x])=>({name,price:x.price,riskPercent:x.risk*100})),cars:(await q`SELECT id,name,value FROM cars WHERE user_id=${userId} ORDER BY id`).map(x=>({id:x.id,name:x.name,value:Number(x.value)})),me:await getMe(userId)};
  },
  async garageBuy(userId,payload) {
    const q=await getSql(); const type=String(payload.type||''); const item=GARAGES[type];
    if(!item) throw new E('Обери один із трьох типів гаража');
    const [u]=await q`SELECT car,garage_type,bal FROM users WHERE id=${userId}`;
    if(!u?.car) throw new E('Спочатку обери активний автомобіль у гаражі');
    if(u.garage_type) throw new E('У тебе вже є гараж');
    const [done]=await q`UPDATE users SET bal=bal-${item.price},garage_protect=true,garage_type=${type},garage_checked_at=now()
      WHERE id=${userId} AND bal>=${item.price} AND garage_type IS NULL RETURNING id`;
    if(!done) throw new E('Недостатньо коштів або гараж уже придбано');
    await inbox(q,userId,'AFK Garage',`Придбано гараж «${type}». Денний ризик втрати активного авто: ${item.risk*100}%`);
    return {me:await getMe(userId)};
  },
  async kazna(userId) {
    const q=await getSql(); const treasury=Number(await stateGet(q,'treasury','100000000'));
    const tax=Number(await stateGet(q,'business_tax','5'));
    const president=Number(await stateGet(q,'president_id','0'))||null;
    return {treasury,tax,president,me:await getMe(userId)};
  },
  async treasuryDeposit(userId,payload) {
    const q=await getSql(); const amount=int(payload.amount,1,MAX_BALANCE_ACTION,'Вкажи суму від 1 до 2 млрд грн');
    const [row]=await q`UPDATE users SET bal=bal-${amount} WHERE id=${userId} AND bal>=${amount} RETURNING id`;
    if(!row) throw new E('Недостатньо коштів');
    await q`UPDATE game_state SET value=(value::bigint+${amount})::text WHERE key='treasury'`;
    return {treasury:Number(await stateGet(q,'treasury','0')),me:await getMe(userId)};
  },
  async countryState(userId) {
    const q=await getSql(); await refreshPolitics(q);
    const president=Number(await stateGet(q,'president_id','0'))||null;
    const [election]=await q`SELECT id,started_at,ends_at,status,week_key FROM president_elections WHERE status='active' ORDER BY id DESC LIMIT 1`;
    const [scheduledElection]=await q`SELECT id,started_at,ends_at FROM president_elections WHERE status='scheduled' ORDER BY started_at LIMIT 1`;
    let candidates=[];
    if(election) candidates=await q`SELECT u.id,u.nick,u.avatar,u.ok,c.party_name,c.party_description,c.fee,c.applied_at,count(v.voter_id)::int AS votes
      FROM president_candidates c JOIN users u ON u.id=c.user_id
      LEFT JOIN president_votes v ON v.candidate_id=u.id AND v.election_id=c.election_id
      WHERE c.election_id=${election.id} GROUP BY u.id,u.nick,u.avatar,u.ok,c.party_name,c.party_description,c.fee,c.applied_at
      ORDER BY votes DESC,u.id LIMIT 50`;
    const myCandidate=election?await q`SELECT party_name,party_description,fee FROM president_candidates WHERE election_id=${election.id} AND user_id=${userId}`:[];
    const myVote=election?await q`SELECT candidate_id FROM president_votes WHERE election_id=${election.id} AND voter_id=${userId}`:[];
    const [motion]=await q`SELECT id,president_id,started_at FROM president_motions WHERE status='active' ORDER BY id DESC LIMIT 1`;
    let motionVotes=0; if(motion){const [v]=await q`SELECT count(*)::int AS n FROM president_motion_votes WHERE motion_id=${motion.id}`;motionVotes=Number(v?.n||0)}
    const [pres]=president?await q`SELECT nick,avatar FROM users WHERE id=${president}`:[null];
    const [me]=await q`SELECT ok FROM users WHERE id=${userId}`; const lvl=level(Number(me?.ok||0));
    const p=kyivParts();
    const [withdrawLimit]=president?await q`SELECT last_at + interval '48 hours' AS ready_at FROM president_limits WHERE user_id=${president} AND action='withdraw'`:[null];
    return {withdrawReadyAt:withdrawLimit?.ready_at||null,scheduledElection:scheduledElection?{id:Number(scheduledElection.id),startsAt:scheduledElection.started_at,endsAt:scheduledElection.ends_at}:null,treasury:Number(await stateGet(q,'treasury','100000000')),tax:Number(await stateGet(q,'business_tax','5')),president,presidentNick:pres?.nick||null,presidentAvatar:pres?.avatar||null,
      election:election?{id:election.id,startedAt:election.started_at,endsAt:election.ends_at,weekKey:election.week_key,candidates:candidates.map(x=>({id:Number(x.id),nick:x.nick,avatar:x.avatar,level:level(Number(x.ok)),partyName:x.party_name,partyDescription:x.party_description,fee:Number(x.fee),votes:Number(x.votes)})),myCandidate:myCandidate[0]||null,myVote:Number(myVote[0]?.candidate_id||0)||null}:null,
      candidacyFee:100000*lvl,level:lvl,kyivNow:p,motion:motion?{id:motion.id,votes:motionVotes,presidentId:motion.president_id}:null,me:await getMe(userId)};
  },
  async electionApply(userId,payload) {
    const q=await getSql(); await refreshPolitics(q);
    const [e]=await q`SELECT id FROM president_elections WHERE status='active' AND ends_at>now() ORDER BY id DESC LIMIT 1`;
    if(!e) throw new E('Подати кандидатуру можна лише під час виборів: у понеділок 13:10–14:20 за Києвом');
    const party=String(payload.party||'').trim(), description=String(payload.description||'').trim();
    if(party.length<3||party.length>48) throw new E('Назва партії має містити 3–48 символів');
    if(description.length<20||description.length>600) throw new E('Опис партії має містити 20–600 символів');
    const [u]=await q`SELECT ok FROM users WHERE id=${userId}`; if(!u) throw new E('Акаунт не знайдено');
    const fee=100000*level(Number(u.ok));
    const [created]=await q`WITH debit AS (
      UPDATE users SET bal=bal-${fee} WHERE id=${userId} AND bal>=${fee}
        AND NOT EXISTS(SELECT 1 FROM president_candidates WHERE election_id=${e.id} AND user_id=${userId}) RETURNING id
      ) INSERT INTO president_candidates(election_id,user_id,party_name,party_description,fee)
        SELECT ${e.id},${userId},${party},${description},${fee} FROM debit RETURNING user_id`;
    if(!created) {
      const [existing]=await q`SELECT user_id FROM president_candidates WHERE election_id=${e.id} AND user_id=${userId}`;
      if(existing) throw new E('Ти вже подав кандидатуру на цих виборах');
      throw new E(`Недостатньо коштів. Потрібно ${fee.toLocaleString('uk-UA')} грн.`);
    }
    await inbox(q,userId,'AFK Elections',`✅ Кандидатуру зареєстровано. Партія «${party}». Внесок: ${fee.toLocaleString('uk-UA')} грн.`);
    return {fee,me:await getMe(userId)};
  },
  async electionVote(userId,payload) {
    const q=await getSql(); await refreshPolitics(q);
    const candidate=int(payload.candidate,1,2_000_000_000,'Обери кандидата');
    const [e]=await q`SELECT id FROM president_elections WHERE status='active' AND ends_at>now() ORDER BY id DESC LIMIT 1`;
    if(!e) throw new E('Зараз немає активних виборів');
    if(candidate===userId) throw new E('За себе голосувати не можна');
    const [c]=await q`SELECT user_id FROM president_candidates WHERE election_id=${e.id} AND user_id=${candidate}`;
    if(!c) throw new E('Цей гравець не подав кандидатуру на поточних виборах');
    await q`INSERT INTO president_votes(election_id,voter_id,candidate_id) VALUES(${e.id},${userId},${candidate}) ON CONFLICT(election_id,voter_id) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,voted_at=now()`;
    return {ok:true};
  },
  async motionStart(userId) {
    const q=await getSql(); const president=Number(await stateGet(q,'president_id','0'))||0;
    if(!president) throw new E('Зараз немає президента');
    const [active]=await q`SELECT id FROM president_motions WHERE status='active' LIMIT 1`;
    if(active) throw new E('Мітинг уже триває');
    const [m]=await q`INSERT INTO president_motions(president_id) VALUES(${president}) RETURNING id`;
    return {id:m.id};
  },
  async motionVote(userId,payload) {
    const q=await getSql(); const id=int(payload.id,1,2_000_000_000,'Мітинг не знайдено');
    const [m]=await q`SELECT id,president_id FROM president_motions WHERE id=${id} AND status='active'`;
    if(!m) throw new E('Мітинг уже завершено'); if(Number(m.president_id)===userId) throw new E('Президент не може голосувати за власне зняття');
    await q`INSERT INTO president_motion_votes(motion_id,voter_id) VALUES(${id},${userId}) ON CONFLICT DO NOTHING`;
    const [n]=await q`SELECT count(*)::int AS n FROM president_motion_votes WHERE motion_id=${id}`;
    if(Number(n.n)>=2){await q`UPDATE president_motions SET status='passed' WHERE id=${id}`;await stateSet(q,'president_id','');await inbox(q,m.president_id,'AFK Politics','Президентські повноваження припинено після успішного мітингу.');const users=await q`SELECT id FROM users WHERE id>0`;for(const u of users)await inbox(q,u.id,'AFK Elections','🇺🇦 Президента усунуто після громадського мітингу. Посада буде обрана на найближчих планових виборах у понеділок о 13:10.')} 
    return {votes:Number(n.n),passed:Number(n.n)>=2};
  },
  async presidentAction(userId,payload) {
    const q=await getSql(); await refreshPolitics(q); const president=Number(await stateGet(q,'president_id','0'))||0;
    if(president!==userId) throw new E('Цей розділ доступний лише чинному президенту');
    const op=String(payload.op||'');
    if(op==='tax'){const percent=int(payload.amount,0,15,'Податок має бути від 0 до 15%');await stateSet(q,'business_tax',percent);return {ok:true,tax:percent};}
    if(op==='withdraw'){
      const amount=int(payload.amount,1,5_000_000,'Президент може зняти не більше 5 000 000 грн за раз');
      const rows=await q`WITH allowed AS (
        INSERT INTO president_limits(user_id,action,last_at)
        SELECT ${userId},'withdraw',now() FROM game_state WHERE key='treasury' AND value::bigint>=${amount}
        ON CONFLICT(user_id,action) DO UPDATE SET last_at=EXCLUDED.last_at
          WHERE president_limits.last_at<=now()-interval '48 hours'
        RETURNING user_id
      ), treasury AS (
        UPDATE game_state SET value=(value::bigint-${amount})::text WHERE key='treasury' AND EXISTS(SELECT 1 FROM allowed) RETURNING value
      ), paid AS (
        UPDATE users SET bal=bal+${amount} WHERE id=${userId} AND EXISTS(SELECT 1 FROM treasury) RETURNING id
      ) SELECT (SELECT value FROM treasury) AS treasury,(SELECT count(*) FROM paid)::int AS paid`;
      if(!rows[0]?.paid) {
        const [limit]=await q`SELECT last_at FROM president_limits WHERE user_id=${userId} AND action='withdraw'`;
        if(limit&&new Date(limit.last_at).getTime()>Date.now()-48*3600000) throw new E('Знімати кошти з казни можна лише раз на 48 годин');
        throw new E('У казні недостатньо грошей');
      }
      await inbox(q,userId,'AFK President',`🏛️ Ти отримав ${amount.toLocaleString('uk-UA')} грн із державної казни.`);
      return {ok:true,treasury:Number(rows[0].treasury),me:await getMe(userId)};
    }
    if(op==='give_all'){
      const amount=int(payload.amount,1,5_000_000,'Премія кожному має бути від 1 до 5 000 000 грн');
      const [cost]=await q`SELECT count(*)::bigint AS n FROM users WHERE id>0`;
      const total=amount*Number(cost.n); if(!Number.isSafeInteger(total)) throw new E('Загальна сума завелика');
      const result=await q`WITH treasury AS (
        UPDATE game_state SET value=(value::bigint-${total})::text WHERE key='treasury' AND value::bigint>=${total} RETURNING value
      ), credits AS (UPDATE users SET bal=bal+${amount} WHERE id>0 AND EXISTS(SELECT 1 FROM treasury) RETURNING id)
      SELECT (SELECT value FROM treasury) AS treasury,count(*)::int AS count FROM credits`;
      if(!result[0]?.count) throw new E('У казні недостатньо грошей для виплати всім');
      const users=await q`SELECT id FROM users WHERE id>0`;
      for(const u of users) await inbox(q,u.id,'AFK President',`🇺🇦 Президент нарахував тобі премію ${amount.toLocaleString('uk-UA')} грн із казни.`);
      return {ok:true,treasury:Number(result[0].treasury),count:Number(result[0].count)};
    }
    if(op==='news'){const [last]=await q`SELECT value FROM game_state WHERE key='president_news_at'`;if(last&&Date.now()-new Date(last.value).getTime()<7200000)throw new E('Новину можна оголошувати раз на 2 години');const message=String(payload.message||'').trim().slice(0,2000);if(!message)throw new E('Напиши текст новини');await stateSet(q,'president_news_at',new Date().toISOString());const users=await q`SELECT id FROM users WHERE id>0 AND id<>${userId}`;for(const u of users)await inbox(q,u.id,'AFK President',`🇺🇦 Новина від президента: ${message}`);return {ok:true,count:users.length};}
    throw new E('Невідома дія президента');
  },
  async bankBorrow(userId,payload) {
    const q=await getSql(); const amount=int(payload.amount,1000,BANK_LOAN_MAX,'Кредит від банку: сума від 1 000 до 100 000 000 грн');
    const days=int(payload.days,1,10,'Строк має бути від 1 до 10 днів');
    const rate=bankRate(amount); const [u]=await q`SELECT bank_blocked,bank_banned FROM users WHERE id=${userId}`;
    if(u?.bank_blocked||u?.bank_banned) throw new E('Доступ до банківського кредитування заблоковано');
    const [active]=await q`SELECT id FROM bank_deals WHERE borrower_id=${userId} AND status IN ('active','grace','processing') LIMIT 1`;
    if(active) throw new E('Спочатку погаси свій попередній кредит');
    const [deal]=await q`INSERT INTO bank_deals(lender_id,borrower_id,initiator_id,recipient_id,principal,rate,days,status,due_at,loan_source)
      VALUES(0,${userId},${userId},${userId},${amount},${rate},${days},'active',now()+(${days}*interval '1 day'),'bank') RETURNING id,due_at`;
    await q`UPDATE users SET bal=bal+${amount} WHERE id=${userId}`;
    await inbox(q,userId,'AFK Bank',`🏦 Банк видав кредит ${amount.toLocaleString('uk-UA')} грн під ${rate}% на ${days} дн. До повернення: ${totalDue(amount,rate).toLocaleString('uk-UA')} грн.`);
    return {id:deal.id,principal:amount,rate,totalDue:totalDue(amount,rate),dueAt:deal.due_at,me:await getMe(userId)};
  },
  async bankRemind(userId,payload) {
    const q=await getSql(); const id=int(payload.id,1,2_000_000_000,'Кредит не знайдено');
    const [row]=await q`UPDATE bank_deals SET reminder_at=now()+interval '1 hour' WHERE id=${id} AND borrower_id=${userId} AND status='grace' RETURNING id`;
    if(!row) throw new E('Нагадування доступне лише для кредиту в пільговому періоді');
    return {ok:true};
  },
  async bankList(userId) {
    const q=await getSql(); await processBankDeadlines(q);
    const [user]=await q`SELECT bank_blocked,bank_banned,bank_ban_reason FROM users WHERE id=${userId}`;
    const rows=await q`SELECT d.*,CASE WHEN d.lender_id=0 THEN 'AFK Bank' ELSE l.nick END AS lender,
      b.nick AS borrower FROM bank_deals d LEFT JOIN users l ON l.id=d.lender_id JOIN users b ON b.id=d.borrower_id
      WHERE d.lender_id=${userId} OR d.borrower_id=${userId} ORDER BY d.created_at DESC LIMIT 50`;
    const deals=rows.map(d=>({id:Number(d.id),lender:d.lender,borrower:d.borrower,principal:Number(d.principal),rate:Number(d.rate),days:Number(d.days),
      status:d.status,loanSource:d.loan_source||'player',initiatedByMe:Number(d.initiator_id)===userId,recipientMe:Number(d.recipient_id)===userId,
      dueAt:d.due_at,graceUntil:d.grace_until,totalDue:totalDue(d.principal,d.rate),reminderSet:Boolean(d.reminder_at)}));
    return {deals,bankBlocked:Boolean(user?.bank_blocked||user?.bank_banned),bankBanReason:user?.bank_ban_reason||null,me:await getMe(userId)};
  },
  async bankCreate(userId,payload) {
    const q=await getSql();
    const kind=payload.kind==='offer'?'offer':payload.kind==='request'?'request':'';
    if(!kind) throw new E('Невідомий тип кредитної заявки');
    const nick=String(payload.nick||'').trim().toLocaleLowerCase('uk-UA');
    const amount=int(payload.amount,BANK_MIN,BANK_MAX,'Сума має бути від 1 000 до 2 000 000 000 грн');
    const rate=Number(payload.rate); if(!Number.isFinite(rate)||rate<.1||rate>70)throw new E('Відсоток має бути від 0,1 до 70');
    const days=int(payload.days,1,10,'Строк має бути від 1 до 10 днів');
    const [actor]=await q`SELECT id,bal FROM users WHERE id=${userId}`;
    const [target]=await q`SELECT id,nick,bal FROM users WHERE nick_lc=${nick} AND id<>${userId}`;
    if(!target)throw new E('Гравця не знайдено');
    const lenderId=kind==='offer'?userId:target.id, borrowerId=kind==='offer'?target.id:userId;
    if(kind==='offer'&&Number(actor.bal)<amount)throw new E('У тебе недостатньо коштів для такої пропозиції');
    if(kind==='request'&&Number(target.bal)<amount)throw new E('У кредитора недостатньо коштів');
    const [active]=await q`SELECT id FROM bank_deals WHERE borrower_id=${borrowerId} AND status IN ('active','grace','processing') LIMIT 1`;
    if(active)throw new E('Позичальник уже має непогашений кредит');
    const [row]=await q`INSERT INTO bank_deals(lender_id,borrower_id,initiator_id,recipient_id,principal,rate,days,loan_source)
      VALUES(${lenderId},${borrowerId},${userId},${target.id},${amount},${rate},${days},'player') RETURNING id`;
    await inbox(q,target.id,'AFK Bank',`Нова ${kind==='offer'?'пропозиція':'заявка'} на кредит №${row.id}: ${amount.toLocaleString('uk-UA')} грн, ${rate}% на ${days} дн. До повернення: ${totalDue(amount,rate).toLocaleString('uk-UA')} грн.`);
    return {id:row.id,me:await getMe(userId)};
  },
  async bankRespond(userId,payload) {
    const q=await getSql();const id=int(payload.id,1,2_000_000_000,'Заявку не знайдено');const action=String(payload.action||'');
    const [deal]=await q`SELECT * FROM bank_deals WHERE id=${id} AND recipient_id=${userId} AND status='pending'`;
    if(!deal)throw new E('Заявка вже недоступна або призначена іншому гравцю');
    if(action==='reject'){
      const [r]=await q`UPDATE bank_deals SET status='rejected' WHERE id=${id} AND status='pending' RETURNING id`;
      if(!r)throw new E('Заявку вже оброблено');const otherId=Number(deal.initiator_id)===userId?Number(deal.recipient_id):Number(deal.initiator_id);await inbox(q,otherId,'AFK Bank',`Заявку №${id} відхилено.`);return {me:await getMe(userId)};
    }
    if(action==='counter'){
      const amount=int(payload.amount,BANK_MIN,BANK_MAX,'Сума має бути від 1 000 до 2 000 000 000 грн');const rate=Number(payload.rate);if(!Number.isFinite(rate)||rate<.1||rate>70)throw new E('Відсоток має бути від 0,1 до 70');const days=int(payload.days,1,10,'Строк має бути від 1 до 10 днів');
      const [closed]=await q`UPDATE bank_deals SET status='countered' WHERE id=${id} AND status='pending' RETURNING id`;if(!closed)throw new E('Заявку вже оброблено');
      const [next]=await q`INSERT INTO bank_deals(lender_id,borrower_id,initiator_id,recipient_id,principal,rate,days,loan_source)
        VALUES(${deal.lender_id},${deal.borrower_id},${userId},${deal.initiator_id},${amount},${rate},${days},'player') RETURNING id`;
      await inbox(q,deal.initiator_id,'AFK Bank',`Контрпропозиція №${next.id}: ${amount.toLocaleString('uk-UA')} грн, ${rate}% на ${days} дн. До повернення ${totalDue(amount,rate).toLocaleString('uk-UA')} грн.`);
      return {id:next.id,me:await getMe(userId)};
    }
    if(action!=='accept')throw new E('Невідома дія');
    const [active]=await q`SELECT id FROM bank_deals WHERE borrower_id=${deal.borrower_id} AND status IN ('active','grace','processing') LIMIT 1`;
    if(active)throw new E('Позичальник уже має непогашений кредит');
    const [moved]=await q`WITH locked AS (SELECT * FROM bank_deals WHERE id=${id} AND status='pending' AND recipient_id=${userId} FOR UPDATE),
      debit AS (UPDATE users SET bal=bal-(SELECT principal FROM locked) WHERE id=(SELECT lender_id FROM locked) AND bal >= (SELECT principal FROM locked) RETURNING id),
      activated AS (UPDATE bank_deals SET status='active',due_at=now()+(days*interval '1 day') WHERE id=${id} AND status='pending' AND EXISTS(SELECT 1 FROM debit) RETURNING lender_id,borrower_id,principal),
      credit AS (UPDATE users SET bal=bal+(SELECT principal FROM activated) WHERE id=(SELECT borrower_id FROM activated) RETURNING id)
      SELECT count(*)::int AS n FROM credit`;
    if(!moved?.n)throw new E('Кредитор не має достатньо коштів або заявку вже оброблено');
    await inbox(q,deal.borrower_id,'AFK Bank',`Кредит №${id} схвалено. Зараховано ${Number(deal.principal).toLocaleString('uk-UA')} грн. До повернення ${totalDue(deal.principal,deal.rate).toLocaleString('uk-UA')} грн.`);
    await inbox(q,deal.lender_id,'AFK Bank',`Кредит №${id} видано. Позичальник отримав ${Number(deal.principal).toLocaleString('uk-UA')} грн.`);
    return {me:await getMe(userId)};
  },
  async bankPay(userId,payload) {
    const q=await getSql();await processBankDeadlines(q);const id=int(payload.id,1,2_000_000_000,'Кредит не знайдено');
    const [deal]=await q`SELECT lender_id,principal,rate,status,grace_until FROM bank_deals WHERE id=${id} AND borrower_id=${userId} AND status IN ('active','grace')`;
    if(!deal)throw new E('Активний кредит або кредит у пільговому періоді не знайдено');
    const due=totalDue(deal.principal,deal.rate);
    const [paid]=await q`WITH debit AS (UPDATE users SET bal=bal-${due} WHERE id=${userId} AND bal>=${due} RETURNING id),
      credit AS (UPDATE users SET bal=bal+${due} WHERE id=${deal.lender_id} AND ${Number(deal.lender_id)>0} AND EXISTS(SELECT 1 FROM debit) RETURNING id),
      close AS (UPDATE bank_deals SET status='paid',paid_at=now(),paid_amount=${due} WHERE id=${id} AND borrower_id=${userId} AND status IN ('active','grace') AND EXISTS(SELECT 1 FROM debit) RETURNING id)
      SELECT count(*)::int AS n FROM close`;
    if(!paid?.n)throw new E('Недостатньо коштів або кредит уже погашено');
    if(Number(deal.lender_id)>0)await inbox(q,deal.lender_id,'AFK Bank',`Кредит №${id} погашено. Зараховано ${due.toLocaleString('uk-UA')} грн.`);
    await inbox(q,userId,'AFK Bank',`✅ Кредит №${id} успішно погашено. Сума: ${due.toLocaleString('uk-UA')} грн.`);
    return {paid:due,me:await getMe(userId)};
  },
  async marketList(userId) {
    const q=await getSql();
    const [user]=await q`SELECT house,biz,garage_protect FROM users WHERE id=${userId}`;
    const listings=await q`SELECT m.id,m.asset_type,m.asset_key,m.price,m.created_at,u.nick AS seller,
      c.name AS car_name FROM market_listings m JOIN users u ON u.id=m.seller_id
      LEFT JOIN cars c ON c.id=m.car_id WHERE m.status='active' AND m.seller_id<>${userId} ORDER BY m.created_at DESC LIMIT 100`;
    const cars=await q`SELECT id,name FROM cars WHERE user_id=${userId} ORDER BY id`;
    const businesses=await q`SELECT name FROM business_assets WHERE user_id=${userId} ORDER BY id`;
    const houses=await q`SELECT name,quantity FROM house_assets WHERE user_id=${userId} AND quantity>0 ORDER BY name`;
    const ownListings=await q`SELECT id,asset_type,asset_key,price FROM market_listings WHERE seller_id=${userId} AND status='active' ORDER BY id DESC`;
    return { ownListings:ownListings.map(x=>({id:x.id,type:x.asset_type,name:x.asset_key,price:Number(x.price)})), listings:listings.map(x=>({id:x.id,type:x.asset_type,key:x.asset_key,name:x.car_name||x.asset_key,price:Number(x.price),seller:x.seller})),
      own:{cars:cars.map(x=>({id:x.id,name:x.name})),house:user.house,houses:houses.map(x=>({name:x.name,quantity:Number(x.quantity)})),biz:user.biz,businesses:businesses.map(x=>x.name),protected:Boolean(user.garage_protect)} };
  },

  async marketCreate(userId,payload) {
    const q=await getSql();
    const type=String(payload.type||'');
    const price=int(payload.price,1,MAX_BALANCE_ACTION,'Вкажи коректну ціну');
    if (!['car','house'].includes(type)) throw new E('На ринку доступні автомобілі та нерухомість');
    const [user]=await q`SELECT house,biz,garage_protect FROM users WHERE id=${userId}`;
    if (type === 'car' && user.garage_protect) throw new E('Захист гаража увімкнений. Вимкни його перед продажем автомобіля');
    if(type==='car'){
      const carId=int(payload.assetId,1,2_000_000_000,'Автомобіль не знайдено');
      const [car]=await q`SELECT id,name FROM cars WHERE id=${carId} AND user_id=${userId}`;
      if(!car) throw new E('Автомобіль не належить тобі');
      const [already]=await q`SELECT id FROM market_listings WHERE seller_id=${userId} AND asset_type='car' AND car_id=${carId} AND status='active' LIMIT 1`;
      if(already) throw new E('Цей автомобіль уже виставлений на ринок');
      const [row]=await q`INSERT INTO market_listings(seller_id,asset_type,asset_key,car_id,price)
        VALUES(${userId},'car',${car.name},${carId},${price}) RETURNING id`;
      await inbox(q,userId,'AFK Market',`Автомобіль «${car.name}» виставлено на ринок за ${price.toLocaleString('uk-UA')} грн.`);
      return {id:row.id};
    }
    const key=String(payload.assetKey||'').trim();
    const catalog=D.houses.find(x=>x[0]===key);
    if(!catalog) throw new E('Обери нерухомість із каталогу');
    const [already]=await q`SELECT id FROM market_listings WHERE seller_id=${userId} AND asset_type='house' AND asset_key=${key} AND status='active' LIMIT 1`;
    if(already) throw new E('Ця нерухомість уже виставлена на ринок');
    const [row]=await q`WITH reserved AS (
      UPDATE house_assets SET quantity=quantity-1
      WHERE user_id=${userId} AND name=${key} AND quantity>0
        AND NOT EXISTS(SELECT 1 FROM market_listings WHERE seller_id=${userId} AND asset_type='house' AND asset_key=${key} AND status='active')
      RETURNING name,quantity
    ), listing AS (
      INSERT INTO market_listings(seller_id,asset_type,asset_key,car_id,price)
      SELECT ${userId},'house',name,NULL,${price} FROM reserved RETURNING id
    ) SELECT listing.id,reserved.quantity FROM listing,reserved`;
    if(!row) throw new E('Цієї нерухомості немає в інвентарі або її вже виставили');
    if(user.house===key && Number(row.quantity)===0) await q`UPDATE users SET house=NULL WHERE id=${userId} AND house=${key}`;
    await inbox(q,userId,'AFK Market',`Нерухомість «${key}» виставлено на ринок за ${price.toLocaleString('uk-UA')} грн.`);
    return {id:row.id};
  },

  async marketBuy(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Оголошення не знайдено');
    const [listing]=await q`SELECT * FROM market_listings WHERE id=${id} AND status='active' AND seller_id<>${userId}`;
    if(!listing) throw new E('Оголошення вже недоступне');
    if(listing.asset_type!=='car'&&listing.asset_type!=='house') throw new E('Цей тип майна не продається на ринку');
    const moved=await q`WITH locked AS (
        SELECT * FROM market_listings WHERE id=${id} AND status='active' AND seller_id<>${userId}
          AND ((asset_type='car' AND EXISTS(SELECT 1 FROM cars c JOIN users s ON s.id=c.user_id WHERE c.id=market_listings.car_id AND c.user_id=market_listings.seller_id AND s.garage_protect=false))
            OR (asset_type='house' AND EXISTS(SELECT 1 FROM market_listings ml WHERE ml.id=market_listings.id))) FOR UPDATE
      ), debit AS (
        UPDATE users SET bal=bal-(SELECT price FROM locked)
        WHERE id=${userId} AND bal >= (SELECT price FROM locked)
        RETURNING id
      ), credit AS (
        UPDATE users SET bal=bal+(SELECT price FROM locked),
          car=CASE WHEN (SELECT asset_type FROM locked)='car' AND car=(SELECT asset_key FROM locked) THEN NULL ELSE car END
        WHERE id=(SELECT seller_id FROM locked) AND EXISTS(SELECT 1 FROM debit) RETURNING id
      ), carmove AS (
        UPDATE cars SET user_id=${userId} WHERE id=(SELECT car_id FROM locked) AND EXISTS(SELECT 1 FROM credit) AND (SELECT asset_type FROM locked)='car' RETURNING id
      ), housemove AS (
        INSERT INTO house_assets(user_id,name,price,quantity)
        SELECT ${userId},asset_key,${D.houses.find(x=>x[0]===listing.asset_key)?.[1]||0},1 FROM locked
        WHERE asset_type='house' AND EXISTS(SELECT 1 FROM credit)
        ON CONFLICT(user_id,name) DO UPDATE SET quantity=house_assets.quantity+1
        RETURNING name
      ), activate_house AS (
        UPDATE users SET house=(SELECT asset_key FROM locked) WHERE id=${userId} AND house IS NULL
          AND EXISTS(SELECT 1 FROM housemove) RETURNING id
      ), sold AS (
        UPDATE market_listings SET status='sold',buyer_id=${userId},sold_at=now()
        WHERE id=${id} AND status='active' AND EXISTS(SELECT 1 FROM credit)
          AND ((SELECT asset_type FROM locked)='house' AND EXISTS(SELECT 1 FROM housemove) OR (SELECT asset_type FROM locked)='car' AND EXISTS(SELECT 1 FROM carmove))
        RETURNING id
      ) SELECT count(*)::int AS bought FROM sold`;
    if(!moved[0]?.bought) throw new E('Недостатньо коштів, майно змінило власника або оголошення недоступне');
    const [buyer]=await q`SELECT nick FROM users WHERE id=${userId}`;
    const [seller]=await q`SELECT nick FROM users WHERE id=${listing.seller_id}`;
    const assetType=listing.asset_type==='car'?'автомобіль':'нерухомість';
    await inbox(q,listing.seller_id,'AFK Market',`${buyer.nick} придбав твоє оголошення «${listing.asset_key}» (${assetType}) за ${Number(listing.price).toLocaleString('uk-UA')} грн.`);
    return {purchased:{type:listing.asset_type,name:listing.asset_key,price:Number(listing.price),seller:seller.nick},me:await getMe(userId)};
  },

  async marketCancel(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Оголошення не знайдено');
    const [listing]=await q`SELECT asset_type,asset_key FROM market_listings WHERE id=${id} AND seller_id=${userId} AND status='active'`;
    if(!listing) throw new E('Оголошення не знайдено або його вже закрито');
    if(listing.asset_type==='house'){
      const price=D.houses.find(x=>x[0]===listing.asset_key)?.[1]||0;
      const [result]=await q`WITH closed AS (
        UPDATE market_listings SET status='cancelled' WHERE id=${id} AND seller_id=${userId} AND status='active' RETURNING asset_key
      ), restored AS (
        INSERT INTO house_assets(user_id,name,price,quantity)
        SELECT ${userId},asset_key,${price},1 FROM closed
        ON CONFLICT(user_id,name) DO UPDATE SET quantity=house_assets.quantity+1
        RETURNING name
      ) SELECT count(*)::int AS n FROM restored`;
      if(!result?.n)throw new E('Оголошення вже закрито');
      await q`UPDATE users SET house=COALESCE(house,${listing.asset_key}) WHERE id=${userId}`;
    }else{
      const [result]=await q`UPDATE market_listings SET status='cancelled' WHERE id=${id} AND seller_id=${userId} AND status='active' RETURNING id`;
      if(!result)throw new E('Оголошення вже закрито');
    }
    return {me:await getMe(userId)};
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
    const [listing]=await q`SELECT asset_type,asset_key FROM market_listings WHERE id=${id} AND seller_id=${userId} AND status='active'`;
    if(!listing) throw new E('Оголошення не знайдено або його вже закрито');
    if(listing.asset_type==='house'){
      const price=D.houses.find(x=>x[0]===listing.asset_key)?.[1]||0;
      const [result]=await q`WITH closed AS (
        UPDATE market_listings SET status='cancelled' WHERE id=${id} AND seller_id=${userId} AND status='active' RETURNING asset_key
      ), restored AS (
        INSERT INTO house_assets(user_id,name,price,quantity)
        SELECT ${userId},asset_key,${price},1 FROM closed
        ON CONFLICT(user_id,name) DO UPDATE SET quantity=house_assets.quantity+1
        RETURNING name
      ) SELECT count(*)::int AS n FROM restored`;
      if(!result?.n)throw new E('Оголошення вже закрито');
      await q`UPDATE users SET house=COALESCE(house,${listing.asset_key}) WHERE id=${userId}`;
    }else{
      const [result]=await q`UPDATE market_listings SET status='cancelled' WHERE id=${id} AND seller_id=${userId} AND status='active' RETURNING id`;
      if(!result)throw new E('Оголошення вже закрито');
    }
    return {me:await getMe(userId)};
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
    const rows=await q`SELECT id,sender,message,created_at,read_at FROM inbox WHERE user_id=${userId} AND read_at IS NULL ORDER BY id ASC LIMIT 30`;
    if(rows.length) await q`UPDATE inbox SET read_at=now() WHERE user_id=${userId} AND read_at IS NULL`;
    return {messages:rows};
  },
  async pushRegister(userId,payload) {
    const q=await getSql(); const subscription=payload.subscription;
    const endpoint=String(subscription?.endpoint||'');
    if(!endpoint.startsWith('https://')||endpoint.length>3000||!subscription?.keys?.p256dh||!subscription?.keys?.auth) throw new E('Некоректна підписка на сповіщення');
    await q`INSERT INTO push_subscriptions(user_id,endpoint,subscription) VALUES(${userId},${endpoint},${JSON.stringify(subscription)}::jsonb)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,subscription=EXCLUDED.subscription`;
    return {ok:true};
  },
  async pushRemove(userId,payload) {
    const q=await getSql(); const endpoint=String(payload.endpoint||'');
    await q`DELETE FROM push_subscriptions WHERE user_id=${userId} AND endpoint=${endpoint}`;
    return {ok:true};
  },

  async admin(userId, payload) {
    const q = await getSql();
    const [actor] = await q`SELECT nick, role FROM users WHERE id = ${userId}`;
    if (!actor || !isAdmin(actor.role)) throw new E('🔒 Лише для адміністраторів', 403);
    if(payload.op==='players'){
      const players=await q`SELECT id,nick,avatar,role,bal,ok FROM users WHERE id>0 ORDER BY id LIMIT 100`;
      return {players:players.map(x=>({id:Number(x.id),nick:x.nick,avatar:x.avatar,role:x.role,bal:Number(x.bal),level:level(Number(x.ok))})),vehicles:CAR_CATALOG.map(x=>({name:x.name,value:x.value})),businesses:D.biz.map(x=>({name:x[0],price:x[1],hourlyProfit:x[2],category:x[3]||'Інше'}))};
    }
    if (payload.op === 'log') {
      const log = await q`SELECT at, admin, text FROM alog ORDER BY id DESC LIMIT 30`;
      return { log };
    }

    const noTarget = ['promo_create','msg_broadcast','election_start'].includes(payload.op);
    const targetId=payload.playerId?int(payload.playerId,1,2_000_000_000,'Обери гравця зі списку'):0;
    const targetNick = String(payload.nick || '').trim().toLocaleLowerCase('uk-UA');
    const [target] = noTarget ? [null] : targetId ? await q`SELECT id,nick,role FROM users WHERE id=${targetId}` : await q`SELECT id,nick,role FROM users WHERE nick_lc=${targetNick}`;
    if (!noTarget && !target) throw new E('Обери гравця зі списку');
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
      if(actor.role!=='owner') throw new E('Видавати автомобілі може лише власник',403);
      const vehicle = CAR_CATALOG.find(car => car.name === String(payload.value||''));
      if (!vehicle) throw new E('Автомобіль не знайдено в каталозі');
      await q`INSERT INTO cars(user_id,name,value,jackpot) VALUES(${target.id},${vehicle.name},${vehicle.value},false)`;
      logText = `give_vehicle ${target.nick} ${vehicle.name}`;
    } else if (payload.op === 'give_business') {
      if(actor.role!=='owner') throw new E('Видавати бізнеси може лише власник',403);
      const business = D.biz.find(row => row[0] === String(payload.value||''));
      if (!business) throw new E('Бізнес не знайдено в каталозі');
      await q`INSERT INTO business_assets(user_id,name,price,hourly_profit,purchased_at,last_paid_at)
        VALUES(${target.id},${business[0]},${business[1]},${business[2]},now(),now()) ON CONFLICT(user_id,name) DO NOTHING`;
      await q`UPDATE users SET biz=COALESCE(biz,${business[0]}) WHERE id=${target.id}`;
      logText = `give_business ${target.nick} ${business[0]}`;
    } else if (payload.op === 'block_bank' || payload.op === 'unblock_bank') {
      const blocked = payload.op === 'block_bank';
      const reason=String(payload.value||'').trim().slice(0,300);
      await q`UPDATE users SET bank_blocked=${blocked},bank_ban_reason=${blocked?(reason||'Рішення адміністрації'):null} WHERE id=${target.id}`;
      await inbox(q,target.id,'AFK Admin',blocked?`Доступ до кредитів банку заблоковано. Причина: ${reason||'Рішення адміністрації'}`:'Доступ до кредитів банку відновлено.');
      logText = `${payload.op} ${target.nick}${blocked?' · '+(reason||'без причини'):''}`;
    } else if (payload.op === 'msg_send') {
      const message = String(payload.value||'').trim().slice(0,4000);
      if (!message) throw new E('Повідомлення порожнє');
      await inbox(q,target.id,actor.nick,message);
      logText = `msg_send ${target.nick}`;
    } else if (payload.op === 'msg_broadcast') {
      const message=String(payload.value||'').trim().slice(0,4000);
      if(!message) throw new E('Повідомлення порожнє');
      const users=await q`SELECT id FROM users WHERE id>0`;
      for(const u of users) await inbox(q,u.id,actor.nick,message);
      logText=`msg_broadcast ${users.length} гравців`;
    } else if (payload.op === 'promo_create') {
      const code = String(payload.value||'').trim().toUpperCase();
      const reward = int(payload.n,1,MAX_BALANCE_ACTION,'Некоректна винагорода');
      const maxUses = int(payload.maxUses||1,1,100000,'Ліміт використань має бути від 1 до 100 000');
      if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new E('Промокод: 3–32 символи A–Z, 0–9, _ або -');
      await q`INSERT INTO promo_codes(code,reward,max_uses,created_by) VALUES(${code},${reward},${maxUses},${userId})`;
      logText = `promo_create ${code} +${reward} (${maxUses} uses)`;
    } else if (payload.op === 'giveadmin' || payload.op === 'takeadmin' || payload.op === 'setadmin') {
      if (actor.role !== 'owner') throw new E('Змінювати статус адміністраторів може лише власник', 403);
      if (target.role === 'owner') throw new E('Не можна змінити роль власника', 403);
      const nextRole = payload.op === 'giveadmin' ? 'admin' : payload.op === 'takeadmin' ? 'user' : (payload.enabled===true || payload.n===1 || payload.n==='1' ? 'admin' : 'user');
      await q`UPDATE users SET role = ${nextRole} WHERE id = ${target.id}`;
      logText = `${payload.op} ${target.nick} → ${nextRole}`;
    } else if(payload.op==='assign_president') {
      if(actor.role!=='owner') throw new E('Призначати президента без виборів може лише власник',403);
      await q`UPDATE president_elections SET status='cancelled' WHERE status IN ('active','scheduled')`;
      await stateSet(q,'president_id',String(target.id));
      const users=await q`SELECT id FROM users WHERE id>0`;
      for(const u of users) await inbox(q,u.id,'AFK Elections',`🏛️ ${target.nick} призначено Президентом рішенням власника. Відкрий розділ «Країна та вибори», щоб переглянути державний кабінет.`);
      logText=`assign_president ${target.nick}`;
    } else if(payload.op==='election_start') {
      if(actor.role!=='owner') throw new E('Запускати позапланові вибори може лише власник',403);
      const [busy]=await q`SELECT id FROM president_elections WHERE status IN ('active','scheduled') LIMIT 1`;
      if(busy) throw new E('Вже є активні або заплановані вибори. Спочатку заверши їх.');
      const start=payload.when==='now'?new Date():new Date(String(payload.startsAt||''));
      if(!Number.isFinite(start.getTime())) throw new E('Вкажи коректну дату й час');
      const delta=start.getTime()-Date.now();
      if(delta < -5000 || delta > 30*24*60*60*1000) throw new E('Вибори можна запустити зараз або запланувати в межах наступних 30 днів');
      const ends=new Date(start.getTime()+70*60*1000);
      const [created]=await q`INSERT INTO president_elections(started_at,ends_at,reason,status) VALUES(${start.toISOString()},${ends.toISOString()},'admin','scheduled') RETURNING id`;
      if(delta<=5000) await refreshPolitics(q);
      else { const users=await q`SELECT id FROM users WHERE id>0`; for(const u of users) await inbox(q,u.id,'AFK Elections',`🗓️ Власник запланував президентські вибори на ${start.toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'})} за Києвом. Тривалість — 70 хвилин.`); }
      logText=`election_start #${created.id} ${start.toISOString()}`;
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
  if (code === '23505' && String(error?.constraint||'').startsWith('mines_')) return { message: 'У тебе вже є активне мінне поле. Заверши його або повернися до поточного раунду.', status: 409 };
  if (code === '23505' && String(error?.constraint||'').startsWith('blackjack_')) return { message: 'У тебе вже є незавершений блек-джек або запрошення. Заверши його перед новою грою.', status: 409 };
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
      return J({ ok: true, database: databaseKind, version: '8.4.0', vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null, pushEnabled: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT), timezone: 'Europe/Kyiv' });
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

export async function runScheduledMaintenance() { await scheduledMaintenance(); return {ok:true}; }

export const config = { path: '/api' };
