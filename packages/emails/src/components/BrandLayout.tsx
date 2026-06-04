import * as React from 'react';
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from '@react-email/components';

/**
 * Operator branding shared by every email. White-label: emails always render the
 * *operator's* brand, never the platform's.
 */
export interface BrandProps {
  /** Operator/tenant display name, e.g. "Lake Sonoma Marina". */
  brandName: string;
  /** Operator primary brand color (CSS color, e.g. "#0a6cff"). */
  brandColor: string;
  /** Optional operator logo URL. Falls back to the brand name as text. */
  logoUrl?: string;
}

export interface BrandLayoutProps extends BrandProps {
  /** Inbox preview line. */
  preview: string;
  /** Optional address/contact line shown in the footer. */
  contactLine?: string;
  children: React.ReactNode;
}

const main: React.CSSProperties = {
  backgroundColor: '#f4f5f7',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  margin: 0,
  padding: 0,
};

const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  maxWidth: '600px',
  width: '100%',
  borderRadius: '12px',
  overflow: 'hidden',
  border: '1px solid #e5e7eb',
};

const content: React.CSSProperties = {
  padding: '0 32px 8px',
};

const footer: React.CSSProperties = {
  padding: '0 32px 32px',
};

const footerText: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  lineHeight: '18px',
  margin: '4px 0',
};

const logoImg: React.CSSProperties = {
  display: 'block',
  maxHeight: '48px',
  width: 'auto',
};

const brandNameText: React.CSSProperties = {
  color: '#ffffff',
  fontSize: '22px',
  fontWeight: 700,
  margin: 0,
  lineHeight: '32px',
};

/**
 * Shared email shell: branded header + footer. Every template wraps its body in
 * this so branding and structure stay consistent.
 */
export function BrandLayout({
  brandName,
  brandColor,
  logoUrl,
  preview,
  contactLine,
  children,
}: BrandLayoutProps): React.ReactElement {
  const header: React.CSSProperties = {
    backgroundColor: brandColor,
    padding: '24px 32px',
  };

  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {logoUrl ? (
              <Img src={logoUrl} alt={brandName} style={logoImg} />
            ) : (
              <Text style={brandNameText}>{brandName}</Text>
            )}
          </Section>
          <Section style={content}>{children}</Section>
          <Hr style={{ borderColor: '#e5e7eb', margin: '8px 32px' }} />
          <Section style={footer}>
            {contactLine ? <Text style={footerText}>{contactLine}</Text> : null}
            <Text style={footerText}>
              You are receiving this email because you have a booking or account with{' '}
              {brandName}.
            </Text>
            <Text style={footerText}>
              &copy; {new Date().getFullYear()} {brandName}. All rights reserved.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default BrandLayout;
