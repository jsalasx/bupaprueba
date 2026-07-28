import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { Observable, throwError } from 'rxjs';
import { tap } from 'rxjs/operators';
import {
  APPLE_LOGIN_URL,
  AUTH_ME_URL,
  APPLE_EXCHANGE_URL,
  APPLE_PLATFORM_PARAM,
} from './apple-auth.config';
import { environment } from '../environments/environment';

/** Datos que la hoja nativa de Apple entrega y la app postea al backend. */
export interface AppleExchangePayload {
  identityToken: string;
  authorizationCode: string;
  nonce: string;
  /** Apple solo entrega name/email en el PRIMER login del usuario. */
  email?: string;
  givenName?: string;
  familyName?: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  /** Ausente en el login biométrico, que solo devuelve los dos tokens. */
  expiresIn?: number;
  /** Header `session-id` en POST /onboarding y POST /user/complete. Lo devuelve /auth/azure. */
  sessionId?: string;
  /** Perfil básico devuelto junto con la sesión (hoy solo /auth/azure). */
  user?: { email: string; name: string; picture: string };
}

/** Error de negocio del backend: `message` ya viene en español y es apto para mostrar. */
export interface ApiError {
  code: string;
  message: string;
}

/**
 * Texto a mostrar ante un error de API. Prefiere el `message` del backend, que
 * ya viene en español, en vez del "Http failure response for…" de HttpClient.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as ApiError | null;
    if (body?.message) {
      return body.message;
    }
    if (error.status === 0) {
      return 'No pudimos conectar con el servidor. Revisa tu conexión.';
    }
    return fallback;
  }

  return error instanceof Error && error.message ? error.message : fallback;
}

/** Usuario devuelto por GET /auth/me cuando hay una sesión válida (cookie HttpOnly). */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  provider: string;
}

/**
 * Respuesta de GET /auth/me?token=… (flujo Apple en Android).
 * Además de la sesión (accessToken/refreshToken/sessionId) puede traer el
 * perfil, ya sea anidado en `user` o plano en la raíz.
 */
export interface TokenSessionResponse extends AuthResponse {
  id?: string;
  name?: string;
  email?: string;
  provider?: string;
}

export interface BiometricRegisterResponse {
  biometricToken: string;
  deviceId: string;
  expiresIn: number;
}

/**
 * Respuesta de POST /auth/biometric/token.
 * OJO: el `refreshToken` es el NUEVO biometricToken — el backend revoca el
 * anterior en cada uso, así que hay que reemplazarlo en el Keychain o el
 * siguiente login biométrico fallará.
 */
export interface BiometricLoginResponse {
  accessToken: string;
  refreshToken: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly BASE_URL = environment.apiBaseUrl;
  private readonly ACCESS_TOKEN_KEY = 'access_token';
  private readonly REFRESH_TOKEN_KEY = 'refresh_token';
  private readonly SESSION_ID_KEY = 'session_id';
  private readonly DEVICE_ID_KEY = 'device_id';
  private readonly BEARER_TOKEN_PUBLIC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJwdWJsaWMiLCJleHAiOjE3ODM1MzQ2NzQsImlhdCI6MTc4MzUyNTY3NCwiaXNzIjoicHVibGljIiwianRpIjoiNGY5Y2UyMGEtZWQxMy00YyIsInB1YmxpY0tleSI6IjRmOWNlMjBhLWVkMTMtNGMiLCJyb2xlcyI6IldfcmtoWlA3dG84Mk5mcGlaVExhSGc9PSIsInNpdGUiOiJwdWJsaWMiLCJzdWIiOiIwMDAwMDAwMDAwMDAwMDAwYzZkMTliNTQxMzliNGE1NGUzNzkxMjg4ZmYxNTYzYTEiLCJ1c2VybmFtZSI6IjJENnpjYzcxTnZBT1dvVlVKMkZpVTBTcTR0TT0ifQ.NjhyKDMuwUXz7trjnbIHk33Kv7Vnj9VwdqoufJ2hFq8";
  readonly BIOMETRIC_SERVER = 'com.bupa.app';
  private readonly headers = new HttpHeaders({
      Authorization: `Bearer ${this.BEARER_TOKEN_PUBLIC}`,
    });
  accessToken = signal<string | null>(localStorage.getItem(this.ACCESS_TOKEN_KEY));

  /** sessionId de la sesión activa; requerido por el onboarding. */
  sessionId = signal<string | null>(localStorage.getItem(this.SESSION_ID_KEY));

  /** Usuario de la sesión activa (poblado por me() tras el login con Apple). */
  currentUser = signal<SessionUser | null>(null);

  constructor(private http: HttpClient) {}

  // ── Sign in with Apple (flujo de redirección de servidor / form_post) ──────

  /**
   * Inicia el login con Apple. No es fetch/HttpClient: el backend redirige a
   * Apple y, tras el callback, de vuelta a la app.
   *
   * El query param `platform` le dice al backend a dónde devolver al usuario:
   *   - `web`     → redirect HTTP a las rutas Angular /auth/apple/success|error.
   *   - `android` → redirect al deep link APPLE_DEEP_LINK_URL con `token` (o
   *                 `error`) en el query string, porque la cookie HttpOnly del
   *                 Custom Tab no llega al WebView de la app.
   *
   * En Android se abre un Chrome Custom Tab (Browser de Capacitor) en vez de
   * navegar el WebView: Apple rechaza el login dentro de webviews embebidos.
   */
  async loginWithApple(): Promise<void> {
    const url = `${APPLE_LOGIN_URL}?${APPLE_PLATFORM_PARAM}=${this.platform()}`;

    if (Capacitor.getPlatform() === 'android') {
      await Browser.open({ url, presentationStyle: 'fullscreen' });
      return;
    }

    window.location.href = url;
  }

  /** Plataforma que se envía al backend en el login con Apple. */
  private platform(): 'web' | 'android' {
    return Capacitor.getPlatform() === 'android' ? 'android' : 'web';
  }

  /**
   * Lee la sesión actual apoyándose en la cookie HttpOnly (withCredentials).
   * 200 → { id, name, email, provider }; 401 → sin sesión (tratar como no autenticado).
   */
  me(): Observable<SessionUser> {
    return this.http
      .get<SessionUser>(AUTH_ME_URL, { withCredentials: true })
      .pipe(tap(user => this.currentUser.set(user)));
  }

  /**
   * Resuelve la sesión a partir del `token` que llega por el deep link (Android).
   * En nativo no hay cookie HttpOnly que enviar, así que el token viaja como
   * query param y el backend responde con la sesión completa
   * (accessToken, refreshToken, sessionId y perfil), que se guarda igual que en
   * el resto de los logins.
   */
  meWithToken(token: string): Observable<TokenSessionResponse> {
    return this.http
      .get<TokenSessionResponse>(AUTH_ME_URL, { params: new HttpParams().set('token', token) })
      .pipe(
        tap(res => {
          if (!res?.accessToken) {
            throw new Error('El backend no devolvió el accessToken de la sesión.');
          }

          this.saveSession(res);

          // El perfil puede venir plano en la raíz en vez de dentro de `user`.
          if (!res.user && (res.email || res.name)) {
            this.currentUser.set({
              id: res.id ?? '',
              name: res.name ?? '',
              email: res.email ?? '',
              provider: res.provider ?? 'apple',
            });
          }
        }),
      );
  }

  /**
   * Flujo NATIVO iOS: intercambia el identityToken de Apple por tokens de sesión.
   * Espejo de exchangeGoogleCode; guarda la sesión en localStorage (no cookie).
   * ⚠️ Requiere que backend implemente POST /auth/apple/exchange (ver APPLE_EXCHANGE_URL).
   */
  exchangeAppleCode(payload: AppleExchangePayload): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(APPLE_EXCHANGE_URL, payload, { headers: this.headers })
      .pipe(tap(res => this.saveSession(res)));
  }

  /** Login con Google Identity Services (web) */
  googleLogin(idToken: string): Observable<AuthResponse> {
    
    return this.http
      .post<AuthResponse>(`${this.BASE_URL}/auth/google`, { idToken }, { headers: this.headers })
      .pipe(tap(res => this.saveSession(res)));
  }

  /**
   * Login con Microsoft (Azure AD / Entra ID).
   * Solo viaja el `idToken` de MSAL: el backend valida firma, issuer, audiencia y
   * tenant. El access_token de Microsoft no se usa ni se envía. Endpoint público
   * (sin captcha ni header session-id) que devuelve la sesión de Bupa en el body.
   */
  azureLogin(idToken: string): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(`${this.BASE_URL}/auth/azure`, { idToken }, { headers: this.headers })
      .pipe(tap(res => this.saveSession(res)));
  }

  /** Intercambia auth code PKCE con el backend (flujo nativo iOS) */
  exchangeGoogleCode(code: string, codeVerifier: string, redirectUri: string): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(`${this.BASE_URL}/auth/google/exchange`, { code, codeVerifier, redirectUri }, {headers: this.headers })
      .pipe(tap(res => this.saveSession(res)));
  }

  /**
   * Registra biometría para este dispositivo.
   * Requiere la sesión del usuario: `Authorization: Bearer <accessToken>` y el
   * header `session-id`. El bearer público NO sirve aquí.
   */
  registerBiometric(deviceId: string): Observable<BiometricRegisterResponse> {
    const accessToken = this.accessToken();
    if (!accessToken) {
      return throwError(() => new Error('No hay sesión activa para registrar la biometría.'));
    }

    let headers = new HttpHeaders({ Authorization: `Bearer ${accessToken}` });

    const sessionId = this.sessionId();
    if (sessionId) {
      headers = headers.set('session-id', sessionId);
    }

    return this.http.post<BiometricRegisterResponse>(
      `${this.BASE_URL}/auth/biometric/register`,
      { deviceId },
      { headers },
    );
  }

  /**
   * Login biométrico — canjea el biometricToken por una sesión nueva.
   * Endpoint anónimo: no lleva Authorization de usuario ni session-id.
   * El `refreshToken` que devuelve es el biometricToken rotado; el llamador debe
   * guardarlo en el Keychain porque el anterior queda revocado.
   */
  biometricLogin(biometricToken: string, deviceId: string): Observable<BiometricLoginResponse> {
    return this.http
      .post<BiometricLoginResponse>(`${this.BASE_URL}/auth/biometric/token`, {
        biometricToken,
        deviceId,
      })
      .pipe(tap(res => this.saveSession(res)));
  }

  saveSession(res: AuthResponse): void {
    localStorage.setItem(this.ACCESS_TOKEN_KEY, res.accessToken);
    localStorage.setItem(this.REFRESH_TOKEN_KEY, res.refreshToken);
    this.accessToken.set(res.accessToken);

    // Solo /auth/azure lo devuelve hoy; los demás flujos dejan la sesión anterior intacta.
    if (res.sessionId) {
      localStorage.setItem(this.SESSION_ID_KEY, res.sessionId);
      this.sessionId.set(res.sessionId);
    }

    if (res.user) {
      this.currentUser.set({
        id: '',
        name: res.user.name,
        email: res.user.email,
        provider: 'azure',
      });
    }
  }

  clearSession(): void {
    localStorage.removeItem(this.ACCESS_TOKEN_KEY);
    localStorage.removeItem(this.REFRESH_TOKEN_KEY);
    localStorage.removeItem(this.SESSION_ID_KEY);
    this.accessToken.set(null);
    this.sessionId.set(null);
    this.currentUser.set(null);
  }

  getDeviceId(): string {
    let id = localStorage.getItem(this.DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(this.DEVICE_ID_KEY, id);
    }
    return id;
  }
}
