import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export interface ResolvedTargetAddress {
  address: string;
  family: 4 | 6;
}

export interface ValidatedTargetUrl {
  url: string;
  hostname: string;
  addresses: ResolvedTargetAddress[];
}

const MAX_URL_LENGTH = 2048;
const DNS_TIMEOUT_MS = 5000;

const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'home.arpa',
  'test',
  'invalid',
  'example',
  'onion',
  'arpa',
  'alt',
];

const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_IPV6_RANGES: Array<[string, number]> = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

const blockedIPv4 = new BlockList();

for (const [network, prefix] of BLOCKED_IPV4_RANGES) {
  blockedIPv4.addSubnet(network, prefix, 'ipv4');
}

const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

const blockedIPv6 = new BlockList();

for (const [network, prefix] of BLOCKED_IPV6_RANGES) {
  blockedIPv6.addSubnet(network, prefix, 'ipv6');
}

function getDnsErrorCode(error: unknown): string | undefined {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error)
  ) {
    return undefined;
  }

  return typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isMissingDnsRecord(error: unknown): boolean {
  const code = getDnsErrorCode(error);

  return code === 'ENODATA' || code === 'ENOTFOUND';
}

@Injectable()
export class TargetUrlValidator {
  async validate(input: unknown): Promise<ValidatedTargetUrl> {
    if (typeof input !== 'string') {
      throw new BadRequestException('Invalid target URL.');
    }

    if (
      input.length === 0 ||
      input.length > MAX_URL_LENGTH ||
      /[\u0000-\u001F\u007F]/.test(input)
    ) {
      throw new BadRequestException('Invalid target URL.');
    }

    const rawUrl = input.trim();

    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
      throw new BadRequestException('Invalid target URL.');
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Invalid target URL.');
    }

    this.validateProtocol(parsedUrl);
    this.validateCredentials(parsedUrl);
    this.validatePort(parsedUrl);

    const hostname = this.normalizeHostname(
      parsedUrl.hostname,
    );

    this.validateHostname(hostname);

    const addresses = await this.resolveHostname(hostname);

    this.validateResolvedAddresses(addresses);

    parsedUrl.hostname = hostname;
    parsedUrl.hash = '';

    return {
      url: parsedUrl.toString(),
      hostname,
      addresses,
    };
  }

  private validateProtocol(url: URL): void {
    if (url.protocol !== 'https:') {
      throw new BadRequestException(
        'Only HTTPS URLs are supported.',
      );
    }
  }

  private validateCredentials(url: URL): void {
    if (url.username || url.password) {
      throw new BadRequestException(
        'Credentials in target URLs are not allowed.',
      );
    }

    const authority =
      url.href
        .slice(url.protocol.length + 2)
        .split(/[/?#]/, 1)[0] ?? '';

    if (authority.includes('@')) {
      throw new BadRequestException(
        'Credentials in target URLs are not allowed.',
      );
    }
  }

  private validatePort(url: URL): void {
    if (url.port !== '') {
      throw new BadRequestException(
        'Only the default HTTPS port is supported.',
      );
    }
  }

  private normalizeHostname(hostname: string): string {
    let normalized = hostname
      .toLowerCase()
      .replace(/\.$/, '');

    if (
      normalized.startsWith('[') &&
      normalized.endsWith(']')
    ) {
      normalized = normalized.slice(1, -1);
    }

    return normalized;
  }

  private validateHostname(hostname: string): void {
    if (!hostname || isIP(hostname) !== 0) {
      throw new BadRequestException(
        'IP addresses cannot be used as target hosts.',
      );
    }

    if (hostname.length > 253 || !hostname.includes('.')) {
      throw new BadRequestException(
        'A valid public domain name is required.',
      );
    }

    const labels = hostname.split('.');

    const validLabels = labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );

    if (!validLabels) {
      throw new BadRequestException(
        'Invalid target hostname.',
      );
    }

    const isBlockedSuffix = BLOCKED_HOST_SUFFIXES.some(
      (suffix) =>
        hostname === suffix ||
        hostname.endsWith(`.${suffix}`),
    );

    if (isBlockedSuffix) {
      throw new BadRequestException(
        'Private or reserved hostnames are not allowed.',
      );
    }
  }

  private async resolveHostname(
    hostname: string,
  ): Promise<ResolvedTargetAddress[]> {
    const resolver = new Resolver();

    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      resolver.cancel();
    }, DNS_TIMEOUT_MS);

    try {
      const [ipv4Result, ipv6Result] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);

      if (timedOut) {
        throw new ServiceUnavailableException(
          'Target DNS resolution timed out.',
        );
      }

      const results = [ipv4Result, ipv6Result];

      for (const result of results) {
        if (
          result.status === 'rejected' &&
          !isMissingDnsRecord(result.reason)
        ) {
          throw new ServiceUnavailableException(
            'Target DNS resolution failed.',
          );
        }
      }

      const addresses: ResolvedTargetAddress[] = [];

      if (ipv4Result.status === 'fulfilled') {
        for (const address of ipv4Result.value) {
          addresses.push({
            address,
            family: 4,
          });
        }
      }

      if (ipv6Result.status === 'fulfilled') {
        for (const address of ipv6Result.value) {
          addresses.push({
            address,
            family: 6,
          });
        }
      }

      if (addresses.length === 0) {
        throw new BadRequestException(
          'Target hostname could not be resolved.',
        );
      }

      const uniqueAddresses = new Map<
        string,
        ResolvedTargetAddress
      >();

      for (const address of addresses) {
        uniqueAddresses.set(
          `${address.family}:${address.address}`,
          address,
        );
      }

      return [...uniqueAddresses.values()];
    } catch (error: unknown) {
      if (
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'Target DNS resolution failed.',
      );
    } finally {
      clearTimeout(timeout);
      resolver.cancel();
    }
  }

  private validateResolvedAddresses(
    addresses: ResolvedTargetAddress[],
  ): void {
    if (addresses.length === 0) {
      throw new BadRequestException(
        'Target hostname has no valid IP addresses.',
      );
    }

    const hasUnsafeAddress = addresses.some(
      ({ address, family }) =>
        !this.isPublicAddress(address, family),
    );

    if (hasUnsafeAddress) {
      throw new BadRequestException(
        'Target resolves to a non-public IP address.',
      );
    }
  }

  private isPublicAddress(
    address: string,
    family: 4 | 6,
  ): boolean {
    if (family === 4) {
      return (
        isIP(address) === 4 &&
        !blockedIPv4.check(address, 'ipv4')
      );
    }

    if (family === 6) {
      return (
        isIP(address) === 6 &&
        globalIPv6.check(address, 'ipv6') &&
        !blockedIPv6.check(address, 'ipv6')
      );
    }

    return false;
  }
}