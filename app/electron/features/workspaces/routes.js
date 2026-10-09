/*
 * Reading the controller's work offsets.
 *
 * `$#` has no reply route of its own, and its answer is not part of the status
 * report, so it is collected the way the firmware routes collect theirs: listen
 * on the controller's `data` event, send the command, and gather the bracketed
 * lines until the report ends. `[PRB:` is the last line grblHAL emits for `$#`.
 */
import express from 'express';

const REPORT_TIMEOUT_MS = 4000;

export function createWorkspaceRoutes(cncController) {
  const router = express.Router();

  router.get('/work-offsets', async (_req, res) => {
    try {
      res.json(await readOffsets(cncController));
    } catch (error) {
      res.status(503).json({ error: error?.message || 'Could not read the work offsets.' });
    }
  });

  return router;
}

function readOffsets(cncController) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let settled = false;

    const dataHandler = (line) => {
      const text = String(line ?? '').trim();
      if (!text.startsWith('[')) return;
      lines.push(text);
      if (text.startsWith('[PRB:')) finish();
    };

    const cleanup = () => {
      cncController.removeListener('data', dataHandler);
      clearTimeout(timer);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const report = lines.join('\n');
      if (!/\[G54:/.test(report)) {
        reject(new Error('The controller did not report its work offsets.'));
        return;
      }
      resolve({ report, slots: parseSlots(report), g92Active: g92IsActive(report) });
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      // A partial report that already has G54 is still usable.
      if (lines.some((l) => l.startsWith('[G54:'))) finish();
      else fail(new Error('The controller did not answer $# in time.'));
    }, REPORT_TIMEOUT_MS);

    cncController.on('data', dataHandler);

    cncController
      .sendCommand('$#', {
        commandId: `work-offsets-${Date.now()}`,
        displayCommand: '$#',
        meta: { sourceId: 'workspaces' }
      })
      .catch((error) => fail(new Error(`Could not send $#: ${error?.message || error}`)));
  });
}

/** `[G54:x,y,z,a]` lines only. G59.1-.3 are deliberately excluded: a workspace
 *  writes the six standard slots, and matching them loosely would catch those. */
function parseSlots(report) {
  const slots = {};
  const pattern = /\[(G5[4-9]):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/g;
  let match;
  while ((match = pattern.exec(report)) !== null) {
    slots[match[1]] = { x: Number(match[2]), y: Number(match[3]), z: Number(match[4]) };
  }
  return slots;
}

/** A non-zero G92 shifts the reported offsets, so a capture taken under one
 *  would be silently wrong in X and Y as well as Z. */
function g92IsActive(report) {
  const match = /\[G92:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(report);
  return match ? [1, 2, 3].some((i) => Number(match[i]) !== 0) : false;
}
