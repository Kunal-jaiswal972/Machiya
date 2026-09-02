import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Object storage, consumer side. The worker is the only process that reads image
 * bytes, and the only one with any reason to touch the private `originals/`
 * prefix.
 */
const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

const BUCKET = env.S3_BUCKET;

export async function getObjectBytes(objectKey: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: objectKey }));

  if (!result.Body) {
    throw new Error(`Object has no body: ${objectKey}`);
  }

  return Buffer.from(await result.Body.transformToByteArray());
}

export async function putObjectBytes(input: {
  objectKey: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: input.objectKey,
      Body: input.body,
      ContentType: input.contentType,
      // Variant keys derive from an immutable image id, so they are never
      // rewritten with different bytes.
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
}

export async function deleteObjects(objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;

  try {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: objectKeys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  } catch (error) {
    logger.warn({ err: error, count: objectKeys.length }, 'failed to delete objects');
  }
}

export interface StoredObject {
  key: string;
  lastModified?: Date;
}

/** Lists keys under a prefix, for the orphan sweep. */
export async function listObjectKeys(prefix: string): Promise<StoredObject[]> {
  const keys: StoredObject[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );

    for (const object of page.Contents ?? []) {
      if (object.Key) {
        keys.push({
          key: object.Key,
          ...(object.LastModified ? { lastModified: object.LastModified } : {}),
        });
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}
