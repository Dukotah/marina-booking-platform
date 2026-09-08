import * as React from 'react';
import { Button, Column, Heading, Row, Section, Text } from '@react-email/components';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';
import type { WaiverLink } from './BookingConfirmation.js';

export interface BookingReminderProps extends BrandProps {
  /** Order/confirmation number, e.g. "LSRA260604001". */
  orderNumber: string;
  /** Customer's first name (or full name) for the greeting. */
  customerName: string;
  /** Activity name, e.g. "24' Pontoon Rental". */
  activityName: string;
  /** Human-readable date, e.g. "Thursday, June 4, 2026". */
  dateLabel: string;
  /** Human-readable booking time / window, e.g. "9:00 AM – 1:00 PM". */
  timeLabel: string;
  /** Recommended check-in time, e.g. "8:30 AM". */
  checkInTimeLabel: string;
  /** Optional location/dock name, e.g. "Main Dock". */
  locationLabel?: string;
  /** Items the guest should bring. */
  whatToBring: string[];
  /**
   * Sign-before-you-arrive links, one per booked item still missing a signed
   * liability waiver. When present, the reminder tells the guest to sign now so
   * check-in is paperwork-free.
   */
  waiverLinks?: WaiverLink[];
}

const heading: React.CSSProperties = {
  color: '#111827',
  fontSize: '24px',
  fontWeight: 700,
  margin: '24px 0 8px',
};

const paragraph: React.CSSProperties = {
  color: '#374151',
  fontSize: '15px',
  lineHeight: '24px',
  margin: '8px 0',
};

const label: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '13px',
  margin: '0 0 2px',
};

const value: React.CSSProperties = {
  color: '#111827',
  fontSize: '15px',
  fontWeight: 600,
  margin: '0 0 12px',
};

const listHeading: React.CSSProperties = {
  color: '#111827',
  fontSize: '15px',
  fontWeight: 700,
  margin: '16px 0 4px',
};

const listItem: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '22px',
  margin: '2px 0',
};

export function BookingReminder({
  brandName,
  brandColor,
  logoUrl,
  orderNumber,
  customerName,
  activityName,
  dateLabel,
  timeLabel,
  checkInTimeLabel,
  locationLabel,
  whatToBring,
  waiverLinks,
}: BookingReminderProps): React.ReactElement {
  const needsWaiver = Boolean(waiverLinks && waiverLinks.length > 0);
  const waiverButton: React.CSSProperties = {
    backgroundColor: brandColor,
    borderRadius: '8px',
    color: '#ffffff',
    display: 'inline-block',
    fontSize: '15px',
    fontWeight: 700,
    padding: '12px 24px',
    textDecoration: 'none',
  };
  const waiverBox: React.CSSProperties = {
    backgroundColor: '#eff6ff',
    border: '1px solid #bfdbfe',
    borderRadius: '8px',
    margin: '16px 0',
    padding: '16px',
    textAlign: 'center',
  };
  const checkInBox: React.CSSProperties = {
    backgroundColor: '#f9fafb',
    border: `1px solid ${brandColor}`,
    borderRadius: '8px',
    margin: '16px 0',
    padding: '16px',
  };

  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`Reminder: your ${activityName} is coming up`}
    >
      <Heading style={heading}>See you soon!</Heading>
      <Text style={paragraph}>
        Hi {customerName}, this is a friendly reminder about your upcoming booking with{' '}
        {brandName}.
      </Text>

      <Section style={{ margin: '16px 0' }}>
        <Text style={label}>Activity</Text>
        <Text style={value}>{activityName}</Text>

        <Row>
          <Column>
            <Text style={label}>Date</Text>
            <Text style={value}>{dateLabel}</Text>
          </Column>
          <Column>
            <Text style={label}>Time</Text>
            <Text style={value}>{timeLabel}</Text>
          </Column>
        </Row>

        {locationLabel ? (
          <>
            <Text style={label}>Location</Text>
            <Text style={value}>{locationLabel}</Text>
          </>
        ) : null}

        <Text style={label}>Confirmation number</Text>
        <Text style={{ ...value, color: brandColor }}>{orderNumber}</Text>
      </Section>

      {needsWaiver && (
        <Section style={waiverBox}>
          <Text style={{ color: '#1e3a8a', fontSize: '15px', fontWeight: 700, margin: '0 0 4px' }}>
            Sign your waiver before you arrive
          </Text>
          <Text style={{ color: '#1e40af', fontSize: '13px', lineHeight: '20px', margin: '4px 0 12px' }}>
            We still need a signed liability waiver for this trip. Sign now on your
            phone and skip the paperwork at check-in.
          </Text>
          {waiverLinks!.map((link) => (
            <React.Fragment key={link.url}>
              <Button href={link.url} style={waiverButton}>
                {waiverLinks!.length > 1 ? `Sign waiver — ${link.label}` : 'Sign your waiver'}
              </Button>
              <Text
                style={{
                  color: '#6b7280',
                  fontSize: '12px',
                  lineHeight: '18px',
                  margin: '8px 0 0',
                  wordBreak: 'break-all',
                }}
              >
                {link.url}
              </Text>
            </React.Fragment>
          ))}
        </Section>
      )}

      <Section style={checkInBox}>
        <Text style={{ ...label, margin: 0 }}>Please check in by</Text>
        <Text style={{ ...value, color: brandColor, margin: '4px 0 0', fontSize: '20px' }}>
          {checkInTimeLabel}
        </Text>
      </Section>

      <Text style={listHeading}>What to bring</Text>
      {whatToBring.map((item, i) => (
        <Text key={`${item}-${i}`} style={listItem}>
          &bull; {item}
        </Text>
      ))}
    </BrandLayout>
  );
}

export default BookingReminder;
