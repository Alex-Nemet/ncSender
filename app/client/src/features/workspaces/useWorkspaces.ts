// Talking to the controller and to settings on behalf of the Workspaces UI.
import {ref} from 'vue';
import { api } from '@/lib/api';
import {
  WCS_SLOTS, type WcsSlot, type Workspace,
  parseOffsetReport, hasActiveG92, loadCommands, verifyAgainstMachine
} from './workspaces';

/** `$#` has no reply route of its own; the controller's answer arrives on the
 *  cnc-data broadcast like any other output, so it is collected there. */
export function readOffsetReport(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      off?.();
      clearTimeout(timer);
      if (error) reject(error); else resolve(text);
    };
    const off = api.on('cnc-data', (payload: any) => {
      const chunk = typeof payload === 'string' ? payload : (payload?.data ?? payload?.raw ?? '');
      if (!chunk) return;
      text += chunk;
      // PRB is the last line of the report, so it marks the end.
      if (/\[PRB:/.test(text)) finish();
    });
    const timer = setTimeout(() => {
      if (/\[G54:/.test(text)) finish();            // partial but usable
      else finish(new Error('The controller did not answer $# in time.'));
    }, timeoutMs);
    api.sendCommandViaWebSocket({command: '$#', displayCommand: '$#', meta: {sourceId: 'workspaces'}})
      .catch((error: any) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

// Module-level so the toolbar and the dialog share one copy: a save made in the
// dialog has to show up in the toolbar's list without a reload.
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
      throw new Error('G92 is active on the controller, which shifts the reported offsets. Clear it (G92.1) before capturing.');
    }
    const live = parseOffsetReport(report);
    const now = new Date().toISOString();
    const workspace: Workspace = {id: cryptoId(), name, slots: {}, createdAt: now};
    for (const slot of WCS_SLOTS) {
      const value = live[slot];
      // A slot sitting at zero is an unused slot, not a position worth saving.
      if (value && (value.x !== 0 || value.y !== 0)) {
        workspace.slots[slot] = {x: value.x, y: value.y, savedAt: now};
      }
    }
    workspaces.value.push(workspace);
    await persist();
    return workspace;
  }

  /** Save one slot's current machine value into a workspace. */
  async function saveSlot(workspace: Workspace, slot: WcsSlot) {
    const report = await readOffsetReport();
    if (hasActiveG92(report)) throw new Error('G92 is active; clear it (G92.1) before saving a position.');
    const live = parseOffsetReport(report)[slot];
    if (!live) throw new Error(`The controller did not report ${slot}.`);
    workspace.slots[slot] = {x: live.x, y: live.y, savedAt: new Date().toISOString()};
    await persist();
  }

  async function clearSlot(workspace: Workspace, slot: WcsSlot) {
    delete workspace.slots[slot];
    await persist();
  }

  /** Write a workspace onto the machine. Callers confirm with the user first. */
  async function apply(workspace: Workspace) {
    for (const command of loadCommands(workspace)) {
      await api.sendCommandViaWebSocket({command, displayCommand: command, meta: {sourceId: 'workspaces'}});
    }
    activeId.value = workspace.id;
    await persist();
  }

  async function verify(workspace: Workspace) {
    return verifyAgainstMachine(workspace, await readOffsetReport());
  }

  return {workspaces, activeId, busy, error, load, persist, captureAll, saveSlot, clearSlot, apply, verify};
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() ?? 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
