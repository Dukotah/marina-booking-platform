import * as React from 'react';
import { Column, Heading, Hr, Row, Section, Text } from '@react-email/components';
import { formatUSD } from '@marina/types';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

export interface BookingCancelledProps extends BrandProps {
  /** Order/confirmation number that was cancelled. */
  orderNumber: string;
  /** Customer's first name (or full name) for the greeting. */
  customerName: string;
  /** What was booked (activity + party), for the "what was cancelled" line. */
  activityName: string;
  /** Human-readable date of the cancelled booking (or a fallback label). */
  dateLabel: string;
  /** Human-readable start time (may be empty when the slot is unknown). */
  timeLabel?: string;
  /** Location of the cancelled booking, when known. */
  locationLabel?: string;
  /** Free-text cancellation reason, when one was recorded. */
  reason?: string;
  /**
   * Total refunded in this cancellation, integer cents. Zero is a valid,
   * meaningful outcome (a within-window / no-refund tier) and is stated plainly.
   */
  refundedCents: number;
  /** Of the refund, how much went back to the original card (cents). */
  cardRefundCents?: number;
  /** Of the refund, how much was issued as gift-card credit (cents). */
  giftRefundCents?: number;
  /** Cancellation fee withheld under the policy, integer cents (0 = none). */
  feeCents?: number;
  /** Optional masked card the refund went back to, e.g. "Visa ending 4242". */
  cardLabel?: string;
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

const amountBox: React.CSSProperties = {
  backgroundColor: '#f9fafb',
  borderRadius: '8px',
  margin: '16px 0',
  padding: '20px',
  textAlign: 'center',
};

const amountLabel: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '13px',
  margin: '0 0 4px',
};

const amountValue: React.CSSProperties = {
  color: '#065f46',
  fontSize: '30px',
  fontWeight: 700,
  margin: 0,
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

/** Describe where/how the refund was disbursed, for the summary + the refund line. */
function refundMethodLabel(
  cardRefundCents: number,
  giftRefundCents: number,
  cardLabel?: string,
): string | null {
  const parts: string[] = [];
  if (cardRefundCents > 0) parts.push(cardLabel ?? 'your card');
  if (giftRefundCents > 0) parts.push('gift-card credit');
  return parts.length > 0 ? parts.join(' and ') : null;
}

export function BookingCancelled({
  brandName,
  brandColor,
  logoUrl,
  orderNumber,
  customerName,
  activityName,
  dateLabel,
  timeLabel,
  locationLabel,
  reason,
  refundedCents,
  cardRefundCents = 0,
  giftRefundCents = 0,
  feeCents = 0,
  cardLabel,
}: BookingCancelledProps): React.ReactElement {
  const whenLabel = timeLabel ? `${dateLabel} at ${timeLabel}` : dateLabel;
  const refundedTo = refundMethodLabel(cardRefundCents, giftRefundCents, cardLabel);
  const hasRefund = refundedCents > 0;

  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`Your booking ${orderNumber} has been cancelled`}
    >
      <Heading style={heading}>Your booking has been cancelled</Heading>
      <Text style={paragraph}>
        Hi {customerName}, your reservation with {brandName} has been cancelled. Here&apos;s
        a summary of what changed.
      </Text>

      <Section style={amountBox}>
        <Text style={amountLabel}>{hasRefund ? 'Amount refunded' : 'Refund'}</Text>
        <Text style={amountValue}>
          {hasRefund ? formatUSD(refundedCents) : 'No refund issued'}
        </Text>
        {hasRefund && refundedTo ? (
          <Text style={{ ...amountLabel, margin: '6px 0 0' }}>to {refundedTo}</Text>
        ) : null}
      </Section>

      <Section>
        <Row>
          <Column>
            <Text style={lineLabel}>Booking</Text>
          </Column>
          <Column>
            <Text style={lineValue}>{activityName}</Text>
          </Column>
        </Row>
        <Row>
          <Column>
            <Text style={lineLabel}>When</Text>
          </Column>
          <Column>
            <Text style={lineValue}>{whenLabel}</Text>
          </Column>
        </Row>
        {locationLabel ? (
          <Row>
            <Column>
              <Text style={lineLabel}>Location</Text>
            </Column>
            <Column>
              <Text style={lineValue}>{locationLabel}</Text>
            </Column>
          </Row>
        ) : null}
        <Row>
          <Column>
            <Text style={lineLabel}>Order number</Text>
          </Column>
          <Column>
            <Text style={{ ...lineValue, fontWeight: 600, color: brandColor }}>
              {orderNumber}
            </Text>
          </Column>
        </Row>
        {reason ? (
          <Row>
            <Column>
              <Text style={lineLabel}>Reason</Text>
            </Column>
            <Column>
              <Text style={lineValue}>{reason}</Text>
            </Column>
          </Row>
        ) : null}

        {hasRefund || feeCents > 0 ? (
          <>
            <Hr style={{ borderColor: '#e5e7eb', margin: '8px 0' }} />
            {cardRefundCents > 0 ? (
              <Row>
                <Column>
                  <Text style={lineLabel}>Refunded to card</Text>
                </Column>
                <Column>
                  <Text style={lineValue}>{formatUSD(cardRefundCents)}</Text>
                </Column>
              </Row>
            ) : null}
            {giftRefundCents > 0 ? (
              <Row>
                <Column>
                  <Text style={lineLabel}>Gift-card credit</Text>
                </Column>
                <Column>
                  <Text style={lineValue}>{formatUSD(giftRefundCents)}</Text>
                </Column>
              </Row>
            ) : null}
            {feeCents > 0 ? (
              <Row>
                <Column>
                  <Text style={lineLabel}>Cancellation fee</Text>
                </Column>
                <Column>
                  <Text style={lineValue}>{formatUSD(feeCents)}</Text>
                </Column>
              </Row>
            ) : null}
          </>
        ) : null}
      </Section>

      <Text style={paragraph}>
        {hasRefund
          ? 'Refunds typically take 5–10 business days to appear on your statement, depending on your bank.'
          : 'This cancellation falls outside the refund window of your booking policy, so no refund was issued.'}{' '}
        If you have any questions, just reply to this email.
      </Text>
    </BrandLayout>
  );
}

export default BookingCancelled;
