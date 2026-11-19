/*
 * This file is part of ncSender.
 *
 * ncSender is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * ncSender is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with ncSender. If not, see <https://www.gnu.org/licenses/>.
 */

import { GCodeJobProcessor } from './job-routes.js';
import { GrblHalTelemetryProvider } from '../cnc/telemetry-provider.js';
import { JobProgressEstimator } from './job-progress-estimator.js';
import { createLogger } from '../../core/logger.js';
import fs from 'node:fs/promises';

const { log, error: logError } = createLogger('JobManager');

// The last G54-G59 a program selects, or null if it never picks one.
export function lastWcsInProgram(content) {
  let last = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '');
    const re = /G0*5([4-9])(?![.\d])/gi;
    let m;
    while ((m = re.exec(line)) !== null) last = 'G5' + m[1];
  }
  return last;
}

class JobProcessorManager {
  constructor() {
    this.currentJob = null;
    this.progressProviderFactory = null;
  }

  async startJob(filePath, filename, cncController, broadcast, commandProcessor, options = {}) {
    if (cncController.workspaceOperation) throw new Error('Wait for the workspace update to finish before starting a job.');
    if (this.currentJob) {
      throw new Error('A job is already running. Stop the current job before starting a new one.');
    }

    // M30 makes the controller drop back to G54. After a finished job, switch back to the
    // WCS the program used last (or the one active at start) so a re-run or jog stays put.
    let restoreWcs = options.serverState?.machineState?.workspace || null;
    try {
      restoreWcs = lastWcsInProgram(await fs.readFile(filePath, 'utf8')) || restoreWcs;
    } catch (err) {
      logError('Could not read program for its WCS:', err?.message || err);
    }

    // Callback to check if we should count time (only count when senderStatus is 'running')
    const shouldCountCallback = () => {
      const senderStatus = options.serverState?.senderStatus;
      return senderStatus === 'running';
    };

    // Create a swappable telemetry-backed progress provider
    const progressProvider = this.progressProviderFactory
      ? this.progressProviderFactory(cncController, { filePath, filename })
      : new JobProgressEstimator({
          telemetry: new GrblHalTelemetryProvider(cncController),
          shouldCountCallback
        });

    this.currentJob = new GCodeJobProcessor(
      filePath,
      filename,
      cncController,
      broadcast,
      commandProcessor,
      { progressProvider, ...options }
    );

    // Listen for job completion to clear the reference
    // Register this BEFORE starting so it's always set up
    this.currentJob.onComplete((reason) => {
      log('Job completed, clearing reference');
      const wasRunning = this.currentJob !== null;

      // Capture final job state before clearing (needed for completion callback)
      const finalJobStatus = wasRunning ? this.getJobStatus() : null;

      this.currentJob = null;

      if (reason === 'completed' && /^G5[4-9]$/.test(restoreWcs || '')) {
        log(`Job finished: restoring ${restoreWcs}`);
        cncController.sendCommand(restoreWcs, { meta: { sourceId: 'system' } }).catch((err) => {
          logError('Could not restore WCS after job:', err?.message || err);
        });
      }

      // Call external completion callback if set and job was actually running
      if (wasRunning && this.onJobCompleteCallback) {
        log('Calling job complete callback');
        this.onJobCompleteCallback(reason, finalJobStatus);
      }
    });

    await this.currentJob.start();
    log('Job started:', filename);

    return this.currentJob;
  }

  pause() {
    if (!this.currentJob) {
      throw new Error('No active job to pause');
    }
    this.currentJob.pause();
    log('Job paused');
  }

  resume() {
    if (!this.currentJob) {
      throw new Error('No active job to resume');
    }
    this.currentJob.resume();
    log('Job resumed');
  }

  stop() {
    if (!this.currentJob) {
      throw new Error('No active job to stop');
    }
    this.currentJob.stop();
    log('Job stopped');
    // Don't set this.currentJob = null here - the onComplete callback handles cleanup
  }

  forceReset() {
    // Force reset the job without validation (used when machine resets externally)
    if (this.currentJob) {
      try {
        this.currentJob.stop();
      } catch (error) {
        // Ignore errors during force reset
      }
      log('Job force reset');
      this.currentJob = null;
    }
  }

  getCurrentJob() {
    return this.currentJob;
  }

  hasActiveJob() {
    return this.currentJob !== null;
  }

  getJobStatus() {
    if (!this.currentJob) {
      return null;
    }

    // Determine status: 'running', 'paused', or 'stopped'
    let status = 'stopped';
    if (this.currentJob.isRunning) {
      status = 'running';
    } else if (this.currentJob.isPaused) {
      status = 'paused';
    }

    const est = this.currentJob.getEstimate?.() || null;

    const base = {
      filename: this.currentJob.filename,
      currentLine: this.currentJob.getExecutingLine?.() ?? this.currentJob.currentLineNumber,
      totalLines: this.currentJob.totalLines || 0,
      status: status,
      sourceId: this.currentJob.sourceId || 'job'
    };

    // Merge estimator output if present
    if (est && typeof est === 'object') {
      return { ...base, ...est };
    }
    return base;
  }

  setJobCompleteCallback(callback) {
    this.onJobCompleteCallback = callback;
  }

  setProgressProviderFactory(factory) {
    // factory: (cncController, { filePath, filename }) => { getEstimate(), startWithContent(), ... }
    this.progressProviderFactory = typeof factory === 'function' ? factory : null;
  }
}

// Export singleton instance
export const jobManager = new JobProcessorManager();
