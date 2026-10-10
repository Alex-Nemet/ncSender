<template>
  <Teleport to="body">
    <div v-if="isOpen" class="ws-overlay" @click.self="$emit('close')">
      <div class="ws-panel" role="dialog" aria-modal="true" aria-label="Manage workspaces">
        <header class="ws-head">
          <h2>Workspaces</h2>
          <button class="ws-x" type="button" @click="$emit('close')" aria-label="Close">×</button>
        </header>
        <p class="ws-current"><strong>Current workspace: {{ current?.name || 'None' }}</strong></p>
        <p class="ws-note">Coordinate changes are saved automatically to the current workspace after confirmation from the controller.</p>
        <p v-if="busy" role="status">Working…</p>
        <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
        <p v-if="message" class="ws-verify ok" role="status">{{ message }}</p>

        <div v-if="!hasBackup" class="ws-firstrun">
          <p><strong>Save your current setup first.</strong></p>
          <p>Capture all six X/Y/Z offsets as Default before switching workspaces.</p>
          <div class="ws-row">
            <input v-model="newName" class="ws-input" aria-label="Initial workspace name" placeholder="Default" />
            <button class="ws-btn primary" :disabled="busy" @click="doCapture">Capture all six from machine</button>
          </div>
        </div>

        <div v-if="workspaces.length" class="ws-row">
          <label for="ws-pick">View workspace</label>
          <select id="ws-pick" class="ws-select" v-model="selectedId" :disabled="busy">
            <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}{{ w.id === activeId ? ' — current' : '' }}</option>
          </select>
          <button class="ws-btn primary" :disabled="busy || !canChange || !hasBackup || !selected || selected.id === activeId" @click="doSwitch">Switch to this workspace</button>
          <button class="ws-btn" :disabled="busy || !canChange || !selected" @click="doVerify">Verify</button>
        </div>

        <template v-if="selected">
          <p v-if="selected.id !== activeId" class="ws-note">Viewing saved coordinates. This workspace is not currently loaded on the controller.</p>
          <div class="ws-row">
            <label for="ws-name">Name</label>
            <input id="ws-name" v-model="renameText" class="ws-input" maxlength="100" :disabled="busy" />
            <button class="ws-btn" :disabled="busy || !renameText.trim() || renameText.trim() === selected.name" @click="doRename">Rename</button>
          </div>
          <table class="ws-table">
            <thead><tr><th>WCS</th><th>X mm</th><th>Y mm</th><th>Z mm</th><th></th></tr></thead>
            <tbody>
              <tr v-for="slot in SLOTS" :key="slot" :class="{unset: !selected.slots[slot]}">
                <td class="mono">{{ slot }}</td>
                <template v-if="selected.slots[slot]">
                  <td class="mono">{{ format(selected.slots[slot]?.x) }}</td>
                  <td class="mono">{{ format(selected.slots[slot]?.y) }}</td>
                  <td class="mono">{{ format(selected.slots[slot]?.z) }}</td>
                </template>
                <td v-else colspan="3" class="muted">Not set — loads as X0 Y0 Z0</td>
                <td><button class="ws-btn small" :disabled="busy || !canChange" @click="doSaveSlot(slot)">Save current {{ slot }}</button></td>
              </tr>
            </tbody>
          </table>
          <div class="ws-row">
            <button class="ws-btn" :disabled="busy || !canChange || selected.id !== activeId || !canUndo" @click="doHistory('undo')">↶ Undo</button>
            <button class="ws-btn" :disabled="busy || !canChange || selected.id !== activeId || !canRedo" @click="doHistory('redo')">↷ Redo</button>
            <button class="ws-btn" :disabled="busy" @click="doExport">Export workspace…</button>
            <button class="ws-btn danger" :disabled="busy" @click="doDelete">Delete…</button>
          </div>
          <p class="ws-note">Undo and Redo restore work offsets on the controller while idle. They do not undo movement. The last 100 changes are kept for each workspace.</p>
          <details class="ws-history">
            <summary>Coordinate history ({{ selected.history?.length || 0 }})</summary>
            <p v-if="!selected.history?.length" class="muted">No changes recorded yet.</p>
            <ol v-else>
              <li v-for="item in historyRows" :key="item.entry.id" :class="{muted: item.index >= historyCursor}">
                <strong>{{ item.entry.label }}</strong> · {{ when(item.entry.at) }}{{ item.index >= historyCursor ? ' · undone' : '' }}
                <div v-for="(to, slot) in item.entry.after" :key="slot" class="mono">{{ slot }}: {{ position(item.entry.before[slot]) }} → {{ position(to) }}</div>
              </li>
            </ol>
          </details>
        </template>

        <div v-if="hasBackup" class="ws-row ws-new">
          <input v-model="newName" class="ws-input" aria-label="New workspace name" maxlength="100" placeholder="New workspace name" />
          <button class="ws-btn" :disabled="busy || !newName.trim()" @click="doCreate">Create empty</button>
          <button class="ws-btn" :disabled="busy || !canChange || !newName.trim()" @click="doCapture">Capture from machine</button>
        </div>
        <div class="ws-row">
          <button class="ws-btn" :disabled="busy" @click="importInput?.click()">Import workspace…</button>
          <input ref="importInput" type="file" accept=".json,application/json" hidden @change="doImport" />
        </div>
        <p class="ws-note">Creating or importing adds to the library without changing the controller. Switch using the toolbar or the button above. Exports contain workspace coordinates, not controller configuration.</p>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue';
import {WCS_SLOTS, type WcsSlot, type SavedPosition} from './workspaces';
import {useWorkspaces} from './useWorkspaces';
import {useAppStore} from '@/composables/use-app-store';

const props = defineProps<{isOpen: boolean; initialWorkspaceId?: string | null}>();
defineEmits<{(e: 'close'): void}>();
const ws = useWorkspaces();
const {workspaces, activeId, current, busy, error, message, hasBackup, canUndo, canRedo} = ws;
const store = useAppStore();
const canChange = computed(() => store.status.connected && store.status.machineState?.toLowerCase() === 'idle' && !store.isJobRunning.value);
const SLOTS = WCS_SLOTS as WcsSlot[];
const selectedId = ref<string | null>(null);
const newName = ref('');
const renameText = ref('');
const importInput = ref<HTMLInputElement | null>(null);
const selected = computed(() => workspaces.value.find(w => w.id === selectedId.value));
const historyCursor = computed(() => selected.value?.historyIndex ?? selected.value?.history?.length ?? 0);
const historyRows = computed(() => (selected.value?.history ?? []).map((entry, index) => ({entry, index})).reverse());
watch(() => selected.value?.name, name => {renameText.value = name ?? '';});
watch(() => props.isOpen, async open => {
  if (!open) return;
  try {
    await ws.load();
    selectedId.value = props.initialWorkspaceId ?? activeId.value ?? workspaces.value[0]?.id ?? null;
  } catch (e: any) {error.value = e.message;}
}, {immediate: true});
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  try {await fn();} catch (e: any) {error.value = e.message;}
}
const doCapture = () => run(async () => {
  const result = await ws.act('capture', {name: newName.value.trim() || 'Default'});
  selectedId.value = result.id; newName.value = '';
  message.value = 'Current coordinates saved. This is now your current workspace.';
});
const doCreate = () => run(async () => {
  const result = await ws.act('create', {name: newName.value});
  selectedId.value = result.id; newName.value = '';
  message.value = 'Created in your library. Not loaded; controller coordinates are unchanged.';
});
const doRename = () => run(async () => {await ws.act('rename', {id: selectedId.value, name: renameText.value});});
const doSwitch = () => run(async () => {if (selectedId.value) await ws.switchWorkspace(selectedId.value);});
const doVerify = () => run(async () => {
  const result = await ws.act('verify', {id: selectedId.value});
  message.value = result.ok ? 'Machine matches. This workspace is now marked current.' : `Does not match: ${result.rows.filter((r: any) => !['ok', 'unset'].includes(r.state)).map((r: any) => r.slot).join(', ')}.`;
});
const doSaveSlot = (slot: WcsSlot) => run(async () => {await ws.act('save-slot', {id: selectedId.value, slot});});
const doHistory = (direction: string) => run(async () => {
  await ws.act(direction, {id: selectedId.value});
  message.value = `${direction === 'undo' ? 'Undo' : 'Redo'} complete. Controller coordinates verified.`;
});
const doDelete = () => run(async () => {
  if (!selected.value || !confirm(`Delete “${selected.value.name}” and its history? Export it first if you want a backup. Controller coordinates will not change.`)) return;
  await ws.act('delete', {id: selectedId.value});
  selectedId.value = activeId.value ?? workspaces.value[0]?.id ?? null;
});
const doExport = () => run(async () => {
  const {file} = await ws.act('export', {id: selectedId.value});
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], {type: 'application/json'}));
  const a = document.createElement('a'); a.href = url;
  a.download = `${file.workspace.name.replace(/[^a-z0-9_-]/gi, '_')}.workspace.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const doImport = (event: Event) => run(async () => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  if (file.size > 100000) throw new Error('Workspace files must be smaller than 100 KB.');
  const result = await ws.act('import', {data: JSON.parse(await file.text())});
  selectedId.value = result.id;
  message.value = 'Imported as a new workspace. Not loaded; controller coordinates are unchanged.';
});
const format = (n: number | undefined) => Number.isFinite(n) ? n!.toFixed(3) : 'Re-save required';
const position = (p?: SavedPosition | null) => p ? `${format(p.x)}, ${format(p.y)}, ${format(p.z)}` : '0, 0, 0';
const when = (iso: string) => new Date(iso).toLocaleString();
</script>
<style scoped>
.ws-overlay { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; z-index: 1000; }
.ws-panel { background: var(--color-surface, #1e1e1e); color: var(--color-text, #eee); border-radius: 10px; padding: 20px; width: min(760px, 94vw); max-height: 88vh; overflow: auto; }
.ws-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.ws-head h2 { margin: 0; font-size: 18px; }
.ws-x { background: none; border: 0; color: inherit; font-size: 22px; cursor: pointer; }
.ws-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
.ws-new { border-top: 1px solid #ffffff22; padding-top: 12px; }
.ws-label { font-size: 12px; opacity: .8; }
.ws-input, .ws-select { background: #0003; color: inherit; border: 1px solid #ffffff33; border-radius: 6px; padding: 6px 8px; }
.ws-input { flex: 1 1 180px; }
.ws-btn { background: #ffffff14; color: inherit; border: 1px solid #ffffff33; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.ws-btn:hover:not(:disabled) { background: #ffffff22; }
.ws-btn:disabled { opacity: .45; cursor: default; }
.ws-btn.small { padding: 3px 8px; font-size: 12px; }
.ws-btn.primary { background: var(--accent-color, #1abc9c); color: #06231d; border-color: transparent; font-weight: 600; }
.ws-btn.danger { border-color: #e0555566; color: #ff9b9b; }
.ws-table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px; }
.ws-table th { text-align: left; font-weight: 600; opacity: .7; padding: 4px 6px; border-bottom: 1px solid #ffffff22; }
.ws-table td { padding: 5px 6px; border-bottom: 1px solid #ffffff11; }
.mono { font-family: ui-monospace, monospace; }
.muted { opacity: .55; }
.hint { font-size: 11px; opacity: .7; }
.when { font-size: 12px; opacity: .7; }
.unset td { background: #ffffff06; }
.ws-actions { text-align: right; white-space: nowrap; }
.ws-note { font-size: 12px; opacity: .8; margin: 6px 0 0; }
.ws-error { background: #e0555522; border: 1px solid #e0555555; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.ws-firstrun { background: #ffffff0d; border: 1px solid #ffffff22; border-radius: 8px; padding: 14px; }
.ws-firstrun p { margin: 0 0 8px; font-size: 13px; }
.ws-confirm { margin-top: 14px; border: 1px solid var(--accent-color, #1abc9c); border-radius: 8px; padding: 12px; }
.ws-confirm h3 { margin: 0 0 8px; font-size: 15px; }
.clearing td { color: #ffb37a; }
.ws-warn { font-size: 12px; color: #ffb37a; }
.ws-verify { margin-top: 12px; padding: 10px; border-radius: 6px; background: #e0555522; font-size: 13px; }
.ws-verify.ok { background: #1abc9c22; }
.ws-verify ul { margin: 6px 0 0; padding-left: 18px; }
</style>
