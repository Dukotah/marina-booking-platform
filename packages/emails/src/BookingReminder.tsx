import * as React from 'react';
import { Column, Heading, Row, Section, Text } from '@react-email/components';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

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
}: BookingReminderProps): React.ReactElement {
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
