// Plain-language labels for API values (as written in the Figma admin pages).

export type Flag = { id: number; userId: string; rule: string; details: Record<string, any>; status: string; createdAt: string; name: string; mobile: string; decidedAt?: string | null };

/** D1 / D3c fraud rules → headline + detail line. */
export function flagText(f: Flag): { title: string; sub: string } {
  const d = f.details ?? {};
  switch (f.rule) {
    case 'scan_burst':
      return { title: `${d.scans ?? 'Many'} scans in ${d.minutes ?? '?'} minutes`, sub: `${f.name} · one account` };
    case 'gps_jump':
      return { title: `GPS jump ${d.km ?? '?'} km in ${d.minutes ?? '?'} min`, sub: f.name };
    case 'shared_device':
      return { title: `${(d.otherAccounts?.length ?? 1) + 1} accounts on one phone`, sub: `${f.name}${d.otherAccounts?.length ? ` · also ${d.otherAccounts.join(', ')}` : ''}` };
    case 'wrong_codes':
      return { title: `${d.tries ?? 'Many'} wrong codes in ${d.minutes ?? 10} min`, sub: `${f.name} · one phone` };
    case 'repeat_code':
      return { title: `Same coupon tried ${d.tries ?? 'again'}${d.tries ? ' times' : ''}`, sub: `${d.code ?? ''} · ${f.name}` };
    default:
      return { title: f.rule.replace(/_/g, ' '), sub: f.name };
  }
}

export const SCAN_RESULT: Record<string, { label: string; tone: string }> = {
  added: { label: 'Added', tone: 'ok' },
  already_used: { label: 'Already used', tone: 'bad' },
  expired: { label: 'Expired', tone: 'warn' },
  not_active: { label: 'Not active yet', tone: 'warn' },
  wrong_code: { label: 'Wrong code', tone: 'bad' },
  blocked: { label: 'Blocked', tone: 'bad' },
};

export const SCAN_SOURCE: Record<string, string> = { scan: 'Camera', typed: 'Typed', offline: 'Offline · sent later' };

export const BATCH_STATUS: Record<string, { label: string; tone: string }> = {
  generated: { label: 'Generated', tone: '' },
  printed: { label: 'Printed', tone: 'info' },
  in_market: { label: 'In market', tone: 'ok' },
  blocked: { label: 'Blocked', tone: 'bad' },
};

export const STEP: Record<string, { label: string; tone: string }> = {
  booked: { label: 'Booked', tone: '' },
  packed: { label: 'Packed', tone: 'warn' },
  shipped: { label: 'Shipped', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
};

export const WD_STATUS: Record<string, { label: string; tone: string }> = {
  requested: { label: 'Waiting', tone: 'warn' },
  held: { label: 'Under check', tone: 'warn' },
  approved: { label: 'To pay', tone: 'info' },
  paid: { label: 'Paid', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
};

/** Rank pill colours from D1 "Top applicators". */
export const rankTone = (id?: string) => (id === 'ustaad' || id === 'legend' ? 'navy' : id === 'kaarigar' ? 'ok' : 'pri');
