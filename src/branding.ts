import { one } from "./db.ts";
import { isKey } from "./storage.ts";

/** Company name, app name, header color and logo, set by an admin (settings key "branding"). */
export interface Branding {
  company_name: string;
  app_name: string;
  color: string;
  logo_key: string | null;
}

export const DEFAULT_BRANDING: Branding = {
  company_name: "Your Company",
  app_name: "TireKicker",
  color: "#2f6b3a",
  logo_key: null,
};

export const COLOR_RE = /^#[0-9a-f]{6}$/i;

export async function getBranding(): Promise<Branding> {
  const r = await one<{ value: Partial<Branding> }>(`SELECT value FROM settings WHERE key = 'branding'`);
  const b = { ...DEFAULT_BRANDING, ...(r?.value ?? {}) };
  if (!COLOR_RE.test(b.color)) b.color = DEFAULT_BRANDING.color;
  if (b.logo_key && !isKey(b.logo_key)) b.logo_key = null;
  return b;
}

export async function saveBranding(patch: Partial<Branding>, userId: number): Promise<Branding> {
  await one(
    `INSERT INTO settings (key, value, updated_by) VALUES ('branding', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE
       SET value = settings.value || EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(patch), userId],
  );
  return getBranding();
}

/** Changes whenever a new logo is uploaded, so the logo URL can be cached for good. */
export function logoVersion(key: string): string {
  return key.split("/")[2]?.slice(0, 8) ?? "0";
}

/** What the app and the sign-in screen get (no storage paths). */
export function publicBranding(b: Branding) {
  return {
    company_name: b.company_name,
    app_name: b.app_name,
    color: b.color,
    logo_url: b.logo_key ? `/api/branding/logo?v=${logoVersion(b.logo_key)}` : null,
  };
}
