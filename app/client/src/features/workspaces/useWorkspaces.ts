// Talking to the controller and to settings on behalf of the Workspaces UI.
import {ref} from 'vue';
import { api } from '@/lib/api';
import {
  WCS_SLOTS, type WcsSlot, type Workspace,
  requireCompleteReport, hasActiveG92, loadCommands, readModes, verifyAgainstMachine
} from './workspaces';

/**
 * Read the controller's work offsets.
 *
 * This goes through the server rather than watching the websocket: `$#` output
 * is not broadcast as `cnc-data` (that fires only for `?` status polls), so the
 * reply is collected server-side off the controller's own `data` event, the way
 * the firmware routes already do it.
 */
export async function readOffsetReport(): Promise<string> {
  const response = await fetch(`${api.baseUrl}/api/work-offsets`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || 'Could not read the work offsets from the controller.');
  return payload.report as string;
}

const workspaces = ref<Workspace[]>([]);
const activeId = ref<string | null>(null);
const busy = ref(false);
const error = ref('');

export function useWorkspaces() {

  async function load() {
    const settings = await api.getSettings();
    workspaces.value = Array.isArray(settings?.workspaces) ? settings.workspaces : [];
    activeId.value = settings?.activeWorkspaceId ?? null;
  }

  async function persist() {
    await api.updateSettings({workspaces: workspaces.value, activeWorkspaceId: activeId.value});
  }

  /** Read every slot off the machine into a new workspace. */
  async function captureAll(name: string): Promise<Workspace> {
    const report = await readOffsetReport();
    if (hasActiveG92(report)) {
      throw new Error('G92 is active. Clear the temporary coordinate shift before capturing a workspace.');
    }
    const live = requireCompleteReport(report);
    const now = new Date().toISOString();
    const workspace: Workspace = {id: cryptoId(), name, slots: {}, createdAt: now};
    for (const slot of WCS_SLOTS) {
      const value = live[slot];
      workspace.slots[slot] = {...value!, savedAt: now};
    }
    const updated = [...workspaces.value, workspace];
    await api.updateSettings({workspaces: updated, activeWorkspaceId: activeId.value});
    workspaces.value = updated;
    return workspace;
  }

  /** Save one slot's current machine value into a workspace. */
  async function saveSlot(workspace: Workspace, slot: WcsSlot) {
    const report = await readOffsetReport();
    if (hasActiveG92(report)) throw new Error('G92 is active; clear it (G92.1) before saving a position.');
    const live = requireCompleteReport(report)[slot];
    if (!live) throw new Error(`The controller did not report ${slot}.`);
    workspace.slots[slot] = {x: live.x, y: live.y, z: live.z, savedAt: new Date().toISOString()};
    await persist();
  }

  async function clearSlot(workspace: Workspace, slot: WcsSlot) {
    delete workspace.slots[slot];
    await persist();
  }

  /** Write a workspace onto the machine. Callers confirm with the user first. */
  async function apply(workspace: Workspace) {
    const state = await api.getServerState();
    if (state.machineState?.status !== 'Idle' || ['running', 'paused'].includes(state.jobLoaded?.status)) {
      throw new Error('Stop the job and wait for the machine to be idle before loading a workspace.');
    }
    const commands = loadCommands(workspace);
    const report = await readOffsetReport();
    requireCompleteReport(report);
    if (hasActiveG92(report)) throw new Error('Clear the temporary G92 coordinate shift before loading a workspace.');
    const modes = readModes(report);
    const send = (command: string) => api.sendCommand(command, {displayCommand: command, meta: {sourceId: 'workspaces'}});
    activeId.value = null;
    await persist();
    try {
      for (const command of commands) await send(command);
    } finally {
      await send(modes);
    }
    const result = verifyAgainstMachine(workspace, await readOffsetReport());
    if (!result.ok) throw new Error('The machine offsets do not match the workspace. Verify them before running a job.');
    activeId.value = workspace.id;
    await persist();
    return result;
  }

  async function verify(workspace: Workspace) {
    return verifyAgainstMachine(workspace, await readOffsetReport());
  }

  return {workspaces, activeId, busy, error, load, persist, captureAll, saveSlot, clearSlot, apply, verify};
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() ?? 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
