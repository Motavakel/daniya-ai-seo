import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const OPENSSL_TIMEOUT_MS = 20_000;

@Injectable()
export class CertificateAuthorityService {
  private readonly caDirectory: string;
  private readonly caConfigPath: string;
  private readonly caCertificatePath: string;
  private readonly caPrivateKeyPath: string;
  private readonly rootCertificatePath: string;
  private readonly passphrase: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {
    this.caDirectory = resolve(this.requiredConfig('CA_DIR'));
    this.caConfigPath = resolve(
      this.config.get<string>('CA_CONFIG_PATH') ??
        join(this.caDirectory, 'openssl.cnf'),
    );
    this.caCertificatePath = resolve(this.requiredConfig('CA_CERT_PATH'));
    this.caPrivateKeyPath = resolve(this.requiredConfig('CA_KEY_PATH'));
    this.rootCertificatePath = resolve(
      this.requiredConfig('CA_ROOT_CERT_PATH'),
    );
    this.passphrase = this.requiredConfig('CA_KEY_PASSPHRASE');
  }

  async validateCsr(csr: string): Promise<void> {
    const workDirectory = await mkdtemp(join(tmpdir(), 'daniya-client-csr-'));

    try {
      const csrPath = join(workDirectory, 'client.csr.pem');
      const publicKeyPath = join(workDirectory, 'client-public.pem');

      await writeFile(csrPath, csr, { mode: 0o600 });

      try {
        await this.runOpenSSL(
          ['req', '-in', csrPath, '-verify', '-noout'],
          workDirectory,
        );
      } catch {
        throw new BadRequestException('Invalid certificate signing request');
      }

      const { stdout: publicKeyPem } = await this.runOpenSSL(
        ['req', '-in', csrPath, '-pubkey', '-noout'],
        workDirectory,
      );

      await writeFile(publicKeyPath, publicKeyPem, { mode: 0o600 });

      let publicKey: ReturnType<typeof createPublicKey>;

      try {
        publicKey = createPublicKey(publicKeyPem);
      } catch {
        throw new BadRequestException('Invalid CSR public key');
      }

      this.validatePublicKey(publicKey);
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  async createClientCertificate(csr: string) {

    return this.withLock(async () => {
      const workDirectory = await mkdtemp(join(tmpdir(), 'daniya-client-ca-'));

      try {
        const csrPath = join(workDirectory, 'client.csr.pem');
        const publicKeyPath = join(workDirectory, 'client-public.pem');
        const certificatePath = join(workDirectory, 'client.crt.pem');

        await writeFile(csrPath, csr, { mode: 0o600 });

        try {
          await this.runOpenSSL(
            ['req', '-in', csrPath, '-verify', '-noout'],
            workDirectory,
          );
        } catch {
          throw new BadRequestException('Invalid certificate signing request');
        }

        const { stdout: publicKeyPem } = await this.runOpenSSL(
          ['req', '-in', csrPath, '-pubkey', '-noout'],
          workDirectory,
        );
        await writeFile(publicKeyPath, publicKeyPem, { mode: 0o600 });
        this.validatePublicKey(createPublicKey(publicKeyPem));

        const caCertificate = new X509Certificate(
          await readFile(this.caCertificatePath),
        );
        const rootCertificate = new X509Certificate(
          await readFile(this.rootCertificatePath),
        );
        const caPrivateKey = createPrivateKey({
          key: await readFile(this.caPrivateKeyPath),
          passphrase: this.passphrase,
        });

        const now = new Date();
        if (
          !caCertificate.ca ||
          !caCertificate.checkPrivateKey(caPrivateKey) ||
          caCertificate.validFromDate > now ||
          caCertificate.validToDate <= now ||
          !rootCertificate.ca ||
          rootCertificate.validFromDate > now ||
          rootCertificate.validToDate <= now
        ) {
          throw new InternalServerErrorException(
            'Client CA configuration is invalid',
          );
        }

        await this.runOpenSSL(
          [
            'verify',
            '-CAfile',
            this.rootCertificatePath,
            this.caCertificatePath,
          ],
          workDirectory,
        );

        const configuredDays = Number(
          this.config.get<string>('OAUTH_CLIENT_CERT_TTL_DAYS') ?? 365,
        );
        if (
          !Number.isSafeInteger(configuredDays) ||
          configuredDays < 1 ||
          configuredDays > 365
        ) {
          throw new InternalServerErrorException(
            'Invalid client certificate lifetime',
          );
        }

        const remainingCaDays = Math.floor(
          (caCertificate.validToDate.getTime() - now.getTime()) / DAY_MS,
        );
        const validDays = Math.min(configuredDays, remainingCaDays);
        if (validDays < 1) {
          throw new InternalServerErrorException(
            'Client CA certificate is expiring',
          );
        }

        await this.runOpenSSL(
          [
            'ca',
            '-config',
            this.caConfigPath,
            '-in',
            csrPath,
            '-out',
            certificatePath,
            '-days',
            String(validDays),
            '-batch',
            '-notext',
            '-md',
            'sha256',
            '-rand_serial',
            '-extensions',
            'client_cert',
            '-subj',
            '/CN=Daniya-Client',
            '-passin',
            'env:CA_KEY_PASSPHRASE',
          ],
          this.caDirectory,
          { CA_KEY_PASSPHRASE: this.passphrase },
        );

        const certificate = await readFile(certificatePath, 'utf8');
        const issuedCertificate = new X509Certificate(certificate);
        if (
          !issuedCertificate.checkIssued(caCertificate) ||
          !issuedCertificate.verify(caCertificate.publicKey)
        ) {
          throw new InternalServerErrorException(
            'Issued certificate chain is invalid',
          );
        }

        const clientCaPem = await readFile(this.caCertificatePath, 'utf8');
        const rootCaPem = await readFile(this.rootCertificatePath, 'utf8');

        return {
          certificate: certificate.trim() + '\n',
          certificateChain:
            certificate.trim() + '\n' + clientCaPem.trim() + '\n',
          rootCaCertificate: rootCaPem,
          thumbprint: createHash('sha256')
            .update(issuedCertificate.raw)
            .digest('base64url'),
          serialNumber: issuedCertificate.serialNumber,
          validFrom: issuedCertificate.validFromDate,
          validUntil: issuedCertificate.validToDate,
        };
      } catch (error) {
        if (
          error instanceof BadRequestException ||
          error instanceof InternalServerErrorException
        ) {
          throw error;
        }
        throw new InternalServerErrorException(
          'Client certificate issuance failed',
        );
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    });
  }

  async revokeClientCertificate(serialNumber: string): Promise<void> {
    if (!/^[A-Fa-f0-9]+$/.test(serialNumber)) {
      throw new BadRequestException('Invalid certificate serial number');
    }

    await this.withLock(async () => {
      const newCertificatesDirectory = join(this.caDirectory, 'newcerts');
      const files = await readdir(newCertificatesDirectory);
      let certificatePath: string | undefined;

      for (const file of files) {
        if (!file.toLowerCase().endsWith('.pem')) continue;
        const candidate = join(newCertificatesDirectory, file);
        try {
          const certificate = new X509Certificate(await readFile(candidate));
          if (
            certificate.serialNumber.toUpperCase() ===
            serialNumber.toUpperCase()
          ) {
            certificatePath = candidate;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!certificatePath) {
        throw new InternalServerErrorException(
          'Issued certificate was not found in CA database',
        );
      }

      await this.runOpenSSL(
        [
          'ca',
          '-config',
          this.caConfigPath,
          '-revoke',
          certificatePath,
          '-passin',
          'env:CA_KEY_PASSPHRASE',
        ],
        this.caDirectory,
        { CA_KEY_PASSPHRASE: this.passphrase },
      );
    });
  }

  private validatePublicKey(
    publicKey: ReturnType<typeof createPublicKey>,
  ): void {
    const details = publicKey.asymmetricKeyDetails;

    const validEc =
      publicKey.asymmetricKeyType === 'ec' &&
      ['prime256v1'].includes(details?.namedCurve ?? '');

    if (!validEc) {
      throw new BadRequestException('Unsupported CSR public key type or size');
    }
  }

  private requiredConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new Error(`Missing required configuration: ${key}`);
    return value;
  }

  private async runOpenSSL(
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {},
  ) {
    return execFileAsync('openssl', args, {
      cwd,
      timeout: OPENSSL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
