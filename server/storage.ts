// Object storage for uploaded files and their extracted text. Postgres keeps only the keys.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface Storage {
  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Short-lived direct download URL, or undefined when the API must stream the file itself. */
  signedUrl(key: string, filename: string, contentType: string): Promise<string | undefined>;
}

function localStorage(root: string): Storage {
  const path = (key: string) => {
    const p = resolve(root, key);
    if (!p.startsWith(root + sep)) throw new Error('storage key escapes the storage root');
    return p;
  };
  return {
    async put(key, body) {
      await mkdir(dirname(path(key)), { recursive: true });
      await writeFile(path(key), body);
    },
    get: (key) => readFile(path(key)),
    delete: (key) => rm(path(key), { force: true }),
    signedUrl: async () => undefined, // the API streams local files behind the session check
  };
}

async function s3Storage(): Promise<Storage> {
  // Loaded only when configured: the SDK is large.
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const Bucket = process.env.S3_BUCKET;
  if (!Bucket) throw new Error('S3_BUCKET must be set when STORAGE_DRIVER=s3');
  const s3 = new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined, // R2, MinIO, Tigris, ...
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
  });
  return {
    async put(Key, Body, ContentType) {
      await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType, ServerSideEncryption: process.env.S3_ENDPOINT ? undefined : 'AES256' }));
    },
    async get(Key) {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
    async delete(Key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    },
    signedUrl: (Key, filename, ContentType) => getSignedUrl(s3, new GetObjectCommand({
      Bucket, Key, ResponseContentType: ContentType,
      ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    }), { expiresIn: 300 }),
  };
}

export const storageDriver = process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local';
export const storage: Storage = storageDriver === 's3'
  ? await s3Storage()
  : localStorage(resolve(process.env.STORAGE_DIR ?? 'data/uploads'));
