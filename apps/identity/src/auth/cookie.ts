/** Read one named cookie out of a raw `Cookie` request header. */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export interface CookieOpts {
  maxAgeSeconds: number;
  secure: boolean;
  path: string;
}

/** Build an httpOnly, SameSite=Strict Set-Cookie value (Secure only when opts.secure). */
export function buildSetCookie(name: string, value: string, opts: CookieOpts): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    `Path=${opts.path}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build a Set-Cookie that immediately expires the cookie. */
export function clearSetCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; SameSite=Strict`;
}
