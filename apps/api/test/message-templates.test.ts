/**
 * Unit tests for the pure template resolvers — no DB, no email/SMS provider.
 * Focuses on the SMS-channel body resolution added for operator-customizable
 * reminder / cancellation / refund texts: an enabled, non-blank override wins and
 * its {{placeholders}} are filled; anything missing/blank/disabled falls back to
 * the built-in copy so a flow is never broken by a bad template.
 */
import { describe, it, expect } from 'vitest';
import { resolveSmsBody, interpolate, type TemplateOverride } from '../src/services/message-templates.js';

const facts = {
  order_number: 'LSRA-1042',
  refund: '$45.00',
  activity: 'Sunset Kayak Tour',
  brand_name: 'Lake Sonoma',
};

const DEFAULT = 'Lake Sonoma: default copy for LSRA-1042.';

function override(partial: Partial<TemplateOverride>): TemplateOverride {
  return { enabled: true, subject_override: null, body_override: null, sms_body_override: null, ...partial };
}

describe('resolveSmsBody', () => {
  it('falls back to the default when there is no override', () => {
    const { body, customized } = resolveSmsBody({ defaultBody: DEFAULT, override: null, facts });
    expect(body).toBe(DEFAULT);
    expect(customized).toBe(false);
  });

  it('falls back when the override is disabled', () => {
    const { body, customized } = resolveSmsBody({
      defaultBody: DEFAULT,
      override: override({ enabled: false, sms_body_override: 'Should not be used {{order_number}}' }),
      facts,
    });
    expect(body).toBe(DEFAULT);
    expect(customized).toBe(false);
  });

  it('falls back when the sms body override is blank/whitespace', () => {
    const { body, customized } = resolveSmsBody({
      defaultBody: DEFAULT,
      override: override({ sms_body_override: '   ' }),
      facts,
    });
    expect(body).toBe(DEFAULT);
    expect(customized).toBe(false);
  });

  it('uses an enabled override and fills {{placeholders}}', () => {
    const { body, customized } = resolveSmsBody({
      defaultBody: DEFAULT,
      override: override({ sms_body_override: '{{brand_name}}: {{refund}} refunded for {{order_number}}.' }),
      facts,
    });
    expect(body).toBe('Lake Sonoma: $45.00 refunded for LSRA-1042.');
    expect(customized).toBe(true);
  });

  it('leaves unknown tokens intact (visible typo, not a silent blank)', () => {
    const { body } = resolveSmsBody({
      defaultBody: DEFAULT,
      override: override({ sms_body_override: 'Ref {{order_number}} / {{bogus}}' }),
      facts,
    });
    expect(body).toBe('Ref LSRA-1042 / {{bogus}}');
  });

  it('shares interpolate semantics (whitespace in braces tolerated)', () => {
    expect(interpolate('Hi {{ activity }}', facts)).toBe('Hi Sunset Kayak Tour');
  });
});
