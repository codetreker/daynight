import { createContext, useContext, type ReactNode } from 'react';
import type { CurrentUser } from '../api/auth-types';

export type CurrentAccount = { readonly user: Pick<CurrentUser, 'id' | 'name'>; readonly admissionBlocked: boolean };
const Context = createContext<CurrentAccount | null>(null);

export const CurrentAccountProvider = ({ user, admissionBlocked, children }: CurrentAccount & { readonly children: ReactNode }) =>
  <Context value={{ user, admissionBlocked }}>{children}</Context>;

export const useCurrentAccount = (): CurrentAccount => {
  const account = useContext(Context);
  if (account === null) throw new Error('An authenticated account is required.');
  return account;
};
