import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { applicationDefault, cert, getApp, getApps, initializeApp, App } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { Auth, getAuth } from 'firebase-admin/auth';

@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app?: App;

  constructor(private readonly config: ConfigService) {}

  /**
   * Composes a service-account credential from individual FIREBASE_* env
   * vars (the downloaded key JSON's fields, one env var per field — see
   * .env.example) rather than a key file. Only the three fields
   * firebase-admin's `cert()` actually needs are required; a missing
   * `FIREBASE_CLIENT_EMAIL` or `FIREBASE_PRIVATE_KEY` means "not configured",
   * not an error — ADC is a legitimate alternative.
   */
  private readServiceAccountFromEnv(): Record<string, string> | null {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID', '').trim();
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL', '').trim();
    // dotenv expands \n inside a double-quoted value to a real newline already;
    // this replace is a no-op in that case and a fix-up if it didn't.
    const privateKey = this.config
      .get<string>('FIREBASE_PRIVATE_KEY', '')
      .trim()
      .replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) return null;

    return {
      type: this.config.get<string>('FIREBASE_TYPE', 'service_account'),
      project_id: projectId,
      private_key_id: this.config.get<string>('FIREBASE_PRIVATE_KEY_ID', ''),
      private_key: privateKey,
      client_email: clientEmail,
      client_id: this.config.get<string>('FIREBASE_CLIENT_ID', ''),
      auth_uri: this.config.get<string>('FIREBASE_AUTH_URI', 'https://accounts.google.com/o/oauth2/auth'),
      token_uri: this.config.get<string>('FIREBASE_TOKEN_URI', 'https://oauth2.googleapis.com/token'),
      auth_provider_x509_cert_url: this.config.get<string>(
        'FIREBASE_AUTH_PROVIDER_X509_CERT_URL',
        'https://www.googleapis.com/oauth2/v1/certs',
      ),
      client_x509_cert_url: this.config.get<string>('FIREBASE_CLIENT_X509_CERT_URL', ''),
      universe_domain: this.config.get<string>('FIREBASE_UNIVERSE_DOMAIN', 'googleapis.com'),
    };
  }

  onModuleInit(): void {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');

    if (getApps().length) {
      this.app = getApp();
      this.logger.log('Firebase Admin already initialized');
      return;
    }

    // Preferred: credentials assembled from individual FIREBASE_* env vars
    // (Secret Manager-backed in any deployed environment, .env locally) —
    // never a key file, checked in or otherwise.
    const envServiceAccount = this.readServiceAccountFromEnv();
    if (envServiceAccount) {
      this.app = initializeApp({ credential: cert(envServiceAccount), projectId });
      this.logger.log('Firebase Admin initialized from FIREBASE_* env vars');
      return;
    }

    try {
      this.app = initializeApp({ credential: applicationDefault(), projectId });
      this.logger.log(
        'Firebase Admin initialized with Application Default Credentials (FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY not set)',
      );
    } catch (err) {
      this.logger.error(
        `Firebase Admin has no credentials available. Set FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY ` +
          `(+ FIREBASE_PROJECT_ID), or run "gcloud auth application-default login" to use ADC instead. ` +
          `Underlying error: ${(err as Error).message}`,
      );
    }
  }

  get firestore(): Firestore {
    if (!this.app) {
      throw new ServiceUnavailableException(
        'Firebase Admin is not initialized — no FIREBASE_* credential env vars and no Application ' +
          'Default Credentials found. See backend/.env.example.',
      );
    }
    return getFirestore(this.app);
  }
  /** Admin SDK Auth — used by AdminGuard to verify caller ID tokens. */
  get auth(): Auth {
    if (!this.app) {
      throw new Error('FirebaseAdminService used before initialisation');
    }
    return getAuth(this.app);
  }

}
