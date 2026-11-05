// PAN verify (about ₹1–3 per check) and UPI name lookup (about ₹1.5–2.5) —
// the provider is for the client to pick (Cashfree / RazorpayX / Signzy).
// The mock accepts any well-formed value, so the whole flow works end to end.
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const UPI_RE = /^[\w.-]{2,}@[a-z]{2,}$/i;

export type KycResult = { ok: true; name: string } | { ok: false; error: string };

export interface KycProvider {
  verifyPan(pan: string, name: string): Promise<KycResult>;
  /** Name registered on the UPI ID; empty string when the provider can't tell. */
  lookupUpi(upi: string): Promise<KycResult>;
}

/**
 * UPI name check through RazorpayX Fund Account Validation (about ₹2–3 a check).
 * PAN is still format-checked only — pick a PAN provider separately.
 */
export function razorpayKyc(rzp: {
  createContact: (c: { name: string; mobile: string; referenceId: string }) => Promise<{ id: string }>;
  createVpaFundAccount: (contactId: string, vpa: string) => Promise<{ id: string }>;
  validateVpa: (fundAccountId: string) => Promise<{ active: boolean; name: string | null }>;
}): KycProvider {
  let checkContact: Promise<string> | null = null; // one shared contact for UPI checks
  return {
    verifyPan: mockKyc().verifyPan,
    async lookupUpi(upi) {
      if (!UPI_RE.test(upi)) return { ok: false, error: 'Check the UPI ID' };
      try {
        checkContact ??= rzp.createContact({ name: 'GoMax UPI check', mobile: '9215844410', referenceId: 'gomax-upi-check' }).then((c) => c.id);
        const fa = await rzp.createVpaFundAccount(await checkContact, upi);
        const v = await rzp.validateVpa(fa.id);
        if (!v.active) return { ok: false, error: 'This UPI ID is not active' };
        return { ok: true, name: (v.name ?? '').toUpperCase() };
      } catch {
        checkContact = null;
        return { ok: false, error: 'Could not check the UPI ID right now. Try again.' };
      }
    },
  };
}

export function mockKyc(): KycProvider {
  return {
    async verifyPan(pan, name) {
      if (!PAN_RE.test(pan)) return { ok: false, error: 'Check the PAN number' };
      return { ok: true, name: name.trim().toUpperCase() };
    },
    async lookupUpi(upi) {
      if (!UPI_RE.test(upi)) return { ok: false, error: 'Check the UPI ID' };
      return { ok: true, name: '' };
    },
  };
}

/** True if every word of the shorter name appears in the longer one (ignores case and punctuation). */
export function namesMatch(a: string, b: string) {
  const words = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  const [x, y] = [words(a), words(b)];
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((p) => long.includes(p));
}
