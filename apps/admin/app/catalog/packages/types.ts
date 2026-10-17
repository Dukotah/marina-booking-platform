/** Shared shapes for the package builder (list, form, actions). */

/** A rate option the builder can attach to a package item. */
export interface RateOption {
  id: string;
  name: string;
  priceCents: number;
}

/** An activity (with its active rates) offered in the package item picker. */
export interface ActivityOption {
  id: string;
  name: string;
  rates: RateOption[];
}

/** One line in the package editor. */
export interface PackageItemInput {
  activityId: string;
  rateId: string;
  quantity: number;
}

/** Full form values for create/edit. */
export interface PackageFormValues {
  nameInternal: string;
  nameExternal: string;
  descriptionHtml: string;
  priceDollars: string;
  status: 'ACTIVE' | 'INACTIVE';
  visibleOnline: boolean;
  sortIndex: number;
  items: PackageItemInput[];
}

export function emptyPackageForm(): PackageFormValues {
  return {
    nameInternal: '',
    nameExternal: '',
    descriptionHtml: '',
    priceDollars: '',
    status: 'ACTIVE',
    visibleOnline: true,
    sortIndex: 0,
    items: [{ activityId: '', rateId: '', quantity: 1 }],
  };
}

/** Result shape returned by the create/update server actions. */
export interface PackageActionResult {
  ok: boolean;
  error?: string;
  packageId?: string;
}
