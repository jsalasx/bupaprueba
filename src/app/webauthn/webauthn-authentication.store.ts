/**
 * Máquina de estados del login con passkey.
 *
 * Espejo del store de registro, con dos diferencias que impone el contrato:
 *  - `authenticate/begin` es PÚBLICO y exige el header `X-Forms-Captcha`, así
 *    que hay un paso previo para obtener el token.
 *  - `authenticate/finish` devuelve tokens de sesión equivalentes a los de
 *    Google/Apple/OTP: se guardan con el `saveSession` de siempre. No hay
 *    almacenamiento paralelo.
 *
 *   idle ──login(email)──► captcha ──► begin ──► ceremony ──► finish ──► success
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth.service';
import { CaptchaService } from './captcha.service';
import { WebAuthnHttpService } from './webauthn.service';
import { WEBAUTHN_PLATFORM } from './webauthn-platform.service';
import { WebAuthnFailure, toWebAuthnFailure } from './webauthn-error.mapper';

export type AuthenticationState =
  | 'idle'
  | 'checking'
  /** Sin autenticador de plataforma: no se ofrece la opción. */
  | 'unsupported'
  /** Obteniendo el token de reCAPTCHA. */
  | 'captcha'
  | 'begin'
  /** Prompt del sistema abierto. */
  | 'ceremony'
  | 'finish'
  | 'success'
  | 'error'
  | 'cooldown';

@Injectable({ providedIn: 'root' })
export class WebAuthnAuthenticationStore {
  private readonly api = inject(WebAuthnHttpService);
  private readonly platform = inject(WEBAUTHN_PLATFORM);
  private readonly captcha = inject(CaptchaService);
  private readonly auth = inject(AuthService);

  readonly state = signal<AuthenticationState>('idle');
  readonly failure = signal<WebAuthnFailure | null>(null);
  readonly cooldownSeconds = signal(0);

  readonly busy = computed(() =>
    ['checking', 'captcha', 'begin', 'ceremony', 'finish'].includes(this.state()),
  );

  readonly canLogin = computed(
    () => !this.busy() && this.state() !== 'unsupported' && this.state() !== 'cooldown',
  );

  readonly errorMessage = computed(() => this.failure()?.message || null);

  private cooldownTimer: ReturnType<typeof setInterval> | null = null;

  /** Feature detection: si no hay autenticador, la opción no se muestra. */
  async checkSupport(): Promise<boolean> {
    this.state.set('checking');

    const supported = await this.platform.isAvailable();
    this.state.set(supported ? 'idle' : 'unsupported');

    return supported;
  }

  /**
   * Ceremonia completa de login. `true` si la sesión quedó guardada.
   *
   * Los mensajes de error de 401 son deliberadamente genéricos (los del mapper):
   * el backend no distingue entre usuario inexistente y credencial revocada, y
   * el cliente no debe deshacer esa ambigüedad.
   */
  async login(email: string): Promise<boolean> {
    if (!this.canLogin()) {
      return false;
    }

    this.failure.set(null);

    try {
      this.state.set('captcha');
      const captchaToken = await this.captcha.getToken('webauthn_login');

      this.state.set('begin');
      const { ceremonyId, publicKey } = await firstValueFrom(
        this.api.authenticateBegin(email, captchaToken),
      );

      this.state.set('ceremony');
      const credential = await this.platform.getCredential(publicKey);

      this.state.set('finish');
      const session = await firstValueFrom(
        this.api.authenticateFinish(ceremonyId, credential),
      );

      // Tokens equivalentes a los de los otros proveedores: mismo flujo de sesión.
      this.auth.saveSession(session);

      this.state.set('success');
      return true;
    } catch (error) {
      this.handleFailure(error);
      return false;
    }
  }

  reset(): void {
    if (this.state() === 'cooldown' || this.busy()) {
      return;
    }
    this.failure.set(null);
    this.state.set('idle');
  }

  private handleFailure(error: unknown): void {
    const failure = toWebAuthnFailure(error);
    this.failure.set(failure);

    switch (failure.recovery) {
      case 'silent':
        this.failure.set(null);
        this.state.set('idle');
        return;

      case 'hide':
        this.state.set('unsupported');
        return;

      case 'backoff':
        this.startCooldown(failure.retryAfterSeconds ?? 60);
        return;

      default:
        this.state.set('error');
    }
  }

  private startCooldown(seconds: number): void {
    this.state.set('cooldown');
    this.cooldownSeconds.set(seconds);

    this.stopCooldown();
    this.cooldownTimer = setInterval(() => {
      const left = this.cooldownSeconds() - 1;
      this.cooldownSeconds.set(left);

      if (left <= 0) {
        this.stopCooldown();
        this.failure.set(null);
        this.state.set('idle');
      }
    }, 1000);
  }

  private stopCooldown(): void {
    if (this.cooldownTimer !== null) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }
}
