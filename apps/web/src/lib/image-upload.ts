import { MAX_IMAGE_BYTES, UPLOADABLE_IMAGE_TYPES, type ImageUploadTicket } from '@machiya/shared';

/**
 * The parts of a photo upload that happen entirely in the browser.
 *
 * No `apiFetch` and no schemas here on purpose — the network layer is TanStack
 * Query in `use-listing-images`, and the shapes it parses live in
 * `lib/listing-schemas`. What is left is the two things neither of those can
 * do: shrink a photo before it leaves the machine, and POST it straight to
 * object storage with a progress bar.
 */

/**
 * Longest edge a browser upload is reduced to before it leaves the machine.
 *
 * The worker derives everything from this and the largest variant is well under
 * it, so a bigger original buys nothing but upload time — and on a mobile
 * connection a 6 MB phone photo is the difference between an upload that
 * finishes and one that is abandoned. The worker still validates and re-derives
 * whatever arrives: compression here is a courtesy, never a substitute for the
 * magic-byte checks in D37.
 */
const MAX_UPLOAD_EDGE = 2400;
const JPEG_QUALITY = 0.85;

/** Below this, shrinking costs more than it saves. */
const COMPRESS_ABOVE_BYTES = 1_500_000;

/**
 * Shrinks an oversized photo, and leaves everything else alone.
 *
 * Returns the original untouched when it is already small enough, when the
 * format is one the canvas cannot safely re-encode (HEIC), or when anything at
 * all goes wrong — a failed compression must degrade to "upload the original",
 * never to "your photo did not upload".
 */
export async function compressForUpload(file: File): Promise<File> {
  const canvasSafe = file.type === 'image/jpeg' || file.type === 'image/png';
  if (file.size < COMPRESS_ABOVE_BYTES || !canvasSafe) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height));

    if (scale >= 1 && file.size <= MAX_IMAGE_BYTES) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext('2d');
    if (!context) return file;

    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
    });

    if (!blob || blob.size >= file.size) return file;

    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export function isUploadableType(type: string): boolean {
  return (UPLOADABLE_IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * The direct browser-to-storage POST, with progress.
 *
 * XHR rather than fetch purely because fetch cannot report upload progress, and
 * a twelve-megabyte photo with no progress bar reads as a hung page. The
 * request never touches the API: the presigned policy is what bounds the size
 * and the content type, and the storage service refuses anything outside it
 * before a byte reaches us (D36).
 */
export function putToStorage(
  ticket: ImageUploadTicket,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.fields)) form.append(key, value);
    // The file must be last: a POST policy ignores everything after it.
    form.append('file', file);

    const request = new XMLHttpRequest();
    request.open('POST', ticket.uploadUrl);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve();
        return;
      }

      reject(
        new Error(
          request.status === 400
            ? 'Storage refused that file — it is too large or the wrong type'
            : `Upload failed with status ${String(request.status)}`,
        ),
      );
    });

    request.addEventListener('error', () => {
      reject(new Error('Upload failed — check your connection'));
    });

    request.send(form);
  });
}
