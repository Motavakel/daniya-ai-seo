import { BadRequestException, Injectable } from '@nestjs/common';
import ipaddr from 'ipaddr.js';

const SENSITIVE_QUERY_KEY_PATTERN = /(^|[_-])(access[_-]?token|auth(?:orization)?|token|api[_-]?key|secret|password|passwd|session|signature|credential|refresh[_-]?token)([_-]|$)/i;

export interface ValidatedTargetUrl {
  url: string;
  hostname: string;
}

@Injectable()
export class TargetUrlValidator {
  async validate(input: string): Promise<ValidatedTargetUrl> {
    if (typeof input !== 'string' || input.length < 8 || input.length > 2_048) {
      throw new BadRequestException('The target URL length is invalid.');
    }

    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new BadRequestException('The target URL is invalid.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('Only HTTP and HTTPS URLs are supported.');
    }
    if (url.username || url.password) {
      throw new BadRequestException('URLs containing credentials are not accepted.');
    }

    // Restrict the initial URL to standard web ports. The egress proxy applies
    // the same restriction to redirects and every subresource request.
    if (url.port) {
      throw new BadRequestException('Custom target ports are not supported.');
    }

    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
        throw new BadRequestException(
          'URLs containing authentication or secret query parameters are not supported.',
        );
      }
    }

    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');

    if (
      !hostname ||
      hostname === 'localhost' ||
      hostname === 'metadata' ||
      hostname === 'metadata.google.internal' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.home.arpa')
    ) {
      throw new BadRequestException('Local and internal hostnames are not allowed.');
    }

    // Validate IP literals here. Hostname DNS is intentionally NOT resolved
    // in the API/Worker: the production egress proxy performs DNS resolution
    // and blocks private/reserved destinations at connection time. This avoids
    // a DNS-rebinding gap between application validation and browser connect.
    if (ipaddr.isValid(hostname)) {
      const address = ipaddr.process(hostname);
      if (address.range() !== 'unicast') {
        throw new BadRequestException('The target IP address is not publicly routable.');
      }
    } else if (!hostname.includes('.')) {
      throw new BadRequestException('Single-label hostnames are not allowed.');
    }

    url.hash = '';
    return { url: url.toString(), hostname };
  }
}
