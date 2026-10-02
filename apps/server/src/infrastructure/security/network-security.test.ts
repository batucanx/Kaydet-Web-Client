import { describe, expect, it } from 'vitest';
import { DefaultNetworkSecurityPolicy } from './network-security.ts';
import { isAppError } from '../../application/errors.ts';

describe('DefaultNetworkSecurityPolicy (SSRF protection)', () => {
  const policy = new DefaultNetworkSecurityPolicy();

  describe('direct IP addresses', () => {
    it('blocks IPv4 loopback (127.0.0.0/8)', async () => {
      await expect(policy.validateEndpoint('127.0.0.1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('127.123.45.67', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
    });

    it('blocks IPv4 private addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)', async () => {
      await expect(policy.validateEndpoint('10.0.1.2', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('172.16.0.5', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('172.31.255.1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('192.168.1.1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
    });

    it('blocks cloud metadata endpoints and link-local (169.254.169.254, 100.100.100.200)', async () => {
      await expect(policy.validateEndpoint('169.254.169.254', 80)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('100.100.100.200', 80)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
    });

    it('blocks IPv6 loopback (::1) and unspecified (::)', async () => {
      await expect(policy.validateEndpoint('::1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('::', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
    });

    it('blocks IPv6 link-local and unique local (fe80::, fc00::)', async () => {
      await expect(policy.validateEndpoint('fe80::1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('fc00::1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('fd12:3456:789a::1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
    });

    it('blocks IPv4-mapped IPv6 pointing to private addresses (::ffff:127.0.0.1)', async () => {
      await expect(policy.validateEndpoint('::ffff:127.0.0.1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('::ffff:10.0.0.1', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
    });
  });

  describe('hostnames and DNS resolution', () => {
    it('blocks localhost and internal domains directly', async () => {
      await expect(policy.validateEndpoint('localhost', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('sub.localhost', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('mail.internal', 993)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('metadata.google.internal', 80)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
    });

    it('blocks domain when resolved DNS returns a private IP (DNS rebinding / SSRF)', async () => {
      const rebindingPolicy = new DefaultNetworkSecurityPolicy({
        dnsLookup: async () => ['127.0.0.1'],
      });
      await expect(rebindingPolicy.validateEndpoint('innocent-looking-mail.com', 993)).rejects.toSatisfy(
        (err) => isAppError(err) && err.code === 'provider_unreachable',
      );
    });

    it('blocks domain when any resolved IP is in a dangerous range', async () => {
      const dualStackPolicy = new DefaultNetworkSecurityPolicy({
        dnsLookup: async () => ['93.184.216.34', '10.0.0.5'],
      });
      await expect(dualStackPolicy.validateEndpoint('dual.example.com', 993)).rejects.toSatisfy(
        (err) => isAppError(err) && err.code === 'provider_unreachable',
      );
    });

    it('allows legitimate public IP / domain with mock DNS', async () => {
      const publicPolicy = new DefaultNetworkSecurityPolicy({
        dnsLookup: async () => ['93.184.216.34'],
      });
      const result = await publicPolicy.validateEndpoint('imap.mailprovider.com', 993);
      expect(result.host).toBe('imap.mailprovider.com');
      expect(result.ip).toBe('93.184.216.34');
      expect(result.port).toBe(993);
    });
  });

  describe('test override mode', () => {
    it('allows loopback when allowPrivateNetworks is explicitly enabled for tests', async () => {
      const testPolicy = new DefaultNetworkSecurityPolicy({
        allowPrivateNetworks: true,
        dnsLookup: async () => ['127.0.0.1'],
      });
      const result = await testPolicy.validateEndpoint('localhost', 993);
      expect(result.host).toBe('localhost');
      expect(result.ip).toBe('127.0.0.1');
    });
  });

  describe('port validation', () => {
    it('rejects ports outside [1, 65535]', async () => {
      await expect(policy.validateEndpoint('imap.example.com', 0)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
      await expect(policy.validateEndpoint('imap.example.com', 70000)).rejects.toSatisfy((err) => isAppError(err) && err.code === 'provider_unreachable');
    });
  });
});
