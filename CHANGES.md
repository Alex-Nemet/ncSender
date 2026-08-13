# ncSender Fork Changes

This document tracks notable bugs found and fixes made in Alex's fork of ncSender.
It's meant as a reference for discussing changes with Francis (upstream author).

---

## Runaway Jog — Lost Button Release Events
**Status:** Fixed (2026-08-13, pointer capture)
**Commit:** 560981e
**Files:** `app/client/src/features/jog/JogControls.vue`

**Problem:** Continuous jog could run away if the mouse/finger moved off the jog button before releasing. The original fix (2026-06-16) added document-level `mouseup`/`touchend` listeners, but the release event could still be lost — something between the button and the document swallowed it. The user had to hit the stop button or an opposite direction button to cancel the runaway.

**Root cause:** `mouseup` events fire on whatever element the cursor is over, and can be intercepted or lost before reaching the document-level safety handler. Additionally, the shared `isLongPress` flag could be reset by a stray second press on another button, causing the release handler to send a step jog instead of cancelling.

**Fix:** Switched from `mousedown`/`mouseup`/`touchstart`/`touchend` to Pointer Events with `setPointerCapture()`. Once a button captures the pointer, the `pointerup` event always fires on that same button regardless of where the cursor goes — it cannot be lost or intercepted. Also tracks `activePointerId` to ignore stray second presses, added `lostpointercapture` as a safety net, and cancels active jogs on component unmount.

**Evidence:** Logs from 2026-08-07 (Z axis) and 2026-08-13 (X axis) both show cross-button releases (press X-, release X+; press Z-, release Z+) — user hitting opposite button to stop runaways that the document-level handler failed to catch.

---

## Connection Lost on Computer Sleep — Controller Stuck
**Status:** Fixed (2026-06-16)
**Commit:** pending
**Files:** `app/electron/main.js`, `app/electron/server.js`, `app/electron/app.js`

**Problem:** When the computer went to sleep, the TCP connection to the grblHAL controller (192.168.5.1:23) died silently — no FIN or RST was sent. The controller's telnet server (single-connection) still held the stale connection, refusing all new connections. ncSender would loop ETIMEDOUT reconnection attempts indefinitely. The only fix was power cycling the controller, which lost homing state and required re-home + TLS.

**Root cause:** No handling of OS sleep/wake events. The network interface was suspended without cleanly closing the TCP socket.

**Fix:** Added Electron `powerMonitor` suspend/resume handlers. On suspend: stops auto-connector and cleanly disconnects the CNC controller (sends TCP RST to free the connection slot). On resume: restarts auto-connector which reconnects automatically. The controller stays powered and retains its homing/position state, so no re-home is needed.

**Evidence:** Log from 2026-06-16 shows status reports flowing normally at 05:13:52, then ECONNRESET at 05:14:12, followed by ~10 hours of ETIMEDOUT retry loops until power cycle.

---

## Corner Jog Buttons Triggering Soft Limits
**Status:** Fixed
**Commit:** 94a454f, 67889d8

**Problem:** Diagonal jog corner buttons were sending positive machine coordinates that triggered soft limit alarms on grblHAL.

**Fix:** Fixed coordinate calculation and increased safety margin for corner button jog commands.

---

## Spindle Not Stopping After Door Resume
**Status:** Fixed
**Commit:** 94bf53a

**Problem:** Explicit M5 was being sent during door state, which caused the spindle to stop unexpectedly after resuming from a door open event.

**Fix:** Removed the explicit M5 during door state — grblHAL handles spindle state internally during door events.

---

## Probe Dialog Hardcoded to Metric
**Status:** Fixed
**Commit:** 429d7aa

**Problem:** Probe dialog was using hardcoded metric values, breaking probing for imperial users.

**Fix:** Updated probe dialog to respect the user's units preference.

---

## XY0 Button Ignoring Units Preference
**Status:** Fixed
**Commit:** 118d847, 2b692d7

**Problem:** The XY0 button used a metric safe Z height value even when the user was in imperial mode, causing incorrect Z moves.

**Fix:** Applied proper unit conversion to the safe Z height based on user preference.

---

## Out-of-Bounds Warning Firing Incorrectly
**Status:** Fixed
**Commit:** 17dec52

**Problem:** Out-of-bounds travel warning was triggering at wrong times, creating false alarms.

**Fix:** Corrected the timing/conditions for the out-of-bounds check.

---

## High Idle CPU Usage
**Status:** Fixed
**Commit:** 8162612, e160bb9

**Problem:** Electron renderer process consumed excessive CPU while idle.

**Fix:** Identified and eliminated unnecessary render/polling cycles.

---

## Pin Status Indicators — Colourblind Accessibility
**Status:** Fixed
**Commit:** 2882ecf

**Problem:** Pin status indicators used red/green which is indistinguishable for colourblind users.

**Fix:** Changed to blue/yellow colour scheme.

---

## Plugin Crash on Missing isOriginal
**Status:** Fixed
**Commit:** 23e7a77

**Problem:** Plugins crashed when `isOriginal` property was missing from command objects.

**Fix:** Added safe handling for missing property.

---

## Imperial Unit Issues (Multiple)
**Status:** Fixed
**Commits:** b495b39, f19d03f, 58218c7, 0c81bb5, 11e9cc6, d14067b

**Problem:** Several places in the UI ignored the imperial units preference: tool slot diameter display, plugin jog defaults, continuous jog distance, probe dialog feed rate.

**Fix:** Systematic pass to respect units preference across all affected components.

---

## Auto-Updater Pointing to Wrong Repo
**Status:** Fixed
**Commit:** 9168214, f391f3d

**Problem:** Auto-updater was still pointed at the upstream repo, not the fork.

**Fix:** Updated auto-updater URLs and fixed Windows manifest filename mismatch.
