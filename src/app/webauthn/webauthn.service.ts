/**
 * Cliente de los 7 endpoints de FIDO2/WebAuthn del ms-controller.
 *
 * Sólo HTTP: arma la petición, tipa la respuesta y deja pasar el error tal cual
 * para que el store lo traduzca con `toWebAuthnFailure`. La lógica de ceremonia
 * (begin → autenticador → finish) vive en `webauthn-registration.store.ts`.
 *
 * Nada de la ceremonia (`ceremonyId`, `challenge`) se persiste: viven en
 * variables locales durante la llamada y mueren con ella.
 */
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth.service';
import {
  AuthenticateBegin,
  AuthenticateBeginResponseDto,
  AuthenticateFinishResponseDto,
  AuthenticationCredentialJSON,
  RegisterBegin,
  RegisterBeginResponseDto,
  RegisterFinishResponseDto,
  RegistrationCredentialJSON,
  WebAuthnCredentialListDto,
  WebAuthnStatusDto,
  unwrapOptions,
} from './webauthn.dto';
import { WebAuthnCeremonyError } from './webauthn-error.mapper';

const WEBAUTHN_PATH = '/auth/webauthn';

@Injectable({ providedIn: 'root' })
export class WebAuthnHttpService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly base = `${environment.apiBaseUrl}${WEBAUTHN_PATH}`;

  // ── Registro (requiere sesión) ───────────────────────────────────────────

  /**
   * Body VACÍO a propósito: la identidad sale de la sesión, nunca del body.
   * Enviar un username aquí sería una vía para registrar passkeys de terceros.
   */
  registerBegin(): Observable<RegisterBegin> {
    return this.withSession(headers =>
      this.http.post<RegisterBeginResponseDto>(`${this.base}/register/begin`, {}, { headers }),
    ).pipe(
      // Aplana el envoltorio de go-webauthn: el resto del cliente trabaja
      // siempre con las opciones planas.
      map(res => ({ ...res, publicKey: unwrapOptions(res.publicKey) })),
    );
  }

  registerFinish(
    ceremonyId: string,
    credential: RegistrationCredentialJSON,
  ): Observable<RegisterFinishResponseDto> {
    return this.withSession(headers =>
      this.http.post<RegisterFinishResponseDto>(
        `${this.base}/register/finish`,
        { ceremonyId, credential },
        { headers },
      ),
    );
  }

  // ── Login sin contraseña (público, con captcha) ──────────────────────────

  /** `X-Forms-Captcha` es obligatorio: el endpoint es público. */
  authenticateBegin(
    username: string,
    captchaToken: string,
  ): Observable<AuthenticateBegin> {
    const headers = new HttpHeaders({ 'X-Forms-Captcha': captchaToken });

    return this.http
      .post<AuthenticateBeginResponseDto>(
        `${this.base}/authenticate/begin`,
        { username },
        { headers },
      )
      .pipe(map(res => ({ ...res, publicKey: unwrapOptions(res.publicKey) })));
  }

  authenticateFinish(
    ceremonyId: string,
    credential: AuthenticationCredentialJSON,
  ): Observable<AuthenticateFinishResponseDto> {
    return this.http.post<AuthenticateFinishResponseDto>(`${this.base}/authenticate/finish`, {
      ceremonyId,
      credential,
    });
  }

  // ── Gestión de dispositivos (requiere sesión) ────────────────────────────

  listCredentials(): Observable<WebAuthnCredentialListDto> {
    return this.withSession(headers =>
      this.http.get<WebAuthnCredentialListDto>(`${this.base}/credentials`, { headers }),
    );
  }

  renameCredential(credentialId: string, name: string): Observable<WebAuthnStatusDto> {
    return this.withSession(headers =>
      this.http.patch<WebAuthnStatusDto>(
        `${this.base}/credentials/${encodeURIComponent(credentialId)}`,
        { name },
        { headers },
      ),
    );
  }

  /** Revoca la credencial Y corta las sesiones abiertas con ese dispositivo. */
  deleteCredential(credentialId: string): Observable<WebAuthnStatusDto> {
    return this.withSession(headers =>
      this.http.delete<WebAuthnStatusDto>(
        `${this.base}/credentials/${encodeURIComponent(credentialId)}`,
        { headers },
      ),
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Headers de sesión. El `Authorization` con el accessToken del usuario es
   * explícito para que el interceptor no lo pise con el bearer público, igual
   * que en `/auth/biometric/register`.
   */
  private withSession<T>(call: (headers: HttpHeaders) => Observable<T>): Observable<T> {
    const accessToken = this.auth.accessToken();
    if (!accessToken) {
      return throwError(() => new WebAuthnCeremonyError('webauthn_unauthorized'));
    }

    let headers = new HttpHeaders({ Authorization: `Bearer ${accessToken}` });

    const sessionId = this.auth.sessionId();
    if (sessionId) {
      headers = headers.set('session-id', sessionId);
    }

    return call(headers);
  }
}
