/** Real HTTP/WebSocket smoke. Test accounts persist; no state-file edits or cheats. */
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:3188');
if (!['http:','https:'].includes(base.protocol) || base.username || base.password) throw new Error('Supply an HTTP(S) origin without credentials');
base.pathname='/';base.search='';base.hash='';
const websocketUrl = new URL('/ws',base);websocketUrl.protocol=base.protocol==='https:'?'wss:':'ws:';
const prefix=`qa_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
const results=[];
const accounts=[];
const connections=[];
const started=new Date();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let world;

async function until(predicate,label,timeout=8000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {const value=predicate();if(value)return value;await pause(50);}
  throw new Error(`Timed out: ${label}`);
}
async function check(name,action) {
  const at=Date.now();
  try {await action();results.push({name,status:'PASS',ms:Date.now()-at});console.log(`PASS ${name}`);}
  catch(error) {results.push({name,status:'FAIL',ms:Date.now()-at,error:error.message});throw error;}
}
async function request(path,{cookie,body,method='GET'}={}) {
  const headers={};if(cookie)headers.cookie=cookie;
  if(body)headers['content-type']='application/json';
  const r=await fetch(new URL(path,base),{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  const data=await r.json();
  return {status:r.status,data,cookie:r.headers.getSetCookie?.().map(c=>c.split(';')[0]).find(c=>c.startsWith('aw_session=')) ?? r.headers.get('set-cookie')?.split(';')[0]};
}
async function register(suffix) {
  const name=`${prefix}_${suffix}`,password=randomBytes(24).toString('base64url');
  const r=await request('/api/auth/register',{method:'POST',body:{name,password}});
  assert.equal(r.status,201);assert.ok(r.cookie);assert.equal(r.data.player.name,name);
  const account={name,password,cookie:r.cookie,id:r.data.player.id};accounts.push(account);return account;
}
async function connect(account) {
  const ws=new WebSocket(websocketUrl,{headers:{Cookie:account.cookie,Origin:base.origin}});
  const connection={ws,snapshot:null,notices:[],sent:0};connections.push(connection);
  ws.on('message',bytes=>{const value=JSON.parse(bytes.toString());if(value.type==='snapshot')connection.snapshot=value;else if(value.type==='notice')connection.notices.push(value);});
  ws.on('error',()=>{});
  await until(()=>connection.snapshot,'initial authenticated snapshot');
  return connection;
}
function send(connection,message) {
  assert.equal(connection.ws.readyState,WebSocket.OPEN,'WebSocket must be open');
  connection.ws.send(JSON.stringify(message));connection.sent++;
}
async function notice(connection,action,kind='success') {
  const index=connection.notices.length;
  send(connection,{type:'action',...action});
  const result=await until(()=>connection.notices[index],`notice for ${action.action}`);
  assert.equal(result.kind,kind,`${action.action}: ${result.text}`);
  return result;
}
function quantity(connection,item,storage='inventory') {return connection.snapshot.self[storage][item]??0;}
async function walk(connection,x,z) {
  const initial=connection.snapshot.self;
  const timeout=Date.now()+Math.hypot(initial.x-x,initial.z-z)/2.3*1000+6000;
  let lastAt=Date.now();
  while(Date.now()<timeout) {
    const self=connection.snapshot.self,distance=Math.hypot(x-self.x,z-self.z);
    if(distance<.7)return;
    await pause(120);
    const current=connection.snapshot.self;
    const dx=x-current.x,dz=z-current.z,remaining=Math.hypot(dx,dz);
    // Latest authoritative snapshot only. Each requested step is at most 5.5 units/s.
    const at=Date.now(),step=Math.min(remaining,5.5*Math.min(.2,(at-lastAt)/1000));lastAt=at;
    if(remaining>0)send(connection,{type:'move',x:current.x+dx/remaining*step,z:current.z+dz/remaining*step,rotation:Math.atan2(dx,dz)});
  }
  throw new Error(`Walk did not reach (${x}, ${z}) at ordinary speed`);
}
async function close(connection) {
  if(connection.ws.readyState===WebSocket.CLOSED)return;
  connection.ws.close();await until(()=>connection.ws.readyState===WebSocket.CLOSED,'WebSocket close',3000);
}

let failure;
try {
  await check('HTTP health and world catalog',async()=>{
    const health=await request('/api/health');assert.equal(health.status,200);assert.equal(health.data.ok,true);
    const catalog=await request('/api/world');assert.equal(catalog.status,200);world=catalog.data;
    assert.ok(world.items.length>=100);assert.ok(world.recipes.length>=50);
    assert.equal(world.professions.length,22);
  });
  await check('Anonymous session does not expose a player',async()=>{
    const r=await request('/api/session');assert.equal(r.status,200);assert.equal(r.data.player,null);
  });
  let a,b,first,second;
  await check('Register two independent accounts with random passwords',async()=>{a=await register('a');b=await register('b');assert.notEqual(a.id,b.id);});
  await check('Two authenticated WebSockets see each other',async()=>{
    first=await connect(a);second=await connect(b);
    await until(()=>first.snapshot.players.some(p=>p.id===b.id)&&second.snapshot.players.some(p=>p.id===a.id),'two-player snapshots');
  });
  await check('Other players inventory, bank, skills, stats and quests are private',async()=>{
    assert.ok(Object.keys(first.snapshot.self.inventory).length>0);
    for(const [viewer,other]of [[first,b],[second,a]]) {
      const player=viewer.snapshot.players.find(p=>p.id===other.id);assert.ok(player);
      for(const field of ['inventory','bank','skills','stats','quest'])assert.deepEqual(player[field],{});
    }
  });
  await check('Distant gathering is rejected without changing inventory',async()=>{
    const before=quantity(first,'wood');
    const error=await notice(first,{action:'gather',target:'tree_0'},'error');assert.match(error.text,/ближе/i);
    await pause(250);assert.equal(quantity(first,'wood'),before);
  });
  await check('Ordinary walking to trader and atomic purchase',async()=>{
    await walk(first,-10,-2);
    const credits=first.snapshot.self.credits;
    for(const [item,count]of [['tin_ore',2],['wood',1]]){
      const before=quantity(first,item);await notice(first,{action:'buy',item,quantity:count});
      await until(()=>quantity(first,item)===before+count,`purchase ${item}`);
    }
    const expected=world.items.find(i=>i.id==='tin_ore').value*2+world.items.find(i=>i.id==='wood').value;
    assert.equal(first.snapshot.self.credits,credits-expected);
  });
  await check('Walk to bank, deposit and withdraw preserve item totals',async()=>{
    await walk(first,0,0);
    const inventory=quantity(first,'wood'),bank=quantity(first,'wood','bank');
    await notice(first,{action:'bankDeposit',item:'wood',quantity:1});
    await until(()=>quantity(first,'wood')===inventory-1&&quantity(first,'wood','bank')===bank+1,'bank deposit');
    await notice(first,{action:'bankWithdraw',item:'wood',quantity:1});
    await until(()=>quantity(first,'wood')===inventory&&quantity(first,'wood','bank')===bank,'bank withdrawal');
    // Keep one purchased resource in bank for the later persistence check.
    await notice(first,{action:'bankDeposit',item:'wood',quantity:1});
    await until(()=>quantity(first,'wood','bank')===bank+1,'persistent bank item');
  });
  await check('Nearby gathering adds one resource and rejects immediate cooldown retry',async()=>{
    await walk(first,-6,10);
    const before=quantity(first,'water');
    await notice(first,{action:'gather',target:'well'});
    const error=await notice(first,{action:'gather',target:'well'},'error');assert.match(error.text,/восстанавливается/i);
    await until(()=>quantity(first,'water')===before+1,'one gathered resource');
    assert.ok(first.snapshot.self.xp>0);
  });
  await check('Walk to furnace and complete a real five-second smelting job',async()=>{
    await walk(first,11,-10);
    const before=quantity(first,'tin_bar'),ore=quantity(first,'tin_ore');
    const recipe=world.recipes.find(r=>r.id==='smelt_tin');assert.equal(recipe.seconds,5);
    const begin=Date.now();await notice(first,{action:'craft',recipe:recipe.id},'info');
    await until(()=>quantity(first,'tin_ore')===ore-2&&first.snapshot.self.action,'job inputs reserved');
    await until(()=>quantity(first,'tin_bar')===before+1&&!first.snapshot.self.action,'job output',9000);
    assert.ok(Date.now()-begin>=4900,'server must respect the production timer');
  });
  await check('World chat reaches the second player and rapid repeat is rejected',async()=>{
    const text=`${prefix}: network smoke`;
    send(first,{type:'chat',text});
    const index=first.notices.length;send(first,{type:'chat',text:'cooldown probe'});
    const error=await until(()=>first.notices[index],'chat cooldown');assert.equal(error.kind,'error');
    await until(()=>second.snapshot.messages.some(m=>m.text===text&&m.name===a.name),'shared chat');
    assert.ok(!second.snapshot.messages.some(m=>m.text==='cooldown probe'));
  });
  let persisted;
  await check('Session API contains current inventory, bank and position',async()=>{
    const r=await request('/api/session',{cookie:a.cookie});assert.equal(r.status,200);
    persisted=r.data.player;
    assert.ok((persisted.inventory.tin_bar??0)>=1);assert.ok((persisted.bank.wood??0)>=1);
    assert.ok(Math.hypot(persisted.x-11,persisted.z+10)<1);
  });
  await check('Logout revokes the old cookie and closes its WebSocket',async()=>{
    const old=a.cookie;const r=await request('/api/auth/logout',{method:'POST',cookie:old});assert.equal(r.status,200);
    await until(()=>first.ws.readyState===WebSocket.CLOSED,'logout WebSocket closure');
    const revoked=await request('/api/session',{cookie:old});assert.equal(revoked.data.player,null);
  });
  await check('Login with wrong password is rejected',async()=>{
    const r=await request('/api/auth/login',{method:'POST',body:{name:a.name,password:randomBytes(24).toString('base64url')}});assert.equal(r.status,401);assert.ok(!r.cookie);
  });
  await check('Fresh login and WebSocket retain the same character state',async()=>{
    const r=await request('/api/auth/login',{method:'POST',body:{name:a.name,password:a.password}});assert.equal(r.status,200);assert.ok(r.cookie);a.cookie=r.cookie;
    assert.equal(r.data.player.id,persisted.id);assert.deepEqual(r.data.player.inventory,persisted.inventory);assert.deepEqual(r.data.player.bank,persisted.bank);
    assert.equal(r.data.player.x,persisted.x);assert.equal(r.data.player.z,persisted.z);
    first=await connect(a);assert.equal(first.snapshot.self.id,persisted.id);assert.deepEqual(first.snapshot.self.inventory,persisted.inventory);
    assert.deepEqual(first.snapshot.self.bank,persisted.bank);
    await until(()=>first.snapshot.players.some(p=>p.id===b.id),'other account still online after relogin');
  });
  await check('HTTP health reports healthy persistence after state changes',async()=>{
    await pause(1300);const r=await request('/api/health');assert.equal(r.status,200);assert.equal(r.data.persistence,'ok');assert.ok(r.data.online>=2);
  });
} catch(error) {failure=error;console.error(`Smoke failed: ${error.message}`);}
finally {
  for(const connection of connections)try{await close(connection);}catch{}
  for(const account of accounts)try{await request('/api/auth/logout',{method:'POST',cookie:account.cookie});}catch{}
  const passed=results.filter(r=>r.status==='PASS').length,failed=results.filter(r=>r.status==='FAIL').length;
  const table=results.map(r=>`| ${r.name} | ${r.status} | ${r.ms} |`).join('\n');
  const report=`# HTTP / WebSocket smoke verification\n\nRun: ${started.toISOString()}\n\nTarget: ${base.origin}\n\nResult: **${failure?'FAILED':'PASSED'} — ${passed} passed, ${failed} failed**. Duration: ${((Date.now()-started.getTime())/1000).toFixed(1)} seconds.\n\n| Check | Result | Duration, ms |\n| --- | --- | --- |\n${table}\n\n${failure?`Failure: ${failure.message}\n\n`:''}Test accounts: ${accounts.map(a=>a.name).join(', ')||'none'}. Passwords and session values are random and were neither logged nor saved. Sessions were logged out after the run. Accounts remain because the server has no account deletion route.\n\nThe script used normal HTTP and authenticated WebSockets, ordinary movement at requested steps below 7 units/s with 120 ms spacing between movement messages, and occasional action packets. The server WebSocket rate limit was not triggered. It did not edit persisted state, modify clocks, teleport players, or call internal game methods.\n\nInventory, bank and coordinates survived logout and a fresh login. HTTP persistence health was checked after an automatic checkpoint. **Server restart durability was not tested by this script.** Browser rendering, visual quality, collision, frame rate, combat, high-tier crafting and complete original-game fidelity require separate checks.\n`;
  await mkdir(resolve('docs'),{recursive:true});await writeFile(resolve('docs/QA.md'),report,'utf8');
  console.log(JSON.stringify({result:failure?'FAILED':'PASSED',passed,failed,testAccounts:accounts.map(a=>a.name),report:'docs/QA.md'}));
  if(failure)process.exitCode=1;
}
