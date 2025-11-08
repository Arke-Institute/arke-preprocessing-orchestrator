# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Cloudflare Worker that orchestrates batch preprocessing for the Arke Institute ingest pipeline. It uses Durable Objects to manage batch state and spawns Fly.io machines for resource-intensive preprocessing tasks (currently TIFF conversion).

**Architecture:**
```
PREPROCESS_QUEUE → Queue Consumer → Durable Object → Fly.io Machines
                    (src/index.ts)   (src/batch-do.ts)  (preprocessing workers)
                                           ↓
                                    Ingest Worker
                                    (completion callback)
```

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start local development server with Wrangler
npm run deploy       # Deploy to Cloudflare
npm run tail         # View live logs from deployed worker
npm run typecheck    # Run TypeScript type checking
```

### Testing Queue Messages

```bash
# Send a test message to the queue
wrangler queues send arke-preprocess-jobs --body '{
  "batch_id": "test-123",
  "r2_prefix": "staging/test-123/",
  "uploader": "test-user",
  "root_path": "/test",
  "total_files": 1,
  "total_bytes": 1000,
  "uploaded_at": "2025-01-06T00:00:00Z",
  "finalized_at": "2025-01-06T00:00:00Z",
  "metadata": {},
  "directories": []
}'
```

## Architecture

### Three-Layer Design

1. **Queue Consumer** (`src/index.ts:queue()`): Receives batch messages from `arke-preprocess-jobs` queue and routes to appropriate Durable Object
2. **Durable Object** (`src/batch-do.ts`): Manages batch state, orchestrates phases, handles alarms and callbacks
3. **HTTP Endpoints** (`src/index.ts:fetch()`): Status polling, callbacks from Fly workers, admin endpoints

### Durable Object State Machine

Each batch gets its own Durable Object instance (keyed by `batch_id`). The DO manages state transitions:

```
TIFF_CONVERSION → (future phases) → DONE
        ↓
      ERROR
```

**State lifecycle:**
1. Queue consumer calls `startBatch()` → initializes state, schedules alarm
2. Alarm fires → `alarm()` executes current phase batch
3. Phase spawns Fly machines → machines call back with results
4. When phase complete → transition to next phase or finalize
5. Finalization → callback to ingest worker with processed file list

### Phase System

Phases are self-contained processing units implementing `src/phases/base.ts:Phase`:

- **discover(files)**: Scan current file list (from previous phase) for tasks to execute
- **executeBatch()**: Spawn Fly machines for pending tasks (respects `BATCH_SIZE_*` config)
- **handleCallback()**: Process completion callbacks from Fly workers
- **transformFile(file, task)**: Transform input file to output files (can return 0, 1, or multiple)
- **getNextPhase()**: Define phase ordering

**Phase Chaining:**
Phases build on each other's outputs through `current_file_list`:
1. Phase 1 discovers tasks from initial file list
2. Phase 1 completes → `transformFile()` applied to each file → new `current_file_list`
3. Phase 2 discovers tasks from Phase 1's output file list
4. Phase 2 completes → `transformFile()` applied → updated `current_file_list`
5. Final `current_file_list` sent to ingest worker

**Example chain:**
```
Initial:     [doc.pdf, image.tiff, photo.jpg]
TIFF Phase:  [doc.pdf, image.tiff, image.jpg, photo.jpg]  // Added JPEG
Resize Phase: [doc.pdf, image.tiff, image.jpg, image-thumb.jpg, photo.jpg, photo-thumb.jpg]  // Added thumbnails
```

**Current phases:**
- `TiffConversionPhase` (`src/phases/tiff-conversion.ts`): Converts TIFF files to JPEG via Fly.io machines
  - **discover()**: Finds TIFF files in current file list
  - **transformFile()**: Returns BOTH original TIFF and converted JPEG
    - TIFF gets `preprocessor_tags: ['TiffConverter:source']`
    - JPEG gets `preprocessor_tags: ['TiffConverter']` and `source_file` metadata

**Adding new phases:**
1. Create phase class implementing `Phase` interface
2. Implement `discover(files: ProcessableFile[])` to find work in current file list
3. Implement `transformFile(file, task)` to define file transformations
4. Add phase to `phases` Map in `src/batch-do.ts:40`
5. Update `BatchStatus` type in `src/types/state.ts:7`
6. Update phase ordering via `getNextPhase()` methods

### Alarm-Based Processing

Durable Objects use alarms (scheduled wake-ups) to process batches:
- Initial alarm scheduled 1s after batch start
- Subsequent alarms scheduled based on `ALARM_DELAY_TIFF_CONVERSION` (default: 5s)
- Error retries use exponential backoff with `ALARM_DELAY_ERROR_RETRY` cap (default: 30s)
- Alarms cleared on completion or terminal error

### Fly.io Machine Spawning

The `TiffConversionPhase` spawns ephemeral Fly machines:
- Machine config in `src/phases/tiff-conversion.ts:112-135`
- Environment variables pass R2 credentials, task details, callback URL
- `auto_destroy: true` ensures cleanup
- Machines POST results to `/callback/:batchId/:taskId`

### HTTP Endpoints

- `GET /health`: Health check
- `GET /status/:batchId`: Get batch processing status (for polling)
- `POST /callback/:batchId/:taskId`: Receive completion from Fly workers
- `POST /admin/reset/:batchId`: Reset batch to ERROR state (admin only)

## Configuration

### Environment Variables (wrangler.jsonc)

**Required secrets (not in wrangler.jsonc):**
- `FLY_API_TOKEN`: Fly.io API token for spawning machines
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: R2 credentials passed to Fly workers

**Config vars (in wrangler.jsonc:vars):**
- `FLY_APP_NAME`: Fly.io app name for machine spawning
- `FLY_WORKER_IMAGE`: Docker image for Fly machines
- `FLY_REGION`: Region to spawn machines (e.g., `ord`)
- `ORCHESTRATOR_URL`: This worker's public URL (for callback URLs)
- `WORKER_URL`: Ingest worker URL (for completion callbacks)
- `R2_BUCKET`: R2 bucket name
- `BATCH_SIZE_TIFF_CONVERSION`: Max Fly machines to spawn per alarm (default: 1000)
- `ALARM_DELAY_TIFF_CONVERSION`: Milliseconds between alarms during processing (default: 5000)
- `ALARM_DELAY_ERROR_RETRY`: Max retry delay in milliseconds (default: 30000)
- `MAX_RETRY_ATTEMPTS`: Phase retry limit before ERROR (default: 5)

### Durable Object Configuration

- **Binding name**: `PREPROCESSING_DO` (accessed via `env.PREPROCESSING_DO`)
- **Class**: `PreprocessingDurableObject`
- **ID strategy**: Named DOs using `batch_id` as key (ensures one DO per batch)

## Key Behaviors

### Idempotency
- Queue messages can be redelivered; `startBatch()` checks existing state
- If batch exists with non-ERROR status, message is acked without reprocessing

### Error Handling
- Phase-level retries with exponential backoff (configurable via `MAX_RETRY_ATTEMPTS`)
- After max retries, batch marked as ERROR and alarm cleared
- Individual task failures tracked but don't fail entire batch

### File List Transformation
- Original queue message preserved in `BatchState.queue_message`
- Each phase's `transformFile()` method defines how files are transformed
- **TIFF Conversion**: Preserves BOTH original TIFF and converted JPEG
  - Original TIFF: Tagged with `preprocessor_tags: ['TiffConverter:source']`
  - Converted JPEG: Tagged with `preprocessor_tags: ['TiffConverter']`, includes `source_file` metadata
- Non-processed files pass through unchanged
- Final callback sends complete transformed file list to ingest worker

### Callback Flow
- Fly workers POST to `/callback/:batchId/:taskId`
- DO loads state, updates task, checks if all tasks complete
- If all tasks done, immediately transitions to next phase (no alarm wait)

## When to Modify This Worker

**DO modify for:**
- Adding new preprocessing phases (implement `Phase` interface)
- Changing Fly machine configuration (memory, CPU, image)
- Adjusting batch sizes or alarm delays
- Modifying retry logic or error handling

**DON'T modify for:**
- Queue message format changes from ingest worker (types in `src/types/queue.ts` should match sender)
- Fly worker implementation changes (this worker only spawns and receives callbacks)
- R2 bucket changes (configure via `wrangler.jsonc`)
