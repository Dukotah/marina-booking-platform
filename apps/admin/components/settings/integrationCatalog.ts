/**
 * Catalog of integrations the platform supports out of the box. Integrations are
 * per-operator config records (Prisma `Integration`) keyed by `key`, not hard-coded
 * features — so OTAs, accounting, CRM, and pixels can be added without schema churn
 * (see docs/ARCHITECTURE.md §3). Each catalog entry declares the config fields the
 * UI should collect; `secret: true` masks the input.
 *
 * Note: the "policies" key is reserved by the Policies settings group and is not
 * surfaced here.
 */

export interface IntegrationField {
  /** Config object key. */
  name: string;
  label: string;
  placeholder?: string;
  /** Render as a password-style masked input (API keys, tokens). */
  secret?: boolean;
  hint?: string;
}

export interface IntegrationDef {
  key: string;
  name: string;
  category: 'Payments' | 'Accounting' | 'Marketing' | 'Communications';
  description: string;
  fields: IntegrationField[];
}

export const INTEGRATION_CATALOG: IntegrationDef[] = [
  {
    key: 'square',
    name: 'Square',
    category: 'Payments',
    description: 'Accept card payments and reconcile transactions.',
    fields: [
      { name: 'application_id', label: 'Application ID', placeholder: 'sq0idp-…' },
      { name: 'access_token', label: 'Access token', secret: true, placeholder: 'EAAA…' },
      { name: 'location_id', label: 'Square location ID', placeholder: 'L…' },
    ],
  },
  {
    key: 'stripe',
    name: 'Stripe',
    category: 'Payments',
    description: 'Alternative card processor.',
    fields: [
      { name: 'publishable_key', label: 'Publishable key', placeholder: 'pk_live_…' },
      { name: 'secret_key', label: 'Secret key', secret: true, placeholder: 'sk_live_…' },
    ],
  },
  {
    key: 'quickbooks',
    name: 'QuickBooks',
    category: 'Accounting',
    description: 'Sync orders and payouts to your books.',
    fields: [
      { name: 'realm_id', label: 'Company (realm) ID' },
      { name: 'client_id', label: 'Client ID' },
      { name: 'client_secret', label: 'Client secret', secret: true },
    ],
  },
  {
    key: 'ga4',
    name: 'Google Analytics 4',
    category: 'Marketing',
    description: 'Track booking funnel conversions on your customer site.',
    fields: [
      { name: 'measurement_id', label: 'Measurement ID', placeholder: 'G-XXXXXXX' },
    ],
  },
  {
    key: 'meta_pixel',
    name: 'Meta Pixel',
    category: 'Marketing',
    description: 'Attribute ad-driven bookings on your customer site.',
    fields: [{ name: 'pixel_id', label: 'Pixel ID', placeholder: '1234567890' }],
  },
  {
    key: 'mailchimp',
    name: 'Mailchimp',
    category: 'Marketing',
    description: 'Add customers to an audience for email marketing.',
    fields: [
      { name: 'api_key', label: 'API key', secret: true },
      { name: 'audience_id', label: 'Audience ID' },
    ],
  },
  {
    key: 'twilio',
    name: 'Twilio',
    category: 'Communications',
    description: 'Send booking confirmations and reminders by SMS.',
    fields: [
      { name: 'account_sid', label: 'Account SID', placeholder: 'AC…' },
      { name: 'auth_token', label: 'Auth token', secret: true },
      { name: 'from_number', label: 'From number', placeholder: '+15555550123' },
    ],
  },
];
