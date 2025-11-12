/**
 * Callback payloads from Fly.io workers
 */

import type { RefData } from './state.js';

/**
 * TIFF conversion callback from Fly worker
 */
export interface TiffCallbackResult {
  task_id: string;
  batch_id: string;
  status: 'success' | 'error';

  // On success
  output_r2_key?: string;
  output_file_name?: string;
  output_file_size?: number;

  // Performance metrics (optional)
  performance?: {
    total_time_ms: number;
    download_time_ms: number;
    conversion_time_ms: number;
    upload_time_ms: number;
  };

  // On error
  error?: string;
}

/**
 * Image processing callback from Fly worker
 */
export interface ImageCallbackResult {
  task_id: string;
  batch_id: string;
  status: 'success' | 'error';

  // On success
  ref_json_r2_key?: string;  // "staging/batch_123/dir/photo.jpg.ref.json"
  ref_data?: RefData;        // The actual ref content
  archive_r2_key?: string;   // Where original was archived

  // Performance metrics (optional)
  performance?: {
    total_time_ms: number;
    download_time_ms: number;
    resize_time_ms: number;
    cdn_upload_time_ms: number;
    archive_time_ms: number;
  };

  // On error
  error?: string;
}
