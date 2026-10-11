import * as React from 'react';
import { Column, Heading, Hr, Row, Section, Text } from '@react-email/components';
import { formatUSD } from '@marina/types';
import { BrandLayout, type BrandProps } from './components/BrandLayout.js';

export interface GiftCardIssuedProps extends BrandProps {
  /** The human-typable redemption code, e.g. "A7QK-9MTX-3RJP". */
  code: string;
  /** Face value of the card in integer cents. */
  amountCents: number;
  /** Recipient's name for the greeting, if provided. */
  recipientName?: string;
  /** Who sent it, if provided (shown as "from"). */
  purchaserName?: string;
  /** A personal gift message, if provided. */
  giftMessage?: string;
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

const codeBox: React.CSSProperties = {
  backgroundColor: '#111827',
  borderRadius: '8px',
  margin: '16px 0',
  padding: '18px',
  textAlign: 'center',
};

const codeValue: React.CSSProperties = {
  color: '#ffffff',
  fontSize: '26px',
  fontWeight: 700,
  letterSpacing: '3px',
  fontFamily: 'monospace',
  margin: 0,
};

const messageBox: React.CSSProperties = {
  borderLeft: '3px solid #e5e7eb',
  margin: '16px 0',
  padding: '4px 0 4px 16px',
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

export function GiftCardIssued({
  brandName,
  brandColor,
  logoUrl,
  code,
  amountCents,
  recipientName,
  purchaserName,
  giftMessage,
}: GiftCardIssuedProps): React.ReactElement {
  return (
    <BrandLayout
      brandName={brandName}
      brandColor={brandColor}
      logoUrl={logoUrl}
      preview={`You have a ${formatUSD(amountCents)} gift card for ${brandName}`}
    >
      <Heading style={heading}>You&apos;ve received a gift card</Heading>
      <Text style={paragraph}>
        {recipientName ? `Hi ${recipientName}, ` : 'Hi, '}
        {purchaserName ? `${purchaserName} sent you ` : "here's "}a gift card for{' '}
        {brandName}. Use the code below at checkout toward any booking.
      </Text>

      <Section style={amountBox}>
        <Text style={amountLabel}>Gift card value</Text>
        <Text style={amountValue}>{formatUSD(amountCents)}</Text>
      </Section>

      <Section style={codeBox}>
        <Text style={codeValue}>{code}</Text>
      </Section>

      {giftMessage ? (
        <Section style={messageBox}>
          <Text style={{ ...paragraph, fontStyle: 'italic', margin: 0 }}>
            &ldquo;{giftMessage}&rdquo;
          </Text>
        </Section>
      ) : null}

      <Hr style={{ borderColor: '#e5e7eb', margin: '16px 0' }} />

      <Section>
        <Row>
          <Column>
            <Text style={lineLabel}>Your code</Text>
          </Column>
          <Column>
            <Text style={{ ...lineValue, fontWeight: 600, color: brandColor }}>{code}</Text>
          </Column>
        </Row>
        <Row>
          <Column>
            <Text style={lineLabel}>Balance</Text>
          </Column>
          <Column>
            <Text style={{ ...lineValue, fontWeight: 700, color: '#111827' }}>
              {formatUSD(amountCents)}
            </Text>
          </Column>
        </Row>
      </Section>

      <Text style={paragraph}>
        Keep this code safe &mdash; anyone who has it can spend the balance. Enter it at
        checkout to apply it toward your reservation. If you have any questions, just reply
        to this email.
      </Text>
    </BrandLayout>
  );
}

export default GiftCardIssued;
