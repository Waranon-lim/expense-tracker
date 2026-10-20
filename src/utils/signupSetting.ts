// Sign-up is open when ALLOW_SIGNUP is not set. If it is set, only true, 1, yes
// or on (any case) keep it open. Anything else, including a typo, closes it:
// a wrong value must never leave the door open.
export function isSignupOpen(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
