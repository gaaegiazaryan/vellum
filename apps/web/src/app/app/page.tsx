import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export const metadata = {
  title: 'Vellum',
};

export default async function AppHome() {
  const session = await auth();
  if (!session) redirect('/signin');

  return (
    <main className="auth-page">
      <h1>Welcome back</h1>
      <p>Signed in as {session.user?.email ?? 'unknown'}.</p>
      <p className="muted">
        The product surface lands here as it gets built. Today this page exists so the sign-in flow
        has somewhere to send you.
      </p>
    </main>
  );
}
