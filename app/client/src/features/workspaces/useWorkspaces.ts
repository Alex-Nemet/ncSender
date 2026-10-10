import {computed, ref} from 'vue';
import {api} from '@/lib/api';
import type {Workspace} from './workspaces';

const workspaces = ref<Workspace[]>([]);
const activeId = ref<string | null>(null);
const serverBusy = ref(false);
const requestBusy = ref(false);
const busy = computed(() => serverBusy.value || requestBusy.value);
const error = ref('');
const message = ref('');
const hasBackup = ref(false);
let stopListening: (() => void) | null = null;
let revision = 0;

function receive(state: any) {
  revision++;
  workspaces.value = state.workspaces;
  activeId.value = state.activeWorkspaceId;
  serverBusy.value = state.busy;
  hasBackup.value = state.hasBackup;
  error.value = state.error || '';
}
async function load() {
  const before = revision;
  const response = await fetch(`${api.baseUrl}/api/workspaces`);
  if (!response.ok) throw new Error('Could not load workspaces.');
  const state = await response.json();
  if (revision === before) receive(state);
}
async function act(action: string, data: any = {}) {
  if (busy.value) throw new Error('A workspace operation is still in progress.');
  requestBusy.value = true; error.value = ''; message.value = '';
  try {
    const response = await fetch(`${api.baseUrl}/api/workspaces/${action}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
    const payload = await response.json();
    if (payload.state) receive(payload.state);
    if (!response.ok) throw new Error(payload.error || 'Workspace operation failed.');
    return payload.result;
  } catch (e: any) { error.value = e.message; throw e; }
  finally { requestBusy.value = false; }
}
async function switchWorkspace(id: string) {
  if (id === activeId.value) return;
  const workspace = workspaces.value.find(w => w.id === id);
  if (!workspace) return;
  const empty = Object.keys(workspace.slots).length === 0;
  if (empty && !window.confirm(`Switch to empty workspace “${workspace.name}”? This clears X, Y and Z in all six WCS slots. Your current workspace will be saved first.`)) return;
  const result = await act('switch', {id, confirmEmpty: empty});
  message.value = `Switched to ${workspace.name}. ${result.written} WCS slots updated; coordinates verified.`;
  return result;
}
function listen() {
  if (stopListening) return;
  const offUpdate = api.on('workspaces-updated', receive);
  const offConnect = api.on('connected', () => load().catch(e => {error.value = e.message;}));
  stopListening = () => {offUpdate(); offConnect(); stopListening = null;};
}
const current = computed(() => workspaces.value.find(w => w.id === activeId.value));
const canUndo = computed(() => !!current.value && (current.value.historyIndex ?? current.value.history?.length ?? 0) > 0);
const canRedo = computed(() => !!current.value && (current.value.historyIndex ?? current.value.history?.length ?? 0) < (current.value.history?.length ?? 0));
export function useWorkspaces() {
  return {workspaces, activeId, current, busy, error, message, hasBackup, canUndo, canRedo, load, act, switchWorkspace, listen, stop: () => stopListening?.()};
}
