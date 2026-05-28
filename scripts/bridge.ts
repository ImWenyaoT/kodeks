import { existsSync, readFileSync } from 'node:fs';

import { createBridgeServer } from '../packages/responses-bridge/src/index.ts';

type Command = 'start' | 'health' | 'smoke';

const DEFAULT_BASE_URL = 'http://127.0.0.1:38440/v1';

// Dispatches local bridge lifecycle commands for pnpm-first development.
async function main(): Promise<void> {
  const command = readCommand(process.argv[2]);
  const env = { ...loadDotEnv('.env'), ...process.env };

  if (command === 'start') {
    startBridge(env);
    return;
  }

  if (command === 'health') {
    await healthCheck(env);
    return;
  }

  await smokeTest(env);
}

// Validates the CLI subcommand and keeps package-script errors short.
function readCommand(value: string | undefined): Command {
  if (value === 'start' || value === 'health' || value === 'smoke') {
    return value;
  }
  throw new Error('Usage: pnpm run bridge:<start|health|smoke>');
}

// Starts the built-in Responses bridge on the configured local address.
function startBridge(env: Record<string, string | undefined>): void {
  const baseURL = readBridgeBaseURL(env);
  const listenURL = new URL(baseURL);
  const server = createBridgeServer({
    deepSeekApiKey: readDeepSeekApiKey(env),
    deepSeekBaseURL:
      env.KODEKS_BRIDGE_DEEPSEEK_BASE_URL ?? env.DEEPSEEK_BASE_URL,
    deepSeekModel:
      env.KODEKS_BRIDGE_DEEPSEEK_MODEL ??
      env.MOONBRIDGE_DEEPSEEK_MODEL ??
      env.DEEPSEEK_MODEL,
    modelAliases: [
      env.KODEKS_BRIDGE_MODEL ?? env.MOONBRIDGE_MODEL ?? 'bridge',
      'moonbridge'
    ],
    userAgent: 'kodeks-responses-bridge/0.1'
  });
  const hostname = listenURL.hostname || '127.0.0.1';
  const port = Number(listenURL.port || '38440');
  server.listen(port, hostname, () => {
    console.log(`Kodeks bridge listening on ${baseURL}`);
  });
}

// Checks the bridge health endpoint.
async function healthCheck(
  env: Record<string, string | undefined>
): Promise<void> {
  const baseURL = readBridgeBaseURL(env);
  const response = await fetch(`${new URL(baseURL).origin}/health`);
  if (!response.ok) {
    throw new Error(
      `Bridge health failed: ${response.status} ${response.statusText}`
    );
  }
  console.log(`Kodeks bridge is healthy at ${baseURL}`);
}

// Sends a minimal Responses request through the local bridge.
async function smokeTest(
  env: Record<string, string | undefined>
): Promise<void> {
  const baseURL = readBridgeBaseURL(env);
  const response = await fetch(`${baseURL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.KODEKS_BRIDGE_API_KEY ?? env.MOONBRIDGE_API_KEY ?? 'bridge'}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.KODEKS_BRIDGE_MODEL ?? env.MOONBRIDGE_MODEL ?? 'bridge',
      input: 'Say hello from Kodeks bridge in one short sentence.',
      stream: true
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Bridge smoke failed: ${response.status} ${response.statusText}\n${text}`
    );
  }
  console.log(text.split('\n').slice(0, 8).join('\n'));
}

// Reads bridge base URL while preserving legacy MOONBRIDGE compatibility.
function readBridgeBaseURL(env: Record<string, string | undefined>): string {
  return (
    env.KODEKS_BRIDGE_BASE_URL ?? env.MOONBRIDGE_BASE_URL ?? DEFAULT_BASE_URL
  );
}

// Reads the DeepSeek key accepted by the built-in bridge.
function readDeepSeekApiKey(
  env: Record<string, string | undefined>
): string | undefined {
  return (
    env.KODEKS_BRIDGE_DEEPSEEK_API_KEY ??
    env.MOONBRIDGE_DEEPSEEK_API_KEY ??
    env.DEEPSEEK_API_KEY
  );
}

// Loads simple KEY=VALUE dotenv files without printing secrets.
function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
