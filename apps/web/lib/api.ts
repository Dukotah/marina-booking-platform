/**
 * Thin client for the marina API. The tenant is selected by the operator slug
 * (later resolved from the request host; for dev it comes from OPERATOR_SLUG).
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const OPERATOR_SLUG = process.env.OPERATOR_SLUG ?? 'lake-sonoma';

export interface CatalogRate {
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
}

export interface CatalogActivity {
  id: string;
  name: string;
  category: string;
  maxParticipants: number;
  color: string;
  photoUrls: string[];
  waiverRequired: boolean;
  fromPriceCents: number | null;
  rates: CatalogRate[];
}

export async function getCatalog(): Promise<CatalogActivity[]> {
  const res = await fetch(`${API_URL}/api/activities`, {
    headers: { 'x-operator-slug': OPERATOR_SLUG },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);
  const data = (await res.json()) as { activities: CatalogActivity[] };
  return data.activities;
}
