import * as React from 'react';
import { Button, Heading, Section, Text } from '@react-email/components';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

export interface WaiverRequestProps extends BrandProps {
  /** Customer's first name (or full name) for the greeting. */
  customerName: string;
  /** Activity the waiver is for, e.g. "24' Pontoon Rental". */
  activityName: string;
  /** Human-readable date of the booking, e.g. "Thursday, June 4, 2026". */
  dateLabel: string;
  /** Order/confirmation number the waiver applies to. */
  orderNumber: string;
  /** Absolute URL where the guest signs the waiver. */
  waiverUrl: string;
  /** Optional human-readable deadline, e.g. "before 9:00 AM on June 4". */
  deadlineLabel?: string;
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

const note: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '16px 0 4px',
  wordBreak: 'break-all',
};

export function WaiverRequest({
  brandName,
  brandColor,
  logoUrl,
  customerName,
  activityName,
  dateLabel,
  orderNumber,
  waiverUrl,
  deadlineLabel,
}: WaiverRequestProps): React.ReactElement {
  const button: React.CSSProperties = {
    backgroundColor: brandColor,
    borderRadius: '8px',
    color: '#ffffff',
    display: 'inline-block',
    fontSize: '16px',
    fontWeight: 700,
    padding: '14px 28px',
    textDecoration: 'none',
  };

  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`Action needed: sign your waiver for ${activityName}`}
    >
      <Heading style={heading}>One more step before your trip</Heading>
      <Text style={paragraph}>
        Hi {customerName}, before your {activityName} on {dateLabel}, every guest must
        complete a signed liability waiver. It only takes a minute.
      </Text>
      {deadlineLabel ? (
        <Text style={paragraph}>
          Please sign {deadlineLabel} so we can get you on the water without delay.
        </Text>
      ) : (
        <Text style={paragraph}>
          Please sign before you arrive so we can get you on the water without delay.
        </Text>
      )}

      <Section style={{ margin: '24px 0', textAlign: 'center' }}>
        <Button href={waiverUrl} style={button}>
          Sign your waiver
        </Button>
      </Section>

      <Text style={note}>
        Booking {orderNumber}. If the button doesn&apos;t work, copy and paste this link
        into your browser:
      </Text>
      <Text style={{ ...note, margin: '0 0 8px' }}>{waiverUrl}</Text>
    </BrandLayout>
  );
}

export default WaiverRequest;
