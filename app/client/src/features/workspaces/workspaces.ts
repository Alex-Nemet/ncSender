export const WCS_SLOTS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] as const;
export type WcsSlot = (typeof WCS_SLOTS)[number];

/** P-word for `G10 L2`: G54 is P1 ... G59 is P6. */
export function slotToP(slot: string): number {
  const index = (WCS_SLOTS as readonly string[]).indexOf(slot.toUpperCase());
  if (index < 0) throw new Error(`Not a work coordinate system: ${slot}`);
  return index + 1;
}

/** A saved position. Machine coordinates in millimetres, matching `$#`. */
export interface SavedPosition {
  x: number;
  y: number;
  z: number;
  savedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  note?: string;
  /** Slots this workspace defines. A slot absent here is deliberately unset. */
  slots: Partial<Record<WcsSlot, SavedPosition>>;
  createdAt: string;
}

/**
 * Parse the `[G54:x,y,z,a]` lines out of a `$#` report.
 * Returns millimetres, exactly as the controller reports them. Extra slots such
 * as G59.1 and the G28/G30/G92/TLO/PRB lines are ignored: they are not slots a
 * workspace writes.
 */
export function parseOffsetReport(text: string): Partial<Record<WcsSlot, {x: number; y: number; z: number}>> {
  const found: Partial<Record<WcsSlot, {x: number; y: number; z: number}>> = {};
  // G59.1 must not match as G59, so the slot name is anchored to the colon.
  const line = /\[(G5[4-9]):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = line.exec(text)) !== null) {
    const slot = match[1] as WcsSlot;
    found[slot] = {x: Number(match[2]), y: Number(match[3]), z: Number(match[4])};
  }
  return found;
}

/** True when an additional G92 coordinate shift is active. */
export function hasActiveG92(text: string): boolean {
  const match = /\[G92:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(text);
  if (!match) return false;
  return [1, 2, 3].some(i => Number(match[i]) !== 0);
}

export interface LoadLine {
  slot: WcsSlot;
  command: string;
  /** What this slot becomes. null means it is being cleared. */
  to: {x: number; y: number; z: number} | null;
}

export function buildLoadProgram(workspace: Workspace): LoadLine[] {
  const lines: LoadLine[] = [];
  for (const slot of WCS_SLOTS) {
    const saved = workspace.slots[slot];
    const p = slotToP(slot);
    if (saved) {
      if (![saved.x, saved.y, saved.z].every(Number.isFinite)) {
        throw new Error(`${slot} is missing valid X/Y/Z offsets. Re-save this slot from the machine before loading.`);
      }
      lines.push({slot, to: {x: saved.x, y: saved.y, z: saved.z},
        command: `G10 L2 P${p} X${fmt(saved.x)} Y${fmt(saved.y)} Z${fmt(saved.z)}`});
    } else {
      lines.push({slot, to: null, command: `G10 L2 P${p} X0 Y0 Z0`});
    }
  }
  return lines;
}

export function readModes(report: string) {
  const words = /\[GC:([^\]]+)\]/.exec(report)?.[1].split(/\s+/) ?? [];
  const units = words.find(word => word === 'G20' || word === 'G21');
  const distance = words.find(word => word === 'G90' || word === 'G91');
  if (!units || !distance) throw new Error('Could not read the controller units and distance mode.');
  return `${units} ${distance}`;
}

export function loadCommands(workspace: Workspace): string[] {
  return ['G21 G90', ...buildLoadProgram(workspace).map(l => l.command)];
}

export function requireCompleteReport(report: string) {
  const slots = parseOffsetReport(report);
  for (const slot of WCS_SLOTS) {
    const value = slots[slot];
    if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) {
      throw new Error(`The controller did not report valid X/Y/Z offsets for ${slot}. Nothing was saved or loaded.`);
    }
  }
  return slots;
}

/** Trailing zeros removed, but never exponent notation. */
function fmt(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot write ${value} to a work offset`);
  return String(Number(value.toFixed(4)));
}

/**
 * Compare what a workspace claims against what `$#` reports, for verification
 * before a job. Tolerance is a thousandth of a millimetre: the controller
 * reports three decimals, so anything larger is a real difference.
 */
export function verifyAgainstMachine(workspace: Workspace, report: string) {
  const actual = parseOffsetReport(report);
  const rows = WCS_SLOTS.map(slot => {
    const saved = workspace.slots[slot];
    const live = actual[slot];
    if (!saved) {
      if (!live) return {slot, state: 'missing', saved: null, live: null};
      const cleared = live.x === 0 && live.y === 0 && live.z === 0;
      return {slot, state: cleared ? 'unset' : 'unexpected', saved: null, live: live ?? null};
    }
    if (!live) return {slot, state: 'missing', saved, live: null};
    const matches = Math.abs(live.x - saved.x) < 0.001 && Math.abs(live.y - saved.y) < 0.001 && Math.abs(live.z - saved.z) < 0.001;
    return {slot, state: matches ? 'ok' : 'differs', saved, live};
  });
  return {rows, ok: rows.every(r => r.state === 'ok' || r.state === 'unset')};
}
