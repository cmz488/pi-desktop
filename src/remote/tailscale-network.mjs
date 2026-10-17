import { Agent, request } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

// Scope proxy support to public HTTPS probes, never the loopback agent gateway.
// Explicit verification also rejects TLS interception if a parent process has
// NODE_TLS_REJECT_UNAUTHORIZED=0. No extra CA or hostname override is installed.
export function requestPublicHttps(url, options, callback) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  // Funnel endpoints are hosted under Tailscale's public ts.net domain. The
  // daemon and its public gateway probe must reach them directly; desktop-wide
  // proxy settings remain available for unrelated HTTPS checks.
  const proxy = url.hostname.toLowerCase().endsWith(".ts.net")
    ? ""
    : getProxyForUrl(url.href);
  const agent = proxy
    ? new HttpsProxyAgent(proxy, { rejectUnauthorized: true, signal })
    : new Agent({ rejectUnauthorized: true });
  try {
    const req = request(
      url,
      { ...options, signal, agent, rejectUnauthorized: true },
      callback,
    );
    req.once("close", () => {
      controller.abort();
      agent.destroy();
    });
    return req;
  } catch (error) {
    controller.abort();
    agent.destroy();
    throw error;
  }
}
