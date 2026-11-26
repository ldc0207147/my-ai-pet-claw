const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const root=path.join(__dirname,'public'),dir=process.env.DATA_DIR||path.join(__dirname,'data');fs.mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(path.join(dir,'claw.sqlite'));db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS admin(username TEXT PRIMARY KEY,salt TEXT,hash TEXT); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER); CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY,credits INTEGER NOT NULL DEFAULT 300); CREATE TABLE IF NOT EXISTS prizes(id TEXT PRIMARY KEY,name TEXT,image TEXT,probability REAL,stock INTEGER,enabled INTEGER); CREATE TABLE IF NOT EXISTS draws(id TEXT PRIMARY KEY,player TEXT,prize TEXT,name TEXT,image TEXT,cost INTEGER,created TEXT,config TEXT); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,created TEXT,action TEXT);`);
db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value REAL)");
if(!db.prepare("SELECT value FROM settings WHERE key='missRate'").get()){const sum=db.prepare('SELECT COALESCE(SUM(probability),0) n FROM prizes WHERE enabled=1').get().n;db.prepare('INSERT INTO settings VALUES(?,?)').run('missRate',sum?Math.max(0,100-sum):70)}
db.prepare("INSERT OR IGNORE INTO settings VALUES('guaranteeCost',150)").run();
const guaranteeCost=()=>db.prepare("SELECT value FROM settings WHERE key='guaranteeCost'").get().value;
const spentSinceWin=id=>db.prepare('SELECT COALESCE(SUM(cost),0) n FROM draws WHERE player=? AND rowid > COALESCE((SELECT MAX(rowid) FROM draws WHERE player=? AND prize IS NOT NULL),0)').get(id,id).n;
const missRate=()=>db.prepare("SELECT value FROM settings WHERE key='missRate'").get().value;
if(!db.prepare('SELECT username FROM admin').get()){
 if(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<12)throw Error('首次啟動請設定 ADMIN_USER 與至少 12 字元的 ADMIN_PASSWORD');
 const salt=crypto.randomBytes(16).toString('hex');db.prepare('INSERT INTO admin VALUES(?,?,?)').run(process.env.ADMIN_USER||'admin',salt,crypto.scryptSync(process.env.ADMIN_PASSWORD,salt,64).toString('hex'));
}
const digest=s=>crypto.createHash('sha256').update(s).digest('hex'),cookie=(req,name)=>{try{return decodeURIComponent((req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'')}catch{return ''}},secure=process.env.COOKIE_SECURE==='1';
function setCookie(res,name,value,maxAge){res.setHeader('Set-Cookie',`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`)}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>3e6)throw Error('內容超過 3 MB')}return JSON.parse(text||'{}')}
function authorized(req){const s=db.prepare('SELECT expires FROM sessions WHERE token=?').get(digest(cookie(req,'admin_session')));return s&&s.expires>Date.now()}
function player(req,res){let id=cookie(req,'player');if(!/^[a-f0-9]{48}$/.test(id)||!db.prepare('SELECT id FROM players WHERE id=?').get(id)){id=crypto.randomBytes(24).toString('hex');db.prepare('INSERT INTO players(id) VALUES(?)').run(id);setCookie(res,'player',id,31536000)}return id}
function snapshot(id){return {credits:db.prepare('SELECT credits FROM players WHERE id=?').get(id).credits,plays:db.prepare('SELECT COUNT(*) n FROM draws WHERE player=?').get(id).n,roundSpend:spentSinceWin(id),guaranteeCost:guaranteeCost(),points:0,awards:db.prepare('SELECT id,name prizeName,image prizeImage,created FROM draws WHERE player=? AND prize IS NOT NULL ORDER BY created DESC').all(id)}}
const attempts=new Map();
const server=http.createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
 try{const url=new URL(req.url,'http://localhost'),p=url.pathname;
 if(p.startsWith('/api/')){
  if(req.method!=='GET'&&(req.headers['x-claw-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)))return json(res,403,{error:'不允許跨來源請求'});
  if(p==='/api/admin/login'&&req.method==='POST'){
   const key=req.socket.remoteAddress,now=Date.now(),rate=attempts.get(key)||{n:0,start:now};if(now-rate.start>900000){rate.n=0;rate.start=now}if(rate.n>=10)return json(res,429,{error:'登入嘗試過多，請 15 分鐘後再試'});rate.n++;attempts.set(key,rate);
   const b=await body(req),a=db.prepare('SELECT * FROM admin WHERE username=?').get(String(b.username||'')),salt=a?.salt||'dummy',hash=crypto.scryptSync(String(b.password||'').slice(0,256),salt,64);
   if(!a||!crypto.timingSafeEqual(hash,Buffer.from(a.hash,'hex')))return json(res,401,{error:'帳號或密碼錯誤'});
   attempts.delete(key);const token=crypto.randomBytes(32).toString('hex');db.prepare('DELETE FROM sessions WHERE expires<?').run(now);db.prepare('INSERT INTO sessions VALUES(?,?)').run(digest(token),now+8*3600000);setCookie(res,'admin_session',token,28800);return json(res,200,{ok:true});
  }
  if(p.startsWith('/api/admin/')){
   if(!authorized(req))return json(res,401,{error:'請先登入後台'});
   if(p==='/api/admin/logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE token=?').run(digest(cookie(req,'admin_session')));setCookie(res,'admin_session','',0);return json(res,200,{ok:true})}
   if(p==='/api/admin/data'&&req.method==='GET')return json(res,200,{missRate:missRate(),guaranteeCost:guaranteeCost(),prizes:db.prepare('SELECT * FROM prizes').all(),draws:db.prepare('SELECT * FROM draws ORDER BY created DESC LIMIT 500').all(),stats:db.prepare('SELECT COUNT(*) total,SUM(cost) spent,COUNT(prize) wins FROM draws').get(),audit:db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 50').all()});
   if(p==='/api/admin/prizes'&&req.method==='POST'){
    const b=await body(req);const threshold=b.guaranteeCost??guaranteeCost();if(!Number.isInteger(threshold)||threshold<0||threshold>100000||threshold%10!==0)throw Error('保夾門檻須為 10 的倍數，0 為停用');const miss=b.missRate??missRate();if(!Number.isFinite(miss)||miss<0||miss>100)throw Error('MISS 率必須是 0–100%');if(!Array.isArray(b.prizes)||b.prizes.length>50)throw Error('獎品上限 50 筆');let sum=0;const ids=new Set();
    const rows=b.prizes.map(x=>{if(typeof x.name!=='string'||!x.name.trim()||x.name.length>80||!Number.isFinite(x.probability)||x.probability<0||x.probability>100||!Number.isInteger(x.stock)||x.stock<0)throw Error('請檢查獎品名稱、機率與庫存');if(x.image&&!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(x.image))throw Error('圖片格式須為 PNG/JPG/WebP');const id=x.id||crypto.randomUUID();if(ids.has(id))throw Error('獎品 ID 重複');ids.add(id);if(x.enabled)sum+=x.probability;return {...x,id,name:x.name.trim(),image:x.image||''}});
    db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE settings SET value=? WHERE key='guaranteeCost'").run(threshold);db.prepare("UPDATE settings SET value=? WHERE key='missRate'").run(miss);db.exec('DELETE FROM prizes');const insert=db.prepare('INSERT INTO prizes VALUES(?,?,?,?,?,?)');for(const x of rows)insert.run(x.id,x.name,x.image,x.probability,x.stock,x.enabled?1:0);db.prepare('INSERT INTO audit(created,action) VALUES(?,?)').run(new Date().toISOString(),'更新獎池 保夾 '+threshold+' credits; MISS '+miss+'%; '+rows.map(x=>`${x.name}: ${x.probability}%, 庫存 ${x.stock}, 啟用 ${!!x.enabled}`).join('; '));db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return json(res,200,{ok:true});
   }
  }
  if(p==='/api/player'&&req.method==='GET')return json(res,200,snapshot(player(req,res)));
  if(p==='/api/draw'&&req.method==='POST'){
   const id=player(req,res),b=await body(req);if(typeof b.requestId!=='string'||!/^[-a-zA-Z0-9]{16,64}$/.test(b.requestId))throw Error('缺少有效請求識別碼');
   const previous=db.prepare('SELECT * FROM draws WHERE id=?').get(b.requestId);if(previous){if(previous.player!==id)return json(res,409,{error:'請求識別碼已使用'});return json(res,200,{draw:previous,state:snapshot(id)})}
   db.exec('BEGIN IMMEDIATE');try{const latest=db.prepare('SELECT created FROM draws WHERE player=? ORDER BY created DESC LIMIT 1').get(id);if(latest&&Date.now()-Date.parse(latest.created)<6000){db.exec('ROLLBACK');return json(res,429,{error:'請等本次抓取完成'})}const balance=db.prepare('SELECT credits FROM players WHERE id=?').get(id).credits;if(balance<10){db.exec('ROLLBACK');return json(res,409,{error:'點數不足'})}
    const pool=db.prepare('SELECT * FROM prizes WHERE enabled=1').all();if(!pool.some(x=>x.stock>0&&x.probability>0)){db.exec('ROLLBACK');return json(res,409,{error:'獎池尚未開放或獎品已送完'})}
    const threshold=guaranteeCost(),spent=spentSinceWin(id),guaranteed=threshold>0&&spent+10>=threshold;const miss=missRate(),active=pool.filter(x=>x.stock>0&&x.probability>0),total=active.reduce((n,x)=>n+x.probability,0);let win=null;if(guaranteed||crypto.randomInt(100000000)/1000000>=miss){const roll=crypto.randomInt(100000000)/100000000*total;let cursor=0;for(const x of active){cursor+=x.probability;if(roll<cursor){win=x;break}}}
    const draw={id:b.requestId,player:id,prize:win?.id||null,name:win?.name||'未中獎',image:win?.image||'',cost:10,created:new Date().toISOString(),config:JSON.stringify({missRate:miss,guaranteeCost:threshold,spentBefore:spent,guaranteed,prizes:pool.map(x=>({id:x.id,name:x.name,weight:x.probability,stock:x.stock}))})};
    db.prepare('UPDATE players SET credits=credits-10 WHERE id=?').run(id);if(win)db.prepare('UPDATE prizes SET stock=stock-1 WHERE id=?').run(win.id);db.prepare('INSERT INTO draws VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(draw));db.exec('COMMIT');return json(res,200,{draw,state:snapshot(id)});
   }catch(e){db.exec('ROLLBACK');throw e}
  }
  return json(res,404,{error:'API 不存在'});
 }
 const file=path.resolve(root,'.'+(p==='/'?'/index.html':p==='/admin'?'/admin.html':decodeURIComponent(p)));if(!file.startsWith(root+path.sep))return json(res,403,{error:'Forbidden'});if(!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{error:'Not found'});res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
 }catch(e){json(res,400,{error:e.message})}
});
server.listen(Number(process.env.PORT||4174),'127.0.0.1',()=>console.log('遊戲 http://127.0.0.1:'+server.address().port+' / 後台 /admin'));
