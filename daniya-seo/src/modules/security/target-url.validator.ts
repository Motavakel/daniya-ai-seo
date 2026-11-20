import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { lookup } from 'node:dns/promises';
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
];

const blockedIPv4 = new BlockList();

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

for (const [network, prefix] of BLOCKED_IPV4_RANGES) {
  blockedIPv4.addSubnet(network, prefix, 'ipv4');
}

const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

const blockedIPv6 = new BlockList();

const BLOCKED_IPV6_RANGES: Array<[string, number]> = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

for (const [network, prefix] of BLOCKED_IPV6_RANGES) {
  blockedIPv6.addSubnet(network, prefix, 'ipv6');
}

@Injectable()
export class TargetUrlValidator {
  async validate(input: unknown): Promise<ValidatedTargetUrl> {
    if (typeof input !== 'string') {
      throw new BadRequestException('Invalid target URL.');
    }

    const rawUrl = input.trim();

    if (
      rawUrl.length === 0 ||
      rawUrl.length > MAX_URL_LENGTH
    ) {
      throw new BadRequestException('Invalid target URL length.');
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
  }

  private validatePort(url: URL): void {
    if (url.port && url.port !== '443') {
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

    if (!hostname.includes('.')) {
      throw new BadRequestException(
        'A public domain name is required.',
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
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const dnsLookup = lookup(hostname, {
        all: true,
        verbatim: true,
      });

      const timeoutPromise = new Promise<never>(
        (_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new ServiceUnavailableException(
                'Target DNS resolution timed out.',
              ),
            );
          }, DNS_TIMEOUT_MS);
        },
      );

      const results = await Promise.race([
        dnsLookup,
        timeoutPromise,
      ]);

      if (!results.length) {
        throw new BadRequestException(
          'Target hostname could not be resolved.',
        );
      }

      return results.map((result) => ({
        address: result.address,
        family: result.family as 4 | 6,
      }));
    } catch (error: unknown) {
      if (
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      throw new BadRequestException(
        'Target hostname could not be resolved.',
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private validateResolvedAddresses(
    addresses: ResolvedTargetAddress[],
  ): void {
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