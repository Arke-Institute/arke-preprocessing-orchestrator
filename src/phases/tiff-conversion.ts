/**
 * TIFF Conversion Phase
 * Discovers TIFFs and spawns Fly machines to convert them to JPEG
 */

import type { Phase } from './base.js';
import type { BatchState, BatchStatus, TiffConversionTask, Task } from '../types/state.js';
import type { Config } from '../types/config.js';
import type { Env } from '../config.js';
import type { TiffCallbackResult } from '../types/callback.js';
import type { ProcessableFile } from '../types/file.js';
import { generateTaskId } from '../utils/task-id.js';

export class TiffConversionPhase implements Phase {
  name: BatchStatus = 'TIFF_CONVERSION';

  /**
   * TIFF DISCOVERY
   * Scan current file list for TIFF files
   */
  async discover(files: ProcessableFile[]): Promise<TiffConversionTask[]> {
    const tasks: TiffConversionTask[] = [];

    console.log(`[TiffConversion] Discovering TIFFs in file list`);

    for (const file of files) {
      if (this.isTiff(file.file_name)) {
        const task: TiffConversionTask = {
          task_id: generateTaskId('tiff', file.r2_key),
          status: 'pending',
          input_r2_key: file.r2_key,
          input_file_name: file.file_name,
          retry_count: 0,
        };

        tasks.push(task);

        console.log(`[TiffConversion] Found TIFF: ${file.file_name} (${file.r2_key})`);
      }
    }

    console.log(`[TiffConversion] Discovered ${tasks.length} TIFF(s)`);

    return tasks;
  }

  /**
   * TIFF EXECUTION
   * Spawn Fly machines for pending TIFFs
   */
  async executeBatch(
    state: BatchState,
    config: Config,
    env: Env
  ): Promise<boolean> {
    // Check for timed-out tasks
    this.checkTimeouts(state, config.TASK_TIMEOUT_TIFF_CONVERSION);

    // Get pending tasks (up to batch size)
    const pendingTasks = Object.values(state.current_phase_tasks)
      .filter(t => t.status === 'pending')
      .slice(0, config.BATCH_SIZE_TIFF_CONVERSION) as TiffConversionTask[];

    if (pendingTasks.length === 0) {
      // No pending tasks - check if phase is complete
      const allDone = Object.values(state.current_phase_tasks)
        .every(t => t.status === 'completed' || t.status === 'failed');

      if (allDone) {
        console.log(`[TiffConversion] All tasks complete`);
        return false; // Phase complete
      }

      // Still have tasks processing
      console.log(`[TiffConversion] Waiting for ${this.countProcessing(state)} task(s) to complete`);
      return true; // More work remains
    }

    console.log(`[TiffConversion] Spawning ${pendingTasks.length} Fly machine(s)`);

    // Spawn Fly machines in parallel
    const spawnResults = await Promise.allSettled(
      pendingTasks.map(task => this.spawnFlyMachine(task, state, config, env))
    );

    // Mark successfully spawned tasks as processing
    for (let i = 0; i < pendingTasks.length; i++) {
      const task = pendingTasks[i];
      const result = spawnResults[i];

      if (result.status === 'fulfilled') {
        task.status = 'processing';
        task.started_at = new Date().toISOString();
        console.log(`[TiffConversion] ✓ Spawned machine for ${task.input_file_name}`);
      } else {
        console.error(`[TiffConversion] ✗ Failed to spawn machine for ${task.input_file_name}:`, result.reason);
        // Task stays pending, will retry on next alarm
      }
    }

    return true; // More work remains
  }

  /**
   * Spawn a single Fly machine for TIFF conversion
   */
  private async spawnFlyMachine(
    task: TiffConversionTask,
    state: BatchState,
    config: Config,
    env: Env
  ): Promise<void> {
    const machineConfig = {
      name: `tiff-${task.task_id}`,
      config: {
        image: config.FLY_WORKER_IMAGE,
        env: {
          TASK_ID: task.task_id,
          BATCH_ID: state.batch_id,
          INPUT_R2_KEY: task.input_r2_key,
          R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
          R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
          R2_BUCKET: env.R2_BUCKET || 'arke-staging',
          CALLBACK_URL: `${config.ORCHESTRATOR_URL}/callback/${state.batch_id}/${task.task_id}`,
        },
        auto_destroy: true,
        restart: { policy: 'no' },
        guest: {
          memory_mb: 1024,
          cpus: 2,
          cpu_kind: 'shared',
        }
      },
      region: config.FLY_REGION,
    };

    const response = await fetch(
      `https://api.machines.dev/v1/apps/${config.FLY_APP_NAME}/machines`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.FLY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(machineConfig),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fly API error: ${response.status} ${errorText}`);
    }

    const machine = await response.json() as { id: string };
    task.fly_machine_id = machine.id;

    console.log(`[TiffConversion] Spawned Fly machine ${machine.id} for task ${task.task_id}`);
  }

  /**
   * Handle callback from Fly worker
   */
  handleCallback(
    task: TiffConversionTask,
    result: TiffCallbackResult,
    state: BatchState
  ): void {
    if (result.status === 'success') {
      task.status = 'completed';
      task.output_r2_key = result.output_r2_key!;
      task.output_file_name = result.output_file_name!;
      task.output_file_size = result.output_file_size!;
      task.completed_at = new Date().toISOString();
      state.tasks_completed++;

      console.log(`[TiffConversion] ✓ Task ${task.task_id} completed: ${task.output_r2_key}`);

      if (result.performance) {
        console.log(`[TiffConversion]   Performance: ${result.performance.total_time_ms}ms total`);
      }
    } else {
      task.status = 'failed';
      task.error = result.error;
      state.tasks_failed++;

      console.error(`[TiffConversion] ✗ Task ${task.task_id} failed: ${result.error}`);
    }
  }

  /**
   * After TIFF conversion, we're done (for now)
   * Future: return next phase like 'PDF_SPLITTING'
   */
  getNextPhase(): BatchStatus | null {
    return null; // Goes to DONE
  }

  /**
   * Transform file: preserve both TIFF and JPEG
   */
  transformFile(
    file: ProcessableFile,
    task: Task | undefined
  ): ProcessableFile[] {
    const tiffTask = task as TiffConversionTask | undefined;

    if (
      tiffTask &&
      tiffTask.status === 'completed' &&
      tiffTask.output_r2_key &&
      tiffTask.output_file_name &&
      tiffTask.output_file_size
    ) {
      // File was converted - return BOTH original TIFF and converted JPEG
      return [
        // 1. Original TIFF (preserved)
        {
          ...file,
          preprocessor_tags: [...(file.preprocessor_tags || []), 'TiffConverter:source'],
        },
        // 2. Converted JPEG
        {
          r2_key: tiffTask.output_r2_key,
          logical_path: file.logical_path.replace(/\.tiff?$/i, '.jpg'),
          file_name: tiffTask.output_file_name,
          file_size: tiffTask.output_file_size,
          content_type: 'image/jpeg',
          processing_config: file.processing_config,
          source_file: file.file_name,
          preprocessor_tags: ['TiffConverter'],
        },
      ];
    } else {
      // Not a TIFF or failed conversion - keep original file as-is
      return [file];
    }
  }

  /**
   * Check for timed-out tasks and mark them as failed
   */
  private checkTimeouts(state: BatchState, timeoutMs: number): void {
    const now = Date.now();
    let timedOutCount = 0;

    for (const task of Object.values(state.current_phase_tasks) as TiffConversionTask[]) {
      if (task.status === 'processing' && task.started_at) {
        const startedMs = new Date(task.started_at).getTime();
        const elapsed = now - startedMs;

        if (elapsed > timeoutMs) {
          task.status = 'failed';
          task.error = `Task timed out after ${Math.round(elapsed / 1000)}s (limit: ${Math.round(timeoutMs / 1000)}s)`;
          state.tasks_failed++;
          timedOutCount++;

          console.error(
            `[TiffConversion] ⏱ Task ${task.task_id} timed out after ${Math.round(elapsed / 1000)}s`
          );
        }
      }
    }

    if (timedOutCount > 0) {
      console.log(`[TiffConversion] Marked ${timedOutCount} task(s) as timed out`);
    }
  }

  /**
   * Check if file is a TIFF
   */
  private isTiff(fileName: string): boolean {
    return /\.tiff?$/i.test(fileName);
  }

  /**
   * Count tasks currently processing
   */
  private countProcessing(state: BatchState): number {
    return Object.values(state.current_phase_tasks)
      .filter(t => t.status === 'processing')
      .length;
  }
}
