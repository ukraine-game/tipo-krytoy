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
      try { await webpush.sendNotification(row.subscription,JSON.stringify({title,body,url:'/'}),{TTL:3600}); }
      catch(error) { if([404,410].includes(error?.statusCode)) await q`DELETE FROM push_subscriptions WHERE id=${row.id}`; }
    }));
  } catch(error) { console.error('AFK push delivery failed:',error?.message||error); }
}
async function inbox(q,userId,sender,message) {
  if (Number(userId)>0) {
    const text=String(message).slice(0,4000);
    await q`INSERT INTO inbox(user_id,sender,message) VALUES(${userId},${sender},${text})`;
    await sendPush(q,userId,String(sender),text);
  }
}
async function settleBusinessIncome(q,userId) {
  const [active]=await q`SELECT b.* FROM business_assets b JOIN users u ON u.id=b.user_id
    WHERE b.user_id=${userId} AND u.biz=b.name LIMIT 1`;
  if(!active) return 0;
  const [due]=await q`SELECT floor(EXTRACT(EPOCH FROM (now()-${active.last_paid_at}))/3600)::int AS hours`;
  const hours=Math.max(0,Number(due?.hours||0));
  if(hours<1) return 0;
  const [taxRow]=await q`SELECT value FROM game_state WHERE key='business_tax'`;
  const taxPercent=Math.max(0,Math.min(15,Number(taxRow?.value??5)));
  const gross=hours*Number(active.hourly_profit);
  const tax=Math.floor(gross*taxPercent/100);
  const net=gross-tax;
  const updated=await q`UPDATE business_assets SET last_paid_at=last_paid_at+(${hours}*interval '1 hour')
    WHERE id=${active.id} AND last_paid_at=${active.last_paid_at} RETURNING id`;
  if(!updated.length) return 0;
  await q`UPDATE users SET bal=bal+${net} WHERE id=${userId}`;
  if(tax>0) await q`UPDATE game_state SET value=(value::bigint+${tax})::text WHERE key='treasury'`;
  await q`INSERT INTO business_payouts(user_id,business_name,hours,gross,tax,net) VALUES(${userId},${active.name},${hours},${gross},${tax},${net})`;
  await inbox(q,userId,'AFK Business',`🏢 Бізнес «${active.name}» приніс ${net.toLocaleString('uk-UA')} грн за ${hours} год. До казни: ${tax.toLocaleString('uk-UA')} грн податку (${taxPercent}%).`);
  return net;
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
  let [active]=await q`SELECT * FROM president_elections WHERE status='active' ORDER BY id DESC LIMIT 1`;

  // Close pre-6.0 ad-hoc elections so they cannot block the new weekly schedule.
  if(active && active.week_key!==weekKey && local.weekday==='Mon' && minuteOfDay>=electionStart) {
    await q`UPDATE president_elections SET status='finished' WHERE id=${active.id} AND status='active'`;
    active=null;
  }

  if(active && (new Date(active.ends_at)<=now || (minuteOfDay>=electionEnd && active.week_key===weekKey))) {
    const tally=await q`SELECT c.user_id AS candidate_id,count(v.voter_id)::int AS votes FROM president_candidates c LEFT JOIN president_votes v ON v.election_id=c.election_id AND v.candidate_id=c.user_id WHERE c.election_id=${active.id} GROUP BY c.user_id`;
    const maxVotes=Math.max(0,...tally.map(x=>Number(x.votes)));
    const tied=tally.filter(x=>Number(x.votes)===maxVotes);
    const winner=tied.length?tied[randomInt(0,tied.length)]:null;
    await q`UPDATE president_elections SET status='finished',winner_id=${winner?.candidate_id||null} WHERE id=${active.id} AND status='active'`;
    await stateSet(q,'president_id',winner?.candidate_id||'');
    await stateSet(q,'last_election_week',weekKey);
    const [winnerUser]=winner?await q`SELECT nick FROM users WHERE id=${winner.candidate_id}`:[null];
    const users=await q`SELECT id FROM users WHERE id>0`;
    const resultText=winner?`🇺🇦 Вибори завершено! Президент — ${winnerUser?.nick||'кандидат'}. ${tied.length>1?'За однакової кількості голосів переможця обрала випадкова жеребкування.':''}`:'🇺🇦 Вибори завершено без голосів. Посада президента тимчасово вакантна.';
    for(const u of users) await inbox(q,u.id,'AFK Elections',resultText);
    active=null;
  }

  // One election each Monday, Kyiv time: candidature and voting run 13:10–14:20.
  if(!active && local.weekday==='Mon' && minuteOfDay>=electionStart && minuteOfDay<electionEnd) {
    const lastWeek=await stateGet(q,'last_election_week','');
    if(lastWeek!==weekKey) {
      const secondsRemaining=(electionEnd-minuteOfDay)*60-local.second;
      const [created]=await q`INSERT INTO president_elections(ends_at,reason,week_key) VALUES(now()+(${Math.max(1,secondsRemaining)}*interval '1 second'),'weekly',${weekKey}) ON CONFLICT DO NOTHING RETURNING id`;
      if(created) {
        await stateSet(q,'last_election_week',weekKey);
        const users=await q`SELECT id FROM users WHERE id>0`;
        for(const u of users) await inbox(q,u.id,'AFK Elections','🗳️ Почалися щотижневі вибори Президента! З 13:10 до 14:20 можна подати кандидатуру або проголосувати в розділі «Країна».');
        [active]=await q`SELECT * FROM president_elections WHERE id=${created.id}`;
      }
    }
  }
}
async function scheduledMaintenance() {
  await init(); const q=await getSql();
  // Handle election boundaries before any potentially long per-user maintenance loop.
  await refreshPolitics(q);
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
    id, nick, avatar, role, bal, ok, stam, car, house, biz, bank_blocked, bank_banned, bank_ban_reason, garage_protect, garage_type, garage_checked_at, business_claim_at, custom_role_id,
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

async function settleExpiredMatch(q, matchId) {
  const rows = await q`WITH done AS (
    UPDATE game_matches SET
      status='completed',
      winner_id=CASE
        WHEN game='cookie' AND creator_score>opponent_score THEN creator_id
        WHEN game='cookie' AND opponent_score>creator_score THEN opponent_id
        ELSE NULL END,
      settled=true
    WHERE id=${matchId} AND status IN ('choosing','active') AND settled=false AND ends_at IS NOT NULL AND ends_at<=now()
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
      return {me:await getMe(userId)};
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
    return {me:await getMe(userId)};
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
    const [sender] = await q`SELECT role FROM users WHERE id = ${userId}`;
    if (!isAdmin(sender?.role)) await q`UPDATE users SET ok = ok + 1 WHERE id = ${userId}`;
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
  async gamesStart(userId,payload) {
    const q=await getSql();
    const game=String(payload.game||'');
    if(game!=='coin') throw new E('Доступна лише безкоштовна анімація монетки. Печенька та число — тільки матчі з другом.');
    const prediction=String(payload.prediction||'');
    if(!['heads','tails'].includes(prediction)) throw new E('Обери орла або решку перед кидком');
    const recent=await q`SELECT id FROM game_challenges WHERE user_id=${userId} AND created_at>now()-interval '2 seconds' LIMIT 1`;
    if(recent.length) throw new E('Зроби коротку паузу перед наступним кидком');
    const answer=randomInt(0,2)?'heads':'tails';
    const [row]=await q`INSERT INTO game_challenges(user_id,game,answer,prompt,metadata,expires_at)
      VALUES(${userId},'coin',${answer},'50/50',${JSON.stringify({prediction})}::jsonb,now()+interval '2 minutes') RETURNING id`;
    return {challenge:{id:row.id,game:'coin',prompt:'50/50',seconds:45}};
  },
  async gamesFinish(userId,payload) {
    const q=await getSql();
    const id=int(payload.id,1,2_000_000_000,'Кидок не знайдено');
    const [challenge]=await q`UPDATE game_challenges SET completed_at=now()
      WHERE id=${id} AND user_id=${userId} AND game='coin' AND completed_at IS NULL AND expires_at>now()
      RETURNING answer,metadata`;
    if(!challenge) throw new E('Кидок уже використано або час вийшов');
    const meta=typeof challenge.metadata==='string'?JSON.parse(challenge.metadata||'{}'):(challenge.metadata||{});
    const correct=String(meta.prediction)===String(challenge.answer);
    const points=0;
    return {correct,points,result:{side:challenge.answer,prediction:meta.prediction},me:await getMe(userId)};
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
    const [existing] = await q`SELECT id FROM game_matches WHERE status IN ('pending','choosing','active') AND (creator_id=${userId} OR opponent_id=${userId} OR creator_id=${opponent.id} OR opponent_id=${opponent.id}) LIMIT 1`;
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
      await inbox(q,rows[0].creator_id,'AFK Games',`Запрошення в матч №${id} відхилено.`);
      return { ok:true };
    }
    const rows=await q`UPDATE game_matches SET status=CASE WHEN game='guess' THEN 'choosing' ELSE 'active' END,
        started_at=now(),ends_at=CASE WHEN game='cookie' THEN now()+interval '60 seconds' ELSE now()+interval '15 minutes' END,
        secret_number=NULL,turn_user_id=NULL
      WHERE id=${id} AND opponent_id=${userId} AND status='pending'
      RETURNING creator_id,opponent_id,game,ends_at`;
    if (!rows.length) throw new E('Запрошення вже оброблено');
    await inbox(q,rows[0].creator_id,'AFK Games',rows[0].game==='guess'?`Матч №${id} прийнято. Обидва гравці мають таємно обрати число від 1 до 30.`:`Матч №${id} прийнято. Гра почалася!`);
    return { ok:true, game:rows[0].game, choosing:rows[0].game==='guess', endsAt:rows[0].ends_at };
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
      myTurn:Number(m.turn_user_id)===userId,mySecretSet:Number(m.creator_id)===userId?m.creator_secret!==null:m.opponent_secret!==null,otherSecretSet:Number(m.creator_id)===userId?m.opponent_secret!==null:m.creator_secret!==null,endsAt:m.ends_at,
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
    const [game]=await q`SELECT creator_id,opponent_id,creator_secret,opponent_secret,turn_user_id,status,ends_at
      FROM game_matches WHERE id=${id} AND game='guess' AND status='active'
        AND ends_at>now() AND turn_user_id=${userId} AND (creator_id=${userId} OR opponent_id=${userId}) FOR UPDATE`;
    if(!game)throw new E('Зараз не твій хід або матч уже завершено');
    const target=Number(game.creator_id)===userId?Number(game.opponent_secret):Number(game.creator_secret);
    const won=guess===target;
    const nextUser=Number(game.creator_id)===userId?Number(game.opponent_id):Number(game.creator_id);
    const [updated]=await q`UPDATE game_matches SET
      status=${won?'completed':'active'},winner_id=${won?userId:null},settled=${won},
      turn_user_id=${won?userId:nextUser}
      WHERE id=${id} AND status='active' AND turn_user_id=${userId}
      RETURNING status,turn_user_id`;
    if(!updated)throw new E('Хід уже оброблено, онови гру');
    if(won){await q`UPDATE users SET ok=ok+5 WHERE id=${userId}`;await inbox(q,nextUser,'AFK Games',`Суперник вгадав твоє число у матчі №${id}. Матч завершено.`);}
    return {won,hint:won?'correct':guess<target?'higher':'lower',myTurn:Number(updated.turn_user_id)===userId,me:await getMe(userId)};
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
    return {me:await getMe(userId)};
  },
  async businessActivate(userId,payload) {
    const q=await getSql(); const name=String(payload.name||'');
    const [asset]=await q`SELECT id FROM business_assets WHERE user_id=${userId} AND name=${name}`;
    if(!asset) throw new E('Цей бізнес не належить тобі');
    await settleBusinessIncome(q,userId);
    await q`UPDATE users SET biz=${name} WHERE id=${userId}`;
    await q`UPDATE business_assets SET last_paid_at=now() WHERE id=${asset.id}`;
    return {me:await getMe(userId)};
  },
  async businessStats(userId) {
    const q=await getSql(); const income=await settleBusinessIncome(q,userId);
    const [u]=await q`SELECT biz FROM users WHERE id=${userId}`;
    const rows=await q`SELECT name,price,hourly_profit,purchased_at,last_paid_at FROM business_assets WHERE user_id=${userId} ORDER BY purchased_at`;
    const tax=Number(await stateGet(q,'business_tax','5'));
    return {income,active:u?.biz||null,tax,assets:rows.map(x=>({name:x.name,price:Number(x.price),hourlyProfit:Number(x.hourly_profit),lastPaidAt:x.last_paid_at,active:x.name===u?.biz})),catalog:D.biz.map(x=>({name:x[0],price:x[1],hourlyProfit:x[2]})),me:await getMe(userId)};
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
    return {withdrawReadyAt:withdrawLimit?.ready_at||null,treasury:Number(await stateGet(q,'treasury','100000000')),tax:Number(await stateGet(q,'business_tax','5')),president,presidentNick:pres?.nick||null,presidentAvatar:pres?.avatar||null,
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
    if (payload.op === 'log') {
      const log = await q`SELECT at, admin, text FROM alog ORDER BY id DESC LIMIT 20`;
      return { log };
    }

    const targetNick = String(payload.nick || '').trim().toLocaleLowerCase('uk-UA');
    const [target] = ['promo_create','msg_broadcast'].includes(payload.op) ? [null] : await q`SELECT id, nick, role FROM users WHERE nick_lc = ${targetNick}`;
    if (!['promo_create','msg_broadcast'].includes(payload.op) && !target) throw new E('Гравця не знайдено');
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
      return J({ ok: true, database: databaseKind, version: '6.0.0', vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null, timezone: 'Europe/Kyiv' });
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
