/**
 * Automation script templates shown in the "New Automation" wizard.
 *
 * Each `code` field is a template string — the body becomes the initial
 * contents of the automation editor when a user clones the template.
 *
 * NOTE: The `console.log(...)` calls inside these template strings are
 * intentional. They're the automation script's own output and go to the
 * per-run session log (visible in the UI), not to the server log.
 * Do not "clean up" these calls — they're example code for users.
 */
export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: 'login' | 'navigation' | 'data-extraction' | 'maintenance';
  tags: string[];
  requiresDevice: boolean;
  requiresHttpsCapture: boolean;
  code: string;
}

export const templates: AutomationTemplate[] = [
  // --- Login Flows ---
  {
    id: 'login-generic-form',
    name: 'Generic Login Form',
    description: 'Automate a standard username/password login form. Customize the selectors and credentials for your target app.',
    category: 'login',
    tags: ['login', 'auth', 'form'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Generic login form automation
  // Customize the package name, selectors, and credentials below

  const APP_PACKAGE = 'com.example.app';
  const USERNAME = 'your_username';
  const PASSWORD = 'your_password';

  await device.startApp(APP_PACKAGE);
  await device.sleep(2000);

  // Wait for login form to appear
  await device.waitFor({ text: 'Sign In' }, 10000);

  // Fill in credentials
  await device.setText({ resourceId: \`\${APP_PACKAGE}:id/username\` }, USERNAME);
  await device.setText({ resourceId: \`\${APP_PACKAGE}:id/password\` }, PASSWORD);

  // Submit
  await device.click({ text: 'Sign In' });

  // Wait for home screen
  await device.waitFor({ text: 'Home' }, 15000);
  await device.screenshot('login-success');
  console.log('Login successful');
}
`,
  },
  {
    id: 'login-google-oauth',
    name: 'Google OAuth Login',
    description: 'Handle Google OAuth sign-in flow, including the Google account picker and consent screens.',
    category: 'login',
    tags: ['login', 'auth', 'google', 'oauth'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Google OAuth login flow
  // Assumes Google account is already signed in on the device

  const APP_PACKAGE = 'com.example.app';

  await device.startApp(APP_PACKAGE);
  await device.sleep(2000);

  // Click "Sign in with Google" button
  await device.waitFor({ text: 'Sign in with Google' }, 10000);
  await device.click({ text: 'Sign in with Google' });
  await device.sleep(3000);

  // Google account picker — select the account
  if (await device.exists({ text: 'Choose an account' })) {
    // Click the first account (or match by email)
    const dom = await device.getDOM();
    const emails = dom.flatten(dom).filter(n => n.text?.includes('@gmail.com'));
    if (emails.length > 0) {
      await device.click({ text: emails[0].text! });
    }
    await device.sleep(2000);
  }

  // Handle consent screen if it appears
  if (await device.exists({ text: 'Allow' })) {
    await device.click({ text: 'Allow' });
    await device.sleep(2000);
  }

  await device.screenshot('oauth-complete');
  console.log('Google OAuth login complete');
}
`,
  },
  {
    id: 'login-otp-2fa',
    name: 'OTP / 2FA Handling',
    description: 'Login flow with OTP or two-factor authentication. Captures the OTP from SMS notifications or a TOTP generator.',
    category: 'login',
    tags: ['login', 'auth', '2fa', 'otp', 'totp'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Login with OTP/2FA handling
  // This template shows how to handle a code entry step after initial login

  const APP_PACKAGE = 'com.example.app';
  const USERNAME = 'your_username';
  const PASSWORD = 'your_password';

  await device.startApp(APP_PACKAGE);
  await device.sleep(2000);

  // Step 1: Enter credentials
  await device.waitFor({ text: 'Sign In' }, 10000);
  await device.setText({ resourceId: \`\${APP_PACKAGE}:id/username\` }, USERNAME);
  await device.setText({ resourceId: \`\${APP_PACKAGE}:id/password\` }, PASSWORD);
  await device.click({ text: 'Sign In' });
  await device.sleep(3000);

  // Step 2: Wait for OTP screen
  await device.waitFor({ text: 'Enter code' }, 15000);
  await device.screenshot('otp-screen');

  // Option A: Read OTP from notification bar
  // await device.pressKey('NOTIFICATION');
  // await device.sleep(1000);
  // const notifDom = await device.getDOM();
  // const otpMatch = dom.getAllText(notifDom).join(' ').match(/\\b(\\d{6})\\b/);
  // await device.pressKey('BACK');

  // Option B: Hardcoded OTP for testing
  const OTP_CODE = '123456';

  await device.setText({ resourceId: \`\${APP_PACKAGE}:id/otp_input\` }, OTP_CODE);
  await device.click({ text: 'Verify' });

  await device.waitFor({ text: 'Home' }, 15000);
  await device.screenshot('2fa-success');
  console.log('2FA login complete');
}
`,
  },

  // --- Navigation ---
  {
    id: 'nav-scroll-to-bottom',
    name: 'Scroll to Bottom',
    description: 'Scroll a view to the very bottom, useful for loading all lazy-loaded content or reaching a footer.',
    category: 'navigation',
    tags: ['scroll', 'navigation', 'infinite-scroll'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Scroll to the bottom of the current view
  // Detects when no new content loads (end of list)

  const MAX_SCROLLS = 50;
  const SCROLL_PAUSE_MS = 1500;

  let previousDom = '';
  let scrollCount = 0;

  while (scrollCount < MAX_SCROLLS) {
    await device.scroll('down', 80);
    await device.sleep(SCROLL_PAUSE_MS);
    scrollCount++;

    // Check if content changed (end-of-list detection)
    const currentDom = JSON.stringify(await device.getDOM());
    if (currentDom === previousDom) {
      console.log(\`Reached bottom after \${scrollCount} scrolls\`);
      break;
    }
    previousDom = currentDom;
  }

  await device.screenshot('scrolled-to-bottom');
  console.log(\`Scrolled \${scrollCount} times\`);
}
`,
  },
  {
    id: 'nav-tab-navigation',
    name: 'Navigate to Tab',
    description: 'Navigate to a specific tab in a bottom navigation bar or tab layout.',
    category: 'navigation',
    tags: ['navigation', 'tabs', 'bottom-nav'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Navigate to a specific tab
  // Customize the tab name and app package

  const APP_PACKAGE = 'com.example.app';
  const TARGET_TAB = 'Profile';  // Change to your target tab name

  await device.startApp(APP_PACKAGE);
  await device.sleep(2000);

  // Click the target tab
  if (await device.exists({ text: TARGET_TAB })) {
    await device.click({ text: TARGET_TAB });
  } else {
    // Try content-description for icon-only tabs
    await device.click({ description: TARGET_TAB });
  }

  await device.sleep(1000);
  await device.screenshot(\`tab-\${TARGET_TAB.toLowerCase()}\`);
  console.log(\`Navigated to \${TARGET_TAB} tab\`);
}
`,
  },
  {
    id: 'nav-cookie-consent',
    name: 'Handle Cookie Consent',
    description: 'Dismiss cookie consent banners and GDPR popups that appear on first launch.',
    category: 'navigation',
    tags: ['navigation', 'cookies', 'gdpr', 'popup', 'consent'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Dismiss cookie consent / GDPR banners
  // Tries multiple common button labels

  const ACCEPT_LABELS = [
    'Accept All',
    'Accept all',
    'Accept Cookies',
    'Accept cookies',
    'I Accept',
    'I agree',
    'Agree',
    'OK',
    'Got it',
    'Allow All',
    'Allow all',
    'Continue',
    'Consent',
  ];

  await device.sleep(2000);

  for (const label of ACCEPT_LABELS) {
    if (await device.exists({ text: label })) {
      await device.click({ text: label });
      console.log(\`Dismissed cookie banner with: "\${label}"\`);
      await device.sleep(1000);
      break;
    }
  }

  // Also check for WebView-based consent dialogs
  const dom = await device.getDOM();
  const allText = dom.getAllText(dom).join(' ').toLowerCase();
  if (allText.includes('cookie') || allText.includes('consent') || allText.includes('privacy')) {
    // Try to find and click any accept/agree button we might have missed
    const buttons = dom.findAll(dom, n =>
      n.className?.includes('Button') &&
      n.clickable &&
      (n.text?.toLowerCase().includes('accept') || n.text?.toLowerCase().includes('agree'))
    );
    if (buttons.length > 0) {
      const center = dom.getCenter(buttons[0]);
      await device.tapAt(center.x, center.y);
      console.log('Dismissed WebView cookie dialog');
    }
  }

  await device.screenshot('after-consent');
}
`,
  },

  // --- Data Extraction ---
  {
    id: 'extract-wait-times',
    name: 'Capture Wait Times from DOM',
    description: 'Extract wait time data from a theme park app by parsing the DOM tree. Logs structured data for each attraction.',
    category: 'data-extraction',
    tags: ['extraction', 'wait-times', 'theme-park', 'scraping'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Extract wait times from a theme park app
  // Scrolls through the attraction list and captures wait time data

  const APP_PACKAGE = 'com.example.themepark';

  await device.startApp(APP_PACKAGE);
  await device.sleep(3000);

  // Navigate to wait times / attractions section
  if (await device.exists({ text: 'Wait Times' })) {
    await device.click({ text: 'Wait Times' });
    await device.sleep(2000);
  }

  const attractions: Array<{ name: string; waitMinutes: string; status: string }> = [];
  let previousDom = '';
  const MAX_SCROLLS = 20;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    const tree = await device.getDOM();
    const allNodes = dom.flatten(tree);

    // Look for patterns: attraction name near a wait time number
    // Adjust selectors based on your target app's DOM structure
    for (const node of allNodes) {
      if (node.text && /^\\d+ min$/.test(node.text)) {
        // Found a wait time — look for nearby attraction name
        const parent = allNodes.find(p =>
          p.children?.some(c => c === node) && p.children?.some(c => c.text && !/^\\d+ min$/.test(c.text))
        );
        if (parent) {
          const nameNode = parent.children?.find(c => c.text && !/^\\d+ min$/.test(c.text));
          if (nameNode?.text) {
            attractions.push({
              name: nameNode.text,
              waitMinutes: node.text,
              status: 'open',
            });
          }
        }
      }
    }

    // Scroll and check for new content
    await device.scroll('down', 60);
    await device.sleep(1000);
    const currentDom = JSON.stringify(tree);
    if (currentDom === previousDom) break;
    previousDom = currentDom;
  }

  // Deduplicate by name
  const unique = [...new Map(attractions.map(a => [a.name, a])).values()];
  console.log(JSON.stringify(unique, null, 2));
  console.log(\`Captured \${unique.length} attraction wait times\`);
  await device.screenshot('wait-times-captured');
}
`,
  },
  {
    id: 'extract-list-items',
    name: 'Extract List Items',
    description: 'Scrape all items from a scrollable list view, collecting text content from each row.',
    category: 'data-extraction',
    tags: ['extraction', 'list', 'scraping'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Extract all items from a scrollable list
  // Collects text from each list item as the view scrolls

  const items: string[] = [];
  const seen = new Set<string>();
  let previousDom = '';
  const MAX_SCROLLS = 30;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    const tree = await device.getDOM();
    const allNodes = dom.flatten(tree);

    // Collect text from list items (adjust className filter for your app)
    const listItems = allNodes.filter(n =>
      (n.className?.includes('ListView') ||
       n.className?.includes('RecyclerView') ||
       n.className?.includes('ScrollView')) &&
      n.children
    );

    for (const container of listItems) {
      for (const child of container.children || []) {
        const texts = dom.getAllText(child).join(' ').trim();
        if (texts && !seen.has(texts)) {
          seen.add(texts);
          items.push(texts);
        }
      }
    }

    await device.scroll('down', 60);
    await device.sleep(800);

    const currentDom = JSON.stringify(tree);
    if (currentDom === previousDom) break;
    previousDom = currentDom;
  }

  console.log(\`Extracted \${items.length} items:\`);
  items.forEach((item, i) => console.log(\`  \${i + 1}. \${item}\`));
  await device.screenshot('list-extracted');
}
`,
  },
  {
    id: 'extract-schedule-grid',
    name: 'Scrape Schedule Grid',
    description: 'Extract schedule or timetable data from a grid/table layout, outputting structured rows and columns.',
    category: 'data-extraction',
    tags: ['extraction', 'schedule', 'grid', 'table', 'timetable'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Scrape a schedule/timetable grid from the app
  // Outputs structured data with headers and rows

  const APP_PACKAGE = 'com.example.app';

  await device.startApp(APP_PACKAGE);
  await device.sleep(3000);

  // Navigate to schedule page (customize as needed)
  if (await device.exists({ text: 'Schedule' })) {
    await device.click({ text: 'Schedule' });
    await device.sleep(2000);
  }

  // Gather the full scrollable DOM
  const tree = await device.gatherDOM({ maxScrollPages: 5 });
  const allNodes = dom.flatten(tree);

  // Strategy: find nodes organized in grid-like patterns
  // Group by Y coordinate to identify rows
  const nodesByRow = new Map<number, typeof allNodes>();

  for (const node of allNodes) {
    if (!node.bounds || !node.text) continue;
    // Round Y to nearest 10px to group into rows
    const rowKey = Math.round(node.bounds.top / 10) * 10;
    if (!nodesByRow.has(rowKey)) nodesByRow.set(rowKey, []);
    nodesByRow.get(rowKey)!.push(node);
  }

  // Sort rows by Y position
  const sortedRows = [...nodesByRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([_y, nodes]) =>
      nodes
        .sort((a, b) => (a.bounds?.left ?? 0) - (b.bounds?.left ?? 0))
        .map(n => n.text!)
    );

  // First row is likely headers
  const headers = sortedRows[0] || [];
  const dataRows = sortedRows.slice(1);

  console.log('Headers:', headers.join(' | '));
  console.log('---');
  for (const row of dataRows) {
    console.log(row.join(' | '));
  }

  console.log(\`\\nExtracted \${dataRows.length} schedule rows\`);
  await device.screenshot('schedule-grid');
}
`,
  },

  // --- Maintenance ---
  {
    id: 'maintenance-clear-cache',
    name: 'Clear App Cache',
    description: 'Clear the cache for a specific app via Android settings, useful for resetting app state without full reinstall.',
    category: 'maintenance',
    tags: ['maintenance', 'cache', 'clear', 'storage'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Clear app cache via Android settings
  // This avoids the need for a full uninstall/reinstall

  const TARGET_PACKAGE = 'com.example.app';

  // Open app info settings page directly
  await device.startApp('com.android.settings');
  await device.sleep(1000);

  // Navigate: Apps -> target app
  await device.waitFor({ text: 'Apps' }, 5000);
  await device.click({ text: 'Apps' });
  await device.sleep(1000);

  // Search for the app or scroll to find it
  if (await device.exists({ resourceId: 'com.android.settings:id/search_bar' })) {
    await device.click({ resourceId: 'com.android.settings:id/search_bar' });
    await device.setText({ className: 'EditText' }, TARGET_PACKAGE.split('.').pop()!);
    await device.sleep(1000);
  }

  // Click on the app
  await device.click({ textContains: TARGET_PACKAGE.split('.').pop()! });
  await device.sleep(1000);

  // Click Storage & cache (or Storage)
  if (await device.exists({ text: 'Storage & cache' })) {
    await device.click({ text: 'Storage & cache' });
  } else if (await device.exists({ text: 'Storage' })) {
    await device.click({ text: 'Storage' });
  }
  await device.sleep(1000);

  // Click Clear cache
  if (await device.exists({ text: 'Clear cache' })) {
    await device.click({ text: 'Clear cache' });
    console.log('Cache cleared successfully');
  } else {
    console.log('Clear cache button not found');
  }

  await device.screenshot('cache-cleared');
  await device.pressKey('HOME');
}
`,
  },
  {
    id: 'maintenance-reset-state',
    name: 'Reset App State',
    description: 'Force-stop an app and clear all its data to return it to a fresh install state.',
    category: 'maintenance',
    tags: ['maintenance', 'reset', 'clear-data', 'force-stop'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Reset app to fresh-install state
  // Force-stops the app and clears all data

  const TARGET_PACKAGE = 'com.example.app';

  // Force stop the app first
  await device.stopApp(TARGET_PACKAGE);
  await device.sleep(1000);

  // Open app info
  await device.startApp('com.android.settings');
  await device.sleep(1000);
  await device.waitFor({ text: 'Apps' }, 5000);
  await device.click({ text: 'Apps' });
  await device.sleep(1000);

  // Find the app
  if (await device.exists({ resourceId: 'com.android.settings:id/search_bar' })) {
    await device.click({ resourceId: 'com.android.settings:id/search_bar' });
    await device.setText({ className: 'EditText' }, TARGET_PACKAGE.split('.').pop()!);
    await device.sleep(1000);
  }

  await device.click({ textContains: TARGET_PACKAGE.split('.').pop()! });
  await device.sleep(1000);

  // Go to Storage
  if (await device.exists({ text: 'Storage & cache' })) {
    await device.click({ text: 'Storage & cache' });
  } else if (await device.exists({ text: 'Storage' })) {
    await device.click({ text: 'Storage' });
  }
  await device.sleep(1000);

  // Clear all data
  if (await device.exists({ text: 'Clear storage' })) {
    await device.click({ text: 'Clear storage' });
  } else if (await device.exists({ text: 'Clear data' })) {
    await device.click({ text: 'Clear data' });
  }
  await device.sleep(500);

  // Confirm dialog
  if (await device.exists({ text: 'OK' })) {
    await device.click({ text: 'OK' });
  } else if (await device.exists({ text: 'Delete' })) {
    await device.click({ text: 'Delete' });
  }

  console.log(\`App \${TARGET_PACKAGE} data cleared\`);
  await device.screenshot('app-reset');
  await device.pressKey('HOME');
}
`,
  },
  {
    id: 'maintenance-update-check',
    name: 'Check for App Updates',
    description: 'Open Google Play Store and check if an update is available for a specific app.',
    category: 'maintenance',
    tags: ['maintenance', 'update', 'play-store', 'version'],
    requiresDevice: true,
    requiresHttpsCapture: false,
    code: `export default async function automation(device: DeviceAPI) {
  // Check for app updates in Google Play Store

  const TARGET_PACKAGE = 'com.example.app';

  // Get current installed version
  const appInfo = await device.getAppInfo(TARGET_PACKAGE);
  console.log(\`Current version: \${appInfo?.versionName ?? 'unknown'}\`);

  // Open Play Store page for the app
  await device.startApp('com.android.vending');
  await device.sleep(2000);

  // Search for the app
  await device.waitFor({ text: 'Search for apps & games' }, 10000);
  await device.click({ text: 'Search for apps & games' });
  await device.sleep(500);
  await device.setText({ className: 'EditText' }, TARGET_PACKAGE);
  await device.pressKey('ENTER');
  await device.sleep(3000);

  // Check for Update button
  if (await device.exists({ text: 'Update' })) {
    console.log('Update available!');
    await device.screenshot('update-available');

    // Uncomment to auto-update:
    // await device.click({ text: 'Update' });
    // console.log('Update started');
  } else if (await device.exists({ text: 'Open' })) {
    console.log('App is up to date');
    await device.screenshot('up-to-date');
  } else {
    console.log('App not found in Play Store');
    await device.screenshot('app-not-found');
  }

  await device.pressKey('HOME');
}
`,
  },
];
