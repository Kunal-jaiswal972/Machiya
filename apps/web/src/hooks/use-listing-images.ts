import { MAX_IMAGES_PER_LISTING } from '@machiya/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { apiFetch } from '../lib/api';
import { compressForUpload, isUploadableType, putToStorage } from '../lib/image-upload';
import {
  imageDeletedSchema,
  imageOrderResponseSchema,
  imageTicketResponseSchema,
  imageUploadedResponseSchema,
} from '../lib/listing-schemas';
import { draftKey } from './use-listing-draft';

export interface PendingUpload {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/**
 * Photo upload, reorder and delete for one draft.
 *
 * The upload is three steps and only two of them are ours: ask the API for a
 * presigned ticket, POST the bytes straight to storage, then tell the API they
 * landed. The API reads no bytes at any point (D34).
 *
 * Reorder and delete are plain mutations that invalidate the draft, because
 * both are metadata-only and never re-run derivation (D41).
 */
export function useListingImages(listingId: string | undefined, currentCount: number) {
  const queryClient = useQueryClient();
  const [uploads, setUploads] = useState<PendingUpload[]>([]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: draftKey(listingId) });
  }, [listingId, queryClient]);

  const uploadOne = useMutation({
    mutationFn: async ({ file, key }: { file: File; key: string }) => {
      const prepared = await compressForUpload(file);

      const { ticket } = await apiFetch(
        `/api/listings/${listingId!}/images`,
        imageTicketResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ contentType: prepared.type, byteSize: prepared.size }),
        },
      );

      await putToStorage(ticket, prepared, (fraction) => {
        setUploads((current) =>
          current.map((entry) => (entry.key === key ? { ...entry, progress: fraction } : entry)),
        );
      });

      const { image } = await apiFetch(
        `/api/listings/${listingId!}/images/${ticket.imageId}/uploaded`,
        imageUploadedResponseSchema,
        { method: 'POST' },
      );

      return image;
    },
    onSettled: invalidate,
  });

  const reorder = useMutation({
    mutationFn: async (imageIds: string[]) => {
      const { images } = await apiFetch(
        `/api/listings/${listingId!}/images/order`,
        imageOrderResponseSchema,
        { method: 'PATCH', body: JSON.stringify({ imageIds }) },
      );
      return images;
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (imageId: string) =>
      apiFetch(`/api/listings/${listingId!}/images/${imageId}`, imageDeletedSchema, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });

  /**
   * Uploads a batch, one at a time.
   *
   * In series rather than in parallel: a dozen concurrent multipart POSTs from
   * a phone starve each other, and the per-file progress bars become useless
   * because they all crawl together.
   */
  const upload = useCallback(
    async (files: File[]): Promise<{ rejected: string[]; overflow: boolean }> => {
      const room = MAX_IMAGES_PER_LISTING - currentCount - uploads.length;
      const rejected: string[] = [];

      if (room <= 0) return { rejected, overflow: true };

      const accepted: File[] = [];
      for (const file of files.slice(0, room)) {
        if (isUploadableType(file.type)) accepted.push(file);
        else rejected.push(file.name);
      }

      for (const file of accepted) {
        const key = `${file.name}-${String(file.size)}-${String(performance.now())}`;
        setUploads((current) => [...current, { key, name: file.name, progress: 0 }]);

        try {
          await uploadOne.mutateAsync({ file, key });
          setUploads((current) => current.filter((entry) => entry.key !== key));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Upload failed';
          setUploads((current) =>
            current.map((entry) => (entry.key === key ? { ...entry, error: message } : entry)),
          );
        }
      }

      return { rejected, overflow: files.length > room };
    },
    [currentCount, uploadOne, uploads.length],
  );

  const dismissUpload = useCallback((key: string) => {
    setUploads((current) => current.filter((entry) => entry.key !== key));
  }, []);

  return {
    uploads,
    upload,
    dismissUpload,
    reorder: reorder.mutateAsync,
    remove: remove.mutateAsync,
    invalidate,
  };
}
