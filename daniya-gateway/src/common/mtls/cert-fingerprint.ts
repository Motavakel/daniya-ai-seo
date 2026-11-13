export function hexColonToBase64Url(x5tHex: string): string {
  const clean = x5tHex.replace(/:/g, '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('Invalid SHA-256 fingerprint hex length');
  }
  const buf = Buffer.from(clean, 'hex');
  return buf.toString('base64url');
}