// Workspaces: named sets of work-offset positions.
//
// The controller has six WCS slots (G54-G59) and they fill up. A Workspace is a
// named set of positions that gets loaded INTO those slots on demand, so the
// slots become scratch space and the library is the real storage.
//
// Two rules decided at the machine on 2026-10-09 and proven there:
//
//  1. Loading a position writes X and Y only, never Z. Z is a property of the
//     stock, not the fixture, and is touched off per blank. Verified that
//     `G10 L2` with no Z word leaves the stored Z untouched.
//  2. Capture reads `$#`, not the status report's WCO. WCO is the sum of the
//     work offset, G92 and the tool length offset - its Z is contaminated by
//     TLO (observed: G54 Z 23.324 + TLO -60.955 = WCO Z -37.631). `$#` reports
//     the stored offsets themselves.
//
// Clearing a slot is a different operation from loading one: it writes X0 Y0 Z0,
// wiping any stale Z, because the slot is being declared meaningless. An unused
// slot sitting at zero is deliberate - on this machine Y runs 0 to -1248, so a
// program run against a zeroed slot leaves the envelope and trips soft limits
// before it moves, rather than cutting somewhere plausible and wrong.

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

/** True when `$#` reports a non-zero G92, which would corrupt a capture. */
export function hasActiveG92(text: string): boolean {
  const match = /\[G92:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(text);
  if (!match) return false;
  return [1, 2, 3].some(i => Number(match[i]) !== 0);
}

export interface LoadLine {
  slot: WcsSlot;
  command: string;
  /** What this slot becomes. null means it is being cleared. */
  to: {x: number; y: number} | null;
}

/**
 * The G10 commands that put a workspace onto the machine.
 *
 * Slots the workspace defines get their X and Y. Slots it does not define are
 * cleared to zero - including Z - so nothing stale is left behind pretending to
 * be a position. Values are emitted in millimetres under G21 because that is
 * what `$#` reports, so a saved number makes the round trip unchanged.
 */
export function buildLoadProgram(workspace: Workspace): LoadLine[] {
  const lines: LoadLine[] = [];
  for (const slot of WCS_SLOTS) {
    const saved = workspace.slots[slot];
    const p = slotToP(slot);
    if (saved) {
      lines.push({slot, to: {x: saved.x, y: saved.y},
        command: `G10 L2 P${p} X${fmt(saved.x)} Y${fmt(saved.y)}`});
    } else {
      lines.push({slot, to: null, command: `G10 L2 P${p} X0 Y0 Z0`});
    }
  }
  return lines;
}

/** Commands to send, with the units/mode prefix the G10 lines rely on. */
export function loadCommands(workspace: Workspace): string[] {
  return ['G21 G90', ...buildLoadProgram(workspace).map(l => l.command), 'G20'];
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
      const cleared = !live || (live.x === 0 && live.y === 0);
      return {slot, state: cleared ? 'unset' : 'unexpected', saved: null, live: live ?? null};
    }
    if (!live) return {slot, state: 'missing', saved, live: null};
    const matches = Math.abs(live.x - saved.x) < 0.001 && Math.abs(live.y - saved.y) < 0.001;
    return {slot, state: matches ? 'ok' : 'differs', saved, live};
  });
  return {rows, ok: rows.every(r => r.state === 'ok' || r.state === 'unset')};
}
