/**
 * Canonical California boat-rental liability-waiver clauses.
 *
 * Shared by the seed (packages/database/prisma/seed.ts) and the idempotent
 * apply script (packages/database/scripts/seed-waiver-clauses.ts) so the legal
 * text lives in exactly one place. Each clause is its own initial-able section;
 * `is_required: false` marks optional consents (e.g. the photo/media release).
 *
 * This text is realistic and plausible for a Northern California lake livery
 * (Lake Sonoma) but is NOT legal advice — an operator should have counsel review
 * it before going live.
 */

export interface WaiverClauseSeed {
  sort_order: number;
  title: string;
  body_html: string;
  requires_initials: boolean;
  is_required: boolean;
}

export const CA_BOAT_WAIVER_CLAUSES: WaiverClauseSeed[] = [
  {
    sort_order: 0,
    title: 'Assumption of Risk & Inherent Dangers of Boating',
    body_html:
      '<p>I understand that operating and riding in or on a vessel, personal watercraft, ' +
      'kayak, canoe, or paddle board is an inherently dangerous activity. Risks include, ' +
      'but are not limited to: capsizing, collision, falling overboard, drowning, ' +
      'propeller injury, carbon monoxide exposure, sunburn, dehydration, hypothermia, ' +
      'submerged objects, wakes and waves, mechanical failure, and the negligence of ' +
      'other boaters. I knowingly and voluntarily assume all such risks, whether known ' +
      'or unknown, and accept full responsibility for my participation and that of my ' +
      'party.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 1,
    title: 'Release of Liability & Indemnification',
    body_html:
      '<p>To the fullest extent permitted by California law, I release, waive, and ' +
      'discharge the Operator, its owners, officers, employees, agents, and the ' +
      'property owner from any and all liability, claims, demands, or causes of action ' +
      'arising out of or related to any loss, damage, injury, or death that may be ' +
      'sustained by me or my party, whether caused by the negligence of the Operator or ' +
      'otherwise. I further agree to indemnify and hold harmless the Operator from any ' +
      'claims brought by or on behalf of me, my guests, or any minor in my care.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 2,
    title: 'Rental Agreement — Equipment, Damage, Fuel & Late Return',
    body_html:
      '<p>I accept the vessel and equipment in good working condition and agree to return ' +
      'it in the same condition, normal wear excepted. I am financially responsible for ' +
      'any loss of or damage to the vessel, motor, trailer, safety equipment, or ' +
      'accessories occurring during my rental, including grounding, propeller and lower-' +
      'unit damage, and damage from improper operation. Vessels are returned fueled per ' +
      'the rental terms; I will pay for refueling plus a service charge if returned ' +
      'under-fueled. Late returns are charged at the posted late rate. A valid credit ' +
      'card on file authorizes these charges.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 3,
    title: 'Operator Competency & California Boater Card / Boating Safety Acknowledgment',
    body_html:
      '<p>I certify that the designated operator is at least 21 years of age, holds a ' +
      'valid California Boater Card (or an accepted equivalent as required by California ' +
      'law), and is competent to operate the rented vessel. This waiver packet ' +
      'supplements — and does not replace — the California Boater Card and all ' +
      'applicable California Harbors &amp; Navigation Code and U.S. Coast Guard ' +
      'requirements. I have received the pre-departure safety orientation and know how ' +
      'to operate the vessel’s controls, navigation lights, and safety equipment.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 4,
    title: 'Alcohol & Drug Policy',
    body_html:
      '<p>I understand that operating a vessel while under the influence of alcohol or ' +
      'drugs is illegal in California (BUI) and grounds for immediate termination of the ' +
      'rental without refund. The designated operator will remain sober and unimpaired ' +
      'at all times while operating the vessel. I accept full responsibility for the ' +
      'conduct of everyone in my party and for compliance with all California boating-' +
      'under-the-influence laws.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 5,
    title: 'Invasive Species — Quagga & Zebra Mussel Inspection (Lake Sonoma)',
    body_html:
      '<p>To protect Lake Sonoma from quagga and zebra mussels and other aquatic ' +
      'invasive species, I agree to comply with all inspection, decontamination, and ' +
      '"Clean, Drain, Dry" requirements. If I bring my own equipment onto the water, I ' +
      'certify it has been cleaned, drained, and dried, and I will submit to any ' +
      'required watercraft inspection. I understand that failure to comply may result in ' +
      'denial of launch and applicable fees or penalties.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 6,
    title: 'Weather & Water Conditions',
    body_html:
      '<p>I understand that weather, wind, water level, and lake conditions can change ' +
      'rapidly and that the Operator may restrict, delay, or recall rentals for safety. ' +
      'I will monitor conditions, return to dock when instructed, and exercise my own ' +
      'judgment to avoid unsafe situations. No refund is owed for time lost to weather ' +
      'once a vessel has departed, except as stated in the posted policy.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 7,
    title: 'USCG Life Jacket / PFD Rules',
    body_html:
      '<p>I agree that a U.S. Coast Guard–approved wearable personal flotation device ' +
      '(PFD) will be available for every person aboard and worn as required. I ' +
      'specifically acknowledge that, under California law, every child under 13 years ' +
      'of age must wear a properly fitted USCG-approved PFD while aboard a moving ' +
      'vessel of 26 feet or less, and while on any personal watercraft, kayak, canoe, or ' +
      'paddle board. I am responsible for ensuring compliance for all minors in my ' +
      'party.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 8,
    title: 'Capacity Limits & Rules of the Waterway',
    body_html:
      '<p>I will not exceed the posted maximum passenger and weight capacity of the ' +
      'vessel. I will obey all rules of the waterway, including no-wake zones, posted ' +
      'speed limits, marker buoys, and swim-area restrictions, and I will maintain a ' +
      'safe distance from swimmers, docks, other vessels, and the shoreline. I will ' +
      'operate at a safe and prudent speed at all times and yield right of way as ' +
      'required by navigation rules.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 9,
    title: 'Minor Participation & Guardian Consent',
    body_html:
      '<p>If any participant is under 18, I represent that I am the parent or legal ' +
      'guardian (or am authorized by them) and I consent to that minor’s participation. ' +
      'On behalf of the minor, I agree to the assumption of risk, release, and ' +
      'indemnification set out above to the fullest extent permitted by California law, ' +
      'and I agree to supervise the minor and ensure their compliance with all safety ' +
      'rules, including PFD requirements.</p>',
    requires_initials: true,
    is_required: true,
  },
  {
    sort_order: 10,
    title: 'Photo/Media Release (optional)',
    body_html:
      '<p>I grant the Operator permission to use photographs, video, or other media in ' +
      'which I or my party may appear, captured during my rental, for promotional and ' +
      'marketing purposes, without compensation. This consent is optional and is not ' +
      'required to rent; you may decline by leaving this section un-initialed.</p>',
    requires_initials: true,
    is_required: false,
  },
];
