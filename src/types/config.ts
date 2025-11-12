/**
 * Configuration interface
 */

export interface Config {
  // Fly.io - TIFF conversion
  FLY_TIFF_APP_NAME: string;
  FLY_TIFF_WORKER_IMAGE: string;

  // Fly.io - Image processing
  FLY_IMAGE_APP_NAME: string;
  FLY_IMAGE_WORKER_IMAGE: string;

  FLY_REGION: string;

  // Orchestrator
  ORCHESTRATOR_URL: string;

  // Worker callback
  WORKER_URL: string;

  // Batch sizes (tunable)
  BATCH_SIZE_TIFF_CONVERSION: number;
  BATCH_SIZE_IMAGE_PROCESSING: number;

  // Alarm delays (ms)
  ALARM_DELAY_TIFF_CONVERSION: number;
  ALARM_DELAY_IMAGE_PROCESSING: number;
  ALARM_DELAY_ERROR_RETRY: number;

  // Task timeouts (ms) - per phase
  TASK_TIMEOUT_TIFF_CONVERSION: number;
  TASK_TIMEOUT_IMAGE_PROCESSING: number;

  // CDN configuration
  CDN_PUBLIC_URL: string;
  CDN_API_URL: string;

  // Retry limits
  MAX_RETRY_ATTEMPTS: number;
}
