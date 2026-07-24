import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { AuthResponse, AuthService } from './auth.service';

/** Independiente del host: BASE_URL cambia entre local, QA y producción. */
const azureUrl = (req: { url: string }) => req.url.endsWith('/auth/azure');

describe('AuthService — login con Microsoft', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;

  const okResponse: AuthResponse = {
    accessToken: 'bupa-access-token',
    refreshToken: 'bupa-refresh-token',
    expiresIn: 3600,
    sessionId: 'c8d2-session',
    user: { email: 'user@bupa.cl', name: 'Usuario Bupa', picture: '' },
  };

  beforeEach(() => {
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  it('envía únicamente el idToken en el body', () => {
    service.azureLogin('ms-id-token').subscribe();

    const req = httpMock.expectOne(azureUrl);
    expect(req.request.method).toBe('POST');
    // El access_token de Microsoft no debe viajar a ningún lado.
    expect(req.request.body).toEqual({ idToken: 'ms-id-token' });
    req.flush(okResponse);
  });

  it('guarda la sesión de Bupa en el store común', () => {
    service.azureLogin('ms-id-token').subscribe();
    httpMock.expectOne(azureUrl).flush(okResponse);

    expect(service.accessToken()).toBe('bupa-access-token');
    expect(service.sessionId()).toBe('c8d2-session');
    expect(localStorage.getItem('access_token')).toBe('bupa-access-token');
    expect(localStorage.getItem('refresh_token')).toBe('bupa-refresh-token');
    expect(localStorage.getItem('session_id')).toBe('c8d2-session');
  });

  it('expone el usuario devuelto con provider azure', () => {
    service.azureLogin('ms-id-token').subscribe();
    httpMock.expectOne(azureUrl).flush(okResponse);

    expect(service.currentUser()).toEqual({
      id: '',
      name: 'Usuario Bupa',
      email: 'user@bupa.cl',
      provider: 'azure',
    });
  });

  it('no inicia sesión cuando el backend rechaza el token', () => {
    let status = 0;
    service.azureLogin('token-manipulado').subscribe({
      error: err => (status = err.status),
    });

    httpMock.expectOne(azureUrl).flush(
      { code: 'INVALID_AZURE_TOKEN', message: 'El token de Microsoft no es válido.' },
      { status: 401, statusText: 'Unauthorized' },
    );

    expect(status).toBe(401);
    expect(service.accessToken()).toBeNull();
    expect(service.sessionId()).toBeNull();
  });

  it('clearSession borra también el sessionId', () => {
    service.azureLogin('ms-id-token').subscribe();
    httpMock.expectOne(azureUrl).flush(okResponse);

    service.clearSession();

    expect(service.sessionId()).toBeNull();
    expect(localStorage.getItem('session_id')).toBeNull();
  });

  it('registra biometría con el accessToken del usuario y el session-id', () => {
    service.azureLogin('ms-id-token').subscribe();
    httpMock.expectOne(azureUrl).flush(okResponse);

    service.registerBiometric('test-device-004').subscribe();

    const req = httpMock.expectOne(r => r.url.endsWith('/auth/biometric/register'));
    // El bearer público NO sirve en este endpoint.
    expect(req.request.headers.get('Authorization')).toBe('Bearer bupa-access-token');
    expect(req.request.headers.get('session-id')).toBe('c8d2-session');
    expect(req.request.body).toEqual({ deviceId: 'test-device-004' });
    req.flush({
      biometricToken: 'bio-token-1',
      deviceId: 'test-device-004',
      expiresIn: 7776000,
    });
  });

  it('no llama a registrar biometría si no hay sesión', () => {
    let message = '';
    service.registerBiometric('test-device-004').subscribe({
      error: err => (message = err.message),
    });

    httpMock.expectNone(r => r.url.endsWith('/auth/biometric/register'));
    expect(message).toContain('No hay sesión activa');
  });

  it('el login biométrico es anónimo y devuelve el token rotado', () => {
    let rotated = '';
    service.biometricLogin('bio-token-1', 'test-device-004').subscribe(res => {
      rotated = res.refreshToken;
    });

    const req = httpMock.expectOne(r => r.url.endsWith('/auth/biometric/token'));
    expect(req.request.body).toEqual({
      biometricToken: 'bio-token-1',
      deviceId: 'test-device-004',
    });
    expect(req.request.headers.has('session-id')).toBe(false);
    req.flush({ accessToken: 'nuevo-access', refreshToken: 'bio-token-2' });

    // `refreshToken` es el siguiente biometricToken: el anterior queda revocado.
    expect(rotated).toBe('bio-token-2');
    expect(service.accessToken()).toBe('nuevo-access');
  });

  it('un login sin sessionId no pisa el ya guardado', () => {
    service.azureLogin('ms-id-token').subscribe();
    httpMock.expectOne(azureUrl).flush(okResponse);

    service.googleLogin('google-id-token').subscribe();
    httpMock
      .expectOne(req => req.url.endsWith('/auth/google'))
      .flush({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 3600 });

    expect(service.sessionId()).toBe('c8d2-session');
  });
});
