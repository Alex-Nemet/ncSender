<template>
  <Teleport to="body">
    <div v-if="isOpen" class="ws-overlay" @click.self="$emit('close')">
      <div class="ws-panel">
        <header class="ws-head">
          <h2>Workspaces</h2>
          <button class="ws-x" type="button" @click="$emit('close')" aria-label="Close">×</button>
        </header>

        <p v-if="error" class="ws-error">{{ error }}</p>

        <!-- Nothing can be loaded until what is on the machine has been saved,
             because loading clears every slot the workspace does not define. -->
        <div v-if="!workspaces.length" class="ws-firstrun">
          <p><strong>Start by saving what the machine has now.</strong></p>
          <p>Loading a workspace clears every slot it does not define, so capture your
             current offsets first or they are gone.</p>
          <div class="ws-row">
            <input v-model="newName" class="ws-input" placeholder="Default" @keyup.enter="doCapture" />
            <button class="ws-btn primary" type="button" :disabled="busy" @click="doCapture">
              Capture all six from machine
            </button>
          </div>
        </div>

        <template v-else>
          <div class="ws-row">
            <label class="ws-label" for="ws-pick">Workspace</label>
            <select id="ws-pick" class="ws-select" v-model="selectedId" :disabled="busy || !!pending">
              <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
            <button class="ws-btn" type="button" :disabled="busy || !selected" @click="doApply">Load onto machine</button>
            <button class="ws-btn" type="button" :disabled="busy || !selected" @click="doVerify">Verify</button>
          </div>

          <table v-if="selected" class="ws-table">
            <thead><tr><th>WCS</th><th>X mm</th><th>Y mm</th><th>Z mm</th><th>Saved</th><th></th></tr></thead>
            <tbody>
              <tr v-for="slot in SLOTS" :key="slot" :class="{ unset: !selected.slots[slot] }">
                <td class="mono">{{ slot }}</td>
                <template v-if="selected.slots[slot]">
                  <td class="mono">{{ selected.slots[slot].x.toFixed(3) }}</td>
                  <td class="mono">{{ selected.slots[slot].y.toFixed(3) }}</td>
                  <td class="mono">{{ selected.slots[slot].z?.toFixed(3) ?? 'Re-save required' }}</td>
                  <td class="when">{{ when(selected.slots[slot].savedAt) }}</td>
                  <td class="ws-actions">
                    <button class="ws-btn small" type="button" :disabled="busy || !!pending" @click="doSaveSlot(slot)">Re-save</button>
                    <button class="ws-btn small" type="button" :disabled="busy || !!pending" @click="doClearSlot(slot)">Clear</button>
                  </td>
                </template>
                <template v-else>
                  <td colspan="4" class="muted">— not set — <span class="hint">cleared to zero when loaded</span></td>
                  <td class="ws-actions">
                    <button class="ws-btn small" type="button" :disabled="busy || !!pending" @click="doSaveSlot(slot)">
                      Save current {{ slot }}
                    </button>
                  </td>
                </template>
              </tr>
            </tbody>
          </table>

          <p class="ws-note">
            Loading restores <strong>X, Y and Z</strong> for every WCS. You can touch off Z again, then re-save the slot to remember it.
          </p>

          <div class="ws-row ws-new">
            <input v-model="newName" class="ws-input" placeholder="New workspace name" @keyup.enter="doCreate" />
            <button class="ws-btn" type="button" :disabled="busy || !newName.trim()" @click="doCreate">Create empty</button>
            <button class="ws-btn" type="button" :disabled="busy || !newName.trim()" @click="doCapture">Capture from machine</button>
            <button class="ws-btn danger" type="button" :disabled="busy || !selected" @click="doDelete">Delete</button>
          </div>
        </template>

        <!-- Confirming a load: every slot that changes is listed before anything is written. -->
        <div v-if="pending" class="ws-confirm">
          <h3>Load “{{ pending.name }}” onto the machine?</h3>
          <table class="ws-table">
            <thead><tr><th>WCS</th><th>Now: X, Y, Z (mm)</th><th>Becomes: X, Y, Z (mm)</th></tr></thead>
            <tbody>
              <tr v-for="row in pendingRows" :key="row.slot" :class="{ clearing: !row.to }">
                <td class="mono">{{ row.slot }}</td>
                <td class="mono muted">{{ row.from }}</td>
                <td class="mono">{{ row.to ? `${row.to.x.toFixed(3)}, ${row.to.y.toFixed(3)}, ${row.to.z.toFixed(3)}` : 'cleared to 0' }}</td>
              </tr>
            </tbody>
          </table>
          <p class="ws-warn" v-if="pendingRows.some(r => !r.to && r.from !== '0.000, 0.000, 0.000')">
            Slots shown as cleared currently hold a position. It will be lost unless it is saved in another workspace.
          </p>
          <div class="ws-row">
            <button class="ws-btn primary" type="button" :disabled="busy" @click="confirmApply">Write offsets</button>
            <button class="ws-btn" type="button" @click="pending = null">Cancel</button>
          </div>
        </div>

        <div v-if="verifyResult" class="ws-verify" :class="{ ok: verifyResult.ok }">
          <strong>{{ verifyResult.ok ? 'Machine matches this workspace.' : 'Machine does not match.' }}</strong>
          <ul>
            <li v-for="r in verifyResult.rows" :key="r.slot" v-show="r.state !== 'ok' && r.state !== 'unset'">
              {{ r.slot }}: {{ r.state }}
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { WCS_SLOTS, type WcsSlot, type Workspace, requireCompleteReport, buildLoadProgram } from './workspaces';
import { useWorkspaces, readOffsetReport } from './useWorkspaces';

const props = defineProps<{ isOpen: boolean; initialWorkspaceId?: string | null }>();
defineEmits<{ (e: 'close'): void }>();

const SLOTS = WCS_SLOTS;
const ws = useWorkspaces();
const { workspaces, busy } = ws;
const error = ref('');
const newName = ref('');
const selectedId = ref<string | null>(null);
const pending = ref<Workspace | null>(null);
const pendingRows = ref<any[]>([]);
const verifyResult = ref<any>(null);

const selected = computed(() => workspaces.value.find(w => w.id === selectedId.value) || null);

watch(() => props.isOpen, async open => {
  if (!open) return;
  error.value = ''; verifyResult.value = null; pending.value = null;
  try {
    await ws.load();
    selectedId.value = props.initialWorkspaceId ?? ws.activeId.value ?? workspaces.value[0]?.id ?? null;
  } catch (e: any) { error.value = e?.message || String(e); }
}, { immediate: true });

const run = async (fn: () => Promise<void>) => {
  if (busy.value) return;
  busy.value = true; error.value = ''; verifyResult.value = null;
  try { await fn(); } catch (e: any) { error.value = e?.message || String(e); }
  finally { busy.value = false; }
};

const doCapture = () => run(async () => {
  const created = await ws.captureAll(newName.value.trim() || 'Default');
  selectedId.value = created.id; newName.value = '';
});

const doCreate = () => run(async () => {
  const w: Workspace = { id: crypto.randomUUID(), name: newName.value.trim(), slots: {}, createdAt: new Date().toISOString() };
  workspaces.value.push(w); await ws.persist();
  selectedId.value = w.id; newName.value = '';
});

const doSaveSlot = (slot: WcsSlot) => run(async () => { if (selected.value) await ws.saveSlot(selected.value, slot); });
const doClearSlot = (slot: WcsSlot) => run(async () => { if (selected.value) await ws.clearSlot(selected.value, slot); });

const doDelete = () => run(async () => {
  if (!selected.value) return;
  if (!confirm(`Delete workspace “${selected.value.name}”? The machine's offsets are not changed.`)) return;
  if (ws.activeId.value === selected.value.id) ws.activeId.value = null;
  workspaces.value = workspaces.value.filter(w => w.id !== selected.value!.id);
  await ws.persist();
  selectedId.value = workspaces.value[0]?.id ?? null;
});

// Read the machine first so the confirmation shows real before/after values.
const doApply = () => run(async () => {
  if (!selected.value) return;
  const live = requireCompleteReport(await readOffsetReport());
  pendingRows.value = buildLoadProgram(selected.value).map(l => ({
    slot: l.slot, to: l.to,
    from: live[l.slot] ? `${live[l.slot]!.x.toFixed(3)}, ${live[l.slot]!.y.toFixed(3)}, ${live[l.slot]!.z.toFixed(3)}` : 'unknown'
  }));
  pending.value = JSON.parse(JSON.stringify(selected.value));
});

const confirmApply = () => run(async () => {
  if (!pending.value) return;
  verifyResult.value = await ws.apply(pending.value);
  pending.value = null;
});

const doVerify = () => run(async () => {
  if (selected.value) verifyResult.value = await ws.verify(selected.value);
});

const when = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
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
