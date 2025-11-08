/**
 * Configuration interface
 */

export interface Config {
  // Fly.io
  FLY_APP_NAME: string;
  FLY_WORKER_IMAGE: string;
  FLY_REGION: string;

  // Orchestrator
  ORCHESTRATOR_URL: string;

  // Worker callback
  WORKER_URL: string;

  // Batch sizes (tunable)
  BATCH_SIZE_TIFF_CONVERSION: number;

  // Alarm delays (ms)
  ALARM_DELAY_TIFF_CONVERSION: number;
  ALARM_DELAY_ERROR_RETRY: number;

  // Task timeouts (ms) - per phase
  TASK_TIMEOUT_TIFF_CONVERSION: number;

  // Retry limits
  MAX_RETRY_ATTEMPTS: number;
}
