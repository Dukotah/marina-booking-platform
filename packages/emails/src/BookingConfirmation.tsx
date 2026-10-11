import * as React from 'react';
import { Button, Column, Heading, Hr, Row, Section, Text } from '@react-email/components';
import { formatUSD } from '@marina/types';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

/** A single line in the price breakdown. Amounts are integer cents. */
export interface PriceLine {
  label: string;
  amountCents: number;
}

/** One operator-question answer echoed back to the guest in the confirmation. */
export interface CustomerDetail {
  /** The question label, e.g. "Trailer license plate". */
  label: string;
  /** The guest's answer, already formatted to a display string. */
  value: string;
}

/** One outstanding waiver: which rental it covers + the absolute signing URL. */
export interface WaiverLink {
  /** Activity the waiver covers, e.g. "24' Pontoon Rental". */
  label: string;
  /** Absolute customer signing URL (`{web base}/waiver/{orderItemId}`). */
  url: string;
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
  /**
   * Amount still owed at the marina, in integer cents. When > 0 the email states
   * the amount due on arrival and what to bring. Defaults to 0 (nothing owed).
   */
  balanceDueCents?: number;
  /** Cancellation policy text to display to the guest. */
  cancellationPolicy: string;
  /**
   * Inline SVG markup for the booking's real, HMAC-signed check-in QR (built by
   * the API from @marina/core). When present it renders a scannable code staff
   * verify at the dock; when absent (e.g. a cancelled order) the email falls back
   * to the plain "present your confirmation number" note. The order number is
   * always shown as the human-readable fallback.
   */
  checkinQrSvg?: string;
  /**
   * Answers to operator custom questions flagged `show_in_confirmation`, echoed
   * back so the guest sees what they told you. Omitted/empty renders nothing.
   */
  customerDetails?: CustomerDetail[];
  /**
   * Sign-before-you-arrive links, one per booked item that still needs a signed
   * liability waiver. When present, the email renders a prominent call-to-action
   * so the guest signs on their own phone instead of at the dock.
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

const dueBox: React.CSSProperties = {
  backgroundColor: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: '8px',
  color: '#92400e',
  fontSize: '14px',
  lineHeight: '20px',
  margin: '16px 0',
  padding: '16px',
};

const waiverBox: React.CSSProperties = {
  backgroundColor: '#eff6ff',
  border: '1px solid #bfdbfe',
  borderRadius: '8px',
  margin: '16px 0',
  padding: '16px',
  textAlign: 'center',
};

const waiverHeading: React.CSSProperties = {
  color: '#1e3a8a',
  fontSize: '15px',
  fontWeight: 700,
  margin: '0 0 4px',
};

const waiverText: React.CSSProperties = {
  color: '#1e40af',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '4px 0 12px',
};

const waiverUrlText: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '12px',
  lineHeight: '18px',
  margin: '8px 0 0',
  wordBreak: 'break-all',
};

const dueAmount: React.CSSProperties = {
  color: '#92400e',
  fontSize: '18px',
  fontWeight: 700,
  margin: '4px 0 8px',
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
  balanceDueCents = 0,
  cancellationPolicy,
  checkinQrSvg,
  waiverLinks,
  customerDetails,
}: BookingConfirmationProps): React.ReactElement {
  const hasDetails = Boolean(customerDetails && customerDetails.length > 0);
  const owesAtMarina = balanceDueCents > 0;
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
  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`Your booking is confirmed — ${orderNumber}`}
    >
      <Heading style={heading}>You&apos;re booked!</Heading>
      <Text style={paragraph}>
        {owesAtMarina
          ? `Hi ${customerName}, thanks for reserving with ${brandName}. Your spot is held — nothing was charged today, and you'll pay when you arrive. Here are your details.`
          : `Hi ${customerName}, thanks for booking with ${brandName}. Your reservation is confirmed. Here are your details.`}
      </Text>

      {needsWaiver && (
        <Section style={waiverBox}>
          <Text style={waiverHeading}>Sign your waiver before you arrive</Text>
          <Text style={waiverText}>
            Every rental needs a signed liability waiver. Sign now on your phone
            and skip the paperwork at check-in.
          </Text>
          {waiverLinks!.map((link) => (
            <React.Fragment key={link.url}>
              <Button href={link.url} style={waiverButton}>
                {waiverLinks!.length > 1 ? `Sign waiver — ${link.label}` : 'Sign your waiver'}
              </Button>
              <Text style={waiverUrlText}>{link.url}</Text>
            </React.Fragment>
          ))}
        </Section>
      )}

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

      {hasDetails && (
        <>
          <Hr style={{ borderColor: '#e5e7eb', margin: '8px 0' }} />
          <Section style={{ margin: '8px 0' }}>
            <Text style={policyHeading}>Your details</Text>
            {customerDetails!.map((detail, i) => (
              <React.Fragment key={`${detail.label}-${i}`}>
                <Text style={label}>{detail.label}</Text>
                <Text style={value}>{detail.value}</Text>
              </React.Fragment>
            ))}
          </Section>
        </>
      )}

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

      {owesAtMarina && (
        <Section style={dueBox}>
          <Text style={{ ...label, color: '#92400e' }}>Due at the marina</Text>
          <Text style={dueAmount}>{formatUSD(balanceDueCents)}</Text>
          <Text style={{ margin: 0, color: '#92400e', fontSize: '13px', lineHeight: '20px' }}>
            Nothing was charged today — your spot is reserved. Pay when you arrive.
            Bring {formatUSD(balanceDueCents)} and a photo ID; cash and card are
            accepted at check-in.
          </Text>
        </Section>
      )}

      {checkinQrSvg ? (
        <Section style={qrNote}>
          <div
            style={{ margin: '0 auto 8px', width: '160px', height: '160px' }}
            // Trusted, self-contained SVG from the @marina/core QR encoder — no
            // user HTML. Falls back to the confirmation number in clients that
            // strip inline SVG.
            dangerouslySetInnerHTML={{ __html: checkinQrSvg }}
          />
          <Text style={{ margin: 0, color: '#6b7280', fontSize: '13px', lineHeight: '20px' }}>
            Show this check-in code at the dock, or give your confirmation number{' '}
            {orderNumber}.
          </Text>
        </Section>
      ) : (
        <Text style={qrNote}>
          Present your confirmation number {orderNumber} when you arrive.
        </Text>
      )}

      <Text style={policyHeading}>Cancellation policy</Text>
      <Text style={policyText}>{cancellationPolicy}</Text>
    </BrandLayout>
  );
}

export default BookingConfirmation;
