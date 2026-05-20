import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { UploadForm } from './form';

export const metadata = {
  title: 'Uploads - Vellum',
};

export default async function UploadsPage() {
  const session = await auth();
  if (!session) redirect('/signin');

  return (
    <main className="ledger">
      <header className="ledger-header">
        <h1>Receipt uploads</h1>
        <p className="muted">
          Upload a receipt image; Vellum extracts the structured shape and shows it back so you can
          review before creating a journal entry. <Link href="/app">back to ledger</Link>
        </p>
      </header>
      <UploadForm />
      <p className="muted">
        Allowed: PNG, JPEG, WebP. Max 5 MB. PDF support lands when the upstream chunking story is
        documented.
      </p>
    </main>
  );
}
