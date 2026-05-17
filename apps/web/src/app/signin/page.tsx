import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { SignInForm } from './form';

export const metadata = {
  title: 'Sign in - Vellum',
};

export default async function SignInPage() {
  const session = await auth();
  if (session) redirect('/app');

  return (
    <main className="auth-page">
      <h1>Sign in</h1>
      <p className="muted">
        Vellum is pre-alpha. Accounts created today exist on this instance only and may be wiped
        before the first stable release.
      </p>
      <SignInForm />
    </main>
  );
}
