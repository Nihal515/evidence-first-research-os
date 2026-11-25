// Sign-in with Neon Auth through our own domain (/api/auth → Neon Auth), so the
// session cookie is first-party and survives Safari's third-party cookie blocking.
// The API is called with Neon Auth's short-lived JWT, which the server verifies.

export interface Account {
  id: string;
  email: string;
  name: string;
  email_verified: boolean;
}

// The Neon Auth SDK (default Better Auth vanilla adapter) is loaded only when needed:
// guests never download it. Typed loosely because the SDK's union of adapter types
// hides the Better Auth methods (signIn.email, signUp.email) from TypeScript.
let client: Promise<any> | null = null;
function authClient(): Promise<any> {
  if (!client) {
    client = import("@neon/neon-js/auth").then(({ createAuthClient }) => createAuthClient(`${window.location.origin}/api/auth`));
  }
  return client;
}

const HINT = "efro.signedIn"; // remembers that this browser had signed in, so guests skip the session check
function hint(on?: boolean): boolean {
  try {
    if (on === true) localStorage.setItem(HINT, "1");
    if (on === false) localStorage.removeItem(HINT);
    return localStorage.getItem(HINT) === "1";
  } catch {
    return false;
  }
}

let cached: { token: string; exp: number } | null = null;
let signedIn = false;
const listeners = new Set<() => void>();

export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  listeners.forEach((fn) => fn());
}

/** exp (seconds) of a JWT, or null if the string is not a JWT. Signature is checked by the server. */
export function jwtExp(token: unknown): number | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/** The current API token, refreshed from the session when it is about to expire. */
export async function getToken(force = false): Promise<string | null> {
  if (!signedIn && !force) return null;
  const now = Date.now() / 1000;
  if (!force && cached && cached.exp - 60 > now) return cached.token;
  try {
    const res: any = await (await authClient()).getSession();
    const token = res?.data?.session?.token;
    const exp = jwtExp(token);
    if (res?.data?.user && token && exp) {
      cached = { token, exp };
      signedIn = true;
      return token;
    }
  } catch {
    /* sign-in service unreachable or not configured: behave as a guest */
  }
  const was = signedIn;
  cached = null;
  signedIn = false;
  if (was) {
    hint(false);
    emit();
  }
  return null;
}

/** Restore a session on page load. Returns true when a user is signed in. */
export async function restoreSession(): Promise<boolean> {
  if (!hint()) return false; // a guest on this browser: nothing to restore, no SDK download
  const ok = Boolean(await getToken(true));
  if (!ok) hint(false);
  return ok;
}

function message(err: any, fallback: string): string {
  const m = err?.message || err?.error?.message;
  if (typeof m === "string" && m && !/fetch|network/i.test(m)) return m;
  return fallback;
}

export async function signIn(email: string, password: string): Promise<void> {
  const res: any = await (await authClient()).signIn.email({ email, password });
  if (res?.error) throw new Error(message(res.error, "Email or password is incorrect."));
  if (!(await getToken(true))) throw new Error("Signed in, but the session could not be started. Please try again.");
  hint(true);
  emit();
}

export async function signUp(name: string, email: string, password: string): Promise<void> {
  const res: any = await (await authClient()).signUp.email({ name: name || email.split("@")[0], email, password });
  if (res?.error) throw new Error(message(res.error, "The account could not be created."));
  if (!(await getToken(true))) {
    throw new Error("Account created. Please check your email if a verification code was sent, then sign in.");
  }
  hint(true);
  emit();
}

export async function signOut(): Promise<void> {
  try {
    await (await authClient()).signOut();
  } finally {
    cached = null;
    signedIn = false;
    hint(false);
    emit();
  }
}

export function isSignedIn(): boolean {
  return signedIn;
}
