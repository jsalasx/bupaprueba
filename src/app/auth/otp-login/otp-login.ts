import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage, AuthService } from '../../auth.service';

/**
 * Ingreso de pacientes por código de un solo uso enviado al correo.
 *
 * Son dos pasos en una sola pantalla: primero el correo, luego el código. Se
 * modela con un signal de fase y no con dos rutas porque volver atrás para
 * corregir el correo debe ser inmediato y sin perder nada de lo escrito.
 */
@Component({
  selector: 'app-otp-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './otp-login.html',
  styleUrls: ['./otp-login.css'],
})
export class OtpLogin {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** `email` pide el correo; `code` pide el código ya enviado. */
  readonly phase = signal<'email' | 'code'>('email');

  readonly email = signal('');
  readonly code = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  /** Envía el código al correo indicado. */
  async requestCode(): Promise<void> {
    const correo = this.email().trim();
    if (!correo) {
      this.error.set('Escribe tu correo.');
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const res = await firstValueFrom(this.auth.generateOtp(correo));

      // `sent: false` es una respuesta correcta que significa que el correo NO
      // salió. Tratarla como éxito dejaría al usuario esperando un código que
      // nunca va a llegar.
      if (!res.sent) {
        this.error.set('No pudimos enviar el código. Revisa el correo e inténtalo de nuevo.');
        return;
      }

      this.phase.set('code');
      this.info.set(`Te enviamos un código a ${correo}.`);
    } catch (error) {
      this.error.set(apiErrorMessage(error, 'No fue posible enviar el código.'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Canjea el código por una sesión y entra al home del paciente. */
  async submitCode(): Promise<void> {
    const codigo = this.code().trim();
    if (!codigo) {
      this.error.set('Escribe el código que te enviamos.');
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    try {
      const res = await firstValueFrom(this.auth.validateOtp(codigo));
      if (!res.verified) {
        this.error.set('El código no es válido.');
        return;
      }
      await this.router.navigate(['/home']);
    } catch (error) {
      this.error.set(apiErrorMessage(error, 'El código no es válido o ya expiró.'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Vuelve al paso del correo conservando lo escrito, para corregir una errata. */
  editEmail(): void {
    this.phase.set('email');
    this.code.set('');
    this.error.set(null);
    this.info.set(null);
  }
}
