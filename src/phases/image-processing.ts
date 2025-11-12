/**
 * Image Processing Phase
 * Discovers JPEG/PNG/WebP images and spawns Fly machines to:
 * - Resize images into smart variants
 * - Upload to CDN
 * - Archive originals
 * - Create .ref.json files
 */

import type { Phase } from './base.js';
import type { BatchState, BatchStatus, ImageProcessingTask, RefData } from '../types/state.js';
import type { Config } from '../types/config.js';
import type { Env } from '../config.js';
import type { ProcessableFile } from '../types/file.js';
import type { ImageCallbackResult } from '../types/callback.js';
import { generateTaskId } from '../utils/task-id.js';

export class ImageProcessingPhase implements Phase {
  name: BatchStatus = 'IMAGE_PROCESSING';

  /**
   * IMAGE DISCOVERY
   * Find JPEG/PNG/WebP files in current file list (output from previous phase)
   * Skip files that are tagged as TiffConverter:source (those are original TIFFs)
   */
  async discover(files: ProcessableFile[]): Promise<ImageProcessingTask[]> {
    const tasks: ImageProcessingTask[] = [];

    console.log(`[ImageProcessing] Discovering images in ${files.length} files`);

    for (const file of files) {
      // Check if it's a processable image type
      if (this.isProcessableImage(file)) {
        // Skip if it's a TIFF source file (we only want to process the converted JPEGs)
        if (file.preprocessor_tags?.includes('TiffConverter:source')) {
          console.log(`[ImageProcessing] Skipping TIFF source: ${file.file_name}`);
          continue;
        }

        const task: ImageProcessingTask = {
          task_id: generateTaskId('img', file.r2_key),
          status: 'pending',
          input_r2_key: file.r2_key,
          input_file_name: file.file_name,
          input_content_type: file.content_type,
          input_file_size: file.file_size,
          input_cid: file.cid,
          retry_count: 0,
        };

        tasks.push(task);

        console.log(`[ImageProcessing] Found image: ${file.file_name} (${file.content_type})`);
      }
    }

    console.log(`[ImageProcessing] Discovered ${tasks.length} image(s) to process`);

    return tasks;
  }

  /**
   * IMAGE EXECUTION
   * Spawn Fly machines for pending image tasks
   */
  async executeBatch(
    state: BatchState,
    config: Config,
    env: Env
  ): Promise<boolean> {
    // Get pending tasks (up to batch size)
    const pendingTasks = Object.values(state.current_phase_tasks)
      .filter(t => t.status === 'pending')
      .slice(0, config.BATCH_SIZE_IMAGE_PROCESSING) as ImageProcessingTask[];

    if (pendingTasks.length === 0) {
      // No pending tasks - check if phase is complete
      const allDone = Object.values(state.current_phase_tasks)
        .every(t => t.status === 'completed' || t.status === 'failed');

      if (allDone) {
        console.log(`[ImageProcessing] All tasks complete`);
        return false; // Phase complete
      }

      // Check for timeouts
      this.checkTimeouts(state, config.TASK_TIMEOUT_IMAGE_PROCESSING);

      // Still have tasks processing
      const processingCount = this.countProcessing(state);
      console.log(`[ImageProcessing] Waiting for ${processingCount} task(s) to complete`);
      return true; // More work remains
    }

    console.log(`[ImageProcessing] Spawning ${pendingTasks.length} Fly machine(s)`);

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
        console.log(`[ImageProcessing] ✓ Spawned machine for ${task.input_file_name}`);
      } else {
        console.error(`[ImageProcessing] ✗ Failed to spawn machine for ${task.input_file_name}:`, result.reason);
        // Task stays pending, will retry on next alarm
      }
    }

    return true; // More work remains
  }

  /**
   * Spawn a single Fly machine for image processing
   */
  private async spawnFlyMachine(
    task: ImageProcessingTask,
    state: BatchState,
    config: Config,
    env: Env
  ): Promise<void> {
    const machineConfig = {
      name: `img-${task.task_id}`,
      config: {
        image: config.FLY_IMAGE_WORKER_IMAGE,
        env: {
          TASK_ID: task.task_id,
          BATCH_ID: state.batch_id,
          INPUT_R2_KEY: task.input_r2_key,
          INPUT_FILE_NAME: task.input_file_name,
          INPUT_CONTENT_TYPE: task.input_content_type,
          INPUT_FILE_SIZE: task.input_file_size.toString(),
          ...(task.input_cid && { INPUT_CID: task.input_cid }),
          R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
          R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
          R2_BUCKET: env.R2_BUCKET || 'arke-staging',
          ARCHIVE_BUCKET: env.ARCHIVE_BUCKET || 'arke-archive',
          CDN_API_URL: config.CDN_API_URL,
          CDN_PUBLIC_URL: config.CDN_PUBLIC_URL,
          CALLBACK_URL: `${config.ORCHESTRATOR_URL}/callback/${state.batch_id}/${task.task_id}`,
        },
        auto_destroy: true,
        restart: { policy: 'no' },
        guest: {
          memory_mb: 2048,
          cpus: 2,
          cpu_kind: 'shared',
        }
      },
      region: config.FLY_REGION,
    };

    const response = await fetch(
      `https://api.machines.dev/v1/apps/${config.FLY_IMAGE_APP_NAME}/machines`,
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

    console.log(`[ImageProcessing] Spawned Fly machine ${machine.id} for task ${task.task_id}`);
  }

  /**
   * Handle callback from Fly worker
   */
  handleCallback(
    task: ImageProcessingTask,
    result: ImageCallbackResult,
    state: BatchState
  ): void {
    if (result.status === 'success') {
      task.status = 'completed';
      task.ref_json_r2_key = result.ref_json_r2_key!;
      task.ref_data = result.ref_data!;
      task.archive_r2_key = result.archive_r2_key!;
      task.completed_at = new Date().toISOString();
      state.tasks_completed++;

      console.log(`[ImageProcessing] ✓ Task ${task.task_id} completed: ${task.ref_json_r2_key}`);

      if (result.performance) {
        console.log(`[ImageProcessing]   Performance: ${result.performance.total_time_ms}ms total`);
      }
    } else {
      task.status = 'failed';
      task.error = result.error;
      state.tasks_failed++;

      console.error(`[ImageProcessing] ✗ Task ${task.task_id} failed: ${result.error}`);
    }
  }

  /**
   * Transform file after phase completes
   * For successfully processed images: REPLACE with .ref.json
   * For other files: KEEP as-is (pass through)
   */
  transformFile(
    file: ProcessableFile,
    task: ImageProcessingTask | undefined
  ): ProcessableFile[] {
    if (
      task &&
      task.status === 'completed' &&
      task.ref_json_r2_key &&
      task.ref_data
    ) {
      // Image was processed → REPLACE with .ref.json
      const refJsonContent = JSON.stringify(task.ref_data, null, 2);

      return [{
        r2_key: task.ref_json_r2_key,
        logical_path: file.logical_path + '.ref.json',
        file_name: file.file_name + '.ref.json',
        file_size: new TextEncoder().encode(refJsonContent).length,
        content_type: 'application/json',
        processing_config: file.processing_config,
        source_file: file.file_name,
        preprocessor_tags: ['ImageProcessor'],
      }];
    } else {
      // Not processed or failed → keep original file as-is
      return [file];
    }
  }

  /**
   * After image processing, we're done
   */
  getNextPhase(): BatchStatus | null {
    return null; // Goes to DONE
  }

  /**
   * Check if file is a processable image type
   */
  private isProcessableImage(file: ProcessableFile): boolean {
    const contentType = file.content_type.toLowerCase();
    return (
      contentType === 'image/jpeg' ||
      contentType === 'image/jpg' ||
      contentType === 'image/png' ||
      contentType === 'image/webp'
    );
  }

  /**
   * Count tasks currently processing
   */
  private countProcessing(state: BatchState): number {
    return Object.values(state.current_phase_tasks)
      .filter(t => t.status === 'processing')
      .length;
  }

  /**
   * Check for timed-out tasks and mark them as failed
   */
  private checkTimeouts(state: BatchState, timeoutMs: number): void {
    const now = Date.now();
    let timedOutCount = 0;

    for (const task of Object.values(state.current_phase_tasks) as ImageProcessingTask[]) {
      if (task.status === 'processing' && task.started_at) {
        const startTime = new Date(task.started_at).getTime();
        const elapsed = now - startTime;

        if (elapsed > timeoutMs) {
          task.status = 'failed';
          task.error = `Task timed out after ${Math.round(elapsed / 1000)}s`;
          task.completed_at = new Date().toISOString();
          state.tasks_failed++;
          timedOutCount++;

          console.warn(`[ImageProcessing] ⏱ Task ${task.task_id} timed out (${Math.round(elapsed / 1000)}s)`);
        }
      }
    }

    if (timedOutCount > 0) {
      console.log(`[ImageProcessing] Marked ${timedOutCount} task(s) as timed out`);
    }
  }
}
