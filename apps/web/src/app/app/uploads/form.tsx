'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { uploadAndExtractAction, type UploadActionState } from './actions';

const INITIAL: UploadActionState = {};

export function UploadForm() {
  const [state, formAction, pending] = useActionState(uploadAndExtractAction, INITIAL);

  return (
    <form action={formAction} className="upload-form" encType="multipart/form-data">
      <label>
        <span>Receipt image</span>
        <input name="file" type="file" accept="image/png,image/jpeg,image/webp" required />
      </label>

      <button type="submit" disabled={pending}>
        {pending ? 'Uploading and extracting...' : 'Upload and extract'}
      </button>

      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      {state.lastExtractionId ? (
        <p className="muted">
          Extracted from upload <code>{state.lastUploadId?.slice(0, 8)}</code>.{' '}
          <Link href={`/app/extractions/${state.lastExtractionId}`}>review and confirm</Link> to
          turn it into a journal entry.
        </p>
      ) : null}
    </form>
  );
}
