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
export interface TokenSessionResponse extends Partial<AuthResponse> {
  id?: string;
  name?: string;
  email?: string;
  provider?: string;
}

/** Respuesta de POST /otp/generate. `sent` en false significa que no se envió el correo. */
export interface GenerateOtpResponse {
  deviceId: string;
  sent: boolean;
}

/**
 * Respuesta de POST /otp/validate.
 *
 * Es un login completo: además de verificar el dispositivo devuelve la sesión
 * (accessToken, refreshToken y sessionId), así que no hace falta un segundo paso.
 */
export interface ValidateOtpResponse {
  deviceId: string;
  verified: boolean;
  verifiedAt: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Tipo de usuario del chat clínico. Lo asigna el backend según la vía de entrada:
 * OTP, Google y Apple dan de alta pacientes; la cuenta corporativa de Bupa
 * (Microsoft) da de alta al equipo médico.
 */
export type UserType = 'MEDICO' | 'PACIENTE';

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
  private readonly USER_TYPE_KEY = 'user_type';
  private readonly USER_EMAIL_KEY = 'user_email';
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

  /**
   * Tipo de usuario del chat, deducido de la pantalla por la que entró.
   *
   * Es una PISTA para enrutar y pintar, no una autorización: quien decide qué puede
   * hacer cada cual es el backend, que lo lee de la cuenta. Guardarlo aquí solo
   * evita mandar al médico al home de pacientes tras recargar la página.
   */
  userType = signal<UserType | null>(
    localStorage.getItem('user_type') as UserType | null,
  );

  /**
   * Correo de la sesión activa.
   *
   * Existe para las PRUEBAS LOCALES: sin Kong delante, el backend no recibe el
   * header X-User-Id que normalmente inyecta la puerta de enlace, así que el
   * interceptor lo suple con este valor. Ver BearerTokenInterceptor.
   */
  userEmail = signal<string | null>(localStorage.getItem('user_email'));

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
   * 200 → perfil (id, name, email, provider); 401 → sin sesión (tratar como no autenticado).
   *
   * Si la respuesta trae además los tokens de sesión (accessToken/refreshToken/
   * sessionId), se guardan igual que en el resto de los logins: sin eso, el
   * logout con Apple en web se quedaba sin `Authorization` y no podía cerrar.
   */
  me(): Observable<TokenSessionResponse> {
    return this.http
      .get<TokenSessionResponse>(AUTH_ME_URL, { withCredentials: true })
      .pipe(tap(res => this.applySession(res)));
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

          this.applySession(res, 'apple');
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

  /**
   * Cierra la sesión en el backend: POST /auth/logout.
   *
   * Endpoint de USUARIO, no anónimo: viaja el `accessToken` (JWT de la sesión)
   * en `Authorization` y el `sessionId` en el header `session-id`. El bearer
   * público NO sirve aquí, por eso se pone el Authorization explícito (el
   * interceptor solo rellena el público cuando el header falta).
   *
   * El body va vacío (`null`) a propósito: así HttpClient no agrega
   * `Content-Type`, que sumaría un header más al preflight CORS.
   */
  logout(): Observable<void> {
    const accessToken = this.accessToken();

    // Apple en web sin tokens en el body: la sesión vive solo en la cookie
    // HttpOnly, así que el logout se hace con withCredentials y sin Authorization
    // de usuario (el interceptor pondrá el bearer público).
    if (!accessToken) {
      if (!this.currentUser()) {
        return throwError(() => new Error('No hay sesión activa que cerrar.'));
      }

      return this.http.post<void>(`${this.BASE_URL}/auth/logout`, null, {
        withCredentials: true,
      });
    }

    let headers = new HttpHeaders({ Authorization: `Bearer ${accessToken}` });

    const sessionId = this.sessionId();
    if (sessionId) {
      headers = headers.set('session-id', sessionId);
    }

    return this.http.post<void>(`${this.BASE_URL}/auth/logout`, null, { headers });
  }

  /**
   * Persiste lo que venga de una respuesta de sesión: tokens si los hay y perfil
   * en cualquiera de sus dos formas (anidado en `user` o plano en la raíz).
   *
   * Los endpoints /auth/me devuelven una u otra forma según el flujo, por eso
   * los tokens son opcionales aquí: si no vienen, se conserva la sesión previa
   * en vez de borrarla.
   */
  private applySession(res: TokenSessionResponse, defaultProvider = 'apple'): void {
    if (res.accessToken) {
      this.saveSession(res as AuthResponse, defaultProvider);
    }

    // El perfil puede venir plano en la raíz en vez de dentro de `user`.
    if (!res.user && (res.email || res.name || res.id)) {
      this.currentUser.set({
        id: res.id ?? '',
        name: res.name ?? '',
        email: res.email ?? '',
        provider: res.provider ?? defaultProvider,
      });
    }
  }

  saveSession(res: AuthResponse, provider = 'azure'): void {
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
        provider,
      });
      if (res.user.email) {
        this.setUserEmail(res.user.email);
      }
    }
  }

  /**
   * POST /otp/generate — envía el código al correo indicado.
   *
   * El deviceId identifica ESTE navegador y se conserva entre intentos: es el que
   * el backend asocia al código, así que generar uno nuevo en cada intento haría
   * que la validación no encontrara nunca el código recién enviado.
   */
  generateOtp(email: string): Observable<GenerateOtpResponse> {
    const normalizado = email.trim().toLowerCase();
    // Se recuerda aquí y no al validar porque es el único punto del flujo donde el
    // correo es un dato de entrada; la validación solo recibe el código.
    this.setUserEmail(normalizado);
    return this.http.post<GenerateOtpResponse>(`${this.BASE_URL}/otp/generate`, {
      deviceId: this.getDeviceId(),
      email: normalizado,
    });
  }

  /**
   * POST /otp/validate — canjea el código por una sesión.
   *
   * Guarda la sesión al vuelo: la respuesta ya trae accessToken, refreshToken y
   * sessionId, así que quien llama no tiene que acordarse de persistirla.
   */
  validateOtp(code: string): Observable<ValidateOtpResponse> {
    return this.http
      .post<ValidateOtpResponse>(`${this.BASE_URL}/otp/validate`, {
        deviceId: this.getDeviceId(),
        code: code.trim(),
      })
      .pipe(
        tap((res) => {
          this.saveSession(
            {
              accessToken: res.accessToken,
              refreshToken: res.refreshToken,
              sessionId: res.sessionId,
            },
            'otp',
          );
          this.setUserType('PACIENTE');
        }),
      );
  }

  /** Recuerda el correo de la sesión (ver userEmail). */
  setUserEmail(email: string): void {
    localStorage.setItem(this.USER_EMAIL_KEY, email);
    this.userEmail.set(email);
  }

  /** Recuerda por qué puerta entró el usuario, para enrutarlo tras recargar. */
  setUserType(type: UserType): void {
    localStorage.setItem(this.USER_TYPE_KEY, type);
    this.userType.set(type);
  }

  /** Ruta del home que corresponde a quien está en sesión. */
  homeRoute(): string {
    return this.userType() === 'MEDICO' ? '/home/medicos' : '/home';
  }

  clearSession(): void {
    localStorage.removeItem(this.ACCESS_TOKEN_KEY);
    localStorage.removeItem(this.REFRESH_TOKEN_KEY);
    localStorage.removeItem(this.SESSION_ID_KEY);
    localStorage.removeItem(this.USER_TYPE_KEY);
    localStorage.removeItem(this.USER_EMAIL_KEY);
    this.accessToken.set(null);
    this.sessionId.set(null);
    this.currentUser.set(null);
    this.userType.set(null);
    this.userEmail.set(null);
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
