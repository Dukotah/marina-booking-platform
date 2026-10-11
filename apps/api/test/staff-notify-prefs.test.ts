import { describe, it, expect } from 'vitest';
import {
  selectStaffNotifyRecipients,
  type StaffNotifyMember,
} from '../src/services/staff-notify-prefs.js';

describe('selectStaffNotifyRecipients', () => {
  it('defaults a member with no pref row to email-on, sms-off, all activities', () => {
    const staff: StaffNotifyMember[] = [
      { email: 'desk@shop.com', notification_pref: null },
    ];
    const r = selectStaffNotifyRecipients(staff, ['act_1']);
    expect(r.emails).toEqual(['desk@shop.com']);
    expect(r.phones).toEqual([]);
  });

  it('respects email_enabled / sms_enabled channel toggles independently', () => {
    const staff: StaffNotifyMember[] = [
      {
        email: 'emailonly@shop.com',
        notification_pref: {
          email_enabled: true,
          sms_enabled: false,
          sms_phone: '+17075550100',
          activity_ids: [],
        },
      },
      {
        email: 'smsonly@shop.com',
        notification_pref: {
          email_enabled: false,
          sms_enabled: true,
          sms_phone: '+17075550101',
          activity_ids: [],
        },
      },
      {
        email: 'both@shop.com',
        notification_pref: {
          email_enabled: true,
          sms_enabled: true,
          sms_phone: '+17075550102',
          activity_ids: [],
        },
      },
    ];
    const r = selectStaffNotifyRecipients(staff, ['act_1']);
    expect(r.emails.sort()).toEqual(['both@shop.com', 'emailonly@shop.com']);
    expect(r.phones.sort()).toEqual(['+17075550101', '+17075550102']);
  });

  it('skips SMS when enabled but no phone is set', () => {
    const staff: StaffNotifyMember[] = [
      {
        email: 'nophone@shop.com',
        notification_pref: {
          email_enabled: false,
          sms_enabled: true,
          sms_phone: null,
          activity_ids: [],
        },
      },
    ];
    const r = selectStaffNotifyRecipients(staff, ['act_1']);
    expect(r.emails).toEqual([]);
    expect(r.phones).toEqual([]);
  });

  it('narrows alerts by activity filter (non-empty activity_ids must overlap)', () => {
    const staff: StaffNotifyMember[] = [
      {
        email: 'kayaks@shop.com',
        notification_pref: {
          email_enabled: true,
          sms_enabled: false,
          sms_phone: null,
          activity_ids: ['act_kayak'],
        },
      },
      {
        email: 'pontoons@shop.com',
        notification_pref: {
          email_enabled: true,
          sms_enabled: false,
          sms_phone: null,
          activity_ids: ['act_pontoon'],
        },
      },
    ];
    const r = selectStaffNotifyRecipients(staff, ['act_kayak']);
    expect(r.emails).toEqual(['kayaks@shop.com']);
  });

  it('matches when any booked activity overlaps the filter', () => {
    const staff: StaffNotifyMember[] = [
      {
        email: 'kayaks@shop.com',
        notification_pref: {
          email_enabled: true,
          sms_enabled: false,
          sms_phone: null,
          activity_ids: ['act_kayak'],
        },
      },
    ];
    const r = selectStaffNotifyRecipients(staff, ['act_pontoon', 'act_kayak']);
    expect(r.emails).toEqual(['kayaks@shop.com']);
  });

  it('drops a member whose email is null even when email is enabled', () => {
    const staff: StaffNotifyMember[] = [
      { email: null, notification_pref: null },
    ];
    const r = selectStaffNotifyRecipients(staff, ['act_1']);
    expect(r.emails).toEqual([]);
  });
});
