/**
 * CLI: provision a new operator (client) via the shared engine.
 *
 *   node --experimental-strip-types scripts/new-operator.ts \
 *     --slug russian-river-kayak --name "Russian River Kayak Co." \
 *     --color "#16a34a" --owner-name "Sam Rivera" --owner-email sam@rrkayak.com \
 *     [--owner-auth dev-rrkayak] [--city Guerneville] [--state CA] \
 *     [--tax 8.5] [--fee 3.5] [--with-demo]
 *
 * --with-demo also seeds a few activities + 30 days of timeslots so the new
 * client's dashboards aren't empty (handy for testing). Run with .env loaded.
 */

import { createOperator, ProvisionError, adminPrisma } from '../src/index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function seedDemoCatalog(operatorId: string, locationId: string) {
  const demo = [
    { name: 'Single Kayak Rental', category: 'WATERCRAFT' as const, cap: 1, price: 4500, color: '#16a34a' },
    { name: 'Tandem Kayak Rental', category: 'WATERCRAFT' as const, cap: 2, price: 6500, color: '#0d9488' },
    { name: 'Guided River Tour (2 hr)', category: 'TOUR' as const, cap: 8, price: 9500, color: '#0ea5e9' },
  ];
  await adminPrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_operator_id = '${operatorId}'`);
    let sort = 0;
    for (const d of demo) {
      const activity = await tx.activity.create({
        data: {
          operator_id: operatorId,
          location_id: locationId,
          name_internal: d.name,
          name_external: d.name,
          category: d.category,
          min_participants: 1,
          max_participants: d.cap,
          color: d.color,
          waiver_required: true,
          sort_index: sort++,
        },
      });
      await tx.rate.create({
        data: {
          operator_id: operatorId,
          activity_id: activity.id,
          name_internal: 'Standard',
          name_external: 'Standard',
          price_cents: d.price,
          duration_minutes: 120,
          is_from_price: true,
        },
      });
      const day0 = new Date();
      day0.setUTCHours(0, 0, 0, 0);
      const slots: { operator_id: string; activity_id: string; datetime: Date; capacity_total: number }[] = [];
      for (let day = 1; day <= 30; day++) {
        for (const h of [9, 11, 13, 15]) {
          const dt = new Date(day0);
          dt.setUTCDate(day0.getUTCDate() + day);
          dt.setUTCHours(h + 7, 0, 0, 0);
          slots.push({ operator_id: operatorId, activity_id: activity.id, datetime: dt, capacity_total: d.cap });
        }
      }
      await tx.timeslot.createMany({ data: slots });
    }
  });
}

async function main() {
  const slug = arg('slug');
  const name = arg('name');
  const ownerName = arg('owner-name');
  const ownerEmail = arg('owner-email');
  if (!slug || !name || !ownerName || !ownerEmail) {
    console.error('Required: --slug --name --owner-name --owner-email');
    process.exit(1);
  }

  const result = await createOperator({
    slug,
    nameExternal: name,
    brandColor: arg('color'),
    timezone: arg('tz'),
    website: arg('website'),
    phone: arg('phone'),
    location: { city: arg('city'), state: arg('state') },
    owner: {
      name: ownerName,
      email: ownerEmail,
      // Dev shim id so you can log into this client's admin locally via
      // `x-dev-staff-id`. In prod this would be the Clerk user id.
      authUserId: arg('owner-auth') || `dev-${slug}`,
    },
    salesTaxPercent: arg('tax') ? Number(arg('tax')) : undefined,
    processingFeePercent: arg('fee') ? Number(arg('fee')) : undefined,
  });

  console.log(`✅ Created client "${name}"`);
  console.log(`   slug:        ${result.slug}`);
  console.log(`   operatorId:  ${result.operatorId}`);
  console.log(`   owner login: x-dev-staff-id: ${arg('owner-auth') || `dev-${slug}`}`);

  if (flag('with-demo')) {
    await seedDemoCatalog(result.operatorId, result.locationId);
    console.log(`   demo catalog: 3 activities + 30 days of timeslots seeded`);
  }
}

main()
  .catch((e) => {
    if (e instanceof ProvisionError) console.error(`❌ ${e.message}`);
    else console.error('❌ Failed:', e);
    process.exit(1);
  })
  .finally(() => adminPrisma.$disconnect());
