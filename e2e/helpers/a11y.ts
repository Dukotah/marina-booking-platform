/**
 * The accessibility harness: axe-core against the running stack, plus the assertions
 * axe cannot make.
 *
 * Two halves, and the second one is the point.
 *
 * **What axe can see.** `auditA11y` runs axe-core with the WCAG 2.1 A/AA rule set and
 * splits the result by impact. `serious` and `critical` fail the test. `moderate` and
 * `minor` are printed to the run output and attached to the report, but do not fail.
 * That split is deliberate and is the honest version of a bar: a suite that failed on
 * every impact level would have been tuned down to a passing subset within a week, and
 * a suite that failed on nothing would be a claim rather than a check. Reporting the
 * lower band keeps it visible without giving anyone a reason to weaken the top band.
 *
 * **What axe cannot see.** Axe is a static pass over one rendered tree. It cannot tell
 * you that focus went nowhere after a failed submit, that Tab walks out of a modal onto
 * the page behind it, that a focus ring is invisible, or that a spinner replaced a
 * control with an unnamed box. Those are the failures that actually strand somebody
 * mid-booking, so the rest of this file is the primitives for asserting them directly:
 * `focusedDescriptor`, `tabTour`, `focusIndicator`, `describedByText`.
 *
 * Nothing here may be relaxed to make a run green. If an audit fails, the product is
 * wrong — see docs/ACCESSIBILITY.md §3 for the ones already known and unowned.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/** Axe's own result shapes, taken from the builder rather than imported from
 *  `axe-core` — that package is a transitive dependency and is not hoisted, so a
 *  direct import would typecheck here and break on a clean install. */
type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type Violation = AxeResults['violations'][number];
type Impact = NonNullable<Violation['impact']>;

/**
 * WCAG 2.1 Level AA, and nothing else.
 *
 * `best-practice` is excluded on purpose: it carries rules that are good advice but are
 * not the conformance claim this product makes (`region`, `skip-link`, heading-order in
 * some versions). Mixing them in would let an argument about whether a best-practice
 * finding "counts" turn into an argument about the whole suite. Where a best-practice
 * rule guards something this flow genuinely depends on — the skip link having a target —
 * the spec asserts it explicitly instead.
 */
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** Impacts that fail a test. */
const BLOCKING: readonly Impact[] = ['critical', 'serious'];

export interface AuditOptions {
  /** Restrict the scan, e.g. to one region of a page. Defaults to the whole document. */
  include?: string;
  /** Subtrees to skip. */
  exclude?: string[];
  /**
   * Rules to switch off, each with the reason. A rule may only be disabled because it
   * cannot produce a meaningful result here (a fixture's own markup, a known axe false
   * positive) — never because the product fails it.
   */
  disableRules?: Record<string, string>;
}

/** One audit's outcome, kept so a spec can assert on it and so the run can total up. */
export interface AuditResult {
  surface: string;
  url: string;
  blocking: Violation[];
  advisory: Violation[];
  passes: number;
}

/**
 * Audit one rendered surface.
 *
 * The page must already be in the state under test — a page object's `open()` has
 * returned, the skeletons have resolved, the error state is on screen. Auditing a
 * loading state by accident is the classic way to get a clean report about nothing.
 */
export async function auditA11y(
  page: Page,
  testInfo: TestInfo,
  surface: string,
  options: AuditOptions = {},
): Promise<AuditResult> {
  let builder = new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]);

  if (options.include) builder = builder.include(options.include);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  const disabled = Object.keys(options.disableRules ?? {});
  if (disabled.length > 0) builder = builder.disableRules(disabled);

  const results = await builder.analyze();

  const blocking = results.violations.filter((v) => BLOCKING.includes(v.impact as Impact));
  const advisory = results.violations.filter((v) => !BLOCKING.includes(v.impact as Impact));

  const audit: AuditResult = {
    surface,
    url: results.url,
    blocking,
    advisory,
    passes: results.passes.length,
  };
  // The full machine-readable result, so a finding can be chased without re-running.
  await testInfo.attach(`axe-${slug(surface)}.json`, {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });

  /*
   * One line per surface, always — pass or fail. Deliberately printed here rather than
   * totalled in a `test.afterAll`: Playwright starts a fresh worker process after a
   * failing test, so a module-level tally would reset every time a surface failed and
   * report a number that was only ever a fraction of the run. Per-audit lines sum
   * correctly however the workers happen to fall.
   */
  console.log(
    `  a11y ${blocking.length === 0 ? 'PASS' : 'FAIL'}  ${surface} — ` +
      `${blocking.length} serious/critical, ${advisory.length} moderate/minor, ` +
      `${results.passes.length} axe checks passed`,
  );

  if (advisory.length > 0) {
    // stdout, not an assertion: visible in `--reporter=line`, attached to the HTML
    // report, and incapable of turning a moderate finding into a red build that
    // somebody then "fixes" by widening the ignore list.
    console.log(
      [
        `  a11y ADVISORY — ${surface} (moderate/minor, reported not failed)`,
        ...formatViolations(advisory).map((line) => `  ${line}`),
      ].join('\n'),
    );
  }

  // Asserted on a one-line-per-rule projection rather than on the violation objects
  // themselves. The objects carry every matched node's full HTML, so a real failure
  // printed thousands of lines of diff and buried the four lines that said what broke.
  // The detail is in the message above and in the JSON attachment.
  expect(
    blocking.map((v) => `${v.id} [${v.impact}] ×${v.nodes.length}`),
    blocking.length === 0
      ? ''
      : [
          `${blocking.length} serious/critical WCAG 2.1 AA violation(s) on ${surface}`,
          `  ${results.url}`,
          ...formatViolations(blocking).map((line) => `  ${line}`),
          '',
          '  Fix the product. Do not narrow the tag set or disable the rule.',
        ].join('\n'),
  ).toEqual([]);

  return audit;
}

/** Human-readable lines for a set of violations, capped so a failure stays readable. */
function formatViolations(violations: Violation[], nodesPerRule = 4): string[] {
  const lines: string[] = [];
  for (const v of violations) {
    lines.push(`• [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node(s))`);
    for (const node of v.nodes.slice(0, nodesPerRule)) {
      const target = node.target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : String(t))).join(', ');
      const why = (node.failureSummary ?? '').split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
      lines.push(`    ${target}`);
      if (why) lines.push(`      ${why}`);
    }
    if (v.nodes.length > nodesPerRule) {
      lines.push(`    … and ${v.nodes.length - nodesPerRule} more node(s)`);
    }
    lines.push(`    ${v.helpUrl}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The things axe cannot see
// ---------------------------------------------------------------------------

/** A description of one element, in the terms a screen reader would announce it. */
export interface FocusDescriptor {
  tag: string;
  id: string;
  role: string;
  /** Accessible name, computed the cheap way: aria-label → aria-labelledby → text. */
  name: string;
  /** Text of whatever `aria-describedby` points at, joined. */
  description: string;
  /** `aria-label` of the nearest ancestor radiogroup/group/dialog, if any. */
  group: string;
  /** True when the element is inside the given selector (used for trap checks). */
  inDocument: boolean;
}

/**
 * Describe `document.activeElement`.
 *
 * The name computation is deliberately a simplification of the accname algorithm —
 * enough to tell two controls apart in an assertion message, not enough to be a
 * conformance checker. Axe owns conformance; this owns "which thing has focus".
 */
export async function focusedDescriptor(page: Page): Promise<FocusDescriptor> {
  return page.evaluate(() => {
    // Focus inside a shadow root reports the host at document level; follow it down.
    let el = document.activeElement as HTMLElement | null;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
    if (!el) {
      return { tag: 'NONE', id: '', role: '', name: '', description: '', group: '', inDocument: false };
    }

    const textOf = (node: Element | null): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const byIds = (ids: string | null): string =>
      (ids ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean)
        .join(' ');

    const label =
      el.getAttribute('aria-label')?.trim() ||
      byIds(el.getAttribute('aria-labelledby')) ||
      (el.id ? textOf(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) : '') ||
      textOf(el.closest('label')) ||
      textOf(el);

    const container = el.closest('[role="radiogroup"], [role="group"], [role="dialog"], form');

    return {
      tag: el.tagName,
      id: el.id ?? '',
      role: el.getAttribute('role') ?? '',
      name: label.slice(0, 120),
      description: byIds(el.getAttribute('aria-describedby')).slice(0, 240),
      group: container?.getAttribute('aria-label') ?? container?.tagName ?? '',
      inDocument: el !== document.body,
    };
  });
}

/**
 * Wait until focus lands somewhere matching `pattern`, then report where it actually
 * is — matched or not.
 *
 * Returns instead of throwing, and that is the point. A page can have several
 * independent focus and labelling problems at once; an assertion that throws on the
 * first one hides every other finding on that surface for the whole run, which is the
 * opposite of what an audit is for. The caller decides whether to assert softly.
 */
export async function settledFocus(
  page: Page,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let where = '';
  do {
    const at = await focusedDescriptor(page);
    where = `<${at.tag}${at.id ? `#${at.id}` : ''}> ${at.name}`;
    if (pattern.test(where)) return where;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return where;
}

/**
 * Press Tab `steps` times, describing where focus lands each time.
 *
 * Returned in order, so a spec can assert the sequence a keyboard user walks rather
 * than asserting that some particular element is reachable at all. `Shift+Tab` when
 * `reverse` is set, for the backwards escape route a naive focus trap leaves open.
 */
export async function tabTour(
  page: Page,
  steps: number,
  options: { reverse?: boolean } = {},
): Promise<FocusDescriptor[]> {
  const key = options.reverse ? 'Shift+Tab' : 'Tab';
  const stops: FocusDescriptor[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(key);
    stops.push(await focusedDescriptor(page));
  }
  return stops;
}

/** What a focus indicator looks like, unfocused vs focused. */
export interface FocusIndicator {
  outlineWidthPx: number;
  outlineStyle: string;
  outlineColor: string;
  boxShadow: string;
  /** The browser's own `:focus-visible` verdict while focused. */
  focusVisible: boolean;
  /** True when focusing changed outline or box-shadow in a way a sighted user can see. */
  visible: boolean;
}

/**
 * Focus `target` the way a keyboard user does, and measure what changed.
 *
 * The subtlety is `:focus-visible`. A bare `locator.focus()` is a programmatic focus,
 * and Chromium suppresses the ring for one of those on a non-text control — so an
 * assertion built on it would report "no visible focus indicator" for a button that
 * rings perfectly well under Tab. What Chromium actually keys on is the *modality* of
 * the last real input event, so this presses a real Tab first (setting modality to
 * keyboard) and then moves focus to the target. `matches(':focus-visible')` is returned
 * alongside the styles so a spec can assert on the browser's own verdict rather than on
 * an inference from a computed value.
 */
export async function focusIndicator(page: Page, target: Locator): Promise<FocusIndicator> {
  const read = () =>
    target.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        outlineWidth: cs.outlineWidth,
        outlineStyle: cs.outlineStyle,
        outlineColor: cs.outlineColor,
        boxShadow: cs.boxShadow,
        focusVisible: el.matches(':focus-visible'),
      };
    });

  await target.evaluate((el) => (el as HTMLElement).blur());
  const before = await read();

  // A real key event, so the browser's focus modality is "keyboard" before we land.
  await page.keyboard.press('Tab');
  await target.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
  await expect(target).toBeFocused();

  const after = await read();

  const width = parseFloat(after.outlineWidth) || 0;
  const grewOutline = width > 0 && after.outlineStyle !== 'none';
  const changedShadow = after.boxShadow !== before.boxShadow && after.boxShadow !== 'none';

  return {
    outlineWidthPx: width,
    outlineStyle: after.outlineStyle,
    outlineColor: after.outlineColor,
    boxShadow: after.boxShadow,
    focusVisible: after.focusVisible,
    visible: grewOutline || changedShadow,
  };
}

/** The text a screen reader would read as the description of `target`. */
export async function describedByText(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    return ids
      .map((id) => (document.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
  });
}

/** Ids referenced by `aria-describedby` that do not resolve to an element. */
export async function danglingDescribedBy(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-describedby]')).flatMap((el) =>
      (el.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .filter((id) => !document.getElementById(id))
        .map((id) => `${el.tagName.toLowerCase()}#${el.id || '(no id)'} → #${id}`),
    ),
  );
}

// ---------------------------------------------------------------------------

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
