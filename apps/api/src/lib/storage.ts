import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_IMAGE_BYTES } from '@machiya/shared';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Object storage, producer side. MinIO in development, Cloudflare R2 in
 * production — same code, different endpoint.
 *
 * The API signs upload URLs, checks that an object exists, and deletes objects.
 * It never READS image bytes: derivation is the worker's job.
 */
export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

export const BUCKET = env.S3_BUCKET;

/** Long enough for a slow phone on a bad connection to finish a 12 MB upload. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Only the variants prefix is publicly readable, so only it gets a URL. */
export function publicVariantUrl(objectKey: string): string {
  return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${objectKey}`;
}

export interface UploadTicket {
  uploadUrl: string;
  fields: Record<string, string>;
  requiredHeaders: Record<string, string>;
}

/**
 * Presigned POST so the browser uploads straight to storage, with the size and
 * type limits enforced by the STORAGE SERVICE rather than by trust.
 *
 * A presigned PUT cannot bound the body length — the client could stream a
 * gigabyte to a 12 MB-labelled ticket. A POST policy carries a
 * content-length-range condition, so an oversized or wrong-typed upload is
 * rejected at MinIO before a byte reaches us. The worker still re-checks the
 * real magic bytes: this stops abuse, not lies. See DECISIONS.md D36.
 */
export async function createUploadTicket(input: {
  objectKey: string;
  contentType: string;
}): Promise<UploadTicket> {
  const { createPresignedPost } = await import('@aws-sdk/s3-presigned-post');

  const presigned = await createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: input.objectKey,
    Conditions: [
      ['content-length-range', 1, MAX_IMAGE_BYTES],
      ['eq', '$Content-Type', input.contentType],
    ],
    Fields: { 'Content-Type': input.contentType },
    Expires: UPLOAD_URL_TTL_SECONDS,
  });

  return {
    uploadUrl: presigned.url,
    fields: presigned.fields,
    requiredHeaders: {},
  };
}

/** Fallback signer for clients that can only do a plain PUT. */
export async function createUploadUrl(input: {
  objectKey: string;
  contentType: string;
}): Promise<{ uploadUrl: string; requiredHeaders: Record<string, string> }> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: input.objectKey,
    ContentType: input.contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
  return { uploadUrl, requiredHeaders: { 'content-type': input.contentType } };
}

export interface ObjectHead {
  exists: boolean;
  byteSize?: number;
  contentType?: string;
}

/**
 * Confirms an upload actually landed, without reading it.
 *
 * This is how the API knows a client's "I uploaded it" is true before it queues
 * work — a HEAD costs nothing and stops the queue filling with jobs for objects
 * that never arrived.
 */
export async function headObject(objectKey: string): Promise<ObjectHead> {
  try {
    const result = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: objectKey }));
    return {
      exists: true,
      ...(result.ContentLength !== undefined ? { byteSize: result.ContentLength } : {}),
      ...(result.ContentType ? { contentType: result.ContentType } : {}),
    };
  } catch {
    return { exists: false };
  }
}

export async function deleteObject(objectKey: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: objectKey }));
  } catch (error) {
    logger.warn({ err: error, objectKey }, 'failed to delete object');
  }
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
