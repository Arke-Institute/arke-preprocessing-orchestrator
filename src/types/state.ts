/**
 * Batch state stored in Durable Object
 */

import type { QueueMessage } from './queue.js';
import type { ProcessableFile } from './file.js';

export type BatchStatus =
  | 'TIFF_CONVERSION'     // Converting TIFFs via Fly machines
  | 'DONE'                // All processing complete
  | 'ERROR';              // Permanent failure

/**
 * Generic task interface
 * Extend this for specific task types
 */
export interface Task {
  task_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  retry_count: number;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

/**
 * TIFF conversion task
 */
export interface TiffConversionTask extends Task {
  // Input
  input_r2_key: string;
  input_file_name: string;

  // Output (from callback)
  output_r2_key?: string;
  output_file_name?: string;
  output_file_size?: number;

  // Fly machine tracking
  fly_machine_id?: string;
}

/**
 * Complete batch state
 */
export interface BatchState {
  // Identity
  batch_id: string;
  status: BatchStatus;

  // Original queue message (preserved for reference)
  queue_message: QueueMessage;

  // Current file list (updated after each phase completes)
  // This is the evolving file list that phases build upon
  current_file_list: ProcessableFile[];

  // Current phase tasks
  current_phase_tasks: Record<string, Task>;

  // Progress counters
  tasks_total: number;
  tasks_completed: number;
  tasks_failed: number;

  // Metadata
  started_at: string;
  updated_at: string;
  completed_at?: string;
  error?: string;

  // Retry tracking
  phase_retry_count: number;
}
