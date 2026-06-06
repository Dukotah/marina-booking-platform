'use client';

import { useMemo, useState, useTransition } from 'react';
import { Sailboat, Package, Gift } from 'lucide-react';
import { calculatePricing, createId, type PricingFee } from '@marina/core';
import { cn } from '../../lib/cn';
import { PageHeader } from '../shell/PageHeader';
import { submitSale } from '../../app/pos/actions';
import { ActivityCatalog } from './ActivityCatalog';
import { MerchandiseCatalog } from './MerchandiseCatalog';
import { MiscTab } from './MiscTab';
import { Cart } from './Cart';
import { PaymentPanel } from './PaymentPanel';
import { CodeSearch } from './CodeSearch';
import type {
  CartLine,
  PosActivity,
  PosConfig,
  PosMerchandise,
  PosPaymentMethod,
  SaleResult,
} from './types';

/**
 * The integrated point-of-sale terminal. Single-screen register: three entry tabs
 * (walk-up bookings, merchandise, gift/misc) feed one cart; a payment panel takes
 * cash or card and checks out via a server action. A QR/code search box pulls up
 * existing orders. All money is recomputed authoritatively server-side at checkout —
 * the client breakdown here is a faithful preview using the same @marina/core engine.
 */
type Tab = 'BOOKINGS' | 'MERCH' | 'MISC';

const TABS: Array<{ id: Tab; label: string; icon: typeof Sailboat }> = [
  { id: 'BOOKINGS', label: 'Walk-up booking', icon: Sailboat },
  { id: 'MERCH', label: 'Merchandise', icon: Package },
  { id: 'MISC', label: 'Gift / misc', icon: Gift },
];

export interface PosTerminalProps {
  activities: PosActivity[];
  merchandise: PosMerchandise[];
  config: PosConfig;
}

const emptyCustomer = { firstName: '', lastName: '', email: '', phone: '' };

export function PosTerminal({ activities, merchandise, config }: PosTerminalProps) {
  const [tab, setTab] = useState<Tab>('BOOKINGS');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [method, setMethod] = useState<PosPaymentMethod>('CARD');
  const [tipCents, setTipCents] = useState(0);
  const [cashTenderedCents, setCashTenderedCents] = useState(0);
  const [giftCardCode, setGiftCardCode] = useState('');
  const [giftCardAmountCents, setGiftCardAmountCents] = useState(0);
  const [customer, setCustomer] = useState(emptyCustomer);
  const [result, setResult] = useState<SaleResult | null>(null);
  const [submitting, startSubmit] = useTransition();

  // Authoritative-shape preview using the shared pricing engine + operator fees.
  const fees: PricingFee[] = useMemo(
    () => config.fees.map((f) => ({ name: f.name, type: f.type, value: f.value })),
    [config.fees],
  );

  const pricing = useMemo(
    () =>
      calculatePricing({
        items: lines.map((l) => ({ unitPriceCents: l.unitPriceCents, quantity: l.quantity })),
        fees,
        tipCents,
      }),
    [lines, fees, tipCents],
  );

  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);

  function addLine(line: Omit<CartLine, 'key'>) {
    setResult(null);
    setLines((prev) => {
      // Merge identical booking/merch lines (same refs) by bumping quantity.
      const matchIndex = prev.findIndex(
        (l) =>
          l.kind === line.kind &&
          l.label === line.label &&
          l.unitPriceCents === line.unitPriceCents &&
          l.activityId === line.activityId &&
          l.rateId === line.rateId &&
          l.timeslotId === line.timeslotId &&
          l.merchandiseId === line.merchandiseId &&
          // MISC lines are always distinct so each charge stands alone.
          line.kind !== 'MISC',
      );
      if (matchIndex >= 0) {
        const next = [...prev];
        next[matchIndex] = {
          ...next[matchIndex],
          quantity: next[matchIndex].quantity + line.quantity,
        };
        return next;
      }
      return [...prev, { ...line, key: createId() }];
    });
  }

  function changeQuantity(key: string, quantity: number) {
    if (quantity <= 0) {
      removeLine(key);
      return;
    }
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, quantity } : l)));
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function resetSale() {
    setLines([]);
    setTipCents(0);
    setCashTenderedCents(0);
    setGiftCardCode('');
    setGiftCardAmountCents(0);
    setCustomer(emptyCustomer);
    setResult(null);
    setTab('BOOKINGS');
  }

  function checkout() {
    if (lines.length === 0) return;
    setResult(null);
    const hasCustomer = customer.firstName.trim() && customer.lastName.trim();
    startSubmit(async () => {
      const res = await submitSale({
        lines: lines.map((l) => ({
          kind: l.kind,
          label: l.label,
          unitPriceCents: l.unitPriceCents,
          quantity: l.quantity,
          activityId: l.activityId,
          rateId: l.rateId,
          timeslotId: l.timeslotId,
          merchandiseId: l.merchandiseId,
        })),
        paymentMethod: method,
        tipCents,
        cashTenderedCents: method === 'CASH' ? cashTenderedCents : undefined,
        giftCardCode: method === 'GIFT_CARD' ? giftCardCode.trim() : undefined,
        giftCardAmountCents:
          method === 'GIFT_CARD' && giftCardAmountCents > 0 ? giftCardAmountCents : undefined,
        customer: hasCustomer
          ? {
              firstName: customer.firstName.trim(),
              lastName: customer.lastName.trim(),
              email: customer.email.trim() || undefined,
              phone: customer.phone.trim() || undefined,
            }
          : undefined,
      });
      setResult(res);
    });
  }

  return (
    <div>
      <PageHeader
        title="Point of Sale"
        description={`Register · ${config.operatorName}`}
      />

      <div className="mb-4">
        <CodeSearch />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        {/* Entry tabs + content */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-100 pb-3">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    tab === t.id
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {t.label}
                </button>
              );
            })}
          </div>

          {tab === 'BOOKINGS' ? (
            <ActivityCatalog activities={activities} onAdd={addLine} />
          ) : null}
          {tab === 'MERCH' ? (
            <MerchandiseCatalog items={merchandise} onAdd={addLine} />
          ) : null}
          {tab === 'MISC' ? <MiscTab onAdd={addLine} /> : null}
        </div>

        {/* Cart + payment */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <Cart
              lines={lines}
              pricing={pricing}
              onChangeQuantity={changeQuantity}
              onRemove={removeLine}
              onClear={resetSale}
            />
          </div>

          <PaymentPanel
            totalCents={pricing.totalCents}
            itemCount={itemCount}
            method={method}
            onMethodChange={setMethod}
            tipCents={tipCents}
            onTipChange={setTipCents}
            cashTenderedCents={cashTenderedCents}
            onCashTenderedChange={setCashTenderedCents}
            giftCardCode={giftCardCode}
            onGiftCardCodeChange={setGiftCardCode}
            giftCardAmountCents={giftCardAmountCents}
            onGiftCardAmountChange={setGiftCardAmountCents}
            customer={customer}
            onCustomerChange={setCustomer}
            submitting={submitting}
            result={result}
            onCheckout={checkout}
            onNewSale={resetSale}
          />
        </div>
      </div>
    </div>
  );
}
