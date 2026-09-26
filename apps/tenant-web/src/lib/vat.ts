import { useEffect, useState } from 'react';
import { settingsApi } from './api';

/**
 * The clinic's VAT rate, for labelling TVSH categories ("Cosmetic · TVSH 20%")
 * and previewing an invoice before it is saved. Read once per session: it is
 * a setting that changes a few times in a clinic's life, and every screen that
 * shows it can live with the value from sign-in.
 */
let pending: Promise<number> | null = null;

export function clinicVatRate(): Promise<number> {
  pending ??= settingsApi
    .get()
    .then((s) => s.vatRateBp)
    .catch(() => {
      pending = null;
      return 0;
    });
  return pending;
}

/** Forget the cached rate, after Settings → Finance saves a new one. */
export function forgetClinicVatRate() {
  pending = null;
}

export function useClinicVatRate(): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void clinicVatRate().then((r) => live && setRate(r));
    return () => {
      live = false;
    };
  }, []);
  return rate;
}
