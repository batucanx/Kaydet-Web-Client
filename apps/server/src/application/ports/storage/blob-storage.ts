/**
 * Attachment/blob storage boundary. Metadata lives in the repositories; bytes live here, addressed by an opaque
 * key. Use cases never know whether that is local disk, object storage or an encrypted store, and no storage
 * location is ever exposed to the browser.
 *
 * Streams are `AsyncIterable<Uint8Array>` (no Node types in the application layer). Uploads are validated while
 * streaming: `put` must stop reading and throw `attachment_too_large` as soon as `maxBytes` is exceeded.
 *
 * Phase 3 defines the port only (plus a memory adapter for tests); real storage and the upload flow are later.
 */
export interface StoredBlob {
  readonly stream: AsyncIterable<Uint8Array>;
  readonly sizeBytes: number;
}

export interface BlobStorage {
  put(key: string, data: AsyncIterable<Uint8Array>, options: { readonly maxBytes: number }): Promise<{ readonly sizeBytes: number }>;
  /** `null` when there is no blob under the key. */
  open(key: string): Promise<StoredBlob | null>;
  remove(key: string): Promise<void>;
}
