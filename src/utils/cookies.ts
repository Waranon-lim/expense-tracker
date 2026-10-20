export const SESSION_COOKIE = 'sid';

// Reads the request's Cookie header ("a=1; sid=abc") into an object. Written
// by hand so the project needs no extra package for one small job.
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

// HttpOnly: page JavaScript cannot read the cookie.
// SameSite=Lax: other sites cannot send it along with a POST.
// Max-Age is set only for "remember me". Without it the cookie ends when the
// browser closes.
export function buildSessionCookie(token: string, options: { maxAgeSeconds?: number; secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
