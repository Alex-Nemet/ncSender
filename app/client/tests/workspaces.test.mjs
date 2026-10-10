import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {createWorkspaceService} from '../../electron/features/workspaces/service.js';
import {readOffsets} from '../../electron/features/workspaces/routes.js';
import {WCS_SLOTS, ZERO, buildLoadProgram, requireCompleteReport, verifyAgainstMachine, importWorkspace, exportWorkspace, changesWorkOffsets, HISTORY_LIMIT} from '../../electron/features/workspaces/model.js';

const originals = {G54:{x:979.418,y:-731.266,z:23.324},G55:{x:672.831,y:-1141.713,z:27.725},G56:{x:0,y:0,z:12},G57:{...ZERO},G58:{x:557.886,y:-797.533,z:-45.012},G59:{x:36.718,y:-827.244,z:-45.294}};
function harness(initialSettings = {}) {
  const h = {live:structuredClone(originals), settings:structuredClone(initialSettings), writes:[], broadcasts:[], mode:'G20 G91', g92:0, failSave:false, failCommand:null, tamper:false, partial:false, disconnected:false};
  h.controller = new EventEmitter();
  h.controller.isConnected = true; h.controller.lastStatus = {status:'Idle'};
  h.serverState = {machineState:{connected:true,status:'Idle'},jobLoaded:null};
  h.report = () => Object.entries(h.live).slice(0,h.partial?2:6).map(([slot,p])=>`[${slot}:${p.x},${p.y},${p.z},0]`).join('\n')+`\n[G59.1:99,99,99]\n[G92:${h.g92},0,0,0]\n[TLO:0,0,-60.955,0]\n[PRB:0,0,0,0:0]\n[GC:G0 G54 ${h.mode} M5]`;
  h.controller.sendCommand = async (command, options = {}) => {
    if(h.disconnected) throw new Error('not connected');
    await Promise.resolve();
    if(command===h.failCommand) throw new Error('Rejected by controller');
    if(command==='$#' || command==='$G') {
      const lines=h.report().split('\n').filter(l=>command==='$G'?l.startsWith('[GC:'):!l.startsWith('[GC:'));
      for(const line of lines) h.controller.emit('data',line);
    } else {
      h.writes.push(command);
      if(command.startsWith('G10')) {
        const m=/P(\d) X([^ ]+) Y([^ ]+) Z([^ ]+)/.exec(command);
        h.live[WCS_SLOTS[+m[1]-1]]={x:+m[2],y:+m[3],z:+m[4]+(h.tamper?1:0)};
      } else h.mode=command;
    }
    h.controller.emit('command-ack',{status:'success',command,meta:options.meta});
  };
  h.service=createWorkspaceService({controller:h.controller,serverState:h.serverState,readSettings:()=>structuredClone(h.settings),saveSettings:updates=>{if(h.failSave)throw new Error('Disk save failed');Object.assign(h.settings,structuredClone(updates));},readOffsets,broadcast:(type,data)=>h.broadcasts.push({type,data})});
  h.capture=async(name='Default')=>(await h.service.execute('capture',{name})).id;
  h.change=async(slot,axes,command='G10 L20 P2 X0 Y0')=>{Object.assign(h.live[slot],axes);h.controller.emit('command-ack',{status:'success',command,meta:{sourceId:'client'}});await h.service.idle();};
  h.workspace=id=>h.settings.workspaces.find(w=>w.id===id);
  h.g10=()=>h.writes.filter(c=>c.startsWith('G10'));
  return h;
}

test('capture selects and persists all six XYZ slots including zero and Z-only positions; TLO stays separate',async()=>{
 const h=harness();const id=await h.capture();const w=h.workspace(id);
 assert.equal(h.settings.activeWorkspaceId,id);assert.equal(h.settings.workspaceBackupCaptured,true);
 assert.equal(Object.keys(w.slots).length,6);assert.equal(w.slots.G54.z,23.324);assert.equal(w.slots.G56.z,12);assert.equal(w.slots.G57.z,0);
 assert.deepEqual(h.writes,[]);
});
test('zero XY automatically saves one history entry and undo/redo only touches G55',async()=>{
 const h=harness();const id=await h.capture();await h.change('G55',{x:5,y:8});
 assert.equal(h.workspace(id).slots.G55.x,5);assert.equal(h.workspace(id).history.length,1);
 assert.deepEqual(Object.keys(h.workspace(id).history[0].before),['G55']);assert.deepEqual(h.writes,[]);
 await h.service.execute('undo',{id});assert.deepEqual(h.live,originals);assert.equal(h.g10().length,1);assert.equal(h.mode,'G20 G91');
 await h.service.execute('redo',{id});assert.equal(h.live.G55.x,5);assert.equal(h.live.G55.y,8);assert.equal(h.live.G55.z,originals.G55.z);assert.equal(h.g10().length,2);
 assert.equal(h.workspace(id).history.length,1);assert.equal(h.settings.activeWorkspaceId,id);
});
test('a Z touch-off is autosaved and survives restarting the service',async()=>{
 const h=harness();const id=await h.capture();await h.change('G55',{z:42},'G10L20P2Z0');
 const resumed=harness(h.settings);resumed.live=structuredClone(h.live);
 await resumed.service.execute('undo',{id});assert.equal(resumed.live.G55.z,originals.G55.z);
 await resumed.service.execute('redo',{id});assert.equal(resumed.live.G55.z,42);
});
test('new change after undo clears redo and retains the new value',async()=>{
 const h=harness();const id=await h.capture();await h.change('G55',{z:42});await h.service.execute('undo',{id});await h.change('G54',{x:7},'G10L20P1X0');
 await assert.rejects(h.service.execute('redo',{id}),/Nothing to redo/);assert.equal(h.workspace(id).history.length,1);assert.equal(h.workspace(id).slots.G54.x,7);
});
test('creating does not change machine or current workspace; empty switch requires confirmation',async()=>{
 const h=harness();const id=await h.capture();const empty=(await h.service.execute('create',{name:'Necks'})).id;
 assert.equal(h.settings.activeWorkspaceId,id);assert.deepEqual(h.live,originals);assert.equal(h.writes.length,0);
 await assert.rejects(h.service.execute('switch',{id:empty}),/Confirm/);assert.equal(h.writes.length,0);
 await h.service.execute('switch',{id:empty,confirmEmpty:true});assert.equal(h.settings.activeWorkspaceId,empty);assert.equal(h.g10().length,5);
 for(const value of Object.values(h.live))assert.deepEqual(value,ZERO);
 assert.equal(h.workspace(id).slots.G55.z,originals.G55.z);assert.equal(h.workspace(empty).history.length,0);
});
test('blank slots and identical slots are skipped; return restores saved XYZ',async()=>{
 const h=harness();const id=await h.capture();const empty=(await h.service.execute('create',{name:'Necks'})).id;
 await h.service.execute('switch',{id:empty,confirmEmpty:true});h.writes=[];
 await h.service.execute('switch',{id});assert.deepEqual(h.live,originals);assert.equal(h.g10().length,5);assert.equal(h.mode,'G20 G91');
});
test('switch with all identical coordinates sends no writes or mode changes',async()=>{
 const h=harness();const a=await h.capture('A');const b=await h.capture('B');
 const result=await h.service.execute('switch',{id:a});assert.equal(result.written,0);assert.equal(h.settings.activeWorkspaceId,a);assert.deepEqual(h.writes,[]);assert.equal(h.workspace(b).history.length,0);
});
test('outgoing missed changes are saved before switch and incoming coordinates never overwrite them',async()=>{
 const h=harness();const a=await h.capture('A');const b=(await h.service.execute('create',{name:'B'})).id;
 h.live.G55.z=88;await h.service.execute('switch',{id:b,confirmEmpty:true});
 assert.equal(h.workspace(a).slots.G55.z,88);assert.equal(h.workspace(a).history.length,1);assert.equal(h.workspace(b).history.length,0);
 await h.change('G54',{x:25},'G10 L20 P1 X0');await h.service.execute('switch',{id:a});
 assert.equal(h.live.G55.z,88);assert.equal(h.live.G54.x,originals.G54.x);assert.equal(h.workspace(b).slots.G54.x,25);
});
test('new workspace gets its own autosave history after switching',async()=>{
 const h=harness();const a=await h.capture();const b=(await h.service.execute('create',{name:'B'})).id;
 await h.service.execute('switch',{id:b,confirmEmpty:true});await h.change('G55',{z:30});
 await h.service.execute('undo',{id:b});assert.equal(h.live.G55.z,0);assert.equal(h.workspace(a).history.length,0);
});
test('failed controller write leaves no active workspace and preserves outgoing saved data',async()=>{
 const h=harness();const a=await h.capture();const b=(await h.service.execute('create',{name:'B'})).id;
 h.failCommand='G10 L2 P2 X0 Y0 Z0';await assert.rejects(h.service.execute('switch',{id:b,confirmEmpty:true}),/Rejected/);
 assert.equal(h.settings.activeWorkspaceId,null);assert.equal(h.mode,'G20 G91');assert.equal(h.controller.workspaceOperation,false);assert.equal(h.workspace(a).slots.G55.z,originals.G55.z);
});
test('read-back mismatch never claims a successful switch',async()=>{
 const h=harness();await h.capture();const b=(await h.service.execute('create',{name:'B'})).id;h.tamper=true;
 await assert.rejects(h.service.execute('switch',{id:b,confirmEmpty:true}),/read-back/);assert.equal(h.settings.activeWorkspaceId,null);
});
test('failed backup persistence does not unlock creating or switching',async()=>{
 const h=harness();h.failSave=true;await assert.rejects(h.capture(),/Disk save failed/);
 assert.equal(h.service.state().hasBackup,false);assert.equal(h.service.state().workspaces.length,0);
});
test('failed autosave is visible, leaves the previous snapshot, and blocks a switch when retry cannot save',async()=>{
 const h=harness();const a=await h.capture();const b=(await h.service.execute('create',{name:'B'})).id;h.failSave=true;
 await h.change('G55',{x:42});assert.match(h.service.state().error,/Disk save failed/);assert.equal(h.workspace(a).slots.G55.x,originals.G55.x);
 await assert.rejects(h.service.execute('switch',{id:b,confirmEmpty:true}),/Disk save failed/);assert.deepEqual(h.writes,[]);
});
test('running, paused, disconnected, probing and queued-command states block switches',async()=>{
 for(const kind of ['run','paused','disconnected','probing','queued']){
  const h=harness();await h.capture();const b=(await h.service.execute('create',{name:'B'})).id;
  if(kind==='run')h.controller.lastStatus.status='Run';if(kind==='paused')h.serverState.jobLoaded={status:'paused'};if(kind==='disconnected')h.controller.isConnected=false;if(kind==='probing')h.serverState.machineState.isProbing=true;if(kind==='queued')h.controller.activeCommand={};
  await assert.rejects(h.service.execute('switch',{id:b,confirmEmpty:true}),/Wait/);assert.equal(h.writes.length,0);
 }
});
test('probe changes are saved once the machine returns idle',async()=>{
 const h=harness();const id=await h.capture();h.serverState.machineState.isProbing=true;await h.change('G55',{z:42});
 assert.equal(h.workspace(id).slots.G55.z,originals.G55.z);h.serverState.machineState.isProbing=false;h.controller.emit('status-report',{});await h.service.idle();assert.equal(h.workspace(id).slots.G55.z,42);
});
test('rejected G10, jogging, selecting G55 and tool-offset commands do not trigger autosave',async()=>{
 const h=harness();const id=await h.capture();h.live.G55.x=42;
 for(const command of ['G55','$J=G91 X1 F100','G43.1 Z10','G100 X1'])h.controller.emit('command-ack',{command,status:'success'});
 h.controller.emit('command-ack',{command:'G10 L20 P2 X0',status:'error'});await h.service.idle();assert.equal(h.workspace(id).history.length,0);
});
test('history records stop at the last 100 changes',async()=>{
 const h=harness();const id=await h.capture();for(let i=0;i<105;i++)await h.change('G55',{x:i});
 assert.equal(h.workspace(id).history.length,HISTORY_LIMIT);assert.equal(h.workspace(id).historyIndex,HISTORY_LIMIT);
});
test('rename preserves identity, coordinates, active status and history',async()=>{
 const h=harness();const id=await h.capture();await h.change('G55',{x:5});const before=structuredClone(h.workspace(id));
 await h.service.execute('rename',{id,name:'  Known good  '});assert.deepEqual(h.workspace(id),{...before,name:'Known good'});assert.equal(h.settings.activeWorkspaceId,id);
});
test('export/import round trip keeps XYZ, creates a fresh identity and makes no controller writes',async()=>{
 const h=harness();const id=await h.capture();await h.change('G55',{z:55});
 const {file}=await h.service.execute('export',{id});const imported=(await h.service.execute('import',{data:JSON.parse(JSON.stringify(file))})).id;
 assert.notEqual(imported,id);assert.equal(h.settings.activeWorkspaceId,id);assert.equal(h.workspace(imported).slots.G55.z,55);assert.equal(h.workspace(imported).history.length,0);assert.equal(h.writes.length,0);
});
test('import before capture cannot replace the mandatory first backup',async()=>{
 const src=harness();const id=await src.capture();const h=harness();const imported=(await h.service.execute('import',{data:exportWorkspace(src.workspace(id))})).id;
 assert.equal(h.service.state().hasBackup,false);await assert.rejects(h.service.execute('switch',{id:imported}),/Capture/);assert.equal(h.writes.length,0);
});
test('import validation rejects missing Z, nonfinite numbers, unknown slots, wrong units and format',()=>{
 const valid={format:'ncsender-workspace',version:1,units:'mm',workspace:{name:'Example',slots:{G54:{x:1,y:2,z:3}}}};
 for(const mutate of [f=>delete f.workspace.slots.G54.z,f=>f.workspace.slots.G54.x=Infinity,f=>f.workspace.slots.G99={...ZERO},f=>f.units='inch',f=>f.version=2,f=>f.workspace.name='']){
  const file=structuredClone(valid);mutate(file);assert.throws(()=>importWorkspace(file));
 }
});
test('old XY-only workspace cannot be loaded and verification does not invent Z',async()=>{
 const h=harness();await h.capture();const {id}=await h.service.execute('create',{name:'Old'});h.workspace(id).slots.G54={x:1,y:2};
 await assert.rejects(h.service.execute('switch',{id}),/Re-save/);assert.equal(h.writes.length,0);assert.equal(verifyAgainstMachine(h.workspace(id),h.report()).ok,false);
});
test('legacy workspace slot can be re-saved with Z',async()=>{
 const h=harness();const id=await h.capture();delete h.workspace(id).slots.G55.z;
 await h.service.execute('save-slot',{id,slot:'G55'});assert.equal(h.workspace(id).slots.G55.z,originals.G55.z);
});
test('matching verification adopts an existing capture without writing offsets',async()=>{
 const h=harness();const id=await h.capture();h.settings.activeWorkspaceId=null;
 assert.equal((await h.service.execute('verify',{id})).ok,true);assert.equal(h.settings.activeWorkspaceId,id);assert.equal(h.writes.length,0);
});
test('G92 and partial reports block capture and writes',async()=>{
 const h=harness();h.partial=true;await assert.rejects(h.capture(),/Missing/);h.partial=false;h.g92=1;await assert.rejects(h.capture(),/G92/);assert.equal(h.writes.length,0);
});
test('read collector waits for acknowledgements, includes modes and removes listeners',async()=>{
 const h=harness();const result=await readOffsets(h.controller);assert.equal(result.slots.G54.z,23.324);assert.match(result.report,/G20 G91/);assert.equal(h.controller.listenerCount('data'),0);
 h.disconnected=true;await assert.rejects(readOffsets(h.controller),/not connected/);assert.equal(h.controller.listenerCount('data'),0);
 h.controller.sendCommand=()=>new Promise(()=>{});await assert.rejects(readOffsets(h.controller,5),/in time/);assert.equal(h.controller.listenerCount('data'),0);
});
test('comparison excludes G59.1, validates six slots and detects Z-only differences',()=>{
 const h=harness();const live=requireCompleteReport(h.report());assert.deepEqual(live,originals);
 const workspace={slots:structuredClone(live)};workspace.slots.G55.z+=1;
 assert.equal(buildLoadProgram(workspace,live).length,1);assert.equal(buildLoadProgram(workspace,live)[0].slot,'G55');
});
test('compact, numbered and lowercase G10 commands are detected without matching comments',()=>{
 for(const command of ['G10L20P2X0','N20 g10 l2 p1 z2','G010 L20 X0'])assert.equal(changesWorkOffsets(command),true);
 for(const command of ['(G10 L20 X0) G55','G55 ; G10 L20 X0','G100 L20 X0','G10 L200 X0'])assert.equal(changesWorkOffsets(command),false);
});
test('two concurrent switch requests execute serially with no history pollution',async()=>{
 const h=harness();const a=await h.capture();const b=(await h.service.execute('create',{name:'B'})).id;
 await Promise.all([h.service.execute('switch',{id:b,confirmEmpty:true}),h.service.execute('switch',{id:a})]);
 assert.deepEqual(h.live,originals);assert.equal(h.settings.activeWorkspaceId,a);assert.equal(h.workspace(a).history.length,0);assert.equal(h.workspace(b).history.length,0);
});

test('adopting a matching workspace preserves unsaved outgoing coordinates',async()=>{
 const h=harness();const a=await h.capture('A');h.live.G55.z=99;
 const b=(await h.service.execute('import',{data:exportWorkspace({...h.workspace(a),slots:structuredClone(h.live)})})).id;
 assert.equal((await h.service.execute('verify',{id:b})).ok,true);
 assert.equal(h.workspace(a).slots.G55.z,99);assert.equal(h.workspace(a).history.length,1);
 assert.equal(h.settings.activeWorkspaceId,b);assert.equal(h.writes.length,0);
});

test('client composable starts with shared refs and updates the active label and history from server events',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {createRequire}=await import('node:module');
 const {pathToFileURL}=await import('node:url');
 const require=createRequire(new URL('../package.json',import.meta.url));
 const ts=require('typescript');
 const listeners=new Map();
 globalThis.__workspaceTestApi={baseUrl:'',on:(event,fn)=>{listeners.set(event,fn);return()=>listeners.delete(event);}};
 const originalFetch=globalThis.fetch;
 try {
  let source=await readFile(new URL('../src/features/workspaces/useWorkspaces.ts',import.meta.url),'utf8');
  source=source.replace("from 'vue'",`from '${pathToFileURL(require.resolve('vue/dist/vue.runtime.esm-bundler.js')).href}'`).replace("import {api} from '@/lib/api';",'const api = globalThis.__workspaceTestApi;');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const {useWorkspaces}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const a=useWorkspaces(),b=useWorkspaces();assert.equal(a.activeId,b.activeId);a.listen();
  const state={workspaces:[{id:'a',name:'Default',slots:{},history:[{}],historyIndex:1}],activeWorkspaceId:'a',hasBackup:true,busy:false,error:''};
  globalThis.fetch=async()=>({ok:true,json:async()=>state});await a.load();
  assert.equal(b.current.value.name,'Default');assert.equal(b.canUndo.value,true);
  listeners.get('workspaces-updated')({...state,activeWorkspaceId:null,busy:true});
  assert.equal(a.activeId.value,null);assert.equal(a.busy.value,true);
  listeners.get('workspaces-updated')({...state,workspaces:[{...state.workspaces[0],name:'Renamed',historyIndex:0}]});
  assert.equal(a.current.value.name,'Renamed');assert.equal(a.canUndo.value,false);assert.equal(a.canRedo.value,true);
  a.stop();assert.equal(listeners.size,0);
 } finally {globalThis.fetch=originalFetch;delete globalThis.__workspaceTestApi;}
});
