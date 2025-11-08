# CDN Registration System - Technical Documentation

## Overview

The CDN registration system is responsible for managing binary assets (images, PDFs, videos, etc.) in the Arke orchestrator pipeline. It ensures that large files are stored efficiently in R2 and made accessible via CDN URLs, while maintaining lightweight JSON references in the IPFS entity graph.

## Table of Contents

1. [When CDN Registration Happens](#when-cdn-registration-happens)
2. [The Two File Types](#the-two-file-types)
3. [Binary Asset Processing Flow](#binary-asset-processing-flow)
4. [Pre-existing .ref.json Flow](#pre-existing-refjson-flow)
5. [CDN Service Architecture](#cdn-service-architecture)
6. [RefData Schema](#refdata-schema)
7. [Code Walkthrough](#code-walkthrough)
8. [Storage Architecture](#storage-architecture)
9. [IPFS CID Preservation](#ipfs-cid-preservation)

---

## When CDN Registration Happens

CDN registration occurs during **Phase 0: Discovery** (`src/phases/discovery.ts`), which is the **first phase** of the batch processing pipeline. This happens synchronously before any alarm-based processing begins.

**Phase Timeline:**
```
Queue Message Received
    ↓
startBatch() called
    ↓
Phase 0: Discovery (synchronous)
  - Build directory tree
  - Classify files (text vs binary vs refs)
  - Process binary assets → CDN registration happens HERE
  - Publish initial entity snapshots
  - Establish parent-child relationships
    ↓
Transition to OCR_IN_PROGRESS
    ↓
Alarm-based processing begins...
```

**Location in Code:**
- File: `src/phases/discovery.ts`
- Function: `discoverAndPublishSnapshots()`
- Lines: 106-138 (binary asset processing)
- Lines: 64-94 (ref file processing)

---

## The Two File Types

The system handles files in two distinct ways:

### 1. Binary Assets Uploaded to R2
- **Examples**: `image.jpg`, `document.pdf`, `video.mp4`
- **Processing**: Copied to archive bucket, registered with CDN, converted to .ref.json
- **Final State**: Binary in ARCHIVE_BUCKET, ref JSON in staging and IPFS

### 2. Pre-existing .ref.json Files
- **Examples**: `image.jpg.ref.json`, `external-resource.ref.json`
- **Processing**: Parsed and validated, added directly to refs array
- **Final State**: Ref JSON in staging and IPFS (binary may be external)

---

## Binary Asset Processing Flow

When a user uploads a binary file (e.g., `photo.jpg`), the following steps occur during discovery:

### Step-by-Step Process

#### Step 1: File Classification

```typescript
// Location: src/phases/discovery.ts:97-103
for (const file of dirGroup.files) {
  // Check if it's a text file
  if (isTextExtension(file.file_name, config)) {
    nodes[dirPath].text_files.push({
      filename: file.file_name,
      staging_key: file.r2_key,
    });
    continue;
  }

  // Check if it's already a ref file
  if (file.file_name.endsWith('.ref.json')) {
    // Handle as pre-existing ref (see next section)
    continue;
  }

  // Everything else is a binary asset → process for CDN
}
```

#### Step 2: Copy to Archive Bucket

Binary files are moved from the temporary staging bucket to the permanent archive bucket.

```typescript
// Location: src/phases/discovery.ts:106-108
const archiveKey = `${file.file_name}`;
await copyR2Object(
  env.STAGING_BUCKET,   // Source: temporary storage
  env.ARCHIVE_BUCKET,   // Destination: permanent storage
  file.r2_key,          // Source key: staging/batch_123/dir/photo.jpg
  archiveKey            // Dest key: photo.jpg
);
```

**Helper Function:**
```typescript
// Location: src/phases/discovery.ts:350-365
async function copyR2Object(
  sourceBucket: R2Bucket,
  destBucket: R2Bucket,
  sourceKey: string,
  destKey: string
): Promise<void> {
  const object = await sourceBucket.get(sourceKey);
  if (!object) {
    throw new Error(`Source object not found: ${sourceKey}`);
  }

  await destBucket.put(destKey, await object.arrayBuffer(), {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  });
}
```

#### Step 3: Generate Asset ID

A unique asset ID is generated to serve as the CDN URL identifier.

```typescript
// Location: src/phases/discovery.ts:111
const assetId = generateAssetId();
```

**Asset ID Generation:**
```typescript
// Location: src/phases/discovery.ts:327-332
function generateAssetId(): string {
  // Generate ULID or similar unique ID
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 15);
  return `${timestamp}${randomPart}`.toUpperCase();
}
```

**Example Output:** `M2K9X7P4Q1W8Z`

#### Step 4: Register with CDN Service

The asset is registered with the CDN service using R2 mode.

```typescript
// Location: src/phases/discovery.ts:112-116
await cdnService.registerAsset({
  assetId,                    // "M2K9X7P4Q1W8Z"
  r2_key: archiveKey,         // "photo.jpg"
  bucket: 'ARCHIVE_BUCKET',   // Bucket identifier
});
```

**CDN Service Implementation:**
```typescript
// Location: src/services/cdn-service.ts:39-56
async registerAsset(request: RegisterAssetRequest): Promise<RegisterAssetResponse> {
  const { assetId, ...body } = request;

  // Call CDN worker via service binding
  const response = await this.cdnService.fetch(`https://cdn/asset/${assetId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`CDN registration error ${response.status}: ${error}`);
  }

  return await response.json();
}
```

**Request Body (R2 Mode):**
```json
{
  "r2_key": "photo.jpg",
  "bucket": "ARCHIVE_BUCKET"
}
```

**Response:**
```json
{
  "success": true,
  "assetId": "M2K9X7P4Q1W8Z",
  "cdnUrl": "https://cdn.arke.institute/asset/M2K9X7P4Q1W8Z",
  "storage_type": "r2",
  "r2_key": "photo.jpg"
}
```

#### Step 5: Create .ref.json File

A reference file is created containing metadata about the asset.

```typescript
// Location: src/phases/discovery.ts:119-128
const refData: RefData = {
  url: `${config.CDN_PUBLIC_URL}/asset/${assetId}`,  // CDN URL
  ...(file.cid && { ipfs_cid: file.cid }),           // Preserve original IPFS CID
  type: file.content_type,                            // MIME type
  size: file.file_size,                               // File size in bytes
  filename: file.file_name,                           // Original filename
};

const refFilename = `${file.file_name}.ref.json`;  // "photo.jpg.ref.json"
const refStagingKey = `${queueMessage.r2_prefix}${dirPath}/${refFilename}`.replace('//', '/');

await writeToStaging(env.STAGING_BUCKET, refStagingKey, JSON.stringify(refData, null, 2));
```

**Example .ref.json Content:**
```json
{
  "url": "https://cdn.arke.institute/asset/M2K9X7P4Q1W8Z",
  "ipfs_cid": "QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7Jh8Fg6Dc5Ab1Mn3Kp9Xy4",
  "type": "image/jpeg",
  "size": 245678,
  "filename": "photo.jpg"
}
```

#### Step 6: Add to Refs Array

The ref is stored in the directory node's `refs[]` array.

```typescript
// Location: src/phases/discovery.ts:131-135
nodes[dirPath].refs.push({
  filename: refFilename,           // "photo.jpg.ref.json"
  staging_key: refStagingKey,      // Full R2 path to ref file
  content: refData,                // Parsed RefData object
});
```

#### Step 7: Delete Original from Staging

The original binary file is removed from staging (now safely in archive).

```typescript
// Location: src/phases/discovery.ts:138
await deleteFromStaging(env.STAGING_BUCKET, file.r2_key);
```

**Helper Function:**
```typescript
// Location: src/phases/discovery.ts:346-348
async function deleteFromStaging(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}
```

---

## Pre-existing .ref.json Flow

Users can upload `.ref.json` files directly to reference external resources or assets that are already processed.

### Processing Steps

#### Step 1: Detect .ref.json File

```typescript
// Location: src/phases/discovery.ts:64
if (file.file_name.endsWith('.ref.json')) {
  // Process as existing ref
}
```

#### Step 2: Read and Parse

```typescript
// Location: src/phases/discovery.ts:66-68
const refContent = await readFromStaging(env.STAGING_BUCKET, file.r2_key);
const refData: RefData = JSON.parse(refContent);
```

#### Step 3: Validate Required Fields

```typescript
// Location: src/phases/discovery.ts:70-74
if (!refData.url) {
  console.warn(`[Discovery] ⚠ Invalid ref file ${file.file_name}: missing required field 'url'`);
  continue;
}
```

**Only `url` is required.** All other fields are optional.

#### Step 4: Check for Pre-existing OCR

If the ref already contains OCR text, mark it as complete to skip OCR phase.

```typescript
// Location: src/phases/discovery.ts:76-88
const hasPreExistingOCR = !!(refData.ocr && refData.ocr.trim().length > 0);

nodes[dirPath].refs.push({
  filename: file.file_name,
  staging_key: file.r2_key,
  content: refData,
  ocr_complete: hasPreExistingOCR ? true : undefined,
});

if (hasPreExistingOCR) {
  console.log(`[Discovery] Found pre-existing OCR in ${file.file_name} (${refData.ocr!.length} chars)`);
}
```

### Example Pre-existing Ref

**File:** `external-image.ref.json`

**Content:**
```json
{
  "url": "https://external-cdn.com/images/abc123.jpg",
  "type": "image/jpeg",
  "size": 123456,
  "filename": "external-image.jpg",
  "ocr": "This is the pre-extracted text from the image"
}
```

**Result:**
- Added to `refs[]` array
- No CDN registration (already has URL)
- No OCR processing (already has OCR text)
- Will be uploaded to IPFS during snapshot publishing

---

## CDN Service Architecture

### Service Binding Communication

The orchestrator communicates with the CDN service via **Cloudflare Service Bindings**, not HTTP URLs. This is worker-to-worker RPC.

```typescript
// Location: src/phases/discovery.ts:26
const cdnService = new CDNService(env.CDN, config);
```

**Service Binding in wrangler.jsonc:**
```json
{
  "services": [
    {
      "binding": "CDN",
      "service": "arke-cdn-worker"
    }
  ]
}
```

### CDN Service Class

```typescript
// Location: src/services/cdn-service.ts:30-64
export class CDNService {
  constructor(
    private cdnService: Fetcher,  // Service binding
    private config: Config
  ) {}

  /**
   * Register an asset with the CDN
   */
  async registerAsset(request: RegisterAssetRequest): Promise<RegisterAssetResponse> {
    const { assetId, ...body } = request;

    const response = await this.cdnService.fetch(`https://cdn/asset/${assetId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CDN registration error ${response.status}: ${error}`);
    }

    return await response.json();
  }

  /**
   * Get CDN URL for an asset ID
   */
  getCDNUrl(assetId: string): string {
    return `${this.config.CDN_PUBLIC_URL}/asset/${assetId}`;
  }
}
```

### Registration Modes

#### URL Mode (External Assets)

For assets hosted externally (IPFS, S3, other CDNs):

```typescript
// Location: src/services/cdn-service.ts:3-16
export interface RegisterAssetRequest {
  assetId: string;

  // URL mode (external URLs like IPFS, S3, etc.)
  url?: string;

  // R2 mode (for assets in ARCHIVE_BUCKET)
  r2_key?: string;
  bucket?: string;

  // Common fields
  content_type?: string;
  size_bytes?: number;
}
```

**Example Request:**
```typescript
await cdnService.registerAsset({
  assetId: "ABC123",
  url: "https://ipfs.io/ipfs/QmX...",
  content_type: "image/png",
  size_bytes: 54321
});
```

#### R2 Mode (Archive Bucket Assets)

For assets stored in the Arke archive bucket:

**Example Request:**
```typescript
await cdnService.registerAsset({
  assetId: "M2K9X7P4Q1W8Z",
  r2_key: "photo.jpg",
  bucket: "ARCHIVE_BUCKET"
});
```

### Response Schema

```typescript
// Location: src/services/cdn-service.ts:18-25
export interface RegisterAssetResponse {
  success: boolean;
  assetId: string;
  cdnUrl: string;
  storage_type?: "url" | "r2";
  sourceUrl?: string;  // Only for URL mode
  r2_key?: string;     // Only for R2 mode
}
```

---

## RefData Schema

The `RefData` interface defines the structure of reference files.

```typescript
// Location: src/types.ts:84-92
export interface RefData {
  url: string;                // CDN URL or external URL (REQUIRED)
  ipfs_cid?: string;          // IPFS CID of the binary asset (from original upload)
  type?: string;              // MIME type (optional, helpful for LLM context)
  size?: number;              // File size in bytes (optional, helpful for LLM context)
  filename?: string;          // Original filename without .ref.json (optional, helpful for LLM context)
  ocr?: string;               // Added during OCR phase
}
```

### Field Descriptions

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| `url` | ✅ Yes | CDN URL or external URL where the asset can be accessed | `"https://cdn.arke.institute/asset/M2K9..."` |
| `ipfs_cid` | ❌ No | Original IPFS CID from upload (preserved for provenance) | `"QmX5ZzBqN8vK3Lm9..."` |
| `type` | ❌ No | MIME type (helps LLM understand asset type) | `"image/jpeg"` |
| `size` | ❌ No | File size in bytes (helps LLM context) | `245678` |
| `filename` | ❌ No | Original filename (without `.ref.json` extension) | `"photo.jpg"` |
| `ocr` | ❌ No | OCR-extracted text (added during OCR phase) | `"Annual Report 2024"` |

### Lifecycle of RefData

**At Creation (Discovery Phase):**
```json
{
  "url": "https://cdn.arke.institute/asset/M2K9X7P4Q1W8Z",
  "ipfs_cid": "QmX5ZzBqN...",
  "type": "image/jpeg",
  "size": 245678,
  "filename": "photo.jpg"
}
```

**After OCR Phase:**
```json
{
  "url": "https://cdn.arke.institute/asset/M2K9X7P4Q1W8Z",
  "ipfs_cid": "QmX5ZzBqN...",
  "type": "image/jpeg",
  "size": 245678,
  "filename": "photo.jpg",
  "ocr": "Annual Report\n2024\nQ4 Financial Results\nRevenue: $5.2M"
}
```

---

## Code Walkthrough

### Complete Flow for Binary Asset

Here's the complete code path for processing a binary file:

```typescript
// Location: src/phases/discovery.ts:62-139

for (const file of dirGroup.files) {
  // ===== TEXT FILE HANDLING =====
  if (isTextExtension(file.file_name, config)) {
    nodes[dirPath].text_files.push({
      filename: file.file_name,
      staging_key: file.r2_key,
    });
    continue;
  }

  // ===== PRE-EXISTING REF HANDLING =====
  if (file.file_name.endsWith('.ref.json')) {
    try {
      // Read and parse ref file
      const refContent = await readFromStaging(env.STAGING_BUCKET, file.r2_key);
      const refData: RefData = JSON.parse(refContent);

      // Validate
      if (!refData.url) {
        console.warn(`[Discovery] ⚠ Invalid ref file ${file.file_name}: missing required field 'url'`);
        continue;
      }

      // Check for pre-existing OCR
      const hasPreExistingOCR = !!(refData.ocr && refData.ocr.trim().length > 0);

      nodes[dirPath].refs.push({
        filename: file.file_name,
        staging_key: file.r2_key,
        content: refData,
        ocr_complete: hasPreExistingOCR ? true : undefined,
      });

      if (hasPreExistingOCR) {
        console.log(`[Discovery] Found pre-existing OCR in ${file.file_name} (${refData.ocr!.length} chars)`);
      }
    } catch (error: any) {
      console.warn(`[Discovery] ⚠ Failed to parse ref file ${file.file_name}: ${error.message}`);
    }
    continue;
  }

  // ===== BINARY ASSET HANDLING =====

  // Step 1: Copy to archive bucket
  const archiveKey = `${file.file_name}`;
  await copyR2Object(env.STAGING_BUCKET, env.ARCHIVE_BUCKET, file.r2_key, archiveKey);

  // Step 2: Register with CDN (R2 mode)
  const assetId = generateAssetId();
  await cdnService.registerAsset({
    assetId,
    r2_key: archiveKey,
    bucket: 'ARCHIVE_BUCKET',
  });

  // Step 3: Create ref file in staging
  const refData: RefData = {
    url: `${config.CDN_PUBLIC_URL}/asset/${assetId}`,
    ...(file.cid && { ipfs_cid: file.cid }),
    type: file.content_type,
    size: file.file_size,
    filename: file.file_name,
  };
  const refFilename = `${file.file_name}.ref.json`;
  const refStagingKey = `${queueMessage.r2_prefix}${dirPath}/${refFilename}`.replace('//', '/');
  await writeToStaging(env.STAGING_BUCKET, refStagingKey, JSON.stringify(refData, null, 2));

  // Step 4: Add to refs array
  nodes[dirPath].refs.push({
    filename: refFilename,
    staging_key: refStagingKey,
    content: refData,
  });

  // Step 5: Delete original from staging
  await deleteFromStaging(env.STAGING_BUCKET, file.r2_key);
}
```

### Snapshot Publishing (How Refs Enter IPFS)

After all files are classified and processed, snapshots are published to IPFS.

```typescript
// Location: src/phases/discovery.ts:222-260

for (let i = 0; i < sortedDirs.length; i += batchSize) {
  const batch = sortedDirs.slice(i, i + batchSize);

  await Promise.all(batch.map(async (dirPath) => {
    const node = nodes[dirPath];

    if (node.snapshot_published) return;

    // Build components map
    const components: Record<string, string> = {};

    // Upload text files to IPFS
    for (const textFile of node.text_files) {
      const content = await readFromStaging(env.STAGING_BUCKET, textFile.staging_key);
      const cid = await ipfsClient.uploadContent(content);
      components[textFile.filename] = cid;  // "README.md" → "QmAbc..."
    }

    // Upload ref files (JSON) to IPFS
    for (const ref of node.refs) {
      const refJson = JSON.stringify(ref.content, null, 2);
      const cid = await ipfsClient.uploadContent(refJson);
      components[ref.filename] = cid;  // "photo.jpg.ref.json" → "QmXyz..."
    }

    // Create entity with initial snapshot (v1)
    const result = await ipfsClient.createEntity({
      components,         // All text files + all ref files
      children_pi: [],    // Start with empty children (added later)
      note: 'Initial snapshot',
    });

    // Update node with entity info
    node.pi = result.pi;
    node.current_tip = result.tip;
    node.current_version = result.ver;
    node.snapshot_published = true;

    publishedCount++;
    console.log(`[Discovery] Published v${result.ver} for ${dirPath} (${publishedCount}/${sortedDirs.length})`);
  }));
}
```

**Example Entity Components Map:**
```json
{
  "README.md": "QmAbc123...",
  "description.md": "QmDef456...",
  "photo.jpg.ref.json": "QmXyz789...",
  "document.pdf.ref.json": "QmGhi012..."
}
```

---

## Storage Architecture

### The Three Buckets

1. **STAGING_BUCKET** (Temporary)
   - Purpose: Holds files during upload and initial processing
   - Lifetime: Until discovery phase completes
   - Contents: User-uploaded files, generated .ref.json files

2. **ARCHIVE_BUCKET** (Permanent)
   - Purpose: Long-term storage for binary assets
   - Lifetime: Permanent
   - Contents: Original binary files (images, PDFs, etc.)

3. **IPFS** (Permanent, Distributed)
   - Purpose: Versioned entity graph with components
   - Lifetime: Permanent
   - Contents: Text files, ref JSON files, metadata

### Storage Flow Diagram

```
User Upload
    ↓
[STAGING_BUCKET]
staging/batch_123/dir/photo.jpg
    ↓
[Discovery Phase]
    ↓
Copy to Archive ──────────────┐
    ↓                         ↓
[ARCHIVE_BUCKET]         Delete from Staging
photo.jpg                     ↓
    ↓                    [STAGING_BUCKET]
Register with CDN        staging/batch_123/dir/photo.jpg (DELETED)
    ↓                         ↓
[CDN Service]            Create .ref.json
Maps: M2K9X7P4Q1 → photo.jpg  ↓
    ↓                    [STAGING_BUCKET]
Public URL Created       staging/batch_123/dir/photo.jpg.ref.json
https://cdn.arke.institute/asset/M2K9X7P4Q1
    ↓
[Snapshot Publishing]
    ↓
Upload ref JSON to IPFS
    ↓
[IPFS]
QmXyz789... (ref JSON content)
    ↓
[Entity Created]
{
  "components": {
    "photo.jpg.ref.json": "QmXyz789..."
  }
}
```

### File Locations at Each Stage

| Stage | Staging Bucket | Archive Bucket | IPFS | CDN |
|-------|---------------|----------------|------|-----|
| **After Upload** | ✅ `photo.jpg` | ❌ | ❌ | ❌ |
| **After CDN Registration** | ✅ `photo.jpg.ref.json` | ✅ `photo.jpg` | ❌ | ✅ Asset registered |
| **After Snapshot Publishing** | ✅ `photo.jpg.ref.json` | ✅ `photo.jpg` | ✅ Ref JSON | ✅ Asset registered |
| **After Batch Complete** | ✅ `photo.jpg.ref.json` | ✅ `photo.jpg` | ✅ Ref JSON + Entity | ✅ Asset accessible |

---

## IPFS CID Preservation

One important feature is **IPFS CID preservation** from the original upload.

### Why Preserve CIDs?

- **Provenance**: Track the original IPFS upload
- **Deduplication**: Multiple uploads of the same file can reference the same CID
- **Verification**: Users can verify file integrity using the original CID

### How It Works

#### 1. Ingest Worker Provides CID

When files are uploaded to the ingest worker, it may provide an IPFS CID:

```typescript
// Queue message from arke-ingest-worker
{
  "files": [
    {
      "r2_key": "staging/batch_123/photo.jpg",
      "file_name": "photo.jpg",
      "cid": "QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7Jh8Fg6Dc5Ab1Mn3Kp9Xy4"  // ← Original IPFS CID
    }
  ]
}
```

#### 2. Orchestrator Preserves CID in Ref

```typescript
// Location: src/phases/discovery.ts:119-125
const refData: RefData = {
  url: `${config.CDN_PUBLIC_URL}/asset/${assetId}`,
  ...(file.cid && { ipfs_cid: file.cid }),  // ← Conditional spread
  type: file.content_type,
  size: file.file_size,
  filename: file.file_name,
};
```

**Generated .ref.json:**
```json
{
  "url": "https://cdn.arke.institute/asset/M2K9X7P4Q1W8Z",
  "ipfs_cid": "QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7Jh8Fg6Dc5Ab1Mn3Kp9Xy4",
  "type": "image/jpeg",
  "size": 245678,
  "filename": "photo.jpg"
}
```

#### 3. CID Available in IPFS Entity

When the ref is uploaded to IPFS, the original CID is preserved:

```json
{
  "components": {
    "photo.jpg.ref.json": "QmNewCID123..."  ← New CID for the ref JSON
  }
}
```

**Content at QmNewCID123...:**
```json
{
  "url": "https://cdn.arke.institute/asset/M2K9X7P4Q1W8Z",
  "ipfs_cid": "QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7Jh8Fg6Dc5Ab1Mn3Kp9Xy4",  ← Original CID preserved
  "type": "image/jpeg"
}
```

### Verification Flow

Users can verify the file using the original CID:

```bash
# Fetch from CDN
curl https://cdn.arke.institute/asset/M2K9X7P4Q1W8Z > downloaded.jpg

# Fetch from IPFS using original CID
curl https://ipfs.io/ipfs/QmX5ZzBqN8vK3Lm9Rt4Yw2Pq7Jh8Fg6Dc5Ab1Mn3Kp9Xy4 > original.jpg

# Compare
diff downloaded.jpg original.jpg  # Should be identical
```

---

## Summary

### Key Takeaways

1. **CDN registration happens during Discovery (Phase 0)** - synchronously before alarm-based processing
2. **Binary files are converted to refs** - stored in ARCHIVE_BUCKET, referenced via CDN URLs
3. **Two types of refs**: Auto-generated (from binaries) and pre-existing (.ref.json uploads)
4. **Service bindings, not HTTP** - CDN communication uses Cloudflare worker-to-worker RPC
5. **IPFS CID preservation** - Original IPFS CIDs are maintained in ref metadata
6. **Refs are IPFS components** - Ref JSON files are uploaded to IPFS and included in entity manifests

### Benefits of This Architecture

- **Efficient storage**: Large binaries in R2, lightweight refs in IPFS
- **Fast access**: CDN delivery for binary assets
- **Versioning**: Ref JSON versioned with each entity update
- **Provenance**: Original IPFS CIDs preserved for verification
- **Flexibility**: Supports both R2-hosted and external assets

### Configuration

Key environment variables (from `wrangler.jsonc`):

```json
{
  "vars": {
    "CDN_PUBLIC_URL": "https://cdn.arke.institute"
  },
  "r2_buckets": [
    { "binding": "STAGING_BUCKET", "bucket_name": "arke-staging" },
    { "binding": "ARCHIVE_BUCKET", "bucket_name": "arke-archive" }
  ],
  "services": [
    { "binding": "CDN", "service": "arke-cdn-worker" }
  ]
}
```

---

## References

- **Discovery Phase**: `src/phases/discovery.ts`
- **CDN Service**: `src/services/cdn-service.ts`
- **Type Definitions**: `src/types.ts`
- **Configuration**: `wrangler.jsonc`
- **IPFS Wrapper**: `src/services/ipfs-wrapper.ts`
