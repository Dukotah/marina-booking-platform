import * as React from 'react';
import { Button, Column, Heading, Hr, Row, Section, Text } from '@react-email/components';
import { formatUSD } from '@marina/types';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

export interface StaffNewBookingProps extends BrandProps {
  /** Name of the staff member being notified (for the greeting). */
  staffName?: string;
  /** Order/confirmation number. */
  orderNumber: string;
  /** Activity name, e.g. "24' Pontoon Rental". */
  activityName: string;
  /** Human-readable date, e.g. "Thursday, June 4, 2026". */
  dateLabel: string;
  /** Human-readable time / window, e.g. "9:00 AM – 1:00 PM". */
  timeLabel: string;
  /** Number of guests in the party. */
  partySize: number;
  /** Optional location/dock name, e.g. "Main Dock". */
  locationLabel?: string;
  /** Booking customer's full name. */
  customerName: string;
  /** Customer email address. */
  customerEmail: string;
  /** Optional customer phone number. */
  customerPhone?: string;
  /** Order total, in integer cents. */
  totalCents: number;
  /** Booking channel/source, e.g. "Online", "POS", "Phone". */
  channelLabel?: string;
  /** Absolute URL to view the booking in the admin dashboard. */
  manageUrl: string;
}

const heading: React.CSSProperties = {
  color: '#111827',
  fontSize: '22px',
  fontWeight: 700,
  margin: '24px 0 4px',
};

const subheading: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '14px',
  margin: '0 0 12px',
};

const lineLabel: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '13px',
  margin: '6px 0 0',
};

const lineValue: React.CSSProperties = {
  color: '#111827',
  fontSize: '15px',
  fontWeight: 600,
  margin: '0 0 6px',
};

export function StaffNewBooking({
  brandName,
  brandColor,
  logoUrl,
  staffName,
  orderNumber,
  activityName,
  dateLabel,
  timeLabel,
  partySize,
  locationLabel,
  customerName,
  customerEmail,
  customerPhone,
  totalCents,
  channelLabel,
  manageUrl,
}: StaffNewBookingProps): React.ReactElement {
  const button: React.CSSProperties = {
    backgroundColor: brandColor,
    borderRadius: '8px',
    color: '#ffffff',
    display: 'inline-block',
    fontSize: '15px',
    fontWeight: 700,
    padding: '12px 24px',
    textDecoration: 'none',
  };

  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`New booking: ${activityName} — ${orderNumber}`}
    >
      <Heading style={heading}>New booking received</Heading>
      <Text style={subheading}>
        {staffName ? `${staffName}, a` : 'A'} new reservation just came in
        {channelLabel ? ` via ${channelLabel}` : ''}.
      </Text>

      <Section>
        <Text style={lineLabel}>Confirmation number</Text>
        <Text style={{ ...lineValue, color: brandColor }}>{orderNumber}</Text>

        <Text style={lineLabel}>Activity</Text>
        <Text style={lineValue}>{activityName}</Text>

        <Row>
          <Column>
            <Text style={lineLabel}>Date</Text>
            <Text style={lineValue}>{dateLabel}</Text>
          </Column>
          <Column>
            <Text style={lineLabel}>Time</Text>
            <Text style={lineValue}>{timeLabel}</Text>
          </Column>
        </Row>

        <Row>
          <Column>
            <Text style={lineLabel}>Party size</Text>
            <Text style={lineValue}>
              {partySize} {partySize === 1 ? 'guest' : 'guests'}
            </Text>
          </Column>
          <Column>
            <Text style={lineLabel}>Total</Text>
            <Text style={lineValue}>{formatUSD(totalCents)}</Text>
          </Column>
        </Row>

        {locationLabel ? (
          <>
            <Text style={lineLabel}>Location</Text>
            <Text style={lineValue}>{locationLabel}</Text>
          </>
        ) : null}
      </Section>

      <Hr style={{ borderColor: '#e5e7eb', margin: '8px 0' }} />

      <Section>
        <Text style={lineLabel}>Customer</Text>
        <Text style={lineValue}>{customerName}</Text>

        <Text style={lineLabel}>Email</Text>
        <Text style={lineValue}>{customerEmail}</Text>

        {customerPhone ? (
          <>
            <Text style={lineLabel}>Phone</Text>
            <Text style={lineValue}>{customerPhone}</Text>
          </>
        ) : null}
      </Section>

      <Section style={{ margin: '20px 0', textAlign: 'center' }}>
        <Button href={manageUrl} style={button}>
          View booking
        </Button>
      </Section>
    </BrandLayout>
  );
}

export default StaffNewBooking;
