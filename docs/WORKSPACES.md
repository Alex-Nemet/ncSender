# Workspace handoff

Branch: `feature/workspaces` · Updated 2026-10-10

## Behavior

Named workspaces store the X/Y/Z offsets for G54–G59. Confirmed G10 L2/L20
changes automatically update the current workspace on the PC. Probe changes are
saved once probing finishes and the controller is idle. Autosaving only reads the
controller; it adds no controller offset writes.

The toolbar switches directly while idle, saving any outstanding outgoing changes,
writing only differing slots, restoring units/distance mode, and verifying all six
slots before marking the new workspace current. An empty workspace needs one
confirmation because switching clears all six XYZ offsets. Creating an empty
workspace or importing a file only adds it to the library.

Manage shows saved XYZ values and supports rename, capture, per-slot save,
verification, export/import, and persistent per-workspace Undo/Redo history (last
100 changes). Undo/Redo restore controller offsets and the saved workspace; they do
not undo motion. A new coordinate change after Undo discards the redo entries.
Exports are versioned JSON workspace coordinates, not full controller settings.
Import creates a fresh identity and does not load the controller or establish the
initial backup. Capture saves all six current slots and marks that workspace current.

## Windows test

1. Install the beta release's Windows EXE and close the previous ncSender instance.
2. In Manage, capture Default if this is the first setup. For an older capture
   showing None, select it and Verify to identify it without controller writes.
3. Export Default as a known-good backup. Check its saved XYZ values.
4. While idle, change G55 XY or Z using the normal controls. Confirm the saved
   value and history update automatically. Undo and Redo should restore both
   controller offsets and the displayed saved values.
5. Create an empty workspace. Creation alone must not change the controller.
   Switch to it and confirm clearing. Set G55 normally, then switch to Default
   and back. Each workspace should restore its own XYZ coordinates.
6. Rename a workspace, export/import it, and restart ncSender. Names, current
   identity, saved coordinates and history should persist.

## Implementation and limits

- `app/electron/features/workspaces/model.js`: shared parsing, comparison, history,
  import/export and G10 generation; `service.js`: serialized operations and autosave.
- `routes.js`: API and complete acknowledged `$#`/`$G` reports with timeouts.
- `useWorkspaces.ts`: shared reactive state, API calls and live updates.
- `WorkspacesDialog.vue`, `App.vue`, `TopToolbar.vue`: user controls and current label.
- Controller/job-manager guards prevent other commands/jobs interleaving with a
  workspace write transaction. Stop/reset/status commands remain available.
- Capture is required before the first switch. Failed persistence cannot unlock it.
- Old XY-only slots must be re-saved with Z before loading; missing Z is not guessed.
- Missing slots load as XYZ zero; already matching/zero slots are not rewritten.
- G92 must be zero. Tool length compensation and physical position are separate.
  Capture uses `$#`, never status WCO (which includes G92/tool compensation).
- Numeric reports assume this machine's `$13=0` millimetre reporting.
- A rejected write or mismatched read-back leaves no workspace marked current.
  Inspect the offsets before proceeding after a partial failure.
- Autosave observes acknowledged commands sent through ncSender. Outside controller
  edits are reconciled on switching/exporting; a persisted label is not proof that
  externally changed hardware still matches. Verify checks the live controller.

## Validation and delivery

`node --test app/client/tests/workspaces.test.mjs` covers simulated XYZ autosave,
history, switching, skipped writes, failures, persistence, import/export and report
collection. `npm --prefix app run build:client` builds the client. The beta pipeline
runs the workspace suite on all build platforms before packaging.

No physical CNC offsets were changed during development. The Windows/controller
round trip remains a hardware acceptance test. Local interactive GUI testing was
unavailable because computer-use permissions were not granted.

Use `RELEASE_NOTES_PATH=<notes-file> bash .scripts/release.sh --beta` after committing.
Deliver the GitHub beta release's direct Windows EXE, not an Actions-only artifact.
The earlier blank startup was missing shared Vue refs in useWorkspaces, fixed in
cb48bba. The prior isolated `/api/init` hang was not reproduced and remains separate.

The prior external backup is `wcs-backups/offsets-2026-10-09.md` in the
`ncSender-plugins` repository.
