/**
 * Preprocessing Durable Object
 * Orchestrates batch preprocessing through multiple phases
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './config.js';
import type { QueueMessage } from './types/queue.js';
import type { BatchState, BatchStatus } from './types/state.js';
import type { ProcessableFile } from './types/file.js';
import type { Phase } from './phases/base.js';
import { loadConfig as loadConfigImpl } from './config.js';
import { TiffConversionPhase } from './phases/tiff-conversion.js';
import { ImageProcessingPhase } from './phases/image-processing.js';

/**
 * Status response for HTTP polling
 */
export interface StatusResponse {
  batch_id: string;
  status: BatchStatus;
  progress: {
    tasks_total: number;
    tasks_completed: number;
    tasks_failed: number;
  };
  started_at: string;
  updated_at: string;
  completed_at?: string;
  error?: string;
}

/**
 * Preprocessing Durable Object
 */
export class PreprocessingDurableObject extends DurableObject<Env> {
  private state: BatchState | null = null;

  // Phase registry
  private phases: Map<BatchStatus, Phase> = new Map<BatchStatus, Phase>([
    ['TIFF_CONVERSION', new TiffConversionPhase()],
    ['IMAGE_PROCESSING', new ImageProcessingPhase()],
  ]);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Start batch processing
   * Called by queue consumer
   */
  async startBatch(queueMessage: QueueMessage): Promise<void> {
    await this.loadState();

    // Idempotency check
    if (this.state && this.state.status !== 'ERROR') {
      console.log(`[DO] Batch ${queueMessage.batch_id} already exists with status ${this.state.status}`);
      return;
    }

    console.log(`[DO] Starting batch ${queueMessage.batch_id}`);

    // Convert queue message files to initial file list
    const initialFiles: ProcessableFile[] = [];
    for (const directory of queueMessage.directories) {
      for (const file of directory.files) {
        initialFiles.push({
          r2_key: file.r2_key,
          logical_path: file.logical_path,
          file_name: file.file_name,
          file_size: file.file_size,
          content_type: file.content_type,
          cid: file.cid,
          processing_config: directory.processing_config,
        });
      }
    }

    console.log(`[DO] Initialized file list with ${initialFiles.length} files`);

    // Determine first phase
    const firstPhase = this.phases.get('TIFF_CONVERSION')!;

    // Run discovery for first phase from initial file list
    const tasks = await firstPhase.discover(initialFiles);

    console.log(`[DO] Discovered ${tasks.length} task(s) for ${firstPhase.name} phase`);

    // Initialize state
    this.state = {
      batch_id: queueMessage.batch_id,
      status: 'TIFF_CONVERSION',
      queue_message: queueMessage,
      current_file_list: initialFiles,
      current_phase_tasks: Object.fromEntries(
        tasks.map(t => [t.task_id, t])
      ),
      tasks_total: tasks.length,
      tasks_completed: 0,
      tasks_failed: 0,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      phase_retry_count: 0,
    };

    await this.saveState();

    // If no tasks, go straight to DONE
    if (tasks.length === 0) {
      console.log(`[DO] No tasks to process, finalizing batch`);
      await this.finalizeBatch();
      return;
    }

    // Start first phase
    console.log(`[DO] Scheduling first alarm`);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /**
   * Alarm handler - process next batch of tasks
   */
  async alarm(): Promise<void> {
    await this.loadState();

    if (!this.state) {
      console.error('[DO] Alarm fired but no state found');
      return;
    }

    // If in ERROR or DONE state, clear alarm and exit
    if (this.state.status === 'ERROR' || this.state.status === 'DONE') {
      console.log(`[DO] Alarm fired in terminal state ${this.state.status}, clearing alarm`);
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const config = loadConfigImpl(this.env);
    const currentPhase = this.phases.get(this.state.status);

    if (!currentPhase) {
      console.error(`[DO] No phase handler for status: ${this.state.status}`);
      return;
    }

    console.log(`[DO] Alarm: Processing ${this.state.status} phase`);

    try {
      const hasMoreWork = await currentPhase.executeBatch(
        this.state,
        config,
        this.env
      );

      this.state.updated_at = new Date().toISOString();
      this.state.phase_retry_count = 0; // Reset on success
      await this.saveState();

      if (hasMoreWork) {
        // Schedule next batch
        const delay = config.ALARM_DELAY_TIFF_CONVERSION;
        console.log(`[DO] More work remains, scheduling next alarm in ${delay}ms`);
        await this.ctx.storage.setAlarm(Date.now() + delay);
      } else {
        // Phase complete - transition to next phase
        console.log(`[DO] Phase ${this.state.status} complete`);
        await this.transitionToNextPhase(currentPhase);
      }
    } catch (error: any) {
      console.error(`[DO] Error in alarm handler:`, error);
      await this.handleError(error);
    }
  }

  /**
   * Apply phase transformations to current file list
   * Builds the new file list after a phase completes
   */
  private applyPhaseTransformations(phase: Phase): ProcessableFile[] {
    const files: ProcessableFile[] = [];

    // Build task map for lookup by input file
    const taskMap = new Map(
      Object.values(this.state!.current_phase_tasks).map(t => [
        (t as any).input_r2_key || (t as any).r2_key,
        t
      ])
    );

    console.log(`[DO] Applying ${phase.name} transformations to ${this.state!.current_file_list.length} files`);

    // Apply transformations to each file in current list
    for (const file of this.state!.current_file_list) {
      const task = taskMap.get(file.r2_key);
      const transformedFiles = phase.transformFile(file, task);
      files.push(...transformedFiles);
    }

    console.log(`[DO] Transformation result: ${files.length} files`);

    return files;
  }

  /**
   * Transition to next phase
   */
  private async transitionToNextPhase(completedPhase: Phase): Promise<void> {
    // 1. Apply completed phase's transformations to build new file list
    const transformedFiles = this.applyPhaseTransformations(completedPhase);
    this.state!.current_file_list = transformedFiles;

    // 2. Get next phase
    const nextStatus = completedPhase.getNextPhase();

    if (nextStatus === null) {
      // No more phases - current_file_list is the final output
      console.log(`[DO] No more phases, finalizing batch`);
      await this.finalizeBatch();
    } else {
      // 3. Next phase discovers from transformed file list
      console.log(`[DO] Transitioning to ${nextStatus} phase`);
      const nextPhase = this.phases.get(nextStatus)!;
      const tasks = await nextPhase.discover(transformedFiles);

      this.state!.status = nextStatus;
      this.state!.current_phase_tasks = Object.fromEntries(
        tasks.map(t => [t.task_id, t])
      );
      this.state!.tasks_total = tasks.length;
      this.state!.tasks_completed = 0;
      this.state!.tasks_failed = 0;
      this.state!.phase_retry_count = 0;

      await this.saveState();

      if (tasks.length === 0) {
        console.log(`[DO] No tasks in ${nextStatus} phase, moving to next`);
        await this.transitionToNextPhase(nextPhase);
      } else {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    }
  }

  /**
   * Handle callback from Fly worker
   */
  async handleCallback(taskId: string, result: any): Promise<void> {
    await this.loadState();

    if (!this.state) {
      throw new Error('Batch not found');
    }

    const task = this.state.current_phase_tasks[taskId];
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    console.log(`[DO] Received callback for task ${taskId}: ${result.status}`);

    const currentPhase = this.phases.get(this.state.status)!;
    currentPhase.handleCallback(task, result, this.state);

    this.state.updated_at = new Date().toISOString();
    await this.saveState();

    // Check if all tasks are done
    const allDone = Object.values(this.state.current_phase_tasks)
      .every(t => t.status === 'completed' || t.status === 'failed');

    if (allDone) {
      console.log(`[DO] All tasks complete via callback, transitioning`);
      await this.transitionToNextPhase(currentPhase);
    }
  }

  /**
   * Finalize batch and callback to worker
   */
  private async finalizeBatch(): Promise<void> {
    this.state!.status = 'DONE';
    this.state!.completed_at = new Date().toISOString();
    await this.saveState();

    console.log(`[DO] Batch ${this.state!.batch_id} complete`);
    console.log(`[DO]   Total tasks: ${this.state!.tasks_total}`);
    console.log(`[DO]   Completed: ${this.state!.tasks_completed}`);
    console.log(`[DO]   Failed: ${this.state!.tasks_failed}`);

    // Use current_file_list (already transformed by all phases)
    const processedFiles = this.state!.current_file_list;

    console.log(`[DO] Sending ${processedFiles.length} file(s) to worker callback`);

    // Callback to worker
    const config = loadConfigImpl(this.env);
    try {
      const response = await fetch(
        `${config.WORKER_URL}/api/batches/${this.state!.batch_id}/enqueue-processed`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: processedFiles }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Worker callback failed: ${response.status} ${errorText}`);
      }

      console.log(`[DO] Worker callback successful`);
    } catch (error: any) {
      console.error(`[DO] Worker callback error:`, error);
      // Mark as error but don't retry
      this.state!.status = 'ERROR';
      this.state!.error = `Worker callback failed: ${error.message}`;
      await this.ctx.storage.deleteAlarm();
      await this.saveState();
    }
  }

  /**
   * Get status (for HTTP polling)
   */
  async getStatus(): Promise<StatusResponse> {
    // Read directly from storage (don't overwrite this.state)
    const state = await this.ctx.storage.get<BatchState>('state');

    if (!state) {
      throw new Error('Batch not found');
    }

    return {
      batch_id: state.batch_id,
      status: state.status,
      progress: {
        tasks_total: state.tasks_total,
        tasks_completed: state.tasks_completed,
        tasks_failed: state.tasks_failed,
      },
      started_at: state.started_at,
      updated_at: state.updated_at,
      completed_at: state.completed_at,
      error: state.error,
    };
  }

  /**
   * Handle errors with retry logic
   */
  private async handleError(error: any): Promise<void> {
    this.state!.phase_retry_count++;

    const config = loadConfigImpl(this.env);

    if (this.state!.phase_retry_count >= config.MAX_RETRY_ATTEMPTS) {
      // Give up
      console.error(`[DO] Giving up after ${this.state!.phase_retry_count} retries`);
      this.state!.status = 'ERROR';
      this.state!.error = `Failed after ${this.state!.phase_retry_count} retries: ${error.message}`;
      await this.ctx.storage.deleteAlarm();
      await this.saveState();
    } else {
      // Retry with exponential backoff
      const delay = Math.min(
        config.ALARM_DELAY_ERROR_RETRY,
        1000 * Math.pow(2, this.state!.phase_retry_count)
      );

      console.log(`[DO] Retry ${this.state!.phase_retry_count}/${config.MAX_RETRY_ATTEMPTS} in ${delay}ms`);

      await this.saveState();
      await this.ctx.storage.setAlarm(Date.now() + delay);
    }
  }

  /**
   * Admin reset endpoint
   */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();

    const state = await this.ctx.storage.get<BatchState>('state');
    if (state) {
      state.status = 'ERROR';
      state.error = 'Manually reset by admin';
      await this.ctx.storage.put('state', state);
    }

    console.log(`[DO] Batch reset by admin`);
  }

  /**
   * Load state from storage
   */
  private async loadState(): Promise<void> {
    this.state = await this.ctx.storage.get<BatchState>('state') || null;
  }

  /**
   * Save state to storage
   */
  private async saveState(): Promise<void> {
    if (this.state) {
      await this.ctx.storage.put('state', this.state);
    }
  }

  /**
   * HTTP fetch handler (for status and admin endpoints)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Status endpoint
    if (url.pathname === '/status' && request.method === 'GET') {
      try {
        const status = await this.getStatus();
        return new Response(JSON.stringify(status), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Admin reset endpoint
    if (url.pathname === '/reset' && request.method === 'POST') {
      await this.reset();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}
