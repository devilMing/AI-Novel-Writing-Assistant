import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import { ProxyAgent, type Dispatcher } from "undici";

const execFileAsync = promisify(execFile);

type FetchWithDispatcher = (
  input: string | URL | Request,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

interface OpenAIFetchDependencies {
  fetchImpl?: FetchWithDispatcher;
  resolveProxyUrl?: () => Promise<string | null>;
  createDispatcher?: (proxyUrl: string) => Dispatcher;
}

function normalizeProxyAddress(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function normalizeWindowsProxy(enabled: boolean, raw: string | undefined): string | null {
  if (!enabled || !raw?.trim()) return null;
  const entries = raw.split(";").map((entry) => entry.trim()).filter(Boolean);
  const mapped = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      mapped.set(entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim());
    }
  }
  return normalizeProxyAddress(mapped.get("https") ?? mapped.get("http") ?? (mapped.size === 0 ? entries[0] : undefined));
}

async function canConnectToProxy(proxyUrl: string): Promise<boolean> {
  const parsed = new URL(proxyUrl);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const host = parsed.hostname.replace(/^\[|\]$/gu, "");
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function resolveWindowsProxySettings(
  enabled: boolean,
  raw: string | undefined,
  isReachable: (proxyUrl: string) => Promise<boolean> = canConnectToProxy,
): Promise<string | null> {
  const proxyUrl = normalizeWindowsProxy(true, raw);
  if (!proxyUrl) return null;
  if (enabled) return proxyUrl;

  const hostname = new URL(proxyUrl).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") return null;
  return await isReachable(proxyUrl) ? proxyUrl : null;
}

async function queryWindowsRegistryValue(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      name,
    ], { windowsHide: true });
    const match = stdout.match(new RegExp(`${name}\\s+REG_(?:DWORD|SZ)\\s+(.+)$`, "imu"));
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function resolveWindowsProxy(): Promise<string | null> {
  const [enabledValue, server] = await Promise.all([
    queryWindowsRegistryValue("ProxyEnable"),
    queryWindowsRegistryValue("ProxyServer"),
  ]);
  const enabled = enabledValue === "0x1" || enabledValue === "1";
  return resolveWindowsProxySettings(enabled, server ?? undefined);
}

async function resolveSystemProxyUrl(): Promise<string | null> {
  if (process.platform === "win32") {
    const windowsProxy = await resolveWindowsProxy();
    if (windowsProxy) return windowsProxy;
  }
  return normalizeProxyAddress(
    process.env.HTTPS_PROXY
      ?? process.env.https_proxy
      ?? process.env.ALL_PROXY
      ?? process.env.all_proxy,
  );
}

export function createOpenAIFetch(dependencies: OpenAIFetchDependencies = {}): typeof fetch {
  const fetchImpl = dependencies.fetchImpl ?? (fetch as FetchWithDispatcher);
  const resolveProxyUrl = dependencies.resolveProxyUrl ?? resolveSystemProxyUrl;
  const createDispatcher = dependencies.createDispatcher ?? ((url: string) => new ProxyAgent(url));
  let dispatcherPromise: Promise<Dispatcher | null> | null = null;

  return (async (input: string | URL | Request, init?: RequestInit) => {
    dispatcherPromise ??= resolveProxyUrl().then((proxyUrl) => proxyUrl ? createDispatcher(proxyUrl) : null);
    const dispatcher = await dispatcherPromise;
    return fetchImpl(input, dispatcher ? { ...init, dispatcher } : init);
  }) as typeof fetch;
}

export const openAIFetch = createOpenAIFetch();
