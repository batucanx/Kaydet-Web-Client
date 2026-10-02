import { AppError } from '../../application/index.ts';
import type { BlobStorage, StoredBlob } from '../../application/index.ts';

/** Non-durable blob store for tests/development. Enforces the size limit while consuming the stream. */
export class MemoryBlobStorage implements BlobStorage {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, data: AsyncIterable<Uint8Array>, options: { readonly maxBytes: number }): Promise<{ sizeBytes: number }> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of data) {
      size += chunk.byteLength;
      if (size > options.maxBytes) throw new AppError('attachment_too_large'); // stop reading immediately
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.blobs.set(key, bytes);
    return { sizeBytes: size };
  }

  open(key: string): Promise<StoredBlob | null> {
    const bytes = this.blobs.get(key);
    if (bytes === undefined) return Promise.resolve(null);
    return Promise.resolve({
      sizeBytes: bytes.byteLength,
      stream: (async function* () {
        yield bytes;
      })(),
    });
  }

  remove(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }
}
