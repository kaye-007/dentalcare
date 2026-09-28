import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  open,
  parseKeyring,
  seal,
  type Keyring,
  type Sealed,
} from '@/core/mfa/secret-box';

/**
 * Seals and opens a clinic's WhatsApp access token (0017).
 *
 * The same AES-256-GCM envelope as TOTP secrets and fiscal keys, under its
 * own keys (WHATSAPP_ENCRYPTION_KEYS). The associated data names the clinic,
 * so a ciphertext copied onto another clinic's row does not open.
 */
@Injectable()
export class WhatsAppTokenBox {
  private readonly keyring: Keyring;

  constructor(config: ConfigService) {
    const spec = config.get<string>('WHATSAPP_ENCRYPTION_KEYS');
    // env.validation refuses production without keys; this derived key is
    // for development and tests only, and differs from the MFA one.
    this.keyring = spec
      ? parseKeyring(spec)
      : developmentKeyring(config.get<string>('JWT_SECRET')!);
  }

  private aad(tenantId: string) {
    return `clinic_whatsapp_connections:${tenantId}`;
  }

  seal(tenantId: string, token: string): Sealed {
    return seal(this.keyring, token, this.aad(tenantId));
  }

  open(tenantId: string, sealed: Sealed): string {
    return open(this.keyring, sealed, this.aad(tenantId));
  }
}

function developmentKeyring(jwtSecret: string): Keyring {
  const key = createHmac('sha256', jwtSecret)
    .update('dentalcare/whatsapp/development-key')
    .digest();
  return { currentId: 'dev', keys: new Map([['dev', key]]) };
}
