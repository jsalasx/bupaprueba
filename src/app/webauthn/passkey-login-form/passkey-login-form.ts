import { Component, computed, input, output, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AuthenticationState } from '../webauthn-authentication.store';

/**
 * Formulario de login con passkey — componente de presentación puro.
 * El email vive aquí porque es estado de formulario; todo lo demás llega por
 * `input()` y sale por `output()`.
 */
@Component({
  selector: 'app-passkey-login-form',
  templateUrl: './passkey-login-form.html',
  styleUrls: ['./passkey-login-form.css'],
  standalone: true,
})
export class PasskeyLoginForm {
  supported = input.required<boolean>();
  state = input.required<AuthenticationState>();
  errorMessage = input<string | null>(null);
  cooldownSeconds = input(0);
  enabled = input.required<boolean>();

  login = output<string>();

  readonly email = signal('');

  /** El texto nombra el gesto real de cada plataforma. */
  readonly ctaLabel = computed(() =>
    Capacitor.getPlatform() === 'ios'
      ? '🔑 Ingresar con Face ID / Touch ID'
      : '🔑 Ingresar con huella o Face ID',
  );

  readonly isValidEmail = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email().trim()));

  onEmailInput(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  submit(): void {
    if (!this.enabled() || !this.isValidEmail()) {
      return;
    }
    this.login.emit(this.email().trim());
  }
}
