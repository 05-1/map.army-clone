// Owner entry point. Before the editor opens it walks through whatever is still missing:
// config.js, the database schema, an owner account. After setup none of these screens appear again.
import type { Session } from '@supabase/supabase-js';
import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { backend, type Who } from './editor/backend';
import { Editor } from './editor/Editor';
import { anonymousSignInsEnabled, checkApp, SCHEMA_VERSION, supabase, SUPABASE_URL, type AppStatus } from './lib/supabase';
import './styles.css';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="splash">
      <div className="login setup">
        <div className="brand">TACMAP</div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** First-run checklist: what is in place and what still needs a click. */
function Checks({ status, claimed }: { status: Extract<AppStatus, { s: 'ok' }>; claimed: boolean }) {
  const [anon, setAnon] = useState<boolean | null | undefined>(undefined);
  useEffect(() => {
    void anonymousSignInsEnabled().then(setAnon);
  }, []);
  const row = (ok: boolean | null, label: string, fix?: string) => (
    <li className={ok === null ? '' : ok ? 'ok' : 'bad'}>
      <span>{ok === null ? '…' : ok ? '✓' : '✗'}</span>
      <div>{label}{!ok && fix && <small>{fix}</small>}</div>
    </li>
  );
  return (
    <ul className="checks">
      {row(true, `Connected to ${SUPABASE_URL?.replace('https://', '')}`)}
      {row(true, `Database schema version ${status.schema}`)}
      {row(anon === undefined ? null : anon, anon === null ? 'Anonymous sign-ins: could not be checked' : 'Anonymous sign-ins (needed for players)',
        'In Supabase: Authentication > Sign In / Providers > turn on "Allow anonymous sign-ins". Then reload this page.')}
      {row(claimed, claimed ? 'Owner account claimed' : 'Owner account: not claimed yet', 'Create an account below, then claim ownership.')}
    </ul>
  );
}

function Login({ status }: { status: Extract<AppStatus, { s: 'ok' }> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent, signUp = false) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    const { error, data } = signUp
      ? await supabase!.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
      : await supabase!.auth.signInWithPassword({ email, password });
    if (error) setMsg(error.message);
    else if (signUp && !data.session) setMsg('Check your inbox to confirm your address, then sign in here.');
    setBusy(false);
  }

  return (
    <Card title={status.claimed ? 'Sign in' : 'First run: create the owner account'}>
      {!status.claimed && <Checks status={status} claimed={false} />}
      <form onSubmit={(e) => void submit(e)}>
        <label className="field wide">
          <span>Email</span>
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field wide">
          <span>Password</span>
          <input type="password" required minLength={8} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {msg && <p className="note">{msg}</p>}
        <button className="btn primary" disabled={busy}>Sign in</button>
        <button type="button" className="btn" disabled={busy || !email || password.length < 8} onClick={(e) => void submit(e, true)}>
          Create account
        </button>
        {status.claimed && (
          <button
            type="button" className="btn sm" disabled={busy || !email.includes('@')} title="Type your email above first"
            onClick={() => {
              setBusy(true);
              // Supabase mails a link that comes back to this page, which then asks for the new password.
              void supabase!.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(({ error }) => {
                setMsg(error ? error.message : 'If that address has an account, a reset link is on its way. Open it on this device.');
                setBusy(false);
              });
            }}
          >
            Forgot password
          </button>
        )}
      </form>
      {status.claimed && <p className="tip">Players and viewers do not sign in here. They use the links you send them.</p>}
    </Card>
  );
}

/** Shown after following a password-reset link: the session is valid, the password is not chosen yet. */
function NewPassword({ onDone }: { onDone(): void }) {
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Choose a new password">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void supabase!.auth.updateUser({ password }).then(({ error }) => (error ? (setMsg(error.message), setBusy(false)) : onDone()));
        }}
      >
        <label className="field wide">
          <span>New password (8 characters or more)</span>
          <input type="password" required minLength={8} autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {msg && <p className="note bad">{msg}</p>}
        <button className="btn primary" disabled={busy || password.length < 8}>Save password</button>
      </form>
    </Card>
  );
}

function Gate({ status, session }: { status: Extract<AppStatus, { s: 'ok' }>; session: Session }) {
  const [who, setWho] = useState<Who | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signOut = () => void supabase!.auth.signOut();

  useEffect(() => {
    (async () => {
      let w = await backend!.whoami();
      // A co-admin invited by email becomes an admin the first time they sign in.
      if (!w.is_admin && (await backend!.acceptAdminInvite())) w = await backend!.whoami();
      setWho(w);
    })().catch((e) => setError((e as Error).message));
  }, [session.user.id]);

  if (error) return <Card title="Could not check this account"><p className="note bad">{error}</p><button type="button" className="btn" onClick={signOut}>Sign out</button></Card>;
  if (!who) return <div className="splash">Loading…</div>;
  if (who.is_admin) return <Editor key={session.user.id} backend={backend!} who={who} onSignOut={signOut} />;

  if (!who.claimed) {
    return (
      <Card title="First run: claim ownership">
        <Checks status={status} claimed={false} />
        <p className="tip">
          Signed in as <strong>{who.email}</strong>. The first account to claim becomes the owner. After that this
          screen is gone for good, and further admins are added from Manage &gt; Settings.
        </p>
        <button
          type="button" className="btn primary" disabled={busy}
          onClick={() => {
            setBusy(true);
            backend!.claimOwner().then(() => location.reload(), (e) => (setError((e as Error).message), setBusy(false)));
          }}
        >
          Claim ownership of this installation
        </button>
        <button type="button" className="btn" onClick={signOut}>Use a different account</button>
      </Card>
    );
  }
  return (
    <Card title="This account is not an admin">
      <p className="note">
        {who.email} is signed in but has no access. If the owner invited you, sign up with exactly the invited address and
        confirm it. If you are a player, use the invite link you were sent instead of this page.
      </p>
      <button type="button" className="btn" onClick={signOut}>Sign out</button>
    </Card>
  );
}

function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    void checkApp().then(setStatus);
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((e, s) => {
      if (e === 'PASSWORD_RECOVERY') setRecovering(true);
      setSession(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!status) return <div className="splash">Connecting…</div>;
  if (status.s === 'no-config') {
    return (
      <Card title="Setup: connect your Supabase project">
        <p className="note">
          This site does not know which Supabase project to use yet. In your GitHub repository, open <code>config.js</code>,
          click the pencil, and paste your project URL and anon (publishable) key. Commit, wait about a minute, reload.
        </p>
        <p className="tip">Both values are in Supabase under Project Settings &gt; API. The anon key is meant to be public; the service-role key is not and is never needed here.</p>
      </Card>
    );
  }
  if (status.s === 'unreachable') {
    return (
      <Card title="Cannot reach Supabase">
        <p className="note bad">{status.detail}</p>
        <p className="note">
          Check the URL and key in <code>config.js</code>. If this used to work, the project is probably paused: free
          projects pause after about a week without activity. Open supabase.com, pick the project and click
          "Restore project". It is back within a few minutes with all data.
        </p>
        <button type="button" className="btn" onClick={() => location.reload()}>Try again</button>
      </Card>
    );
  }
  if (status.s === 'no-schema' || status.schema < SCHEMA_VERSION) {
    return (
      <Card title={status.s === 'no-schema' ? 'Setup: create the database' : 'The database needs an upgrade'}>
        <p className="note">
          {status.s === 'no-schema'
            ? 'Connected to Supabase, but the tables are not there yet.'
            : `The database is on schema version ${status.schema}; this version of the site needs ${SCHEMA_VERSION}.`}{' '}
          Open <code>setup.sql</code> from the release folder, copy all of it, paste it into Supabase &gt; SQL Editor and click Run.
          It is safe to run on an existing installation: data is kept.
        </p>
        <button type="button" className="btn primary" onClick={() => location.reload()}>Done, check again</button>
      </Card>
    );
  }
  if (status.schema > SCHEMA_VERSION) {
    return (
      <Card title="This site is older than its database">
        <p className="note">The database is on schema version {status.schema}, this copy of the site expects {SCHEMA_VERSION}. Upload the newer release folder to GitHub.</p>
      </Card>
    );
  }
  if (session === undefined) return <div className="splash">Loading…</div>;
  if (!session || session.user.is_anonymous) return <Login status={status} />;
  if (recovering) return <NewPassword onDone={() => setRecovering(false)} />;
  return <Gate status={status} session={session} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
