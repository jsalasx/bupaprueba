import { Component, input, output } from '@angular/core';

/**
 * Botón presentacional (dumb) de "Sign in with Apple".
 * Sigue las Human Interface Guidelines de Apple: logo + texto, temas claro/oscuro.
 * No conoce el AuthService: solo emite (press) para que el contenedor decida.
 */
@Component({
  selector: 'app-apple-sign-in-button',
  templateUrl: './apple-sign-in-button.html',
  styleUrls: ['./apple-sign-in-button.css'],
  standalone: true,
})
export class AppleSignInButton {
  /** 'black' (fondo negro) u 'white' (fondo blanco con borde). Default: 'black'. */
  theme = input<'black' | 'white'>('black');
  /** Texto del botón. */
  label = input('Continuar con Apple');
  /** Deshabilita el botón (p. ej. durante una redirección en curso). */
  disabled = input(false);

  readonly press = output<void>();

  onClick(): void {
    if (!this.disabled()) {
      this.press.emit();
    }
  }
}
