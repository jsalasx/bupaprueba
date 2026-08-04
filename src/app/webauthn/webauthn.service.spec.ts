import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { AuthService } from '../auth.service';
import { WebAuthnHttpService } from './webauthn.service';
import { RegistrationCredentialJSON } from './webauthn.dto';
import { toWebAuthnFailure } from './webauthn-error.mapper';

/** Independiente del host: apiBaseUrl cambia entre local, QA y producción. */
const endsWith = (path: string) => (req: { url: string }) => req.url.endsWith(path);

const credential: RegistrationCredentialJSON = {
  id: 'Y3JlZC1pZA',
  rawId: 'Y3JlZC1pZA',
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0ZXN0' },
};

describe('WebAuthnHttpService', () => {
  let service: WebAuthnHttpService;
  let auth: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    service = TestBed.inject(WebAuthnHttpService);
    auth = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);

    auth.accessToken.set('user-access-token');
    auth.sessionId.set('session-abc');
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  describe('register/begin', () => {
    it('manda el body VACÍO y los headers de sesión', () => {
      service.registerBegin().subscribe();

      const req = httpMock.expectOne(endsWith('/auth/webauthn/register/begin'));

      // La identidad sale de la sesión: mandar username aquí permitiría
      // registrar passkeys contra la cuenta de otro.
      expect(req.request.body).toEqual({});
      expect(req.request.headers.get('session-id')).toBe('session-abc');
      expect(req.request.headers.get('Authorization')).toBe('Bearer user-access-token');

      req.flush({ ceremonyId: 'cer-1', publicKey: {} });
    });

    it('aplana el envoltorio publicKey.publicKey de go-webauthn', () => {
      // El backend serializa un protocol.CredentialCreation, que anida las
      // opciones un nivel más. Si esto no se aplana, el plugin nativo responde
      // "requestJson is required" porque no encuentra el challenge.
      const options = {
        challenge: 'Y2hhbGxlbmdl',
        rp: { name: 'Blua Salud Digital', id: 'localhost' },
        user: { id: 'dXNlcg', name: 'a@b.cl', displayName: 'A' },
        pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }],
      };

      let received: unknown;
      service.registerBegin().subscribe(res => (received = res.publicKey));

      httpMock
        .expectOne(endsWith('/auth/webauthn/register/begin'))
        .flush({ ceremonyId: 'cer-1', publicKey: { publicKey: options } });

      expect(received).toEqual(options);
    });

    it('deja las opciones intactas si ya vienen planas', () => {
      const options = {
        challenge: 'Y2hhbGxlbmdl',
        rp: { name: 'Blua' },
        user: { id: 'dXNlcg', name: 'a@b.cl', displayName: 'A' },
        pubKeyCredParams: [],
      };

      let received: unknown;
      service.registerBegin().subscribe(res => (received = res.publicKey));

      httpMock
        .expectOne(endsWith('/auth/webauthn/register/begin'))
        .flush({ ceremonyId: 'cer-1', publicKey: options });

      expect(received).toEqual(options);
    });

    it('no llega a la red si no hay sesión', () => {
      auth.accessToken.set(null);

      let failureCode: string | undefined;
      service.registerBegin().subscribe({
        error: err => (failureCode = toWebAuthnFailure(err).code),
      });

      expect(failureCode).toBe('webauthn_unauthorized');
      httpMock.expectNone(endsWith('/auth/webauthn/register/begin'));
    });

    it('propaga el 429 con su code para que el store aplique backoff', () => {
      let retryAfter: number | undefined;
      service.registerBegin().subscribe({
        error: (err: HttpErrorResponse) => (retryAfter = toWebAuthnFailure(err).retryAfterSeconds),
      });

      httpMock.expectOne(endsWith('/auth/webauthn/register/begin')).flush(
        { code: 'webauthn_rate_limited', message: 'too many' },
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '45' } },
      );

      expect(retryAfter).toBe(45);
    });

    it('propaga el 401 webauthn_unauthorized del backend', () => {
      let recovery: string | undefined;
      service.registerBegin().subscribe({
        error: err => (recovery = toWebAuthnFailure(err).recovery),
      });

      httpMock
        .expectOne(endsWith('/auth/webauthn/register/begin'))
        .flush(
          { code: 'webauthn_unauthorized', message: 'sin sesión' },
          { status: 401, statusText: 'Unauthorized' },
        );

      expect(recovery).toBe('reauth');
    });
  });

  describe('register/finish', () => {
    it('envía ceremonyId y la credencial cruda, sin tocar sus campos', () => {
      service.registerFinish('cer-1', credential).subscribe();

      const req = httpMock.expectOne(endsWith('/auth/webauthn/register/finish'));

      expect(req.request.body).toEqual({ ceremonyId: 'cer-1', credential });
      req.flush({ status: 'ok', credentialId: 'Y3JlZC1pZA' });
    });

    it('propaga el 400 de desafío expirado', () => {
      let recovery: string | undefined;
      service.registerFinish('cer-1', credential).subscribe({
        error: err => (recovery = toWebAuthnFailure(err).recovery),
      });

      httpMock
        .expectOne(endsWith('/auth/webauthn/register/finish'))
        .flush(
          { code: 'webauthn_challenge_invalid', message: 'expirado' },
          { status: 400, statusText: 'Bad Request' },
        );

      expect(recovery).toBe('restart');
    });

    it('propaga el 409 de credencial duplicada', () => {
      let code: string | undefined;
      service.registerFinish('cer-1', credential).subscribe({
        error: err => (code = toWebAuthnFailure(err).code),
      });

      httpMock
        .expectOne(endsWith('/auth/webauthn/register/finish'))
        .flush(
          { code: 'webauthn_credential_duplicate', message: 'ya existe' },
          { status: 409, statusText: 'Conflict' },
        );

      expect(code).toBe('webauthn_credential_duplicate');
    });
  });

  describe('authenticate', () => {
    it('begin es público y lleva el captcha obligatorio', () => {
      service.authenticateBegin('user@bupa.cl', 'captcha-token').subscribe();

      const req = httpMock.expectOne(endsWith('/auth/webauthn/authenticate/begin'));

      expect(req.request.headers.get('X-Forms-Captcha')).toBe('captcha-token');
      expect(req.request.body).toEqual({ username: 'user@bupa.cl' });
      // Endpoint público: no viaja la sesión del usuario.
      expect(req.request.headers.has('session-id')).toBe(false);

      req.flush({ ceremonyId: 'cer-2', publicKey: {} });
    });

    it('begin también aplana el envoltorio de go-webauthn', () => {
      const options = { challenge: 'Y2hhbGxlbmdl', rpId: 'portal.bupa.cl' };

      let received: unknown;
      service
        .authenticateBegin('user@bupa.cl', 'captcha')
        .subscribe(res => (received = res.publicKey));

      httpMock
        .expectOne(endsWith('/auth/webauthn/authenticate/begin'))
        .flush({ ceremonyId: 'cer-2', publicKey: { publicKey: options } });

      expect(received).toEqual(options);
    });

    it('finish no lleva captcha ni sesión', () => {
      const assertion = {
        id: 'a',
        rawId: 'a',
        type: 'public-key' as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: 'Y2xpZW50',
          authenticatorData: 'YXV0aA',
          signature: 'c2ln',
          userHandle: null,
        },
      };

      service.authenticateFinish('cer-2', assertion).subscribe();

      const req = httpMock.expectOne(endsWith('/auth/webauthn/authenticate/finish'));

      expect(req.request.body).toEqual({ ceremonyId: 'cer-2', credential: assertion });
      expect(req.request.headers.has('X-Forms-Captcha')).toBe(false);

      req.flush({ status: 'ok', accessToken: 'at', refreshToken: 'rt' });
    });
  });

  describe('gestión de dispositivos', () => {
    it('lista con los headers de sesión', () => {
      service.listCredentials().subscribe();

      const req = httpMock.expectOne(endsWith('/auth/webauthn/credentials'));
      expect(req.request.method).toBe('GET');
      req.flush({ credentials: [] });
    });

    it('escapa el credentialId base64url en la URL', () => {
      // Los "-" y "_" son seguros, pero el id se trata como dato, no como path.
      service.renameCredential('abc-_123', 'iPhone de Ale').subscribe();

      const req = httpMock.expectOne(
        r => r.method === 'PATCH' && r.url.endsWith('/credentials/abc-_123'),
      );

      expect(req.request.body).toEqual({ name: 'iPhone de Ale' });
      req.flush({ status: 'ok' });
    });

    it('revoca con DELETE y propaga el 404 para refrescar la lista', () => {
      let recovery: string | undefined;
      service.deleteCredential('abc').subscribe({
        error: err => (recovery = toWebAuthnFailure(err).recovery),
      });

      httpMock
        .expectOne(r => r.method === 'DELETE' && r.url.endsWith('/credentials/abc'))
        .flush(
          { code: 'webauthn_credential_not_found', message: 'no existe' },
          { status: 404, statusText: 'Not Found' },
        );

      expect(recovery).toBe('refresh');
    });
  });
});
