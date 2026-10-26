import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';
import { SPONSOR_AD_INTERVAL_MS } from '../../src/services/supporterVisibility';

// The provider creative is replaced by a static loopback page, so these
// journeys cover the placement's own behaviour (frame, timing, suppression),
// not what Adsterra renders inside it.
const LOAD_TIMEOUT_MS = 12_000;
const COUNTDOWN_MS = 10_000;

test('the sponsor card is sandboxed on loopback, closes by itself and returns only after the interval', async ({ page }) => {
  await page.clock.install();
  await desktopFixture(page, { supporterState: 'inactive', settings: { supporterPromptLastShownAt: Date.now() } });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });

  const banner = page.getByRole('complementary', { name: /Sponsored advertisement/ });
  await expect(banner).toBeVisible();
  const frame = banner.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  await expect(frame).toHaveAttribute('src', /^http:\/\/localhost:14201\/ad-banner\?cycle=\d+$/);

  // No creative reports in, so the fallback card takes over and the
  // ten-second countdown then closes the placement without interaction.
  await page.clock.runFor(LOAD_TIMEOUT_MS + 500);
  await expect(banner).toContainText('Closes in');
  await page.clock.runFor(COUNTDOWN_MS + 2_000);
  await expect(banner).toHaveCount(0);

  await page.clock.fastForward(SPONSOR_AD_INTERVAL_MS - 60_000);
  await expect(banner).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(banner).toBeVisible();
});

test('the sponsor frame follows the loopback port the media server really bound', async ({ page }) => {
  await desktopFixture(page, { supporterState: 'inactive', streamingPort: 15999, settings: { supporterPromptLastShownAt: Date.now() } });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  const frame = page.getByRole('complementary', { name: /Sponsored advertisement/ }).locator('iframe');
  await expect(frame).toHaveAttribute('src', /^http:\/\/localhost:15999\/ad-banner\?cycle=\d+$/);
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
});

for (const sponsorPort of [undefined,15997]) for (const supporterState of ['active', 'needs_refresh'] as const) {
  test(`a ${supporterState} supporter gets no sponsor frame on ${sponsorPort ? "separate" : "default"} origin, including after the return interval`, async ({ page }) => {
    await page.clock.install();
    await desktopFixture(page, { supporterState, sponsorPort });
    await page.goto('/');
    await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
    const banner = page.getByRole('complementary', { name: /Sponsored advertisement/ });
    await expect(banner).toHaveCount(0);
    await page.clock.fastForward(SPONSOR_AD_INTERVAL_MS + 60_000);
    await expect(banner).toHaveCount(0);
    await expect(page.locator('iframe[src*="/ad-banner"]')).toHaveCount(0);
  });
}

test('the selected separate sponsor origin remains sandboxed and its fallback opens the existing sponsor destination', async ({ page }) => {
  await page.clock.install();
  await desktopFixture(page, {supporterState:'inactive',streamingPort:15998,sponsorPort:15997,settings:{supporterPromptLastShownAt:Date.now()}});
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg',{exact:true})).toBeVisible({timeout:30_000});
  const banner=page.getByRole('complementary',{name:/Sponsored advertisement/});
  const frame=banner.locator('iframe');
  await expect(frame).toHaveAttribute('src',/^http:\/\/localhost:15997\/ad-banner\?cycle=\d+$/);
  await expect(frame).toHaveAttribute('sandbox','allow-scripts allow-same-origin');
  await page.clock.runFor(LOAD_TIMEOUT_MS+500);
  await banner.getByRole('button',{name:/browser/i}).click();
  const calls=await page.evaluate(()=>(window as any).__desktopTest.calls);
  expect(calls.some((call:any)=>call.command==='plugin:shell|open' && call.args.path?.includes('psid=desktop_banner_fallback'))).toBeTruthy();
  await page.clock.runFor(COUNTDOWN_MS+2000);
  await expect(banner).toHaveCount(0);
});

test('sponsor loading and countdown use the selected language',async ({page})=>{
  await page.clock.install();
  await desktopFixture(page,{supporterState:'inactive',settings:{language:'es',supporterPromptLastShownAt:Date.now()}});
  await page.goto('/');
  const banner=page.getByRole('complementary',{name:/Sponsored advertisement|Anuncio patrocinado/});
  await expect(banner).toBeVisible({timeout:30_000});
  await expect(banner).not.toContainText('Loading…');
  await page.clock.runFor(LOAD_TIMEOUT_MS+500);
  await expect(banner).toContainText('Se cierra en');
  await expect(banner).toHaveAttribute('aria-label',/Anuncio patrocinado/);
});

test('a returning sponsor cycle waits for fresh health before requesting any old origin',async ({page})=>{
  await page.clock.install();
  await desktopFixture(page,{supporterState:'inactive',sponsorPort:15997,settings:{supporterPromptLastShownAt:Date.now()}});
  await page.route('http://localhost:15996/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><p>Recovered sponsor fixture</p>'}));
  const requests:string[]=[];
  page.on('request',request=>{if(request.url().includes('/ad-banner'))requests.push(request.url());});
  await page.goto('/');
  const banner=page.getByRole('complementary',{name:/Sponsored advertisement/});
  await expect(banner.locator('iframe')).toHaveAttribute('src',/15997/);
  await page.clock.runFor(LOAD_TIMEOUT_MS+COUNTDOWN_MS+3000);
  await expect(banner).toHaveCount(0);
  requests.length=0;
  await page.evaluate(()=>{(window as any).__desktopTest.holdStartupHealth=true;});
  await page.clock.fastForward(SPONSOR_AD_INTERVAL_MS+1000);
  await expect(banner).toBeVisible();
  await expect(banner.locator('iframe')).toHaveCount(0);
  expect(requests,'no old-port request is permitted while current health is pending').toEqual([]);
  await page.evaluate(()=>{const state=(window as any).__desktopTest;state.sponsorPort=15996;state.releaseStartupHealth();});
  await expect(banner.locator('iframe')).toHaveAttribute('src',/15996/);
});


test('a pending sponsor-origin lookup cannot postpone the visible fallback deadline', async ({page}) => {
  await page.clock.install();
  await desktopFixture(page, {supporterState: 'inactive', settings: {supporterPromptLastShownAt: Date.now()}});
  await page.goto('/');
  const banner = page.getByRole('complementary', {name: /Sponsored advertisement/});
  await expect(banner.locator('iframe')).toBeVisible();
  await page.clock.runFor(LOAD_TIMEOUT_MS + COUNTDOWN_MS + 3_000);
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => { (window as any).__desktopTest.holdStartupHealth = true; });
  await page.clock.fastForward(SPONSOR_AD_INTERVAL_MS + 1_000);
  await expect(banner).toBeVisible();
  await expect(banner.locator('iframe')).toHaveCount(0);
  await page.clock.runFor(LOAD_TIMEOUT_MS + 500);
  await expect(banner).toContainText('Closes in');
  await expect(banner.getByRole('button', {name: /browser/i})).toBeVisible();
  await page.clock.runFor(COUNTDOWN_MS + 2_000);
  await expect(banner).toHaveCount(0);
});

for (const [language, expected] of [['en', 'Sponsored — View offer'], ['es', 'Patrocinado — Ver oferta'], ['bn-BD', 'স্পন্সর — অফার দেখুন']] as const) {
  test(`TV sponsor button preserves its short offer meaning in ${language}`, async ({page}) => {
    await desktopFixture(page, {platform: 'android', isTelevision: true, supporterState: 'inactive', settings: {language}});
    await page.goto('/?a11y-fixture=sponsor-mobile');
    const button = page.getByRole('button', {name: expected, exact: true});
    await expect(button).toBeVisible();
    await button.click();
    await expect.poll(async () => (await nativeCalls(page, 'plugin:shell|open')).some(call => call.args.path?.includes('psid=android_banner'))).toBe(true);
    expect(await nativeCalls(page, 'cmd_begin_supporter_checkout')).toHaveLength(0);
  });
}
