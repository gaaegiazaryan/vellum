'use client';

import { useActionState, useState } from 'react';
import { signinAction, signupAction, type ActionState } from './actions';

const INITIAL: ActionState = {};

export function SignInForm() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const action = mode === 'signin' ? signinAction : signupAction;
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className="auth-form">
      <div className="auth-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signin'}
          className={mode === 'signin' ? 'active' : ''}
          onClick={() => setMode('signin')}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signup'}
          className={mode === 'signup' ? 'active' : ''}
          onClick={() => setMode('signup')}
        >
          Create account
        </button>
      </div>

      {mode === 'signup' ? (
        <label>
          <span>Name (optional)</span>
          <input name="name" type="text" autoComplete="name" maxLength={120} />
        </label>
      ) : null}

      <label>
        <span>Email</span>
        <input
          name="email"
          type="email"
          required
          autoComplete={mode === 'signin' ? 'email' : 'email'}
        />
      </label>

      <label>
        <span>Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
        />
      </label>

      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <button type="submit" disabled={pending}>
        {pending ? 'Working...' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>
    </form>
  );
}
