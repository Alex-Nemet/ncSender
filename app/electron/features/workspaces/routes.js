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

export function readOffsets(cncController, timeoutMs = REPORT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let settled = false;
    const dataHandler = (line) => {
      const text = String(line ?? '').trim();
      if (text.startsWith('[')) lines.push(text);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cncController.removeListener('data', dataHandler);
      if (error) return reject(error);
      const report = lines.join('\n');
      const slots = parseSlots(report);
      if (Object.keys(slots).length !== 6 || !/\[G92:/.test(report) || !/\[GC:/.test(report)) {
        return reject(new Error('The controller returned an incomplete work-offset report.'));
      }
      resolve({ report, slots });
    };
    const timer = setTimeout(() => finish(new Error('The controller did not answer in time.')), timeoutMs);
    cncController.on('data', dataHandler);
    (async () => {
      for (const command of ['$#', '$G']) {
        if (settled) return;
        await cncController.sendCommand(command, {meta: {sourceId: 'workspaces'}});
      }
      finish();
    })().catch(error => finish(new Error(`Could not read work offsets: ${error?.message || error}`)));
  });
}

function parseSlots(report) {
  const slots = {};
  const pattern = /\[(G5[4-9]):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/g;
  let match;
  while ((match = pattern.exec(report)) !== null) {
    const value = { x: Number(match[2]), y: Number(match[3]), z: Number(match[4]) };
    if (Object.values(value).every(Number.isFinite)) slots[match[1]] = value;
  }
  return slots;
}
