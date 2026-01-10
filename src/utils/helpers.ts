import { createHmac } from 'crypto';

/**
 * Generate HMAC-SHA512 signature for Indodax Private API
 */
export function generateSignature(secretKey: string, payload: string): string {
  return createHmac('sha512', secretKey)
    .update(payload)
    .digest('hex');
}

/**
 * Generate a unique client order ID
 */
export function generateClientOrderId(prefix: string = 'bot'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Generate nonce (incrementing integer)
 */
let nonceCounter = Date.now();
export function generateNonce(): number {
  return ++nonceCounter;
}

/**
 * Format number for Indodax API
 */
export function formatAmount(amount: number, precision: number = 8): string {
  return amount.toFixed(precision);
}

/**
 * Format price for IDR
 */
export function formatPrice(price: number): string {
  return Math.floor(price).toString();
}

/**
 * Parse pair string (e.g., 'btc_idr' -> { base: 'btc', quote: 'idr' })
 */
export function parsePair(pair: string): { base: string; quote: string } {
  const [base, quote] = pair.toLowerCase().split('_');
  return { base, quote };
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
