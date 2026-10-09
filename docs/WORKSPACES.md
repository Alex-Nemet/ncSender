# Workspaces — named sets of work offsets

Branch: `feature/workspaces` · Updated 2026-10-09

## Intended behavior

A workspace saves **X, Y and Z** work offsets for G54–G59. Loading it restores
those saved values, just as each controller WCS remembers its own XYZ zero.
The user may touch off Z normally, then re-save the slot to remember its new value.
This supersedes the original XY-only design.

Tool length compensation, G92, machine settings, and physical machine position
are separate from the saved work offsets. Capture uses `$#`, never status `WCO`,
which includes G92 and tool length compensation. The measured G54 Z was 23.324 mm,
TLO was −60.955 mm, and WCO Z was −37.631 mm: saving WCO would mix them together.

## First Windows machine test

1. Close the existing ncSender before starting the preview build.
2. Open **Workspace → Manage…**. Use **Capture all six from machine**, named
   **Default**, before any load is available. This only reads/saves offsets.
   Check the saved XYZ values against the controller's current values.
3. Verify Default; it should match. Keep the external offset backup too.
4. **Create empty** creates a saved workspace without changing the machine.
5. **Load onto machine** previews all six before/after XYZ values. Only confirming
   **Write offsets** writes them. Loading an empty workspace sets all six to XYZ zero.
6. Without running a job, load Default and verify that all original XYZ values return.
7. For a new setup, set each WCS normally, then **Save current G54**, etc.
   After adjusting Z, **Re-save** that slot before switching away.

Saving is explicit, not automatic. Selecting a workspace opens the dialog; only
an acknowledged and verified load marks it active. Loading offsets commands no
motion. Zeroed slots are **not** a general safety mechanism; do not run a job
against a slot that has not been set up.

## Implementation rules

- Capture all preserves all six slots, including all-zero and Z-only offsets.
- Loads write saved XYZ. Slots absent from a workspace are cleared in all three axes.
- Clear edits the saved workspace; the machine changes only on confirmed load.
- Old XY-only slots must be re-saved from the intended setup before loading.
  Missing Z is never guessed or replaced with zero.
- `$#` and `$G` reads await controller acknowledgement and require complete replies.
  G59.1–.3 are outside this feature's scope. Partial reports cannot silently clear slots.
- G92 must be zero for capture/load because its separate temporary shift is not saved.
- The machine must be idle with no running/paused job. Each write is acknowledged.
  A failure may leave partially changed offsets; no workspace is marked loaded.
- Prior units/distance modes come from `$G` and are restored even after a write failure.
- Read-back verification includes Z, cleared slots, and missing slots.
- Saved numbers assume this machine's `$13=0` millimetre reporting.
- A workspace label is not live proof of matching offsets after outside edits.
  Use Verify and re-save adjusted offsets as needed.

## Confirmed startup bug

`useWorkspaces.ts` returned `workspaces`, `activeId`, `busy`, and `error` without
any declarations. `App.vue` calls it during setup, causing a ReferenceError and
preventing mounting. Shared module-level Vue refs now exist. Tests instantiate
the composable and confirm callers share the same state.

The older handoff also reported `/api/init` hanging in a local standalone Node
process. The init route has no diff against main. An isolated server using temporary
settings, disabled CNC auto-connect and `UV_THREADPOOL_SIZE=16` returned the full
init payload without a controller. The exact cause of the older process's hang
remains unproven and is separate from the confirmed missing-ref defect.

## Files

- `app/client/src/features/workspaces/workspaces.ts`: XYZ data, complete-report
  validation, G10 generation, modal parsing, verification.
- `app/client/src/features/workspaces/useWorkspaces.ts`: shared state, persistence,
  capture, acknowledged loading and read-back verification.
- `app/client/src/features/workspaces/WorkspacesDialog.vue`: XYZ table and load preview.
- `app/electron/features/workspaces/routes.js`: `$#` / `$G` collection and timeouts.
- `App.vue` / `TopToolbar.vue`: requested selection stays separate from loaded identity.
- `app/client/tests/workspaces.test.mjs`: simulated controller and route regressions.
- `.github/workflows/workspace-preview.yml`: Windows preview artifact build on this
  branch; no stable release or version tag is created.

## Validation and remaining work

`node --test app/client/tests/workspaces.test.mjs` passes twelve tests, including failed-backup persistence: XYZ
capture/persistence/restore, Z re-save, zero/Z-only offsets, legacy XY rejection,
partial reads, rejected commands, mode restoration, verification failure,
idle/G92 guards, clearing and listener cleanup. `npm run build:client` in `app` passes.

The real Windows UI and physical-controller round trip still need the user's
machine test. Local interactive inspection was unavailable because computer-use
permissions were not granted. No real controller offsets were written in this session.

## External backup from the previous session

`wcs-backups/offsets-2026-10-09.md` in the `ncSender-plugins` repository contains the
six original positions and a paste-ready restore script.
