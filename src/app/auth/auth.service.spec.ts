import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { vi } from 'vitest';

import { AuthAzureService } from './auth.service';
import { MSAL_INSTANCE } from './auth.config';
import { AuthService } from '../auth.service';

/** Independiente del host: BASE_URL cambia entre local, QA y producción. */
const azureUrl = (req: { url: string }) => req.url.endsWith('/auth/azure');

// MSAL toca window.location y almacenamiento del navegador, que jsdom no puede
// ejecutar; se sustituye por el token MSAL_INSTANCE para probar solo lo nuestro
// (canje del id_token, manejo de errores y cancelación).
const msalMock = {
  initialize: vi.fn(),
  handleRedirectPromise: vi.fn(),
  loginRedirect: vi.fn(),
  logoutRedirect: vi.fn(),
  setActiveAccount: vi.fn(),
  getActiveAccount: vi.fn(),
  getAllAccounts: vi.fn(),
};

const account = { username: 'user@bupa.cl', name: 'Usuario Bupa' };

/** Deja correr las microtareas pendientes hasta que la petición HTTP se emite. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('AuthAzureService', () => {
  let auth: AuthService;
  let httpMock: HttpTestingController;

  /**
   * El bootstrap de MSAL corre al instanciar el servicio, así que cada test
   * configura sus mocks primero y solo entonces lo pide.
   */
  const createService = (): AuthAzureService => TestBed.inject(AuthAzureService);

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    msalMock.initialize.mockResolvedValue(undefined);
    msalMock.handleRedirectPromise.mockResolvedValue(null);
    msalMock.loginRedirect.mockResolvedValue(undefined);
    msalMock.logoutRedirect.mockResolvedValue(undefined);
    msalMock.getActiveAccount.mockReturnValue(null);
    msalMock.getAllAccounts.mockReturnValue([]);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MSAL_INSTANCE, useValue: msalMock },
      ],
    });

    auth = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  it('navega a Microsoft con el redirectUri registrado y los scopes mínimos', async () => {
    const service = createService();

    await service.login();

    expect(msalMock.loginRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'http://localhost:4200/auth-azure',
        scopes: ['openid', 'profile', 'email'],
        prompt: 'select_account',
      }),
    );
    expect(service.error()).toBeNull();
  });

  it('canjea por la sesión de Bupa el idToken que llega en el callback', async () => {
    msalMock.handleRedirectPromise.mockResolvedValue({
      account,
      idToken: 'ms-id-token',
    });
    const service = createService();

    const pending = service.initialize();
    await tick();

    const req = httpMock.expectOne(azureUrl);
    expect(req.request.method).toBe('POST');
    // El access_token de Microsoft no debe viajar a ningún lado.
    expect(req.request.body).toEqual({ idToken: 'ms-id-token' });
    req.flush({
      accessToken: 'bupa-access-token',
      refreshToken: 'r',
      expiresIn: 3600,
      sessionId: 's1',
    });

    await pending;
    expect(auth.accessToken()).toBe('bupa-access-token');
    expect(auth.sessionId()).toBe('s1');
    expect(service.isAuthenticated()).toBe(true);
    expect(service.error()).toBeNull();
  });

  it('muestra el mensaje del backend ante 401 INVALID_AZURE_TOKEN', async () => {
    msalMock.handleRedirectPromise.mockResolvedValue({
      account,
      idToken: 'token-de-otro-tenant',
    });
    const service = createService();

    const pending = service.initialize();
    await tick();

    httpMock.expectOne(azureUrl).flush(
      { code: 'INVALID_AZURE_TOKEN', message: 'El token de Microsoft no es válido.' },
      { status: 401, statusText: 'Unauthorized' },
    );

    await pending;
    expect(service.error()).toBe('El token de Microsoft no es válido.');
    expect(auth.accessToken()).toBeNull();
    expect(service.isAuthenticated()).toBe(false);
  });

  it('cancelar en la pantalla de Microsoft no muestra error', async () => {
    // Cancelar vuelve con error=access_denied, que MSAL lanza al procesar el hash.
    msalMock.handleRedirectPromise.mockRejectedValue({ errorCode: 'access_denied' });
    const service = createService();

    await service.initialize();

    expect(service.error()).toBeNull();
    expect(auth.accessToken()).toBeNull();
  });

  it('un fallo real de MSAL sí deja mensaje de error', async () => {
    msalMock.handleRedirectPromise.mockRejectedValue({
      errorCode: 'no_token_request_cache_error',
    });
    const service = createService();

    await service.initialize();

    expect(service.error()).toBe('No fue posible iniciar sesión con Microsoft.');
  });

  it('sin respuesta en el hash no llama al backend', async () => {
    const service = createService();

    await service.initialize();

    httpMock.expectNone(azureUrl);
    expect(service.isAuthenticated()).toBe(false);
  });

  it('el logout limpia la sesión de Bupa antes de navegar', async () => {
    auth.saveSession({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 3600,
      sessionId: 's1',
    });
    const service = createService();

    await service.logout();

    expect(auth.accessToken()).toBeNull();
    expect(auth.sessionId()).toBeNull();
    expect(msalMock.logoutRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        postLogoutRedirectUri: 'http://localhost:4200/auth-azure',
      }),
    );
  });
});
