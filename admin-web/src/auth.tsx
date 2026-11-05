import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { login as apiLogin, logout as apiLogout, restore, setSignedOutHandler, type Staff } from './api';

type Auth = { staff: Staff | null; ready: boolean; login: (id: string, pw: string) => Promise<void>; logout: () => Promise<void> };
const Ctx = createContext<Auth>(null!);
export const useAuth = () => useContext(Ctx);
/** The signed-in staff member (pages are only rendered when signed in). */
export const useStaff = () => useContext(Ctx).staff!;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSignedOutHandler(() => setStaff(null));
    restore()
      .then(setStaff)
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (id: string, pw: string) => setStaff(await apiLogin(id, pw)), []);
  const logout = useCallback(async () => {
    await apiLogout();
    setStaff(null);
  }, []);

  return <Ctx.Provider value={{ staff, ready, login, logout }}>{children}</Ctx.Provider>;
}
