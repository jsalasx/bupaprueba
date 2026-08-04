import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';

import { AuthService } from '../auth.service';
import { CaptchaService } from './captcha.service';
import { WebAuthnAuthenticationStore } from './webauthn-authentication.store';
import { WebAuthnHttpService } from './webauthn.service';
import { WEBAUTHN_PLATFORM, WebAuthnPlatform } from './webauthn-platform.service';
import {
  AuthenticationCredentialJSON,
  RegistrationCredentialJSON,
} from './webauthn.dto';

const assertion: AuthenticationCredentialJSON = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: 'Y2xpZW50',
    authenticatorData: 'YXV0aA',
    signature: 'c2ln',
    userHandle: null,
  },
};

class PlatformStub implements WebAuthnPlatform {
  available = true;
  getError: unknown = null;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async createCredential(): Promise<RegistrationCredentialJSON> {
    throw new Error('no usado en login');
  }

  async getCredential(): Promise<AuthenticationCredentialJSON> {
    if (this.getError) {
      throw this.getError;
    }
    return assertion;
  }
}

class ApiStub {
  beginResult: unknown = of({
    ceremonyId: 'cer-1',
    publicKey: { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost' },
  });
  finishResult: unknown = of({
    status: 'ok',
    accessToken: 'at-passkey',
    refreshToken: 'rt-passkey',
  });
  beginArgs: { username: string; captcha: string }[] = [];

  authenticateBegin(username: string, captcha: string) {
    this.beginArgs.push({ username, captcha });
    return this.beginResult as any;
  }

  authenticateFinish() {
    return this.finishResult as any;
  }
}

class CaptchaStub {
  token = 'captcha-token';
  actions: string[] = [];

  async getToken(action: string): Promise<string> {
    this.actions.push(action);
    return this.token;
  }
}

const httpError = (status: number, code: string) =>
  throwError(() => new HttpErrorResponse({ status, error: { code, message: 'x' } }));

describe('WebAuthnAuthenticationStore', () => {
  let store: WebAuthnAuthenticationStore;
  let platform: PlatformStub;
  let api: ApiStub;
  let captcha: CaptchaStub;
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    platform = new PlatformStub();
    api = new ApiStub();
    captcha = new CaptchaStub();

    TestBed.configureTestingModule({
      providers: [
        { provide: WEBAUTHN_PLATFORM, useValue: platform },
        { provide: WebAuthnHttpService, useValue: api },
        { provide: CaptchaService, useValue: captcha },
      ],
    });

    store = TestBed.inject(WebAuthnAuthenticationStore);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => localStorage.clear());

  it('camino feliz: guarda la sesión con el flujo de siempre', async () => {
    await expect(store.login('user@bupa.cl')).resolves.toBe(true);

    expect(store.state()).toBe('success');
    // Mismo almacenamiento que Google/Apple/Azure: nada paralelo.
    expect(auth.accessToken()).toBe('at-passkey');
    expect(localStorage.getItem('access_token')).toBe('at-passkey');
    expect(localStorage.getItem('refresh_token')).toBe('rt-passkey');
  });

  it('manda el captcha y el email a begin', async () => {
    await store.login('user@bupa.cl');

    expect(api.beginArgs).toEqual([{ username: 'user@bupa.cl', captcha: 'captcha-token' }]);
    expect(captcha.actions).toEqual(['webauthn_login']);
  });

  it('no ofrece la opción si no hay autenticador de plataforma', async () => {
    platform.available = false;

    await expect(store.checkSupport()).resolves.toBe(false);
    expect(store.state()).toBe('unsupported');
    expect(store.canLogin()).toBe(false);
  });

  it('la cancelación del usuario es silenciosa', async () => {
    platform.getError = Object.assign(new Error(), { name: 'NotAllowedError' });

    await expect(store.login('user@bupa.cl')).resolves.toBe(false);

    expect(store.state()).toBe('idle');
    expect(store.errorMessage()).toBeNull();
    expect(auth.accessToken()).toBeNull();
  });

  it('401 usa el mensaje genérico y no revela nada del usuario', async () => {
    api.finishResult = httpError(401, 'webauthn_assertion_invalid');

    await store.login('user@bupa.cl');

    expect(store.state()).toBe('error');
    expect(store.errorMessage()).toBe('No pudimos verificar tu dispositivo.');
    expect(store.errorMessage()).not.toMatch(/existe|revocad|registrad/i);
  });

  it('un desafío expirado permite reintentar desde cero', async () => {
    api.finishResult = httpError(400, 'webauthn_challenge_invalid');

    await store.login('user@bupa.cl');

    expect(store.failure()?.recovery).toBe('restart');
    expect(store.canLogin()).toBe(true);
  });

  it('429 bloquea el botón durante el backoff', async () => {
    api.beginResult = httpError(429, 'webauthn_rate_limited');

    await store.login('user@bupa.cl');

    expect(store.state()).toBe('cooldown');
    expect(store.canLogin()).toBe(false);

    // Un segundo intento durante el cooldown no gasta otra ceremonia.
    const calls = api.beginArgs.length;
    await expect(store.login('user@bupa.cl')).resolves.toBe(false);
    expect(api.beginArgs.length).toBe(calls);
  });

  it('503 apaga la feature', async () => {
    api.beginResult = httpError(503, 'SERVICE_UNAVAILABLE');

    await store.login('user@bupa.cl');

    expect(store.state()).toBe('unsupported');
  });

  it('no guarda sesión si finish falla', async () => {
    api.finishResult = httpError(401, 'webauthn_credential_invalid');

    await store.login('user@bupa.cl');

    expect(auth.accessToken()).toBeNull();
    expect(localStorage.getItem('access_token')).toBeNull();
  });
});
