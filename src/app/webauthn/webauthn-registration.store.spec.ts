import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';

import { WebAuthnRegistrationStore } from './webauthn-registration.store';
import { WebAuthnHttpService } from './webauthn.service';
import { WEBAUTHN_PLATFORM, WebAuthnPlatform } from './webauthn-platform.service';
import {
  AuthenticationCredentialJSON,
  RegisterBeginResponseDto,
  RegistrationCredentialJSON,
} from './webauthn.dto';

const beginResponse: RegisterBeginResponseDto = {
  ceremonyId: 'cer-1',
  publicKey: {
    challenge: 'Y2hhbGxlbmdl',
    rp: { name: 'Bupa', id: 'portal.bupa.cl' },
    user: { id: 'dXNlcg', name: 'user@bupa.cl', displayName: 'Usuario' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { userVerification: 'required' },
  },
};

const credential: RegistrationCredentialJSON = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0ZXN0' },
};

/** Doble de plataforma controlable desde cada test. */
class PlatformStub implements WebAuthnPlatform {
  available = true;
  createError: unknown = null;
  createCalls = 0;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async createCredential(): Promise<RegistrationCredentialJSON> {
    this.createCalls++;
    if (this.createError) {
      throw this.createError;
    }
    return credential;
  }

  async getCredential(): Promise<AuthenticationCredentialJSON> {
    throw new Error('no usado en registro');
  }
}

/** Doble del cliente HTTP: cada test decide qué devuelve begin/finish. */
class ApiStub {
  beginResult: unknown = of(beginResponse);
  finishResult: unknown = of({ status: 'ok', credentialId: 'Y3JlZA' });
  beginCalls = 0;
  finishArgs: { ceremonyId: string }[] = [];

  registerBegin() {
    this.beginCalls++;
    return this.beginResult as any;
  }

  registerFinish(ceremonyId: string) {
    this.finishArgs.push({ ceremonyId });
    return this.finishResult as any;
  }
}

const httpError = (status: number, code: string) =>
  throwError(() => new HttpErrorResponse({ status, error: { code, message: 'x' } }));

describe('WebAuthnRegistrationStore — máquina de estados', () => {
  let store: WebAuthnRegistrationStore;
  let platform: PlatformStub;
  let api: ApiStub;

  beforeEach(() => {
    platform = new PlatformStub();
    api = new ApiStub();

    TestBed.configureTestingModule({
      providers: [
        { provide: WEBAUTHN_PLATFORM, useValue: platform },
        { provide: WebAuthnHttpService, useValue: api },
      ],
    });

    store = TestBed.inject(WebAuthnRegistrationStore);
  });

  describe('feature detection', () => {
    it('deja el store en idle cuando hay autenticador de plataforma', async () => {
      await expect(store.checkSupport()).resolves.toBe(true);
      expect(store.state()).toBe('idle');
      expect(store.canRegister()).toBe(true);
    });

    it('marca unsupported y bloquea el registro si no lo hay', async () => {
      platform.available = false;

      await expect(store.checkSupport()).resolves.toBe(false);
      expect(store.state()).toBe('unsupported');
      expect(store.canRegister()).toBe(false);
    });
  });

  describe('camino feliz', () => {
    it('begin → ceremonia → finish → success', async () => {
      await expect(store.register()).resolves.toBe(true);

      expect(store.state()).toBe('success');
      expect(store.registeredId()).toBe('Y3JlZA');
      expect(store.failure()).toBeNull();
      // El ceremonyId que salió de begin es el que se manda a finish.
      expect(api.finishArgs).toEqual([{ ceremonyId: 'cer-1' }]);
    });

    it('reset() vuelve a idle y limpia el resultado', async () => {
      await store.register();
      store.reset();

      expect(store.state()).toBe('idle');
      expect(store.registeredId()).toBeNull();
    });
  });

  describe('cancelación del usuario', () => {
    it('NotAllowedError vuelve a idle SIN error visible', async () => {
      platform.createError = Object.assign(new Error(), { name: 'NotAllowedError' });

      await expect(store.register()).resolves.toBe(false);

      expect(store.state()).toBe('idle');
      expect(store.errorMessage()).toBeNull();
      expect(store.canRegister()).toBe(true);
    });

    it('no manda finish si la ceremonia se canceló', async () => {
      platform.createError = Object.assign(new Error(), { name: 'NotAllowedError' });

      await store.register();

      expect(api.finishArgs).toEqual([]);
    });
  });

  describe('errores', () => {
    it('InvalidStateError se muestra como dispositivo ya registrado', async () => {
      platform.createError = Object.assign(new Error(), { name: 'InvalidStateError' });

      await store.register();

      expect(store.state()).toBe('error');
      expect(store.errorMessage()).toBe('Este dispositivo ya está registrado.');
    });

    it('un desafío expirado deja el botón listo para arrancar de cero', async () => {
      api.finishResult = httpError(400, 'webauthn_challenge_invalid');

      await store.register();

      expect(store.state()).toBe('error');
      expect(store.failure()?.recovery).toBe('restart');
      // Clave: el ceremonyId es de un solo uso, así que se debe poder reintentar
      // y el reintento tiene que volver a pasar por begin.
      expect(store.canRegister()).toBe(true);

      api.finishResult = of({ status: 'ok', credentialId: 'nuevo' });
      await store.register();

      expect(api.beginCalls).toBe(2);
      expect(store.state()).toBe('success');
    });

    it('503 apaga la feature en vez de mostrar un error reintentable', async () => {
      api.beginResult = httpError(503, 'SERVICE_UNAVAILABLE');

      await store.register();

      expect(store.state()).toBe('unsupported');
      expect(store.canRegister()).toBe(false);
    });

    it('401 deja constancia de que hay que re-autenticarse', async () => {
      api.beginResult = httpError(401, 'webauthn_unauthorized');

      await store.register();

      expect(store.state()).toBe('error');
      expect(store.failure()?.recovery).toBe('reauth');
    });
  });

  describe('rate limit', () => {
    it('429 bloquea el botón durante la ventana de backoff', async () => {
      api.beginResult = httpError(429, 'webauthn_rate_limited');

      await store.register();

      expect(store.state()).toBe('cooldown');
      expect(store.cooldownSeconds()).toBe(60);
      expect(store.canRegister()).toBe(false);
    });

    it('durante el cooldown no se puede gastar otra ceremonia a botonazos', async () => {
      api.beginResult = httpError(429, 'webauthn_rate_limited');
      await store.register();

      const callsAfterLimit = api.beginCalls;

      await expect(store.register()).resolves.toBe(false);
      await expect(store.register()).resolves.toBe(false);

      expect(api.beginCalls).toBe(callsAfterLimit);
    });

    it('el cooldown se agota y devuelve el store a idle', async () => {
      vi.useFakeTimers();
      try {
        api.beginResult = httpError(429, 'webauthn_rate_limited');
        await store.register();

        vi.advanceTimersByTime(60_000);

        expect(store.state()).toBe('idle');
        expect(store.cooldownSeconds()).toBe(0);
        expect(store.canRegister()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('reentrada', () => {
    it('busy() bloquea el botón mientras la ceremonia está en curso', async () => {
      let resolveCeremony: (() => void) | undefined;
      platform.createCredential = () =>
        new Promise<RegistrationCredentialJSON>(resolve => {
          resolveCeremony = () => resolve(credential);
        });

      const pending = store.register();
      await Promise.resolve();

      expect(store.state()).toBe('ceremony');
      expect(store.busy()).toBe(true);
      expect(store.canRegister()).toBe(false);

      // Un segundo click mientras el prompt está abierto no arranca otra ceremonia.
      await expect(store.register()).resolves.toBe(false);
      expect(api.beginCalls).toBe(1);

      resolveCeremony!();
      await pending;

      expect(store.state()).toBe('success');
    });
  });
});
