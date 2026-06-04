import * as React from 'react';
import { Column, Heading, Hr, Row, Section, Text } from '@react-email/components';
import { formatUSD } from '@marina/types';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

export interface RefundReceiptProps extends BrandProps {
  /** Order/confirmation number the refund applies to. */
  orderNumber: string;
  /** Customer's first name (or full name) for the greeting. */
  customerName: string;
  /** Amount refunded, in integer cents. */
  refundedCents: number;
  /** Reason the refund was issued. */
  reason: string;
  /** Original order total, in integer cents. */
  originalTotalCents: number;
  /** Remaining balance after this refund, in integer cents (0 = fully refunded). */
  remainingBalanceCents: number;
  /** Optional human-readable date the refund was processed. */
  processedDateLabel?: string;
  /** Optional masked payment method, e.g. "Visa ending 4242". */
  paymentMethodLabel?: string;
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

export function RefundReceipt({
  brandName,
  brandColor,
  logoUrl,
  orderNumber,
  customerName,
  refundedCents,
  reason,
  originalTotalCents,
  remainingBalanceCents,
  processedDateLabel,
  paymentMethodLabel,
}: RefundReceiptProps): React.ReactElement {
  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`Refund issued for ${orderNumber} — ${formatUSD(refundedCents)}`}
    >
      <Heading style={heading}>Your refund has been issued</Heading>
      <Text style={paragraph}>
        Hi {customerName}, we&apos;ve processed a refund for your order with {brandName}.
      </Text>

      <Section style={amountBox}>
        <Text style={amountLabel}>Amount refunded</Text>
        <Text style={amountValue}>{formatUSD(refundedCents)}</Text>
      </Section>

      <Section>
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
        <Row>
          <Column>
            <Text style={lineLabel}>Reason</Text>
          </Column>
          <Column>
            <Text style={lineValue}>{reason}</Text>
          </Column>
        </Row>
        {processedDateLabel ? (
          <Row>
            <Column>
              <Text style={lineLabel}>Processed</Text>
            </Column>
            <Column>
              <Text style={lineValue}>{processedDateLabel}</Text>
            </Column>
          </Row>
        ) : null}
        {paymentMethodLabel ? (
          <Row>
            <Column>
              <Text style={lineLabel}>Refunded to</Text>
            </Column>
            <Column>
              <Text style={lineValue}>{paymentMethodLabel}</Text>
            </Column>
          </Row>
        ) : null}

        <Hr style={{ borderColor: '#e5e7eb', margin: '8px 0' }} />

        <Row>
          <Column>
            <Text style={lineLabel}>Original total</Text>
          </Column>
          <Column>
            <Text style={lineValue}>{formatUSD(originalTotalCents)}</Text>
          </Column>
        </Row>
        <Row>
          <Column>
            <Text style={{ ...lineLabel, fontWeight: 700, color: '#111827' }}>
              Remaining balance
            </Text>
          </Column>
          <Column>
            <Text style={{ ...lineValue, fontWeight: 700, color: '#111827' }}>
              {formatUSD(remainingBalanceCents)}
            </Text>
          </Column>
        </Row>
      </Section>

      <Text style={paragraph}>
        Refunds typically take 5&ndash;10 business days to appear on your statement,
        depending on your bank. If you have any questions, just reply to this email.
      </Text>
    </BrandLayout>
  );
}

export default RefundReceipt;
