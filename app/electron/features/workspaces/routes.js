import express from 'express';
import {readSettings, saveSettings} from '../../core/settings-manager.js';
import {createWorkspaceService} from './service.js';
import {requireCompleteReport, hasActiveG92, readModes} from './model.js';

const REPORT_TIMEOUT_MS = 4000;

export function createWorkspaceRoutes(cncController, serverState, broadcast) {
  const service = createWorkspaceService({controller: cncController, serverState, broadcast, readSettings, saveSettings, readOffsets});
  const router = express.Router();
  router.get('/workspaces', (_req, res) => res.json(service.state()));
  router.post('/workspaces/:action', async (req, res) => {
    try {
      const result = await service.execute(req.params.action, req.body);
      res.json({state: service.state(), result});
    } catch (error) {
      res.status(409).json({error: error.message, state: service.state()});
    }
  });
  router.get('/work-offsets', async (_req, res) => {
    try {
      res.json(await service.execute('report'));
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
      let slots;
      try {
        slots = requireCompleteReport(report);
        hasActiveG92(report);
        readModes(report);
      } catch (error) { return reject(error); }
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
