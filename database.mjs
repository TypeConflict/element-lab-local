import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {base,key,validateResult} from './dist/recipes.js';
export class GameDatabase {
 constructor(path){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS elements(name TEXT PRIMARY KEY, emoji TEXT NOT NULL, reason TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS recipes(pair TEXT PRIMARY KEY, result TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, result TEXT NOT NULL, is_new INTEGER NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
 if(!this.db.prepare('PRAGMA table_info(history)').all().some(c=>c.name==='kind'))this.db.exec("ALTER TABLE history ADD COLUMN kind TEXT NOT NULL DEFAULT 'combine'");
 const seed=this.db.prepare('INSERT OR IGNORE INTO elements(name,emoji,reason) VALUES(?,?,?)');for(const e of base)seed.run(e.name,e.emoji,'起始元素');
 }
 read(){return {elements:this.db.prepare(`SELECT name,emoji,reason,favorite, EXISTS(SELECT 1 FROM history WHERE kind='extract' AND json_extract(result,'$.name')=elements.name) AS concept FROM elements ORDER BY discovered_at,rowid`).all().map(e=>({...e,favorite:!!e.favorite,concept:!!e.concept})),history:this.db.prepare('SELECT * FROM history ORDER BY created_at DESC,rowid DESC LIMIT 200').all().map(h=>({id:h.id,kind:h.kind,a:h.a,b:h.b,result:JSON.parse(h.result),new:!!h.is_new,createdAt:h.created_at})),cache:Object.fromEntries(this.db.prepare('SELECT * FROM recipes').all().map(r=>[r.pair,JSON.parse(r.result)])),settings:JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get()?.value||'{"mode":"classic","endpoint":""}')};}
 merge(state){if(!state||typeof state!=='object'||!Array.isArray(state.elements)||state.elements.length>10000||!Array.isArray(state.history)||state.history.length>1000)throw Error('Invalid state');
 const elements=state.elements.map(e=>({...validateResult({...e,reason:e.reason||'已收藏'}),favorite:e.favorite}));
 const history=state.history.map((h,i)=>{if(!h||!['combine','extract'].includes(h.kind||'combine')||(h.kind==='extract'&&h.b!=='')||typeof h.a!=='string'||typeof h.b!=='string'||h.a.length>24||h.b.length>24)throw Error('Invalid history');const result=validateResult(h.result);const id=typeof h.id==='string'&&h.id.length<=100?h.id:'legacy:'+JSON.stringify([h.a,h.b,result.name,i]);const createdAt=typeof h.createdAt==='string'&&!Number.isNaN(Date.parse(h.createdAt))?new Date(h.createdAt).toISOString():new Date(Date.UTC(2020,0,1,0,0,state.history.length-i)).toISOString();return {...h,kind:h.kind||'combine',result,id,createdAt}});
 const cache=Object.entries(state.cache||{}).map(([k,v])=>{if(k.length>2048)throw Error('Invalid recipe');return [k,validateResult(v)]});
 if(cache.length>10000)throw Error('Too many recipes');if(state.settings&&(!['classic','llm'].includes(state.settings.mode)||typeof state.settings.endpoint!=='string'||state.settings.endpoint.length>2000||(state.settings.extractEndpoint!==undefined&&(typeof state.settings.extractEndpoint!=='string'||state.settings.extractEndpoint.length>2000))))throw Error('Invalid settings');
 this.db.exec('BEGIN IMMEDIATE');try{const insert=this.db.prepare('INSERT INTO elements(name,emoji,reason,favorite) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET emoji=excluded.emoji,reason=excluded.reason');for(const e of elements)insert.run(e.name,e.emoji,e.reason,e.favorite?1:0);
 const rec=this.db.prepare('INSERT INTO recipes(pair,result) VALUES(?,?) ON CONFLICT(pair) DO UPDATE SET result=excluded.result');for(const [k,v]of cache)rec.run(k,JSON.stringify(v));const hist=this.db.prepare('INSERT OR IGNORE INTO history(id,a,b,result,is_new,created_at,kind) VALUES(?,?,?,?,?,?,?)');for(const h of history)hist.run(h.id,h.a,h.b,JSON.stringify(h.result),h.new?1:0,h.createdAt,h.kind);
 if(state.settings)this.db.prepare('INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(state.settings));this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e}return this.read();
 }
 dictionary(){
  const entries=new Map(this.db.prepare('SELECT name,emoji,reason FROM elements ORDER BY discovered_at,rowid').all().filter(e=>!base.some(b=>b.name===e.name)).map(e=>[e.name,{...e,combinations:[],extractions:[]}]));
  for(const h of this.db.prepare('SELECT a,b,result,kind FROM history ORDER BY created_at DESC,rowid DESC').all()){
   const result=JSON.parse(h.result);if(!entries.has(result.name))entries.set(result.name,{...result,combinations:[],extractions:[]});
   const entry=entries.get(result.name);if(h.kind==='extract'){if(!entry.extractions.some(x=>x.source===h.a))entry.extractions.push({source:h.a,reason:result.reason});continue}if(!entry.combinations.some(c=>key(c.a,c.b)===key(h.a,h.b)))entry.combinations.push({a:h.a,b:h.b,reason:result.reason});
  }
  // Recover older imported discoveries whose original history was already truncated.
  for(const row of this.db.prepare('SELECT pair,result FROM recipes').all())try{
   const result=JSON.parse(row.result),entry=entries.get(result.name);if(!entry)continue;
   if(row.pair.startsWith('extract:'))continue;
   let pair=row.pair.startsWith('classic:')?JSON.parse(row.pair.slice(8)):JSON.parse(row.pair);
   if(Array.isArray(pair)&&pair[0]==='server')pair=JSON.parse(pair.at(-1));
   else if(Array.isArray(pair)&&pair.length===2&&typeof pair[1]==='string'&&pair[1].startsWith('['))pair=JSON.parse(pair[1]);
   if(Array.isArray(pair)&&pair.length===2&&pair.every(x=>typeof x==='string'&&x.length<=24)&&!entry.combinations.some(c=>key(c.a,c.b)===key(...pair)))entry.combinations.push({a:pair[0],b:pair[1],reason:result.reason});
  }catch{}
  return [...entries.values()];
 }
 favorite(name,value){if(typeof name!=='string'||typeof value!=='boolean')throw Error('Invalid favorite');const r=this.db.prepare('UPDATE elements SET favorite=? WHERE name=?').run(value?1:0,name);if(!r.changes)throw Error('Unknown element');}
 getRecipe(pair){const r=this.db.prepare('SELECT result FROM recipes WHERE pair=?').get(pair);return r?JSON.parse(r.result):null;}
 putRecipe(pair,result){this.db.prepare('INSERT INTO recipes(pair,result) VALUES(?,?) ON CONFLICT(pair) DO UPDATE SET result=excluded.result').run(pair,JSON.stringify(validateResult(result)));}
 close(){this.db.close()}
}
