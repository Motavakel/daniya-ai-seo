export function sha256FingerprintToBase64Url(value: string): string {
  const normalized = value.replace(/:/g, '').toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('Invalid SHA-256 certificate fingerprint');
  }

  return Buffer.from(normalized, 'hex').toString('base64url');
}
