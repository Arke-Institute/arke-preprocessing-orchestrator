/**
 * Configuration loader
 */

import type { Config } from './types/config.js';

export interface Env {
  // Fly.io
  FLY_API_TOKEN: string;

  // R2
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET?: string;
  ARCHIVE_BUCKET?: string;

  // Config vars
  FLY_TIFF_APP_NAME?: string;
  FLY_TIFF_WORKER_IMAGE?: string;
  FLY_IMAGE_APP_NAME?: string;
  FLY_IMAGE_WORKER_IMAGE?: string;
  FLY_REGION?: string;
  ORCHESTRATOR_URL?: string;
  WORKER_URL?: string;
  BATCH_SIZE_TIFF_CONVERSION?: string;
  BATCH_SIZE_IMAGE_PROCESSING?: string;
  ALARM_DELAY_TIFF_CONVERSION?: string;
  ALARM_DELAY_IMAGE_PROCESSING?: string;
  ALARM_DELAY_ERROR_RETRY?: string;
  TASK_TIMEOUT_TIFF_CONVERSION?: string;
  TASK_TIMEOUT_IMAGE_PROCESSING?: string;
  MAX_RETRY_ATTEMPTS?: string;
  CDN_PUBLIC_URL?: string;
  CDN_API_URL?: string;

  // Durable Object
  PREPROCESSING_DO: DurableObjectNamespace;
}

/**
 * Load configuration from environment
 */
export function loadConfig(env: Env): Config {
  return {
    // Fly.io - TIFF conversion
    FLY_TIFF_APP_NAME: env.FLY_TIFF_APP_NAME || 'arke-tiff-worker',
    FLY_TIFF_WORKER_IMAGE: env.FLY_TIFF_WORKER_IMAGE || 'registry.fly.io/arke-tiff-worker:latest',

    // Fly.io - Image processing
    FLY_IMAGE_APP_NAME: env.FLY_IMAGE_APP_NAME || 'arke-image-processor',
    FLY_IMAGE_WORKER_IMAGE: env.FLY_IMAGE_WORKER_IMAGE || 'registry.fly.io/arke-image-processor:latest',

    FLY_REGION: env.FLY_REGION || 'ord',

    // Orchestrator
    ORCHESTRATOR_URL: env.ORCHESTRATOR_URL || 'https://arke-preprocessing.workers.dev',

    // Worker callback
    WORKER_URL: env.WORKER_URL || 'https://ingest.arke.institute',

    // Batch sizes
    BATCH_SIZE_TIFF_CONVERSION: parseInt(env.BATCH_SIZE_TIFF_CONVERSION || '1000'),
    BATCH_SIZE_IMAGE_PROCESSING: parseInt(env.BATCH_SIZE_IMAGE_PROCESSING || '1000'),

    // Alarm delays
    ALARM_DELAY_TIFF_CONVERSION: parseInt(env.ALARM_DELAY_TIFF_CONVERSION || '5000'),
    ALARM_DELAY_IMAGE_PROCESSING: parseInt(env.ALARM_DELAY_IMAGE_PROCESSING || '5000'),
    ALARM_DELAY_ERROR_RETRY: parseInt(env.ALARM_DELAY_ERROR_RETRY || '30000'),

    // Task timeouts (ms)
    TASK_TIMEOUT_TIFF_CONVERSION: parseInt(env.TASK_TIMEOUT_TIFF_CONVERSION || '60000'), // 1 minute default
    TASK_TIMEOUT_IMAGE_PROCESSING: parseInt(env.TASK_TIMEOUT_IMAGE_PROCESSING || '120000'), // 2 minutes default

    // CDN configuration
    CDN_PUBLIC_URL: env.CDN_PUBLIC_URL || 'https://cdn.arke.institute',
    CDN_API_URL: env.CDN_API_URL || 'https://cdn.arke.institute',

    // Retry limits
    MAX_RETRY_ATTEMPTS: parseInt(env.MAX_RETRY_ATTEMPTS || '5'),
  };
}
