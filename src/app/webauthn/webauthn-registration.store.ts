/**
 * Máquina de estados del registro de passkey.
 *
 * Estados y transiciones válidas:
 *
 *   idle ──register()──► begin ──► ceremony ──► finish ──► success
 *     ▲                    │          │           │
 *     │                    ▼          ▼           ▼
 *     └────── reset() ── error ◄── cancelled ◄────┘
 *
 * Reglas que impone el backend y que esta máquina respeta:
 *  - El `ceremonyId` es de UN SOLO USO y el desafío vive 60 s. Si el usuario
 *    cancela o tarda, se vuelve a `begin`; NUNCA se reintenta con el mismo id.
 *  - Un 429 deja el store en `cooldown` con el botón bloqueado, para que no se
 *    pueda gastar el límite de 10 ceremonias por identidad cada 60 s a botonazos.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { WebAuthnHttpService } from './webauthn.service';
import { WEBAUTHN_PLATFORM } from './webauthn-platform.service';
import { WebAuthnFailure, toWebAuthnFailure } from './webauthn-error.mapper';

export type RegistrationState =
  | 'idle'
  /** Comprobando soporte de la plataforma. */
  | 'checking'
  /** Sin autenticador de plataforma: no se muestra la opción. */
  | 'unsupported'
  /** POST /register/begin en vuelo. */
  | 'begin'
  /** Prompt del sistema abierto (Face ID / huella / PIN). */
  | 'ceremony'
  /** POST /register/finish en vuelo. */
  | 'finish'
  | 'success'
  | 'error'
  /** Bloqueado por rate limit. */
  | 'cooldown';

@Injectable({ providedIn: 'root' })
export class WebAuthnRegistrationStore {
  private readonly api = inject(WebAuthnHttpService);
  private readonly platform = inject(WEBAUTHN_PLATFORM);

  readonly state = signal<RegistrationState>('idle');
  readonly failure = signal<WebAuthnFailure | null>(null);
  /** Id de la passkey recién creada (base64url), sólo para confirmar en UI. */
  readonly registeredId = signal<string | null>(null);
  /** Segundos restantes de bloqueo tras un 429. */
  readonly cooldownSeconds = signal(0);

  /** `true` mientras haya cualquier paso en vuelo: bloquea el botón. */
  readonly busy = computed(() =>
    ['checking', 'begin', 'ceremony', 'finish'].includes(this.state()),
  );

  readonly canRegister = computed(
    () => !this.busy() && this.state() !== 'unsupported' && this.state() !== 'cooldown',
  );

  /** Mensaje a mostrar; vacío cuando el usuario canceló (cancelación silenciosa). */
  readonly errorMessage = computed(() => this.failure()?.message || null);

  private cooldownTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Feature detection. Se llama antes de pintar la UI de passkeys: si no hay
   * autenticador de plataforma, la opción no se muestra y el usuario se queda
   * con los métodos actuales (Google, Apple, OTP, biometría nativa).
   */
  async checkSupport(): Promise<boolean> {
    this.state.set('checking');

    const supported = await this.platform.isAvailable();
    this.state.set(supported ? 'idle' : 'unsupported');

    return supported;
  }

  /** Ceremonia completa de registro. Devuelve `true` sólo si terminó en `finish` 200. */
  async register(): Promise<boolean> {
    if (!this.canRegister()) {
      return false;
    }

    this.failure.set(null);
    this.registeredId.set(null);

    try {
      this.state.set('begin');
      const { ceremonyId, publicKey } = await firstValueFrom(this.api.registerBegin());

      // A partir de aquí el reloj de 60 s del desafío corre.
      this.state.set('ceremony');
      const credential = await this.platform.createCredential(publicKey);

      this.state.set('finish');
      const result = await firstValueFrom(this.api.registerFinish(ceremonyId, credential));

      this.registeredId.set(result.credentialId);
      this.state.set('success');
      return true;
    } catch (error) {
      this.handleFailure(error);
      return false;
    }
  }

  /** Vuelve a `idle` desde `success`/`error`. No toca el cooldown. */
  reset(): void {
    if (this.state() === 'cooldown' || this.busy()) {
      return;
    }
    this.failure.set(null);
    this.registeredId.set(null);
    this.state.set('idle');
  }

  private handleFailure(error: unknown): void {
    const failure = toWebAuthnFailure(error);
    this.failure.set(failure);

    switch (failure.recovery) {
      case 'silent':
        // Cancelación del usuario: vuelve a idle sin error rojo.
        this.failure.set(null);
        this.state.set('idle');
        return;

      case 'hide':
        this.state.set('unsupported');
        return;

      case 'backoff':
        this.startCooldown(failure.retryAfterSeconds ?? 60);
        return;

      // 'restart' comparte tratamiento con el resto: el botón queda habilitado
      // y el siguiente intento arranca de nuevo desde `begin`, que es
      // exactamente lo que pide un desafío expirado.
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
