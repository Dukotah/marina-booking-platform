import { test, expect } from '@playwright/test';

test('reserve mode full booking journey at 390px', async ({ browser }) => {
  const context = await browser.newContext({ 
    viewport: { width: 390, height: 844 },
    baseURL: 'http://localhost:3000'
  });
  const page = await context.newPage();
  
  // Navigate to activity page 
  await page.goto('http://localhost:3000/activities/pontoon-5-person');
  await expect(page).toHaveTitle(/5-Person Pontoon/);
  
  // Wait for rate group to be visible
  await page.waitForSelector('[role=radiogroup]');
  
  // Take screenshot of activity page
  await page.screenshot({ path: '/tmp/journey-1-activity.png' });
  
  // Select 1-hour rate (first radio in rate group)
  const rateGroup = page.getByRole('radiogroup', { name: 'Choose a rate' });
  const firstRate = rateGroup.getByRole('radio').first();
  await firstRate.click();
  await expect(firstRate).toHaveAttribute('aria-checked', 'true');
  
  // Select a date - Sep 9
  const dateStrip = page.getByRole('radiogroup', { name: 'Choose a date', exact: true });
  await dateStrip.waitFor({ state: 'visible' });
  const sep9 = dateStrip.getByRole('radio', { name: /September 9/ });
  await sep9.waitFor({ state: 'visible' });
  await sep9.click();
  await page.waitForTimeout(1000);
  
  // Check date aria-checked
  const sep9Checked = await sep9.getAttribute('aria-checked');
  console.log('Sep 9 aria-checked after click:', sep9Checked);
  
  // Select time
  const timeGroup = page.getByRole('radiogroup', { name: 'Choose a time' });
  await timeGroup.waitFor({ state: 'visible', timeout: 5000 });
  const firstTime = timeGroup.getByRole('radio').first();
  await firstTime.click();
  
  // Take screenshot  
  await page.screenshot({ path: '/tmp/journey-2-selections.png' });
  
  // Click checkout
  const checkoutBtn = page.getByRole('button', { name: /Continue to checkout/ });
  await expect(checkoutBtn).toBeEnabled();
  await checkoutBtn.click();
  await page.waitForURL(/\/checkout\?/);
  
  await expect(page).toHaveTitle(/Lake Sonoma Marina/);
  const checkoutTitle = await page.title();
  console.log('Checkout title:', checkoutTitle);
  
  await page.screenshot({ path: '/tmp/journey-3-checkout.png' });
  
  // Wait for form to be ready
  await page.waitForFunction(() => {
    const input = document.getElementById('firstName');
    return input && Object.keys(input).some(k => k.startsWith('__reactProps$'));
  }, { timeout: 30000 });
  
  // Fill guest details
  await page.fill('#firstName', 'Lake');
  await page.fill('#lastName', 'Tester');
  await page.fill('#email', 'qa@example.com');
  await page.fill('#phone', '7075551234');
  
  // Fill driver info
  await page.fill('input[name="participants.0.driver_name"]', 'Lake Tester');
  await page.fill('input[name="participants.0.dob"]', '1985-01-15');
  
  // Accept waiver
  const waiverCheckbox = page.getByRole('checkbox', { name: /I have read and agree/ });
  await waiverCheckbox.click();
  await page.fill('input[name=signatureName]', 'Lake Tester');
  
  await page.screenshot({ path: '/tmp/journey-4-filled.png' });
  
  // Submit - in reserve mode, button says "Reserve my spot"
  const submitBtn = page.getByRole('button', { name: /Reserve my spot/ }).last();
  await submitBtn.scrollIntoViewIfNeeded();
  await submitBtn.click();
  
  // Wait for confirmation
  await page.waitForURL(/\/confirmation\?/, { timeout: 30000 });
  
  const confirmUrl = page.url();
  console.log('Confirmation URL:', confirmUrl);
  const orderNum = new URL(confirmUrl).searchParams.get('order');
  console.log('Order number:', orderNum);
  
  const confirmTitle = await page.title();
  console.log('Confirmation title:', confirmTitle);
  
  await page.screenshot({ path: '/tmp/journey-5-confirmation.png' });
  
  // Verify confirmation heading
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/You're all set!/);
  
  console.log('BOOKING JOURNEY COMPLETE');
  
  await context.close();
});
