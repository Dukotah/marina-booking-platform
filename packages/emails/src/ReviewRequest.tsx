import * as React from 'react';
import { Button, Heading, Section, Text } from '@react-email/components';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

export interface ReviewRequestProps extends BrandProps {
  /** Order/confirmation number, e.g. "LSRA260604001". */
  orderNumber: string;
  /** Customer's first name (or full name) for the greeting. */
  customerName: string;
  /** Activity name, e.g. "24' Pontoon Rental". */
  activityName: string;
  /** Human-readable date the trip happened, e.g. "Thursday, June 4, 2026". */
  dateLabel: string;
  /** Public review URL (Google/Yelp/etc) the CTA links to. */
  reviewUrl: string;
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

export function ReviewRequest({
  brandName,
  brandColor,
  logoUrl,
  orderNumber,
  customerName,
  activityName,
  dateLabel,
  reviewUrl,
}: ReviewRequestProps): React.ReactElement {
  const reviewButton: React.CSSProperties = {
    backgroundColor: brandColor,
    borderRadius: '8px',
    color: '#ffffff',
    display: 'inline-block',
    fontSize: '15px',
    fontWeight: 700,
    padding: '12px 24px',
    textDecoration: 'none',
  };
  const ctaBox: React.CSSProperties = {
    margin: '20px 0',
    textAlign: 'center',
  };

  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`How was your ${activityName}? Leave ${brandName} a review`}
    >
      <Heading style={heading}>How did we do?</Heading>
      <Text style={paragraph}>
        Hi {customerName}, thanks for choosing {brandName}. We hope you had a great
        time on your trip — if you have a minute, we would love to hear how it went.
      </Text>

      <Section style={{ margin: '16px 0' }}>
        <Text style={label}>Activity</Text>
        <Text style={value}>{activityName}</Text>

        <Text style={label}>Date</Text>
        <Text style={value}>{dateLabel}</Text>

        <Text style={label}>Confirmation number</Text>
        <Text style={{ ...value, color: brandColor }}>{orderNumber}</Text>
      </Section>

      <Section style={ctaBox}>
        <Button href={reviewUrl} style={reviewButton}>
          Leave a review
        </Button>
        <Text
          style={{
            color: '#6b7280',
            fontSize: '12px',
            lineHeight: '18px',
            margin: '12px 0 0',
            wordBreak: 'break-all',
          }}
        >
          {reviewUrl}
        </Text>
      </Section>

      <Text style={paragraph}>
        Your feedback helps us keep improving and helps other guests find us. Thank
        you!
      </Text>
    </BrandLayout>
  );
}

export default ReviewRequest;
