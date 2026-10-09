import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {EventEmitter} from 'node:events';
import {readOffsets} from '../../electron/features/workspaces/routes.js';

const bundled = await build({
  entryPoints: ['src/features/workspaces/useWorkspaces.ts'],
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  bundle:true, write:false, platform:'node', format:'esm',
  plugins:[{name:'fake-api',setup(b){b.onResolve({filter:/^@\/lib\/api$/},()=>({path:'api',namespace:'fake'}));b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:'export const api = globalThis.workspaceTestApi;'}));}}]
});
const logicBundle = await build({entryPoints:['src/features/workspaces/workspaces.ts'],absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),bundle:true,write:false,format:'esm'});
const logic = await import(`data:text/javascript;base64,${Buffer.from(logicBundle.outputFiles[0].text).toString('base64')}`);
const initial = [[979.418,-731.266,23.324],[672.831,-1141.713,27.725],[0,0,12],[0,0,0],[557.886,-797.533,-45.012],[36.718,-827.244,-45.294]];
let live, settings, commands, failCommand, mode, machineStatus, tamper, partial, g92, failPersist;
const report = () => live.map((v,i)=>`[G${54+i}:${v.join(',')}]`).slice(0,partial?2:6).join('\n')+`\n[G59.1:99,99,99]\n[G92:${g92},0,0]\n[TLO:0,0,-60.955]\n[PRB:0,0,0:0]\n[GC:G0 G54 ${mode} M5]`;
globalThis.workspaceTestApi = {
  baseUrl:'http://fake',
  getSettings:async()=>structuredClone(settings),
  updateSettings:async value=>{if(failPersist) throw new Error('Save failed');settings=JSON.parse(JSON.stringify(value));},
  getServerState:async()=>({machineState:{status:machineStatus},jobLoaded:null}),
  sendCommand:async command=>{
    commands.push(command);
    await new Promise(resolve=>setTimeout(resolve,1));
    if(command===failCommand) throw new Error('Controller rejected command');
    if(command.startsWith('G10')) {
      const match=/P(\d) X([^ ]+) Y([^ ]+) Z([^ ]+)/.exec(command);
      live[Number(match[1])-1]=match.slice(2).map(Number);
      if(tamper) live[Number(match[1])-1][2]+=1;
    } else mode=command;
  }
};
globalThis.fetch=async()=>({ok:true,json:async()=>({report:report()})});
const {useWorkspaces}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const ws=useWorkspaces();
async function reset(){live=structuredClone(initial);settings={workspaces:[],activeWorkspaceId:null};commands=[];failCommand=null;mode='G20 G91';machineStatus='Idle';tamper=false;partial=false;g92=0;failPersist=false;await ws.load();}

test('capture, reload saved settings, restore and verify six XYZ slots without mixing in TLO',async()=>{
 await reset();
 assert.equal(useWorkspaces().workspaces,ws.workspaces);
 const saved=await ws.captureAll('Default');
 assert.equal(saved.slots.G54.z,23.324);
 assert.equal(saved.slots.G56.z,12);
 assert.equal(saved.slots.G57.z,0);
 assert.equal(Object.keys(saved.slots).length,6);
 await ws.load();
 live=live.map(()=>[1,2,3]);
 assert.equal((await ws.apply(ws.workspaces.value[0])).ok,true);
 assert.deepEqual(live,initial);
 assert.equal(mode,'G20 G91');
 assert.equal(settings.activeWorkspaceId,saved.id);
 assert.equal(commands.length,8);
});
test('re-touching Z and re-saving survives a workspace reload',async()=>{
 await reset();const saved=await ws.captureAll('Default');
 live[1][2]=42;await ws.saveSlot(saved,'G55');live[1][2]=0;
 await ws.load();await ws.apply(ws.workspaces.value[0]);assert.equal(live[1][2],42);
});
test('old XY-only workspace is rejected before sending any commands',async()=>{
 await reset();const saved=await ws.captureAll('Old');delete saved.slots.G54.z;
 await assert.rejects(ws.apply(saved),/Re-save/);assert.equal(commands.length,0);
});
test('partial capture does not persist a workspace',async()=>{
 await reset();partial=true;await assert.rejects(ws.captureAll('Partial'),/G56/);assert.equal(settings.workspaces.length,0);
});
test('controller rejection stops loading, restores modes, and leaves workspace inactive',async()=>{
 await reset();const saved=await ws.captureAll('Default');failCommand=logic.buildLoadProgram(saved)[1].command;
 await assert.rejects(ws.apply(saved),/rejected/);assert.equal(commands.length,4);assert.equal(mode,'G20 G91');assert.equal(settings.activeWorkspaceId,null);
});
test('verification catches Z mismatch and missing or uncleared slots',async()=>{
 await reset();const saved=await ws.captureAll('Default');live[0][2]+=1;assert.equal((await ws.verify(saved)).ok,false);
 delete saved.slots.G54;assert.equal((await ws.verify(saved)).ok,false);
 live[0]=[0,0,0];assert.equal((await ws.verify(saved)).ok,true);
 partial=true;assert.equal((await ws.verify(saved)).ok,false);
});
test('failed read-back never marks the workspace active',async()=>{
 await reset();const saved=await ws.captureAll('Default');tamper=true;
 await assert.rejects(ws.apply(saved),/do not match/);assert.equal(settings.activeWorkspaceId,null);
});
test('running machine and G92 block loading before writes',async()=>{
 await reset();const saved=await ws.captureAll('Default');machineStatus='Run';await assert.rejects(ws.apply(saved),/idle/);
 machineStatus='Idle';g92=1;await assert.rejects(ws.apply(saved),/G92/);assert.equal(commands.length,0);
});
test('an intentionally cleared slot writes and verifies XYZ zero',async()=>{
 await reset();const saved=await ws.captureAll('Default');await ws.clearSlot(saved,'G55');await ws.apply(saved);assert.deepEqual(live[1],[0,0,0]);
});
test('server waits for acknowledgements and parser state, then removes listener',async()=>{
 await reset();const controller=new EventEmitter();const sent=[];
 controller.sendCommand=async command=>{sent.push(command);for(const line of report().split('\n').filter(l=>command==='$G'?l.startsWith('[GC:'):!l.startsWith('[GC:')))controller.emit('data',line);};
 const result=await readOffsets(controller);assert.equal(result.slots.G54.z,23.324);assert.deepEqual(sent,['$#','$G']);assert.equal(controller.listenerCount('data'),0);
});
test('server refuses incomplete, disconnected, and timed-out reports',async()=>{
 await reset();const controller=new EventEmitter();controller.sendCommand=async()=>{controller.emit('data','[G54:1,2,3]');};
 await assert.rejects(readOffsets(controller),/incomplete/);
 controller.sendCommand=async()=>{throw new Error('not connected');};await assert.rejects(readOffsets(controller),/not connected/);
 controller.sendCommand=()=>new Promise(()=>{});await assert.rejects(readOffsets(controller,10),/in time/);assert.equal(controller.listenerCount('data'),0);
});

test('failed first backup never unlocks workspace loading',async()=>{
 await reset();failPersist=true;await assert.rejects(ws.captureAll('Default'),/Save failed/);
 assert.equal(ws.workspaces.value.length,0);assert.equal(settings.workspaces.length,0);
});
