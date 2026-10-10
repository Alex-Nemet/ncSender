import {WCS_SLOTS, ZERO, samePosition, requireCompleteReport, hasActiveG92, readModes, buildLoadProgram, verifyAgainstMachine, snapshot, recordChange, historyTarget, workspaceName, importWorkspace, exportWorkspace, changesWorkOffsets, validPosition} from './model.js';

export function createWorkspaceService({controller, serverState, readSettings, saveSettings, readOffsets, broadcast = () => {}}) {
  let queue = Promise.resolve();
  let busy = false;
  let error = '';
  let pendingSync = false;
  let disposed = false;
  const state = () => {
    const settings = readSettings() ?? {};
    return {workspaces: structuredClone(settings.workspaces ?? []), activeWorkspaceId: settings.activeWorkspaceId ?? null, hasBackup: settings.workspaceBackupCaptured ?? (settings.workspaces ?? []).some(w => WCS_SLOTS.every(slot => validPosition(w.slots?.[slot]))), busy, error};
  };
  const notify = () => broadcast('workspaces-updated', state());
  const commit = data => {
    saveSettings({workspaces: data.workspaces, activeWorkspaceId: data.activeWorkspaceId, workspaceBackupCaptured: data.hasBackup});
    notify();
  };
  const find = (data, id) => {
    const workspace = data.workspaces.find(item => item.id === id);
    if (!workspace) throw new Error('Workspace no longer exists.');
    return workspace;
  };
  const isIdle = () => controller.isConnected && String(controller.lastStatus?.status ?? serverState.machineState?.status).toLowerCase() === 'idle'
    && !serverState.machineState?.isProbing && !serverState.machineState?.isToolChanging
    && !['running', 'paused'].includes(serverState.jobLoaded?.status);
  const requireIdle = () => { if (!isIdle()) throw new Error('Wait for the machine to be idle with no running or paused job.'); };
  const report = async () => {
    const result = await readOffsets(controller);
    requireCompleteReport(result.report);
    if (hasActiveG92(result.report)) throw new Error('Clear the temporary G92 coordinate shift before using workspaces.');
    return result;
  };
  const enqueue = operation => {
    const result = queue.then(async () => {
      busy = true; error = ''; notify();
      try { return await operation(); }
      catch (e) { error = e.message || String(e); throw e; }
      finally { busy = false; notify(); }
    });
    queue = result.catch(() => {});
    return result;
  };
  const syncInto = (data, live, label) => {
    const current = data.workspaces.find(item => item.id === data.activeWorkspaceId);
    if (!current) return false;
    const slots = {...current.slots};
    for (const slot of WCS_SLOTS) {
      if (!samePosition(slots[slot] ?? ZERO, live[slot])) slots[slot] = {...live[slot], savedAt: new Date().toISOString()};
    }
    return recordChange(current, slots, label);
  };
  const synchronize = async label => {
    if (!isIdle()) { pendingSync = true; return; }
    const data = state();
    if (!data.activeWorkspaceId) { pendingSync = false; return; }
    const live = requireCompleteReport((await report()).report);
    if (syncInto(data, live, label)) commit(data);
    pendingSync = false;
  };
  const scheduleSync = label => {
    if (disposed) return;
    enqueue(() => synchronize(label)).catch(() => { pendingSync = false; });
  };
  const onAck = result => {
    if (result.status !== 'success' || result.meta?.sourceId === 'workspaces' || !changesWorkOffsets(result.command)) return;
    pendingSync = true;
    scheduleSync('Coordinate change');
  };
  const onStatus = () => {
    if (pendingSync && !busy && isIdle()) {
      pendingSync = false;
      scheduleSync('Coordinate change');
    }
  };
  controller.on('command-ack', onAck);
  controller.on('status-report', onStatus);

  const writeAndVerify = async (workspace, before) => {
    const live = requireCompleteReport(before.report);
    const lines = buildLoadProgram(workspace, live);
    if (!lines.length) return {result: verifyAgainstMachine(workspace, before.report), written: 0};
    const modes = readModes(before.report);
    const send = command => controller.sendCommand(command, {displayCommand: command, meta: {sourceId: 'workspaces'}});
    try {
      await send('G21 G90');
      for (const line of lines) {
        requireIdle();
        await send(line.command);
      }
    } finally {
      await send(modes);
    }
    const result = verifyAgainstMachine(workspace, (await report()).report);
    if (!result.ok) throw new Error('Controller read-back does not match. The workspace is not marked active; inspect the offsets before continuing.');
    return {result, written: lines.length};
  };
  const exclusive = async fn => {
    requireIdle();
    if (controller.activeCommand || controller.pendingCommands?.size || controller.commandQueue?.size) throw new Error('Wait for queued controller commands to finish.');
    controller.workspaceOperation = true;
    try { return await fn(); }
    finally { controller.workspaceOperation = false; }
  };
  const switchTo = async (id, confirmEmpty = false) => exclusive(async () => {
    const data = state();
    const target = find(data, id);
    buildLoadProgram(target);
    if (!data.hasBackup) throw new Error('Capture all six current offsets as Default before switching.');
    if (!Object.keys(target.slots).length && !confirmEmpty) throw new Error('Confirm switching to this empty workspace: all six WCS offsets will be cleared.');
    const before = await report();
    if (syncInto(data, requireCompleteReport(before.report), 'Saved before switching')) commit(data);
    if (data.activeWorkspaceId === id) return {written: 0};
    const lines = buildLoadProgram(target, requireCompleteReport(before.report));
    if (lines.length) {
      data.activeWorkspaceId = null;
      commit(data);
    }
    const result = await writeAndVerify(target, before);
    data.activeWorkspaceId = id;
    commit(data);
    pendingSync = false;
    return result;
  });
  const undoRedo = async (id, direction) => exclusive(async () => {
    const data = state();
    if (data.activeWorkspaceId !== id) throw new Error('Switch to this workspace before using Undo or Redo.');
    const before = await report();
    if (syncInto(data, requireCompleteReport(before.report), 'Coordinate change')) commit(data);
    const workspace = find(data, id);
    const target = historyTarget(workspace, direction);
    const changed = Object.keys(direction === 'undo' ? target.entry.before : target.entry.after);
    for (const slot of changed) {
      if (target.slots[slot] && !validPosition(target.slots[slot])) throw new Error('This history predates saved Z offsets and cannot be restored.');
    }
    data.activeWorkspaceId = null;
    commit(data);
    const result = await writeAndVerify({...workspace, slots: target.slots}, before);
    workspace.slots = target.slots;
    workspace.historyIndex = target.historyIndex;
    data.activeWorkspaceId = id;
    commit(data);
    pendingSync = false;
    return result;
  });

  const execute = (action, input = {}) => enqueue(async () => {
    const data = state();
    switch (action) {
      case 'capture': {
        requireIdle();
        const live = requireCompleteReport((await report()).report);
        if (syncInto(data, live, 'Coordinate change')) commit(data);
        const workspace = {id: crypto.randomUUID(), name: workspaceName(input.name), slots: snapshot(live), createdAt: new Date().toISOString(), history: [], historyIndex: 0};
        data.workspaces.push(workspace); data.activeWorkspaceId = workspace.id; data.hasBackup = true; commit(data);
        return {id: workspace.id};
      }
      case 'create': {
        if (!data.hasBackup) throw new Error('Capture your current coordinates as Default first.');
        const workspace = {id: crypto.randomUUID(), name: workspaceName(input.name), slots: {}, createdAt: new Date().toISOString(), history: [], historyIndex: 0};
        data.workspaces.push(workspace); commit(data); return {id: workspace.id};
      }
      case 'rename': find(data, input.id).name = workspaceName(input.name); commit(data); return {};
      case 'delete':
        find(data, input.id);
        data.workspaces = data.workspaces.filter(w => w.id !== input.id);
        if (data.activeWorkspaceId === input.id) data.activeWorkspaceId = null;
        commit(data); return {};
      case 'import': {
        const workspace = importWorkspace(input.data);
        data.workspaces.push(workspace); commit(data); return {id: workspace.id};
      }
      case 'export': {
        if (data.activeWorkspaceId === input.id && isIdle()) await synchronize('Coordinate change');
        return {file: exportWorkspace(find(state(), input.id))};
      }
      case 'verify': {
        requireIdle();
        const before = await report();
        const result = verifyAgainstMachine(find(data, input.id), before.report);
        if (result.ok) {
          syncInto(data, requireCompleteReport(before.report), 'Saved before verifying another workspace');
          data.activeWorkspaceId = input.id;
          commit(data);
        }
        return result;
      }
      case 'save-slot': {
        requireIdle();
        if (!WCS_SLOTS.includes(input.slot)) throw new Error('Unknown WCS.');
        const live = requireCompleteReport((await report()).report);
        const workspace = find(data, input.id);
        const slots = {...workspace.slots, [input.slot]: {...live[input.slot], savedAt: new Date().toISOString()}};
        recordChange(workspace, slots, `Saved ${input.slot}`); commit(data); return {};
      }
      case 'report': return report();
      case 'switch': return switchTo(input.id, input.confirmEmpty === true);
      case 'undo': case 'redo': return undoRedo(input.id, action);
      default: throw new Error('Unknown workspace action.');
    }
  });
  return {state, execute, idle: () => queue, dispose() {disposed = true; controller.removeListener('command-ack', onAck); controller.removeListener('status-report', onStatus);}};
}
