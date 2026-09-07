import { useState } from 'react';
import { login } from './api.js';

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await login(email.trim(), password));
    } catch (err) {
      // One message for both failures, matching the API: an unknown address must
      // not be distinguishable from a wrong password (apps/api/auth.js).
      setError(err.message ?? 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Nirikshan</h1>
        <p className="mt-1 text-sm text-dim">Verifiable inspection &amp; monitoring</p>

        <label className="mt-8 block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded border border-line bg-card px-3 py-2 outline-none focus:border-ink"
        />

        <label className="mt-4 block text-sm font-medium" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-line bg-card px-3 py-2 outline-none focus:border-ink"
        />

        {error && (
          <p role="alert" className="mt-4 text-sm text-bad">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded bg-ink px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="mt-6 text-sm text-dim">
          Verifying a draw needs no account —{' '}
          <a className="underline" href="/verify.html">
            open the public verification page
          </a>
          .
        </p>
      </form>
    </main>
  );
}
