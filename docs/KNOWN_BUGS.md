# Known Bugs & Investigation Notes

A running log of bugs under investigation or recently fixed, with plain-language explanations of root causes.

---

## Out-of-Bounds Warning Fires at Wrong Times

**Status:** Fixed (2026-03-18)
**Reported by:** Alex, Francis

### Symptoms
The "Warning: Toolpath exceeds machine boundaries at Z and above" message appears even when the file is fine and the toolpath does not actually exceed machine limits.

### Root Cause
The warning fires at the wrong time. It's supposed to say "this file will crash your machine" before you run it. But right now it also fires in two false-alarm situations:

1. **When you load a file before setting your work zeros** — the machine doesn't know where it is yet (work coordinate offset is 0,0,0), so it thinks everything is out of bounds. Specifically, with Z work offset at 0, the maximum Z bound becomes 0, so any normal Z retract in the G-code (e.g. `Z0.1`) looks like it's above the machine limit.

2. **After a job finishes** — GRBL resets its coordinate system back to G54 at program end (M2/M30). The visualizer sees the work position changed, rechecks the file, and now thinks the file (which just ran perfectly) is out of bounds. This is especially noticeable if you were running the job in G55 — the file was fine under G55, but after GRBL resets to G54, the same toolpath appears out of bounds under the wrong coordinate system.

### The Fix
Two guards added in `GCodeVisualizer.vue`:
1. At file load: if WCO is all zeros (machine not yet zeroed), skip OOB evaluation and clear the warning. Once the user sets work zeros, the workOffset watch re-evaluates correctly.
2. In the workOffset watch: after rebuilding the grid, suppress the warning if not in pre-run state (job already ran) or WCO is unset. Kills the G55→G54 post-job false alarm.

The warning still fires correctly in the only window that matters: file loaded, work zeros set, job not yet started.

### Related Code
- `app/client/src/features/toolpath/visualizer/gcode-visualizer.js` — `_axisOutOfBounds()`, bounds checking logic
- `app/client/src/features/toolpath/GCodeVisualizer.vue` — `applyBoundsAndWarnings()`, `computeGridBoundsFrom()`, watch on `workOffset` and `zMaxTravel`
- `app/client/src/composables/use-app-store.ts` — `zMaxTravel` sourced from `$132` (always mm), WCO sourced from GRBL `?` report

---

## Safe Z Height Bug (Fixed — commit 118d847)

**Status:** Fixed
**Reported by:** Alex

### Symptom
Using the XY0 button caused the machine to plunge Z down by ~5 inches unexpectedly. Workaround was to set safe Z to 0.

### Root Cause
The safe Z default value is `-5mm`. When the user is in imperial mode (G20), the value was being sent to GRBL without converting from mm to inches first. GRBL in G20 mode interpreted `-5` as **-5 inches** (~127mm) instead of -5mm (~0.2 inches). A massive unintended plunge.

### Fix
Convert safe Z to the correct units before sending, and include the unit mode code (G20/G21) in the command so GRBL interprets it correctly.

---
