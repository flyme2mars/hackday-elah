import { webkit } from 'playwright';
const browser = await webkit.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => logs.push(['console', msg.type(), msg.text()]));
page.on('pageerror', (err) => logs.push(['pageerror', err.message, err.stack || '']));
page.on('requestfailed', (req) => logs.push(['fail', req.url(), req.failure()?.errorText || '']));
await page.goto('http://127.0.0.1:43123/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
const root = await page.evaluate(() => {
  const r = document.getElementById('root');
  return { kids: r?.children.length ?? -1, len: r?.innerHTML.length ?? -1, title: document.title };
});
console.log(JSON.stringify({ root, logs }, null, 2));
await browser.close();
