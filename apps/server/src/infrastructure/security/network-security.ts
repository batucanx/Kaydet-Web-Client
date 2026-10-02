import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { AppError } from '../../application/errors.ts';

/**
 * Options for configuring SSRF protection on network endpoints.
 */
export interface NetworkSecurityOptions {
  /**
   * Whether to allow loopback and private networks.
   * STRICTLY false by default; true ONLY in local testing environments with fake mail servers.
   */
  readonly allowPrivateNetworks?: boolean;
  /**
   * Custom DNS resolver function for testing or DNS rebinding defense.
   */
  readonly dnsLookup?: (host: string) => Promise<string[]>;
}

export interface NetworkSecurityPolicy {
  validateEndpoint(host: string, port: number): Promise<{ host: string; port: number; ip: string }>;
  isHostAllowed(host: string): boolean;
  isIpAllowed(ip: string): boolean;
}

/**
 * Checks if an IPv4 address string falls into a private/loopback/link-local/dangerous CIDR range.
 */
function isDangerousIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed is dangerous
  }
  const [a, b] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (Private)
  if (a === 10) return true;
  // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (Link-local, AWS/GCP/Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (CGNAT / Shared, Alibaba metadata 100.100.100.200)
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET)
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  // 224.0.0.0/4 (Multicast)
  if (a !== undefined && a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved) & 255.255.255.255 (Broadcast)
  if (a !== undefined && a >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address falls into a private/loopback/link-local/dangerous range.
 */
function isDangerousIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Loopback (::1) & Unspecified (::)
  if (normalized === '::1' || normalized === '::') return true;

  // IPv4-mapped IPv6 (::ffff:127.0.0.1, etc.)
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice(7);
    if (isIP(v4) === 4) return isDangerousIpv4(v4);
  }

  // Link-local: fe80::/10 (fe8, fe9, fea, feb)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  // Unique Local Address (ULA / Private): fc00::/7 (fc, fd)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  // Multicast: ff00::/8
  if (normalized.startsWith('ff')) {
    return true;
  }

  return false;
}

export class DefaultNetworkSecurityPolicy implements NetworkSecurityPolicy {
  private readonly allowPrivate: boolean;
  private readonly lookupFn: (host: string) => Promise<string[]>;

  constructor(options: NetworkSecurityOptions = {}) {
    this.allowPrivate = options.allowPrivateNetworks ?? false;
    this.lookupFn =
      options.dnsLookup ??
      (async (host: string) => {
        const results = await dnsPromises.lookup(host, { all: true });
        return results.map((r) => r.address);
      });
  }

  isHostAllowed(host: string): boolean {
    const trimmed = host.trim().toLowerCase();
    if (!trimmed) return false;

    // Direct IP address check
    const ipVersion = isIP(trimmed);
    if (ipVersion !== 0) {
      return this.isIpAllowed(trimmed);
    }

    // Prohibited hostnames
    if (
      trimmed === 'localhost' ||
      trimmed.endsWith('.localhost') ||
      trimmed.endsWith('.local') ||
      trimmed.endsWith('.internal') ||
      trimmed.endsWith('.lan') ||
      trimmed === 'metadata.google.internal' ||
      trimmed === 'instance-data'
    ) {
      return this.allowPrivate;
    }

    return true;
  }

  isIpAllowed(ip: string): boolean {
    if (this.allowPrivate) return true;

    const version = isIP(ip);
    if (version === 4) {
      return !isDangerousIpv4(ip);
    }
    if (version === 6) {
      return !isDangerousIpv6(ip);
    }
    return false;
  }

  async validateEndpoint(host: string, port: number): Promise<{ host: string; port: number; ip: string }> {
    if (port < 1 || port > 65535) {
      throw new AppError('provider_unreachable', {
        operation: 'network.security',
        cause: `Invalid port: ${port}`,
      });
    }

    const trimmedHost = host.trim();
    if (!this.isHostAllowed(trimmedHost)) {
      throw new AppError('provider_unreachable', {
        operation: 'network.security',
        cause: `Host is blocked by network security policy: ${trimmedHost}`,
      });
    }

    // Check if host is direct IP
    const directIpVer = isIP(trimmedHost);
    if (directIpVer !== 0) {
      if (!this.isIpAllowed(trimmedHost)) {
        throw new AppError('provider_unreachable', {
          operation: 'network.security',
          cause: `IP is blocked by network security policy: ${trimmedHost}`,
        });
      }
      return { host: trimmedHost, port, ip: trimmedHost };
    }

    // Resolve DNS
    let resolvedIps: string[];
    try {
      resolvedIps = await this.lookupFn(trimmedHost);
    } catch (err) {
      throw new AppError('provider_unreachable', {
        operation: 'network.security',
        cause: `DNS resolution failed for ${trimmedHost}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!resolvedIps || resolvedIps.length === 0) {
      throw new AppError('provider_unreachable', {
        operation: 'network.security',
        cause: `DNS returned no records for ${trimmedHost}`,
      });
    }

    for (const ip of resolvedIps) {
      if (!this.isIpAllowed(ip)) {
        throw new AppError('provider_unreachable', {
          operation: 'network.security',
          cause: `Resolved IP ${ip} for ${trimmedHost} is blocked by network security policy`,
        });
      }
    }

    return { host: trimmedHost, port, ip: resolvedIps[0]! };
  }
}
