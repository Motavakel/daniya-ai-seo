export interface TrustedGatewayContext {
  callerRef: string;
  profile: 'basic' | 'detailed';
}

export interface GatewayContextRequest {
  gatewayContext?: unknown;
}

export function isTrustedGatewayContext(
  value: unknown,
): value is TrustedGatewayContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['callerRef'] === 'string' &&
    record['callerRef'].trim().length > 0 &&
    record['callerRef'].length <= 128 &&
    (record['profile'] === 'basic' || record['profile'] === 'detailed');
}
