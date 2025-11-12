# Image Processing Fly Worker - Technical Specification

## Overview

The Image Processing Fly Worker is an ephemeral Fly.io machine that processes image files (JPEG, PNG, WebP) by:
1. Downloading the original image from R2 staging bucket
2. Generating smart-sized image variants
3. Uploading variants to the CDN
4. Archiving the original image to permanent storage
5. Writing a `.ref.json` file to staging with CDN metadata
6. Calling back to the orchestrator with results

This worker is spawned by the `ImageProcessingPhase` in the preprocessing orchestrator.

---

## Input: Environment Variables

The orchestrator spawns the Fly machine with the following environment variables:

### Task Identification
```bash
TASK_ID="<unique_task_id>"              # e.g., "img_1234567890_abcdef"
BATCH_ID="<batch_id>"                    # e.g., "batch_abc123"
```

### Input File Information
```bash
INPUT_R2_KEY="<r2_key>"                 # e.g., "staging/batch_abc123/photos/sunset.jpg"
INPUT_FILE_NAME="<file_name>"           # e.g., "sunset.jpg"
INPUT_CONTENT_TYPE="<mime_type>"        # e.g., "image/jpeg"
INPUT_FILE_SIZE="<size_bytes>"          # e.g., "2457600"
INPUT_CID="<ipfs_cid>"                  # Optional, e.g., "QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7..."
```

### R2 Credentials (for downloading original and uploading artifacts)
```bash
R2_ACCOUNT_ID="<account_id>"
R2_ACCESS_KEY_ID="<access_key>"
R2_SECRET_ACCESS_KEY="<secret_key>"
R2_BUCKET="arke-staging"                # Staging bucket name
ARCHIVE_BUCKET="arke-archive"           # Archive bucket name
```

### CDN Configuration
```bash
CDN_API_URL="https://cdn.arke.institute" # CDN API endpoint for registration
CDN_PUBLIC_URL="https://cdn.arke.institute" # Public CDN URL for asset access
```

### Callback Configuration
```bash
CALLBACK_URL="<orchestrator_callback_url>"  # e.g., "https://preprocessing-orchestrator.arke.institute/callback/batch_abc123/img_1234567890_abcdef"
```

---

## Processing Steps

### Step 1: Download Original Image

```typescript
// Download from R2 staging bucket
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const downloadResponse = await s3Client.send(
  new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: INPUT_R2_KEY,
  })
);

const imageBuffer = await streamToBuffer(downloadResponse.Body);
```

**Expected:** Original image downloaded successfully.

---

### Step 2: Generate Smart-Sized Variants

Analyze the original image dimensions and generate appropriate variants:

**Smart Sizing Logic:**
- **Thumbnail**: Max 400px on longest side
- **Medium**: Max 1200px on longest side
- **Large**: Max 2400px on longest side
- **Original**: Keep if under reasonable size limit (e.g., 4000px)

**Example using Sharp (Node.js):**
```typescript
import sharp from 'sharp';

const metadata = await sharp(imageBuffer).metadata();
const originalWidth = metadata.width!;
const originalHeight = metadata.height!;

const variants: ImageVariant[] = [];

// Determine which sizes to generate
if (originalWidth > 400 || originalHeight > 400) {
  variants.push({
    name: 'thumb',
    maxDimension: 400,
  });
}

if (originalWidth > 1200 || originalHeight > 1200) {
  variants.push({
    name: 'medium',
    maxDimension: 1200,
  });
}

if (originalWidth > 2400 || originalHeight > 2400) {
  variants.push({
    name: 'large',
    maxDimension: 2400,
  });
}

// Generate resized images
const resizedImages = await Promise.all(
  variants.map(async (variant) => {
    const resized = await sharp(imageBuffer)
      .resize(variant.maxDimension, variant.maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();

    return {
      name: variant.name,
      buffer: resized,
      size: resized.length,
    };
  })
);
```

**Expected Output:** Array of resized image buffers with size metadata.

---

### Step 3: Generate Asset ID

Generate a unique asset ID for CDN registration:

```typescript
import { randomBytes } from 'crypto';

function generateAssetId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = randomBytes(8).toString('hex').toUpperCase();
  return `${timestamp}${random}`;
}

const assetId = generateAssetId();
// Example: "M2K9X7P4Q1A1B2C3D4E5F6G7H8"
```

---

### Step 4: Upload Variants to CDN

Register the asset with the CDN service and upload variants.

**CDN API Endpoint:** `POST {CDN_API_URL}/asset/{assetId}`

**Request Body:**
```json
{
  "variants": [
    {
      "name": "thumb",
      "data": "<base64_encoded_image>",
      "content_type": "image/jpeg",
      "size": 45678
    },
    {
      "name": "medium",
      "data": "<base64_encoded_image>",
      "content_type": "image/jpeg",
      "size": 234567
    },
    {
      "name": "large",
      "data": "<base64_encoded_image>",
      "content_type": "image/jpeg",
      "size": 1234567
    }
  ],
  "original_filename": "sunset.jpg",
  "original_content_type": "image/jpeg",
  "ipfs_cid": "QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7..." // Optional
}
```

**Expected CDN Response:**
```json
{
  "success": true,
  "assetId": "M2K9X7P4Q1A1B2C3D4E5F6G7H8",
  "cdnUrl": "https://cdn.arke.institute/asset/M2K9X7P4Q1A1B2C3D4E5F6G7H8",
  "variants": {
    "thumb": "https://cdn.arke.institute/asset/M2K9X7P4Q1A1B2C3D4E5F6G7H8?size=thumb",
    "medium": "https://cdn.arke.institute/asset/M2K9X7P4Q1A1B2C3D4E5F6G7H8?size=medium",
    "large": "https://cdn.arke.institute/asset/M2K9X7P4Q1A1B2C3D4E5F6G7H8?size=large"
  }
}
```

**Implementation:**
```typescript
const cdnResponse = await fetch(`${CDN_API_URL}/asset/${assetId}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    variants: resizedImages.map(img => ({
      name: img.name,
      data: img.buffer.toString('base64'),
      content_type: INPUT_CONTENT_TYPE,
      size: img.size,
    })),
    original_filename: INPUT_FILE_NAME,
    original_content_type: INPUT_CONTENT_TYPE,
    ...(INPUT_CID && { ipfs_cid: INPUT_CID }),
  }),
});

if (!cdnResponse.ok) {
  throw new Error(`CDN upload failed: ${cdnResponse.status} ${await cdnResponse.text()}`);
}

const cdnResult = await cdnResponse.json();
```

---

### Step 5: Archive Original Image

Upload the original image to the permanent archive bucket:

```typescript
const archiveKey = INPUT_FILE_NAME; // Just the filename, e.g., "sunset.jpg"

await s3Client.send(
  new PutObjectCommand({
    Bucket: ARCHIVE_BUCKET,
    Key: archiveKey,
    Body: imageBuffer,
    ContentType: INPUT_CONTENT_TYPE,
    Metadata: {
      'original-r2-key': INPUT_R2_KEY,
      'batch-id': BATCH_ID,
      'task-id': TASK_ID,
      ...(INPUT_CID && { 'ipfs-cid': INPUT_CID }),
    },
  })
);
```

**Expected:** Original image stored in `ARCHIVE_BUCKET` with key `sunset.jpg`.

---

### Step 6: Create .ref.json File

Create a reference JSON file with CDN metadata and write it to the staging bucket:

**RefData Structure:**
```typescript
interface RefData {
  url: string;          // CDN URL (base, without size parameter)
  ipfs_cid?: string;    // Original IPFS CID (if provided)
  type?: string;        // MIME type
  size?: number;        // Original file size
  filename?: string;    // Original filename
}
```

**Example:**
```typescript
const refData: RefData = {
  url: cdnResult.cdnUrl,  // "https://cdn.arke.institute/asset/M2K9X7P4Q1..."
  ipfs_cid: INPUT_CID || undefined,
  type: INPUT_CONTENT_TYPE,
  size: parseInt(INPUT_FILE_SIZE),
  filename: INPUT_FILE_NAME,
};

const refJsonContent = JSON.stringify(refData, null, 2);

// Write to staging bucket
const refJsonKey = `${INPUT_R2_KEY}.ref.json`;
// e.g., "staging/batch_abc123/photos/sunset.jpg.ref.json"

await s3Client.send(
  new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: refJsonKey,
    Body: refJsonContent,
    ContentType: 'application/json',
  })
);
```

**Expected .ref.json content:**
```json
{
  "url": "https://cdn.arke.institute/asset/M2K9X7P4Q1A1B2C3D4E5F6G7H8",
  "ipfs_cid": "QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7Jh8Fg6Dc5Ab1Mn3Kp9Xy4",
  "type": "image/jpeg",
  "size": 2457600,
  "filename": "sunset.jpg"
}
```

---

### Step 7: Delete Original from Staging (Optional)

**Note:** The orchestrator expects the original image to still exist in staging until the final batch cleanup. However, if you want to save space, you can delete it here since it's now in the archive bucket.

```typescript
await s3Client.send(
  new DeleteObjectCommand({
    Bucket: R2_BUCKET,
    Key: INPUT_R2_KEY,
  })
);
```

**Decision:** Recommend **NOT** deleting here to keep things simple. Let the orchestrator or ingest worker handle final cleanup.

---

### Step 8: Send Callback to Orchestrator

POST the results back to the orchestrator:

**Callback URL:** `{CALLBACK_URL}`
Example: `https://preprocessing-orchestrator.arke.institute/callback/batch_abc123/img_1234567890_abcdef`

**Success Callback Payload:**
```typescript
interface ImageCallbackResult {
  task_id: string;
  batch_id: string;
  status: 'success' | 'error';

  // On success
  ref_json_r2_key?: string;
  ref_data?: RefData;
  archive_r2_key?: string;

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
```

**Example Success Response:**
```json
{
  "task_id": "img_1234567890_abcdef",
  "batch_id": "batch_abc123",
  "status": "success",
  "ref_json_r2_key": "staging/batch_abc123/photos/sunset.jpg.ref.json",
  "ref_data": {
    "url": "https://cdn.arke.institute/asset/M2K9X7P4Q1A1B2C3D4E5F6G7H8",
    "ipfs_cid": "QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7Jh8Fg6Dc5Ab1Mn3Kp9Xy4",
    "type": "image/jpeg",
    "size": 2457600,
    "filename": "sunset.jpg"
  },
  "archive_r2_key": "sunset.jpg",
  "performance": {
    "total_time_ms": 3450,
    "download_time_ms": 230,
    "resize_time_ms": 1200,
    "cdn_upload_time_ms": 1800,
    "archive_time_ms": 220
  }
}
```

**Example Error Response:**
```json
{
  "task_id": "img_1234567890_abcdef",
  "batch_id": "batch_abc123",
  "status": "error",
  "error": "Failed to resize image: unsupported format"
}
```

**Implementation:**
```typescript
const callbackPayload: ImageCallbackResult = {
  task_id: TASK_ID,
  batch_id: BATCH_ID,
  status: 'success',
  ref_json_r2_key: refJsonKey,
  ref_data: refData,
  archive_r2_key: archiveKey,
  performance: {
    total_time_ms: totalTime,
    download_time_ms: downloadTime,
    resize_time_ms: resizeTime,
    cdn_upload_time_ms: cdnUploadTime,
    archive_time_ms: archiveTime,
  },
};

const callbackResponse = await fetch(CALLBACK_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(callbackPayload),
});

if (!callbackResponse.ok) {
  console.error(`Callback failed: ${callbackResponse.status}`);
  // Worker will auto-destroy anyway, orchestrator will handle timeout
}
```

---

## Output Summary

### What the Worker Creates

1. **CDN Assets**
   - Registered at CDN with asset ID
   - Multiple variants (thumb, medium, large)
   - Accessible via `{CDN_PUBLIC_URL}/asset/{assetId}?size={variant}`

2. **Archive Bucket**
   - Original image stored permanently
   - Key: `{INPUT_FILE_NAME}` (e.g., `sunset.jpg`)
   - Metadata includes batch_id, task_id, original R2 key

3. **Staging Bucket**
   - `.ref.json` file created
   - Key: `{INPUT_R2_KEY}.ref.json`
   - Contains RefData with CDN URL

4. **Orchestrator Callback**
   - POST to CALLBACK_URL with success/error status
   - Includes ref_json_r2_key and ref_data for successful processing

---

## Error Handling

The worker should handle these error cases:

### Download Errors
```typescript
try {
  const downloadResponse = await s3Client.send(new GetObjectCommand(...));
} catch (error) {
  await sendErrorCallback(`Failed to download image: ${error.message}`);
  process.exit(1);
}
```

### Image Processing Errors
```typescript
try {
  const metadata = await sharp(imageBuffer).metadata();
} catch (error) {
  await sendErrorCallback(`Failed to process image: ${error.message}`);
  process.exit(1);
}
```

### CDN Upload Errors
```typescript
if (!cdnResponse.ok) {
  await sendErrorCallback(`CDN upload failed: ${cdnResponse.status}`);
  process.exit(1);
}
```

### Archive Upload Errors
```typescript
try {
  await s3Client.send(new PutObjectCommand(...));
} catch (error) {
  await sendErrorCallback(`Failed to archive image: ${error.message}`);
  process.exit(1);
}
```

**Important:** Always send a callback (success or error) before exiting, so the orchestrator knows the task status.

---

## Fly Machine Configuration

The orchestrator will spawn the Fly machine with this configuration:

```json
{
  "name": "img-{task_id}",
  "config": {
    "image": "registry.fly.io/arke-image-processor:latest",
    "env": {
      "TASK_ID": "...",
      "BATCH_ID": "...",
      "INPUT_R2_KEY": "...",
      "INPUT_FILE_NAME": "...",
      "INPUT_CONTENT_TYPE": "...",
      "INPUT_FILE_SIZE": "...",
      "INPUT_CID": "...",
      "R2_ACCOUNT_ID": "...",
      "R2_ACCESS_KEY_ID": "...",
      "R2_SECRET_ACCESS_KEY": "...",
      "R2_BUCKET": "arke-staging",
      "ARCHIVE_BUCKET": "arke-archive",
      "CDN_API_URL": "https://cdn.arke.institute",
      "CDN_PUBLIC_URL": "https://cdn.arke.institute",
      "CALLBACK_URL": "..."
    },
    "auto_destroy": true,
    "restart": {
      "policy": "no"
    },
    "guest": {
      "memory_mb": 2048,
      "cpus": 2,
      "cpu_kind": "shared"
    }
  },
  "region": "ord"
}
```

---

## Testing Checklist

When implementing the worker, test these scenarios:

- [ ] Small image (< 400px) → No variants generated, original uploaded
- [ ] Medium image (400-1200px) → Thumb generated
- [ ] Large image (1200-2400px) → Thumb + medium generated
- [ ] Very large image (> 2400px) → Thumb + medium + large generated
- [ ] Portrait orientation → Correct aspect ratio maintained
- [ ] Landscape orientation → Correct aspect ratio maintained
- [ ] Square image → Correct aspect ratio maintained
- [ ] JPEG input → Processed correctly
- [ ] PNG input → Processed correctly
- [ ] WebP input → Processed correctly
- [ ] Invalid image format → Error callback sent
- [ ] R2 download failure → Error callback sent
- [ ] CDN upload failure → Error callback sent
- [ ] Archive upload failure → Error callback sent
- [ ] Missing IPFS CID → Ref created without ipfs_cid field
- [ ] Callback failure → Logged but worker completes

---

## Example Worker Entrypoint

```typescript
#!/usr/bin/env node

import { processImage } from './processor';

async function main() {
  const startTime = Date.now();

  try {
    console.log(`[Worker] Starting image processing for task ${process.env.TASK_ID}`);

    const result = await processImage({
      taskId: process.env.TASK_ID!,
      batchId: process.env.BATCH_ID!,
      input: {
        r2Key: process.env.INPUT_R2_KEY!,
        fileName: process.env.INPUT_FILE_NAME!,
        contentType: process.env.INPUT_CONTENT_TYPE!,
        fileSize: parseInt(process.env.INPUT_FILE_SIZE!),
        cid: process.env.INPUT_CID,
      },
      r2Config: {
        accountId: process.env.R2_ACCOUNT_ID!,
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        bucket: process.env.R2_BUCKET!,
        archiveBucket: process.env.ARCHIVE_BUCKET!,
      },
      cdnConfig: {
        apiUrl: process.env.CDN_API_URL!,
        publicUrl: process.env.CDN_PUBLIC_URL!,
      },
      callbackUrl: process.env.CALLBACK_URL!,
    });

    const totalTime = Date.now() - startTime;
    console.log(`[Worker] Completed in ${totalTime}ms`);
    process.exit(0);
  } catch (error) {
    console.error(`[Worker] Fatal error:`, error);
    process.exit(1);
  }
}

main();
```

---

## Questions or Clarifications Needed

1. **CDN API Endpoint:** Does the CDN accept multi-part form data or base64-encoded JSON? (Spec assumes JSON with base64)
2. **Asset ID Collision:** Should the worker check if an asset ID already exists before uploading?
3. **Original Deletion:** Should the worker delete the original from staging, or leave it for orchestrator cleanup? (Spec recommends leaving it)
4. **Variant Naming:** Are the variant names (`thumb`, `medium`, `large`) fixed, or should they be configurable?
5. **Max File Size:** Should there be a maximum file size limit for processing? (e.g., reject > 50MB images)
6. **Image Format Conversion:** Should all variants be converted to JPEG, or preserve the original format?

---

## Summary

The Image Processing Fly Worker is a stateless, ephemeral worker that:
- **Input:** Environment variables with task info, R2 credentials, CDN config
- **Process:** Download → Resize → Upload to CDN → Archive → Create .ref.json
- **Output:** CDN-hosted image variants + .ref.json in staging + callback to orchestrator

The orchestrator handles all coordination, retry logic, and phase transitions. The worker only needs to execute the processing steps and report back.
