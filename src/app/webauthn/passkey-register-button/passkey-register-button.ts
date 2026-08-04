import { Component, input, output } from '@angular/core';
import { RegistrationState } from '../webauthn-registration.store';

/**
 * Botón de registro de passkey — componente de presentación puro.
 * Recibe todo por `input()` y avisa por `output()`; no conoce el store ni HTTP.
 */
@Component({
  selector: 'app-passkey-register-button',
  templateUrl: './passkey-register-button.html',
  styleUrls: ['./passkey-register-button.css'],
  standalone: true,
})
export class PasskeyRegisterButton {
  /** `false` → no se pinta nada: el usuario se queda con los métodos actuales. */
  supported = input.required<boolean>();
  state = input.required<RegistrationState>();
  /** `null` cuando el usuario canceló (cancelación silenciosa, sin error rojo). */
  errorMessage = input<string | null>(null);
  cooldownSeconds = input(0);
  enabled = input.required<boolean>();

  register = output<void>();
}
