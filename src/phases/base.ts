/**
 * Base phase interface
 * All preprocessing phases implement this interface
 */

import type { ProcessingConfig } from '../types/queue.js';
import type { BatchState, BatchStatus, Task } from '../types/state.js';
import type { Config } from '../types/config.js';
import type { Env } from '../config.js';
import type { ProcessableFile } from '../types/file.js';

/**
 * Phase interface
 * Each phase is self-contained with discovery, execution, and callback handling
 */
export interface Phase {
  /**
   * Phase name (matches BatchStatus)
   */
  name: BatchStatus;

  /**
   * Discover tasks for this phase
   * Analyzes current file list (output from previous phase) and creates tasks
   *
   * @param files - Current file list (from previous phase or initial queue message)
   * @returns Tasks to execute in this phase
   */
  discover(files: ProcessableFile[]): Promise<Task[]>;

  /**
   * Execute a batch of tasks
   * Spawns Fly machines for pending tasks
   * @returns true if more work remains, false if phase is complete
   */
  executeBatch(
    state: BatchState,
    config: Config,
    env: Env
  ): Promise<boolean>;

  /**
   * Handle callback from Fly worker
   */
  handleCallback(
    task: Task,
    callbackResult: any,
    state: BatchState
  ): void;

  /**
   * Get next phase status after this phase completes
   * @returns Next phase status, or null if no more phases (goes to DONE)
   */
  getNextPhase(): BatchStatus | null;

  /**
   * Transform file after phase completes
   * Allows phases to add/modify/remove files based on their processing
   *
   * @param file - Input file from current file list
   * @param task - Completed task for this file (if any)
   * @returns Array of files to include in next phase (can be 0, 1, or multiple)
   */
  transformFile(
    file: ProcessableFile,
    task: Task | undefined
  ): ProcessableFile[];
}
