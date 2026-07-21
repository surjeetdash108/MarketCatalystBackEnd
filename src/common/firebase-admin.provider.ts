import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
  App,
} from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { Auth, getAuth } from 'firebase-admin/auth';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app?: App;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const serviceAccountPath = resolve(
      this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH', './service-account.json'),
    );

    if (getApps().length) {
      this.app = getApp();
      this.logger.log('Firebase Admin already initialized');
      return;
    }

    if (existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
      this.app = initializeApp({ credential: cert(serviceAccount), projectId });
      this.logger.log('Firebase Admin initialized with service-account.json');
      return;
    }

    try {
      this.app = initializeApp({ credential: applicationDefault(), projectId });
      this.logger.log(
        'Firebase Admin initialized with Application Default Credentials (no service-account.json found)',
      );
    } catch (err) {
      this.logger.error(
        `Firebase Admin has no credentials available. Either save a key at ${serviceAccountPath}, ` +
          `or run "gcloud auth application-default login" to use ADC instead. ` +
          `Underlying error: ${(err as Error).message}`,
      );
    }
  }

  get firestore(): Firestore {
    if (!this.app) {
      throw new ServiceUnavailableException(
        'Firebase Admin is not initialized — no service-account.json and no Application Default ' +
          'Credentials found. See backend/.env.example.',
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
