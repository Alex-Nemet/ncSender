# Workspaces — named sets of work offsets

Branch: `feature/workspaces` · Written 2026-10-09 · **Status: does not work yet, see "Current bug"**

## The problem

grblHAL gives six work coordinate systems, G54–G59 (plus G59.1–.3). They fill up.
On this machine all six are in use and there is no record of what most of them are
for, so reusing a slot destroys a position that may have taken real setup time to
establish.

More slots is not the fix. The fix is to stop treating the slots as storage: keep a
named library of positions in the app and **load** them into whichever slots are
needed for the job at hand. The six slots become scratch space.

A "Workspace" is a named set of positions, e.g. *Top of neck operations* =
{ G54 → blank A, G55 → blank B }.

### What this unlocks

The motivating job is cutting two (or more) banjo necks in one run. Blank A on G54,
blank B on G55, each with its **own Z** touched off because the two blanks differ in
thickness. The G-code generator then emits each operation once per blank with only
the WCS word changed (`G54` → `G55`), never recomputing a coordinate.

## Verified machine facts

All measured on the real machine (grblHAL, 192.168.50.114) on 2026-10-09.

```
$20 soft limits = 1        $21 hard limits = 1
X travel 1260 mm   Y travel 1248 mm   Z travel 170 mm
$13 report inches = 0      -> the controller reports millimetres
```

Work offsets as found (mm, from `$#`):

```
G54   979.418  -731.266   23.324
G55   672.831 -1141.713   27.725
G56   214.999  -414.998  -45.010
G57   429.932 -1133.189  -45.103
G58   557.886  -797.533  -45.012
G59    36.718  -827.244  -45.294
G59.1 / .2 / .3   all zero (free)
G92   0,0,0        TLO  0,0,-60.955
```

Three findings that drove the design:

1. **`G10 L2` with no Z word leaves the stored Z untouched.** Proven: G54 was moved
   2″ left and restored; its Z held at 23.324 throughout.
2. **The status report's `WCO` is not the work offset.** `WCO = offset + G92 + TLO`.
   Here G54 Z 23.324 + TLO −60.955 = WCO Z −37.631. Capturing Z from `WCO` would
   write a 2.4″ error. X and Y happen to be clean only because TLO and G92 are zero
   there — so a capture must be refused while G92 is non-zero.
3. **Zero is the right value for an unused slot.** Machine Y runs 0 → −1248, and
   programs cut at positive work-Y, so a program run against a zeroed slot leaves the
   envelope and trips soft limits *before moving*. A slot parked somewhere "safe"
   would run instead of alarm. This depends on the machine being homed.

## Design rules

| rule | why |
| --- | --- |
| Loading writes **X and Y only**, never Z | Z is a property of the stock, not the fixture; it is touched off per blank. This is what lets two blanks of different thickness run together. |
| Capture reads **`$#`**, never `WCO` | `WCO` is contaminated by TLO (finding 2). |
| Capture is refused while **G92 ≠ 0** | G92 shifts the reported offsets, corrupting X and Y too. |
| **Clearing** a slot writes `X0 Y0 Z0` | Clearing declares a slot meaningless, so stale Z goes too. Distinct from loading, which never touches Z. |
| Loading **clears every slot the workspace does not define** | No stale position left pretending to be meaningful. |
| Nothing can be loaded until a workspace has been captured | Because of the rule above, a first load would otherwise wipe real positions. |
| Loading shows a **before/after confirmation** listing every slot that changes | Overwriting several offsets must never be a single silent click. |
| **Verify** re-reads `$#` and compares to what the workspace claims | "Am I in the right workspace?" needs a check against reality, not a label. |

## Implementation

| file | role |
| --- | --- |
| `app/client/src/features/workspaces/workspaces.ts` | Pure logic: parse `$#`, build the `G10 L2` program, verify. No I/O. |
| `app/client/src/features/workspaces/useWorkspaces.ts` | Composable: settings persistence, capture, apply, verify. Module-level refs so the toolbar and dialog share one copy. |
| `app/client/src/features/workspaces/WorkspacesDialog.vue` | The management UI. |
| `app/electron/features/workspaces/routes.js` | `GET /api/work-offsets` — sends `$#`, collects the reply. |
| `app/electron/core/settings-manager.js` | `workspaces: []`, `activeWorkspaceId: null` added to `DEFAULT_SETTINGS`. |
| `app/client/src/shell/TopToolbar.vue` | New **Workspace** dropdown; the existing G54–G59 selector relabelled **WCS**. |
| `app/client/src/App.vue` | Wiring + dialog mount. |

Naming: **Workspace** = the named set. **WCS** = a G54–G59 slot. The existing
toolbar selector was relabelled accordingly.

### Why the server reads `$#`

`$#` has no reply route and its answer is not part of the status report. An earlier
attempt read it in the browser from the `cnc-data` websocket broadcast; that can
never work, because `cnc-data` is only emitted for `?` status polls
(`app/electron/server/websocket.js`). The controller emits each bracketed reply on
its own `data` event, which is how `features/firmware/routes.js` already collects
its responses. The workspaces route does the same and ends the report on `[PRB:`.

## Current bug — unresolved

**After installing the branch build, ncSender opens to a blank window.** Title bar
renders, page body is empty.

Confirmed:

- `#app` has **zero children**; `__vue_app__` is absent — Vue never mounts.
- **No JavaScript exception** is thrown (checked over CDP with `Runtime.enable` and
  `Log.enable` before navigation).
- `main.ts` does `await loadInitData()` **before** `app.mount('#app')`, so anything
  that hangs there produces exactly this symptom: blank page, no error.
- Locally, **`GET /api/init` never returns** while `GET /api/settings` returns 200
  from the same running server. This is the prime suspect.
- The new `GET /api/work-offsets` route works correctly — returns a clean
  `503 {"error":"Could not send $#: CNC controller is not connected"}` when there is
  no controller.
- `app/client/public/sw.js` is a **no-op service worker** (a fetch listener that
  never calls `respondWith`) and predates this branch, so the "fetch event handler"
  message in DevTools is probably benign.

Not yet established:

- Whether `/api/init` hangs **because of this branch** or because the local test
  machine has no controller attached. `/api/init` awaits
  `Promise.all([readSettings(), readMacros(), tryReadFirmwareFile(), getAllTools()])`
  — `getAllTools()` has a `.catch`, but `tryReadFirmwareFile()` does not obviously
  time out. **A baseline build of `main` has not been tested in the same harness**,
  so the local reproduction may not be the user's bug at all.

### The next step

Build `main` unchanged, serve it, and request `/api/init`. If it also hangs with no
controller attached, the local symptom is environmental and the real fault is
elsewhere — get the error from the installed build's DevTools console instead. If
`main` returns and this branch does not, diff the settings path: the only server
change here is two new keys in `DEFAULT_SETTINGS` plus the new route registration in
`app/electron/server/http.js`.

## What is and is not proven

**Proven:** the `$#` parse and the `G10 L2` generation, tested against the real
report above — six slots, exact values, G59.1–.3 correctly excluded, G92 detection.
The `G10 L2`-leaves-Z-alone behaviour, on the machine.

**Not proven:** anything in the UI. It has never been clicked, has never written an
offset to a controller, and currently prevents the app from starting at all.

## Safety net

`wcs-backups/offsets-2026-10-09.md` in the `ncSender-plugins` repo holds all six
positions and a paste-ready restore script.
