import { useState, type FormEvent } from 'react';
import { accessToken, api } from './session.js';

/** Sign in, or create an account and sign in. */
export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent, register: boolean) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (register) await api('POST', '/api/auth/register', { email, password, displayName });
      const login = await api<{ accessToken: string }>('POST', '/api/auth/login', {
        email,
        password,
      });
      accessToken.set(login.accessToken);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, value: string, set: (v: string) => void, type = 'text') => (
    <p>
      <input
        aria-label={label}
        placeholder={label}
        type={type}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </p>
  );
  return (
    <form onSubmit={(e) => void submit(e, false)}>
      <h2>Sign in</h2>
      {field('Email', email, setEmail, 'email')}
      {field('Password', password, setPassword, 'password')}
      {field('Display name (new accounts)', displayName, setDisplayName)}
      <button type="submit" disabled={busy}>
        Sign in
      </button>{' '}
      <button
        type="button"
        disabled={busy || !displayName.trim()}
        onClick={(e) => void submit(e, true)}
      >
        Create account
      </button>
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
    </form>
  );
}
