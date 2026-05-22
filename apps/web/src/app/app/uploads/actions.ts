'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { apiClient, ApiError } from '@/lib/api';

export interface UploadActionState {
  error?: string;
  lastUploadId?: string;
  lastExtractionId?: string;
}

export async function uploadAndExtractAction(
  _prev: UploadActionState,
  formData: FormData,
): Promise<UploadActionState> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'pick a file first' };
  }

  const client = await apiClient();
  let uploadId: string;

  try {
    const uploadForm = new FormData();
    uploadForm.append('file', file);
    const upload = await client.postMultipart<{ id: string }>('/uploads', uploadForm);
    uploadId = upload.id;
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: friendlyApiError(err.status, err.body) };
    }
    return { error: 'network error while uploading' };
  }

  let extractionId: string;
  try {
    const extraction = await client.post<{ id: string; status: string }>(
      '/extractions',
      { uploadId },
      `extract-${randomUUID()}`,
    );
    extractionId = extraction.id;
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        lastUploadId: uploadId,
        error: friendlyApiError(err.status, err.body),
      };
    }
    return { lastUploadId: uploadId, error: 'network error during extraction' };
  }

  revalidatePath('/app/uploads');
  return { lastUploadId: uploadId, lastExtractionId: extractionId };
}

function friendlyApiError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    if (parsed.error === 'upload_too_large') return 'file is too large (5 MB max)';
    if (parsed.error === 'unsupported_mime_type') return 'use png, jpeg, or webp';
    return parsed.message ?? `api error ${status}`;
  } catch {
    return `api error ${status}`;
  }
}
