'use client';

import { useActionState } from 'react';
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
          Extracted. Upload <code>{state.lastUploadId?.slice(0, 8)}</code>, extraction{' '}
          <code>{state.lastExtractionId.slice(0, 8)}</code>. The receipt-review UI lands in a
          follow-up; for now the extraction row is in the database with the parsed receipt jsonb.
        </p>
      ) : null}
    </form>
  );
}
