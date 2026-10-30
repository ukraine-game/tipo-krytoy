// AFK Bank API — Netlify Function + Netlify DB (Postgres/Neon). Усі гроші, ставки, кулдауни й виплати рахує тільки сервер.
import { neon } from '@netlify/neon';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import D from './data.json';
const sql = neon();
const LV=[20,40,60,80,100,120,150,200,250,300,350,450,550,650,800,1000,1200,1400,1600];
const DAILY=50000, MINB=100, MAXB=2e9, PW_MIN=6, NICK_MAX=16;
const lvl=o=>1+LV.filter(t=>o>=t).length, mul=o=>2**(lvl(o)-1), rnd=(a,b)=>a+Math.floor(Math.random()*(b-a+1));
class E extends Error{constructor(m,s=400){super(m);this.s=s}}
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const hash=t=>createHash('sha256').update(t).digest('hex');
const pick=(w,it)=>{let r=Math.random()*w.reduce((a,b)=>a+b,0);for(let i=0;i<w.length;i++)if((r-=w[i])<0)return it[i];return it.at(-1)};
const int=(v,lo,hi,msg)=>{v=Math.floor(Number(v));if(!(v>=lo&&v<=hi))throw new E(msg);return v};
const bet=v=>int(v,MINB,MAXB,`❌ Ставка: від ${MINB} до ${MAXB.toLocaleString('uk-UA')}`);
let ready;
const init=()=>ready??=(async()=>{
 await sql`CREATE TABLE IF NOT EXISTS users(id serial PRIMARY KEY,nick text NOT NULL,nick_lc text UNIQUE NOT NULL,avatar text NOT NULL,salt text NOT NULL,pw text NOT NULL,role text NOT NULL DEFAULT 'user',bal bigint NOT NULL DEFAULT 0,dick int NOT NULL DEFAULT 0,ok int NOT NULL DEFAULT 0,daily_at timestamptz,dick_at timestamptz,mast_at timestamptz,mast_end timestamptz,stam boolean NOT NULL DEFAULT false,car text,house text,biz text,created timestamptz NOT NULL DEFAULT now())`;
 await sql`CREATE TABLE IF NOT EXISTS sessions(h text PRIMARY KEY,user_id int NOT NULL,created timestamptz NOT NULL DEFAULT now())`;
 await sql`CREATE TABLE IF NOT EXISTS inv(user_id int NOT NULL,key text NOT NULL,qty int NOT NULL DEFAULT 0,PRIMARY KEY(user_id,key))`;
 await sql`CREATE TABLE IF NOT EXISTS cars(id serial PRIMARY KEY,user_id int NOT NULL,name text NOT NULL,value int NOT NULL,jackpot boolean NOT NULL)`;
 await sql`CREATE TABLE IF NOT EXISTS alog(id serial PRIMARY KEY,at timestamptz NOT NULL DEFAULT now(),admin text NOT NULL,text text NOT NULL)`;
})();
async function me(id){
 const[u]=await sql`SELECT *,GREATEST(0,EXTRACT(EPOCH FROM(daily_at+interval '24 hours'-now()))*1000)::float8 c_d,GREATEST(0,EXTRACT(EPOCH FROM(dick_at+interval '24 hours'-now()))*1000)::float8 c_k,GREATEST(0,EXTRACT(EPOCH FROM(mast_at+interval '2 hours'-now()))*1000)::float8 c_m,GREATEST(0,EXTRACT(EPOCH FROM(mast_end-now()))*1000)::float8 m_run,(mast_end IS NOT NULL AND mast_end<=now()) m_pend FROM users WHERE id=${id}`;
 const cs=await sql`SELECT key,qty FROM inv WHERE user_id=${id} AND qty>0`, cr=await sql`SELECT id,name,value,jackpot FROM cars WHERE user_id=${id} ORDER BY id`;
 const z=u.stam?0:1, ok=u.ok;
 return{nick:u.nick,avatar:u.avatar,role:u.role,bal:Number(u.bal),dick:u.dick,ok,level:lvl(ok),mult:mul(ok),stam:u.stam,car:u.car,house:u.house,biz:u.biz,
  cases:Object.fromEntries(cs.map(r=>[r.key,r.qty])),cars:cr,cd:{daily:z*u.c_d,dick:z*u.c_k,mast:z*u.c_m,run:u.m_run,pend:u.m_pend}};
}
const isAdm=r=>r==='owner'||r==='admin';
async function auth(x){
 if(!x.tk)throw new E('Потрібен вхід',401);
 const[s]=await sql`SELECT user_id FROM sessions WHERE h=${hash(String(x.tk))}`;
 if(!s)throw new E('Сесія завершена',401);return s.user_id;
}
async function session(id){const tk=randomBytes(24).toString('hex');await sql`INSERT INTO sessions(h,user_id) VALUES(${hash(tk)},${id})`;return tk}
const pwHash=(p,salt)=>scryptSync(p,salt,32).toString('hex');
const AV=/^(p\d{1,2}|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+)$/;
const Pub={
 async register(x){
  const nick=String(x.nick||'').trim(),pw=String(x.pw||''),av=String(x.avatar||'p0');
  if(nick.length<2||nick.length>NICK_MAX)throw new E(`Нік: 2–${NICK_MAX} символів`);
  if(!/^[\p{L}\p{N}_.\- ]+$/u.test(nick))throw new E('Нік: літери, цифри, пробіл, _ . -');
  if(pw.length<PW_MIN||pw.length>72)throw new E(`Пароль: мінімум ${PW_MIN} символів`);
  if(!AV.test(av)||av.length>60000)throw new E('Недійсна аватарка');
  const salt=randomBytes(16).toString('hex'),owner=process.env.OWNER_NICK?.toLowerCase()===nick.toLowerCase();
  let r;try{
   r=await sql`INSERT INTO users(nick,nick_lc,avatar,salt,pw,role) VALUES(${nick},${nick.toLowerCase()},${av},${salt},${pwHash(pw,salt)},CASE WHEN ${owner} OR (NOT EXISTS(SELECT 1 FROM users) AND ${!process.env.OWNER_NICK}) THEN 'owner' ELSE 'user' END) RETURNING id`;
  }catch(e){if(e.code==='23505')throw new E('Цей нік уже зайнятий');throw e}
  return{tk:await session(r[0].id),me:await me(r[0].id)};
 },
 async login(x){
  const[u]=await sql`SELECT id,salt,pw FROM users WHERE nick_lc=${String(x.nick||'').trim().toLowerCase()}`;
  const ok=u&&timingSafeEqual(Buffer.from(pwHash(String(x.pw||''),u.salt)),Buffer.from(u.pw));
  if(!ok)throw new E('Невірний нік або пароль',401);
  return{tk:await session(u.id),me:await me(u.id)};
 }
};
const Act={
 async me(uid){return{me:await me(uid)}},
 async logout(uid,x){await sql`DELETE FROM sessions WHERE h=${hash(String(x.tk))}`;return{}},
 async daily(uid){
  const u=await me(uid),rw=DAILY*u.mult;
  const r=await sql`UPDATE users SET bal=bal+${rw},ok=ok+${isAdm(u.role)?0:1},daily_at=now() WHERE id=${uid} AND (stam OR daily_at IS NULL OR daily_at<=now()-interval '24 hours') RETURNING id`;
  if(!r.length)throw new E('⏳ Бонус ще недоступний');return{rw,me:await me(uid)};
 },
 async flip(uid,x){
  const b=bet(x.bet);if(!['Орел','Решка'].includes(x.c))throw new E('Обери Орел або Решку');
  const r=Math.random()<.5?'Орел':'Решка',w=r===x.c;
  const q=await sql`UPDATE users SET bal=bal-${b}+${w?b*2:0} WHERE id=${uid} AND bal>=${b} RETURNING id`;
  if(!q.length)throw new E('❌ Недостатньо грошей');return{r,w,win:b,me:await me(uid)};
 },
 async roul(uid,x){
  const t=D.rl[int(x.t,0,D.rl.length-1,'Рівень?')],[lo,hi,m]=t,g=int(x.g,lo,hi,`❌ Число від ${lo} до ${hi}`),b=bet(x.bet);
  const r=rnd(lo,hi),w=r===g;
  const q=await sql`UPDATE users SET bal=bal-${b}+${w?b*m:0} WHERE id=${uid} AND bal>=${b} RETURNING id`;
  if(!q.length)throw new E('❌ Недостатньо грошей');return{r,w,win:b*m,me:await me(uid)};
 },
 async dick(uid){
  const c=pick([8,10,12,14,14,12,10,8,6,4,3,2],[-3,-2,-1,0,1,2,3,4,5,6,7,8]);
  const q=await sql`UPDATE users SET dick=GREATEST(0,dick+${c}),dick_at=now() WHERE id=${uid} AND (stam OR dick_at IS NULL OR dick_at<=now()-interval '24 hours') RETURNING id`;
  if(!q.length)throw new E('⏳ Ти вже використовував команду сьогодні');return{c,me:await me(uid)};
 },
 async mstart(uid){
  const q=await sql`UPDATE users SET mast_end=now()+interval '30 seconds' WHERE id=${uid} AND mast_end IS NULL AND (stam OR mast_at IS NULL OR mast_at<=now()-interval '2 hours') RETURNING id`;
  if(!q.length)throw new E('⏳ Активність недоступна');return{me:await me(uid)};
 },
 async mclaim(uid){
  const rw=rnd(5000,15000),q=await sql`UPDATE users SET bal=bal+${rw},mast_at=now(),mast_end=NULL WHERE id=${uid} AND mast_end IS NOT NULL AND mast_end<=now() RETURNING id`;
  if(!q.length)throw new E('⏳ Ще не завершено');return{rw,me:await me(uid)};
 },
 async bcase(uid,x){
  const c=D.cases[x.k];if(!c)throw new E('Кейс?');
  const q=await sql`WITH p AS(UPDATE users SET bal=bal-${c.p} WHERE id=${uid} AND bal>=${c.p} RETURNING id) INSERT INTO inv(user_id,key,qty) SELECT id,${x.k},1 FROM p ON CONFLICT(user_id,key) DO UPDATE SET qty=inv.qty+1 RETURNING qty`;
  if(!q.length)throw new E('❌ Недостатньо грошей');return{me:await me(uid)};
 },
 async ocase(uid,x){
  const c=D.cases[x.k];if(!c)throw new E('Кейс?');
  const car=pick(c.c.map((_,i)=>17-i),c.c);
  const q=await sql`WITH d AS(UPDATE inv SET qty=qty-1 WHERE user_id=${uid} AND key=${x.k} AND qty>0 RETURNING 1) INSERT INTO cars(user_id,name,value,jackpot) SELECT ${uid},${car[0]},${car[1]},${car[2]} FROM d RETURNING id`;
  if(!q.length)throw new E('❌ Немає такого кейса');return{car,me:await me(uid)};
 },
 async ucar(uid,x){await sql`UPDATE users SET car=cars.name FROM cars WHERE cars.id=${int(x.id,1,2e9,'?')} AND cars.user_id=${uid} AND users.id=${uid}`;return{me:await me(uid)}},
 async buy(uid,x){
  const col=x.w==='house'?'house':'biz',row=(col==='house'?D.houses:D.biz).find(r=>r[0]===x.n);if(!row)throw new E('Не знайдено');
  const q=col==='house'?await sql`UPDATE users SET bal=bal-${row[1]},house=${row[0]} WHERE id=${uid} AND bal>=${row[1]} RETURNING id`:await sql`UPDATE users SET bal=bal-${row[1]},biz=${row[0]} WHERE id=${uid} AND bal>=${row[1]} RETURNING id`;
  if(!q.length)throw new E('❌ Недостатньо грошей');return{me:await me(uid)};
 },
 async pay(uid,x){
  const a=int(x.amt,1,MAXB,'❌ Некоректна сума'),to=String(x.to||'').trim().toLowerCase();
  const q=await sql`WITH r AS(SELECT id FROM users WHERE nick_lc=${to} AND id<>${uid}),s AS(UPDATE users SET bal=bal-${a} WHERE id=${uid} AND bal>=${a} AND EXISTS(SELECT 1 FROM r) RETURNING 1),c AS(UPDATE users SET bal=bal+${a} WHERE id=(SELECT id FROM r) AND EXISTS(SELECT 1 FROM s) RETURNING 1) SELECT count(*)::int n FROM s`;
  if(!q[0].n)throw new E('❌ Не вдалося: немає такого гравця (або це ти) чи недостатньо грошей');
  const u=await me(uid);if(!isAdm(u.role))await sql`UPDATE users SET ok=ok+1 WHERE id=${uid}`;return{me:await me(uid)};
 },
 async top(){return{top:(await sql`SELECT nick,avatar,bal FROM users ORDER BY bal DESC,id ASC LIMIT 3`).map(r=>({...r,bal:Number(r.bal)}))}},
 async adm(uid,x){
  const u=await me(uid);if(!isAdm(u.role))throw new E('🔒 Лише для адміністраторів',403);
  if(x.op==='log')return{log:await sql`SELECT at,admin,text FROM alog ORDER BY id DESC LIMIT 12`};
  const to=String(x.nick||'').trim().toLowerCase(),[t]=await sql`SELECT id,nick FROM users WHERE nick_lc=${to}`;if(!t)throw new E('Гравця не знайдено');
  let txt;
  if(x.op==='givemoney'){const n=int(x.n,1,MAXB,'Сума?');await sql`UPDATE users SET bal=bal+${n} WHERE id=${t.id}`;txt=`givemoney ${t.nick} +${n}`}
  else if(x.op==='setmoney'){const n=int(x.n,0,MAXB,'Сума?');await sql`UPDATE users SET bal=${n} WHERE id=${t.id}`;txt=`setmoney ${t.nick} =${n}`}
  else if(x.op==='setdick'){const n=int(x.n,0,1e6,'Розмір?');await sql`UPDATE users SET dick=${n} WHERE id=${t.id}`;txt=`setdick ${t.nick} =${n}`}
  else if(x.op==='stamina'){const[r]=await sql`UPDATE users SET stam=NOT stam WHERE id=${t.id} RETURNING stam`;txt=`stamina ${t.nick} ${r.stam?'ON':'OFF'}`}
  else throw new E('Невідома дія');
  await sql`INSERT INTO alog(admin,text) VALUES(${u.nick},${txt})`;return{ok:txt,me:await me(uid)};
 }
};
export default async req=>{
 try{
  if(req.method!=='POST')return J({err:'POST only'},405);
  const x=await req.json();await init();
  if(Pub[x.a])return J(await Pub[x.a](x));
  if(!Act[x.a])throw new E('Невідома дія',404);
  return J(await Act[x.a](await auth(x),x));
 }catch(e){if(!(e instanceof E))console.error(e);return J({err:e instanceof E?e.message:'Помилка сервера'},e.s||500)}
};
export const config={path:'/api'};
