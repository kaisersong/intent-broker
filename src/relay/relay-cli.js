import { loadCredentials, saveCredentials, deleteCredentials, isTokenExpired, getJwtPayload } from './credential-store.js';

const GITHUB_CLIENT_ID = process.env.RELAY_GITHUB_CLIENT_ID || 'Ov23liTyGMaL8ZKE8WTF';
const GOOGLE_CLIENT_ID = process.env.RELAY_GOOGLE_CLIENT_ID || 'PLACEHOLDER_GOOGLE_CLIENT_ID';

const RELAY_AUTH_URL = process.env.RELAY_AUTH_URL || 'https://relay.kaihub.space';

async function deviceFlowGitHub() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: 'read:user user:email',
    }),
  });

  if (!res.ok) throw new Error(`GitHub device code request failed: ${res.status}`);
  return res.json();
}

async function pollGitHubToken(deviceCode, interval) {
  while (true) {
    await new Promise(r => setTimeout(r, interval * 1000));

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await res.json();

    if (data.access_token) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      interval = (data.interval || interval) + 1;
      continue;
    }
    throw new Error(`GitHub auth failed: ${data.error_description || data.error}`);
  }
}

async function deviceFlowGoogle() {
  const res = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'openid email profile',
    }),
  });

  if (!res.ok) throw new Error(`Google device code request failed: ${res.status}`);
  return res.json();
}

async function pollGoogleToken(deviceCode, interval) {
  while (true) {
    await new Promise(r => setTimeout(r, interval * 1000));

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await res.json();

    if (data.access_token) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      interval = (data.interval || interval) + 1;
      continue;
    }
    throw new Error(`Google auth failed: ${data.error_description || data.error}`);
  }
}

async function exchangeForRelayJwt(provider, accessToken) {
  const res = await fetch(`${RELAY_AUTH_URL}/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ provider, accessToken }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Relay token exchange failed: ${res.status} ${body}`);
  }
  return res.json();
}

export async function relayLogin(provider = 'github') {
  console.log(`\nAuthenticating with ${provider}...\n`);

  let deviceData;
  let tokenData;

  if (provider === 'github') {
    deviceData = await deviceFlowGitHub();
    console.log(`! Copy this code: ${deviceData.user_code}`);
    console.log(`  Then open: ${deviceData.verification_uri}\n`);
    console.log('Waiting for authorization...');
    tokenData = await pollGitHubToken(deviceData.device_code, deviceData.interval || 5);
  } else if (provider === 'google') {
    deviceData = await deviceFlowGoogle();
    console.log(`! Copy this code: ${deviceData.user_code}`);
    console.log(`  Then open: ${deviceData.verification_uri}\n`);
    console.log('Waiting for authorization...');
    tokenData = await pollGoogleToken(deviceData.device_code, deviceData.interval || 5);
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  console.log('Authorization received, exchanging for relay token...');

  const relayData = await exchangeForRelayJwt(provider, tokenData.access_token);

  await saveCredentials({
    provider,
    jwt: relayData.jwt,
    refreshToken: relayData.refreshToken || tokenData.refresh_token || null,
    issuedAt: new Date().toISOString(),
  });

  const payload = getJwtPayload(relayData.jwt);
  console.log(`\n✓ Authenticated as ${payload?.email || payload?.sub || 'unknown'}`);
  console.log(`  Plan: ${payload?.plan || 'free'}`);
  console.log(`  Token saved to ~/.intent-broker/credentials\n`);
}

export async function relayLogout() {
  await deleteCredentials();
  console.log('✓ Credentials removed');
}

export async function relayStatus() {
  const credentials = await loadCredentials();

  if (!credentials) {
    console.log('Not authenticated. Run: intent-broker relay login');
    return;
  }

  const expired = isTokenExpired(credentials);
  const payload = getJwtPayload(credentials.jwt);

  console.log(`Provider: ${credentials.provider || 'unknown'}`);
  console.log(`User: ${payload?.email || payload?.sub || 'unknown'}`);
  console.log(`Plan: ${payload?.plan || 'free'}`);
  console.log(`Token: ${expired ? 'EXPIRED' : 'valid'}`);
  if (payload?.exp) {
    console.log(`Expires: ${new Date(payload.exp * 1000).toISOString()}`);
  }
  console.log(`Issued: ${credentials.issuedAt || 'unknown'}`);
}

export async function runRelayCli(args) {
  const command = args[0];

  switch (command) {
    case 'login': {
      const provider = args[1] || 'github';
      if (!['github', 'google'].includes(provider)) {
        console.error(`Unknown provider: ${provider}. Use: github, google`);
        process.exit(1);
      }
      await relayLogin(provider);
      break;
    }
    case 'logout':
      await relayLogout();
      break;
    case 'status':
      await relayStatus();
      break;
    default:
      console.log('Usage: intent-broker relay <login|logout|status>');
      console.log('');
      console.log('Commands:');
      console.log('  login [github|google]  Authenticate with relay service');
      console.log('  logout                 Remove stored credentials');
      console.log('  status                 Show current auth status');
      process.exit(command ? 1 : 0);
  }
}
