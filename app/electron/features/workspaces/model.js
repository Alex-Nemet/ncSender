export const WCS_SLOTS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];
export const HISTORY_LIMIT = 100;
export const ZERO = {x: 0, y: 0, z: 0};
const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const xyz = `${number},${number},${number}`;

export function parseOffsetReport(report) {
  const slots = {};
  for (const match of report.matchAll(new RegExp(`\\[(G5[4-9]):(${xyz})(?:,${number})*\\]`, 'g'))) {
    const [x, y, z] = match[2].split(',').map(Number);
    slots[match[1]] = {x, y, z};
  }
  return slots;
}
export function requireCompleteReport(report) {
  const slots = parseOffsetReport(report);
  for (const slot of WCS_SLOTS) {
    if (!validPosition(slots[slot])) throw new Error(`Missing valid X/Y/Z offsets for ${slot}. Nothing was saved.`);
  }
  return slots;
}
export function validPosition(value) {
  return value && ['x', 'y', 'z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis]) && Math.abs(value[axis]) <= 1e7);
}
export function hasActiveG92(report) {
  const match = new RegExp(`\\[G92:(${xyz})(?:,${number})*\\]`).exec(report);
  if (!match) throw new Error('The controller did not report G92.');
  return match[1].split(',').some(value => Number(value) !== 0);
}
export function readModes(report) {
  const words = /\[GC:([^\]]+)\]/.exec(report)?.[1].split(/\s+/) ?? [];
  const units = words.find(word => word === 'G20' || word === 'G21');
  const distance = words.find(word => word === 'G90' || word === 'G91');
  if (!units || !distance) throw new Error('Could not read controller units and distance mode.');
  return `${units} ${distance}`;
}
export function samePosition(a, b) {
  return validPosition(a) && validPosition(b) && ['x', 'y', 'z'].every(axis => Math.abs(a[axis] - b[axis]) < 0.0005);
}
export function slotToP(slot) {
  const index = WCS_SLOTS.indexOf(slot);
  if (index < 0) throw new Error(`Unknown WCS: ${slot}`);
  return index + 1;
}
export function buildLoadProgram(workspace, live) {
  return WCS_SLOTS.flatMap(slot => {
    const saved = workspace.slots[slot];
    if (saved && !validPosition(saved)) throw new Error(`${slot} needs valid X/Y/Z. Re-save this legacy slot before switching.`);
    const to = saved ?? ZERO;
    if (live && samePosition(to, live[slot])) return [];
    const fmt = value => Number(value.toFixed(4)).toString();
    return [{slot, to: saved ? {...to} : null, command: `G10 L2 P${slotToP(slot)} X${fmt(to.x)} Y${fmt(to.y)} Z${fmt(to.z)}`}];
  });
}
export function verifyAgainstMachine(workspace, report) {
  const actual = parseOffsetReport(report);
  const rows = WCS_SLOTS.map(slot => {
    const saved = workspace.slots[slot] ?? null;
    const live = actual[slot] ?? null;
    const matches = samePosition(saved ?? ZERO, live);
    return {slot, saved, live, state: !live ? 'missing' : matches ? saved ? 'ok' : 'unset' : 'differs'};
  });
  return {rows, ok: rows.every(row => row.state === 'ok' || row.state === 'unset')};
}
export function snapshot(live) {
  const now = new Date().toISOString();
  return Object.fromEntries(WCS_SLOTS.map(slot => [slot, {...live[slot], savedAt: now}]));
}
export function recordChange(workspace, nextSlots, label) {
  const changes = WCS_SLOTS.filter(slot => !samePosition(workspace.slots[slot] ?? ZERO, nextSlots[slot] ?? ZERO));
  if (!changes.length) return false;
  const history = workspace.history ?? [];
  const cursor = workspace.historyIndex ?? history.length;
  const before = {}, after = {};
  for (const slot of changes) {
    before[slot] = workspace.slots[slot] ? {...workspace.slots[slot]} : null;
    after[slot] = nextSlots[slot] ? {...nextSlots[slot]} : null;
  }
  workspace.history = [...history.slice(0, cursor), {id: crypto.randomUUID(), at: new Date().toISOString(), label, before, after}].slice(-HISTORY_LIMIT);
  workspace.historyIndex = workspace.history.length;
  workspace.slots = nextSlots;
  return true;
}
export function historyTarget(workspace, direction) {
  const history = workspace.history ?? [];
  const cursor = workspace.historyIndex ?? history.length;
  const index = direction === 'undo' ? cursor - 1 : cursor;
  const entry = history[index];
  if (!entry) throw new Error(`Nothing to ${direction}.`);
  const slots = structuredClone(workspace.slots);
  const patch = direction === 'undo' ? entry.before : entry.after;
  for (const [slot, value] of Object.entries(patch)) {
    if (value) slots[slot] = {...value};
    else delete slots[slot];
  }
  return {slots, historyIndex: direction === 'undo' ? cursor - 1 : cursor + 1, entry};
}
export function workspaceName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Use a workspace name between 1 and 100 characters.');
  return name.trim();
}
export function exportWorkspace(workspace) {
  buildLoadProgram(workspace);
  return {format: 'ncsender-workspace', version: 1, units: 'mm', exportedAt: new Date().toISOString(), workspace: {name: workspace.name, note: workspace.note ?? '', slots: structuredClone(workspace.slots)}};
}
export function importWorkspace(data) {
  if (data?.format !== 'ncsender-workspace' || data.version !== 1 || data.units !== 'mm') throw new Error('Choose a version 1 ncSender workspace export in millimetres.');
  const input = data.workspace;
  const name = workspaceName(input?.name);
  if (!input.slots || typeof input.slots !== 'object' || Array.isArray(input.slots)) throw new Error('Workspace slots are missing.');
  const slots = {};
  const now = new Date().toISOString();
  for (const [slot, value] of Object.entries(input.slots)) {
    if (!WCS_SLOTS.includes(slot) || !validPosition(value)) throw new Error(`Invalid coordinates for ${slot}.`);
    slots[slot] = {x: value.x, y: value.y, z: value.z, savedAt: now};
  }
  return {id: crypto.randomUUID(), name, note: typeof input.note === 'string' ? input.note.slice(0, 2000) : '', slots, createdAt: now, history: [], historyIndex: 0};
}
export function changesWorkOffsets(command) {
  const code = String(command).replace(/\([^)]*\)|;.*/g, '').toUpperCase();
  return /(?:^|[^A-Z])G0?10(?=[^\d.]|$)/.test(code) && /L(?:2|20)(?=[^\d.]|$)/.test(code);
}
