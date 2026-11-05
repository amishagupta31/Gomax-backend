import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  Gift,
  HardHat,
  History,
  Image,
  Landmark,
  LayoutDashboard,
  MessageCircle,
  Package,
  QrCode,
  ScanLine,
  Settings,
  Sparkles,
  Trophy,
  Users,
} from 'lucide-react';
import type { Role } from './api';

// D0 "Who can open which page" (Settings → Staff logins), matched to what the API allows.
// Owners can open everything. "view" = can open but not change.
export type Access = 'full' | 'view' | 'own';
export type NavItem = { to: string; label: string; icon: LucideIcon; group: string; roles: Partial<Record<Role, Access>>; badge?: string };

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, group: 'OVERVIEW', roles: { accounts: 'view', factory: 'own', helpline: 'view', ops: 'own' } },
  { to: '/applicators', label: 'Applicators', icon: HardHat, group: 'APPLICATORS', roles: { accounts: 'full', helpline: 'view' } },
  { to: '/coupons', label: 'Coupons', icon: QrCode, group: 'APPLICATORS', roles: { accounts: 'view', factory: 'own', helpline: 'view' }, badge: 'coupons' },
  { to: '/scans', label: 'Scans log', icon: ScanLine, group: 'APPLICATORS', roles: { accounts: 'view', factory: 'view', helpline: 'view' }, badge: 'flags' },
  { to: '/withdrawals', label: 'Withdrawals', icon: Banknote, group: 'APPLICATORS', roles: { accounts: 'full' }, badge: 'withdrawals' },
  { to: '/gifts', label: 'Gifts & courier', icon: Gift, group: 'APPLICATORS', roles: { accounts: 'view', factory: 'own', helpline: 'view' }, badge: 'gifts' },
  { to: '/referrals', label: 'Referral tree', icon: Users, group: 'APPLICATORS', roles: { accounts: 'view', helpline: 'view' } },
  { to: '/dealers', label: 'Dealers', icon: Landmark, group: 'DEALERS', roles: { helpline: 'view' } },
  { to: '/games', label: 'Games & odds', icon: Sparkles, group: 'ENGAGE', roles: {} },
  { to: '/challenges', label: 'Challenges', icon: Trophy, group: 'ENGAGE', roles: { ops: 'own', helpline: 'view' }, badge: 'photos' },
  { to: '/content', label: 'Home content', icon: Image, group: 'ENGAGE', roles: { helpline: 'view' } },
  { to: '/whatsapp', label: 'WhatsApp messages', icon: MessageCircle, group: 'ENGAGE', roles: {} },
  { to: '/products', label: 'Products & TDS', icon: Package, group: 'CATALOGUE', roles: { factory: 'view', helpline: 'view' } },
  { to: '/settings', label: 'Settings', icon: Settings, group: 'SYSTEM', roles: { accounts: 'view', factory: 'view', helpline: 'view', ops: 'view' } },
  { to: '/audit', label: 'Audit log', icon: History, group: 'SYSTEM', roles: { accounts: 'view' } },
];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner admin',
  accounts: 'Accounts',
  factory: 'Factory',
  helpline: 'Helpline team',
  ops: 'Office staff',
};

export function access(role: Role, path: string): Access | null {
  if (role === 'owner') return 'full';
  const item = NAV.find((n) => (n.to === '/' ? path === '/' : path === n.to || path.startsWith(`${n.to}/`)));
  return item?.roles[role] ?? null;
}

export const can = (role: Role, path: string) => access(role, path) !== null;
/** Can change things on this page (not view-only). */
export const canEdit = (role: Role, path: string) => {
  const a = access(role, path);
  return a === 'full' || a === 'own';
};
