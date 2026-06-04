import * as React from 'react';
import { Column, Heading, Hr, Row, Section, Text } from '@react-email/components';
import { formatUSD } from '@marina/types';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

/** A single line in the price breakdown. Amounts are integer cents. */
export interface PriceLine {
  label: string;
  amountCents: number;
}

export interface BookingConfirmationProps extends BrandProps {
  /** Order/confirmation number, e.g. "LSRA260604001". */
  orderNumber: string;
  /** Customer's first name (or full name) for the greeting. */
  customerName: string;
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
  /** Price breakdown lines (subtotal, discounts, fees, tax, tip). */
  lineItems: PriceLine[];
  /** Grand total in integer cents. */
  totalCents: number;
  /** Cancellation policy text to display to the guest. */
  cancellationPolicy: string;
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

const lineLabel: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  margin: '4px 0',
};

const lineValue: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  margin: '4px 0',
  textAlign: 'right',
};

const totalLabel: React.CSSProperties = {
  color: '#111827',
  fontSize: '16px',
  fontWeight: 700,
  margin: '8px 0',
};

const totalValue: React.CSSProperties = {
  color: '#111827',
  fontSize: '16px',
  fontWeight: 700,
  margin: '8px 0',
  textAlign: 'right',
};

const qrNote: React.CSSProperties = {
  backgroundColor: '#f9fafb',
  border: '1px dashed #d1d5db',
  borderRadius: '8px',
  color: '#6b7280',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '16px 0',
  padding: '16px',
  textAlign: 'center',
};

const policyHeading: React.CSSProperties = {
  color: '#111827',
  fontSize: '15px',
  fontWeight: 700,
  margin: '20px 0 4px',
};

const policyText: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '4px 0',
};

export function BookingConfirmation({
  brandName,
  brandColor,
  logoUrl,
  orderNumber,
  customerName,
  activityName,
  dateLabel,
  timeLabel,
  partySize,
  locationLabel,
  lineItems,
  totalCents,
  cancellationPolicy,
}: BookingConfirmationProps): React.ReactElement {
  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`Your booking is confirmed — ${orderNumber}`}
    >
      <Heading style={heading}>You&apos;re booked!</Heading>
      <Text style={paragraph}>
        Hi {customerName}, thanks for booking with {brandName}. Your reservation is
        confirmed. Here are your details.
      </Text>

      <Section style={{ margin: '16px 0' }}>
        <Text style={label}>Confirmation number</Text>
        <Text style={{ ...value, color: brandColor }}>{orderNumber}</Text>

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

        <Row>
          <Column>
            <Text style={label}>Party size</Text>
            <Text style={value}>
              {partySize} {partySize === 1 ? 'guest' : 'guests'}
            </Text>
          </Column>
          {locationLabel ? (
            <Column>
              <Text style={label}>Location</Text>
              <Text style={value}>{locationLabel}</Text>
            </Column>
          ) : (
            <Column />
          )}
        </Row>
      </Section>

      <Hr style={{ borderColor: '#e5e7eb', margin: '8px 0' }} />

      <Section>
        {lineItems.map((line, i) => (
          <Row key={`${line.label}-${i}`}>
            <Column>
              <Text style={lineLabel}>{line.label}</Text>
            </Column>
            <Column>
              <Text style={lineValue}>{formatUSD(line.amountCents)}</Text>
            </Column>
          </Row>
        ))}
        <Hr style={{ borderColor: '#e5e7eb', margin: '4px 0' }} />
        <Row>
          <Column>
            <Text style={totalLabel}>Total</Text>
          </Column>
          <Column>
            <Text style={totalValue}>{formatUSD(totalCents)}</Text>
          </Column>
        </Row>
      </Section>

      <Text style={qrNote}>
        Your check-in QR code will appear here in the confirmation on your device.
        Present it (or your confirmation number {orderNumber}) when you arrive.
      </Text>

      <Text style={policyHeading}>Cancellation policy</Text>
      <Text style={policyText}>{cancellationPolicy}</Text>
    </BrandLayout>
  );
}

export default BookingConfirmation;
