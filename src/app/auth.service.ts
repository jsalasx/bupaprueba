import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { APPLE_LOGIN_URL, AUTH_ME_URL, APPLE_EXCHANGE_URL } from './apple-auth.config';

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
  expiresIn: number;
}

/** Usuario devuelto por GET /auth/me cuando hay una sesión válida (cookie HttpOnly). */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  provider: string;
}

export interface BiometricRegisterResponse {
  biometricToken: string;
  deviceId: string;
  expiresIn: number;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly BASE_URL = 'https://api-qa.bupa.cl/portal-blua/ms-controller';
  private readonly ACCESS_TOKEN_KEY = 'access_token';
  private readonly REFRESH_TOKEN_KEY = 'refresh_token';
  private readonly DEVICE_ID_KEY = 'device_id';
  private readonly BEARER_TOKEN_PUBLIC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJwdWJsaWMiLCJleHAiOjE3ODM1MzQ2NzQsImlhdCI6MTc4MzUyNTY3NCwiaXNzIjoicHVibGljIiwianRpIjoiNGY5Y2UyMGEtZWQxMy00YyIsInB1YmxpY0tleSI6IjRmOWNlMjBhLWVkMTMtNGMiLCJyb2xlcyI6IldfcmtoWlA3dG84Mk5mcGlaVExhSGc9PSIsInNpdGUiOiJwdWJsaWMiLCJzdWIiOiIwMDAwMDAwMDAwMDAwMDAwYzZkMTliNTQxMzliNGE1NGUzNzkxMjg4ZmYxNTYzYTEiLCJ1c2VybmFtZSI6IjJENnpjYzcxTnZBT1dvVlVKMkZpVTBTcTR0TT0ifQ.NjhyKDMuwUXz7trjnbIHk33Kv7Vnj9VwdqoufJ2hFq8";
  readonly BIOMETRIC_SERVER = 'com.bupa.app';
  private readonly headers = new HttpHeaders({
      Authorization: `Bearer ${this.BEARER_TOKEN_PUBLIC}`,
    });
  accessToken = signal<string | null>(localStorage.getItem(this.ACCESS_TOKEN_KEY));

  /** Usuario de la sesión activa (poblado por me() tras el login con Apple). */
  currentUser = signal<SessionUser | null>(null);

  constructor(private http: HttpClient) {}

  // ── Sign in with Apple (flujo de redirección de servidor / form_post) ──────

  /**
   * Inicia el login con Apple con una NAVEGACIÓN REAL del navegador.
   * No es fetch/HttpClient: el backend redirige a Apple y, tras el callback,
   * de vuelta a la ruta de éxito o error de Angular.
   */
  loginWithApple(): void {
    window.location.href = APPLE_LOGIN_URL;
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

  /** Intercambia auth code PKCE con el backend (flujo nativo iOS) */
  exchangeGoogleCode(code: string, codeVerifier: string, redirectUri: string): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(`${this.BASE_URL}/auth/google/exchange`, { code, codeVerifier, redirectUri }, {headers: this.headers })
      .pipe(tap(res => this.saveSession(res)));
  }

  /** Registra biometría para este dispositivo (requiere accessToken vigente) */
  registerBiometric(deviceId: string): Observable<BiometricRegisterResponse> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${this.accessToken()}` });
    return this.http.post<BiometricRegisterResponse>(
      `${this.BASE_URL}/auth/biometric/register`,
      { deviceId },
      { headers: this.headers },
    );
  }

  /** Login biométrico — intercambia biometricToken por nuevos accessToken/refreshToken */
  biometricLogin(biometricToken: string, deviceId: string): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(`${this.BASE_URL}/auth/biometric/token`, { biometricToken, deviceId })
      .pipe(tap(res => this.saveSession(res)));
  }

  saveSession(res: AuthResponse): void {
    localStorage.setItem(this.ACCESS_TOKEN_KEY, res.accessToken);
    localStorage.setItem(this.REFRESH_TOKEN_KEY, res.refreshToken);
    this.accessToken.set(res.accessToken);
  }

  clearSession(): void {
    localStorage.removeItem(this.ACCESS_TOKEN_KEY);
    localStorage.removeItem(this.REFRESH_TOKEN_KEY);
    this.accessToken.set(null);
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
