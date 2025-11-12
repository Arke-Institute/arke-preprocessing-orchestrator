/**
 * Batch state stored in Durable Object
 */

import type { QueueMessage } from './queue.js';
import type { ProcessableFile } from './file.js';

export type BatchStatus =
  | 'TIFF_CONVERSION'     // Converting TIFFs via Fly machines
  | 'IMAGE_PROCESSING'    // Processing images (JPEG/PNG/WebP) for CDN
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
 * Image processing task
 */
export interface ImageProcessingTask extends Task {
  // Input file info
  input_r2_key: string;
  input_file_name: string;
  input_content_type: string;
  input_file_size: number;
  input_cid?: string;  // Preserve original IPFS CID

  // Output (from callback)
  ref_json_r2_key?: string;  // Where .ref.json was written
  ref_data?: RefData;        // The ref content
  archive_r2_key?: string;   // Where original was archived

  // Fly machine tracking
  fly_machine_id?: string;
}

/**
 * RefData structure for CDN references
 */
export interface RefData {
  url: string;          // CDN URL (REQUIRED)
  ipfs_cid?: string;    // Original IPFS CID
  type?: string;        // MIME type
  size?: number;        // File size in bytes
  filename?: string;    // Original filename
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
