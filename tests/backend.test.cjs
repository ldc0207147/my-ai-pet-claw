const {test}=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('登入、獎池驗證、伺服器抽獎、庫存、去重與持久化',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'petclaw-test-'));const child=spawn(process.execPath,['server.cjs'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:'0',DATA_DIR:dir,ADMIN_USER:'qa-admin',ADMIN_PASSWORD:'qa-only-long-password'}});t.after(()=>child.kill());
 let url='';await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{const m=String(d).match(/http:\/\/127.0.0.1:\d+/);if(m){url=m[0];resolve()}});child.once('exit',()=>reject(Error('server exited')));child.stderr.on('data',d=>{if(String(d).includes('Error:'))reject(Error(String(d)))})});
 async function call(p,data,cookie=''){const r=await fetch(url+p,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Claw-Request':'1',Cookie:cookie},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
 assert.equal((await call('/api/admin/data')).status,401);assert.equal((await call('/api/admin/login',{username:'qa-admin',password:'wrong'})).status,401);
 const auth=await call('/api/admin/login',{username:'qa-admin',password:'qa-only-long-password'});assert.equal(auth.status,200);const cookie=auth.cookie;
 const prize={name:'測試驚喜獎',image:'',probability:100,stock:1,enabled:true};assert.equal((await call('/api/admin/prizes',{prizes:[{...prize,probability:101}]},cookie)).status,400);
 assert.equal((await call('/api/admin/prizes',{prizes:[prize],missRate:0},cookie)).status,200);
 const player=await call('/api/player');assert.equal(player.data.credits,300);const id=crypto.randomUUID();const draw=await call('/api/draw',{requestId:id},player.cookie);assert.equal(draw.status,200);assert.equal(draw.data.state.credits,290);assert.equal(draw.data.state.awards.length,1);assert.equal(draw.data.draw.name,'測試驚喜獎');
 const again=await call('/api/draw',{requestId:id},player.cookie);assert.equal(again.data.state.credits,290);
 const data=await call('/api/admin/data',null,cookie);assert.equal(data.data.prizes[0].stock,0);assert.equal(data.data.stats.total,1);assert.equal(data.data.stats.wins,1);assert.equal(JSON.parse(data.data.draws[0].config).prizes[0].weight,100);
 const other=await call('/api/player');assert.equal((await call('/api/draw',{requestId:crypto.randomUUID()},other.cookie)).status,409);
 assert.equal((await call('/api/player',null,player.cookie)).data.credits,290);
 assert.equal((await call('/api/admin/prizes',{prizes:[{...prize,stock:2}],missRate:101},cookie)).status,400);
 await call('/api/admin/prizes',{prizes:[{...prize,stock:2}],missRate:100},cookie);
 const loser=await call('/api/player');const miss=await call('/api/draw',{requestId:crypto.randomUUID()},loser.cookie);assert.equal(miss.data.draw.prize,null);assert.equal(miss.data.state.credits,290);assert.equal(JSON.parse(miss.data.draw.config).missRate,100);
 assert.equal((await call('/api/admin/prizes',{prizes:[{...prize,stock:2}],missRate:100,guaranteeCost:15},cookie)).status,400);
 await call('/api/admin/prizes',{prizes:[{...prize,stock:2}],missRate:100,guaranteeCost:20},cookie);
 const pityPlayer=await call('/api/player');const first=await call('/api/draw',{requestId:crypto.randomUUID()},pityPlayer.cookie);assert.equal(first.data.draw.prize,null);assert.equal(first.data.state.roundSpend,10);
 await new Promise(resolve=>setTimeout(resolve,6100));
 const pityId=crypto.randomUUID();const second=await call('/api/draw',{requestId:pityId},pityPlayer.cookie);assert.ok(second.data.draw.prize);assert.equal(second.data.state.roundSpend,0);assert.equal(second.data.state.credits,280);assert.equal(JSON.parse(second.data.draw.config).guaranteed,true);
 const retry=await call('/api/draw',{requestId:pityId},pityPlayer.cookie);assert.equal(retry.data.state.credits,280);assert.equal(retry.data.state.roundSpend,0);
 const blocked=await fetch(url+'/api/admin/prizes',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
 await call('/api/admin/logout',{},cookie);assert.equal((await call('/api/admin/data',null,cookie)).status,401);
 assert.ok(fs.statSync(path.join(dir,'claw.sqlite')).size>0);
});
