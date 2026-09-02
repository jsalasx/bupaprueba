import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../auth.service';
import { AuthAzureService } from '../auth.service';

/**
 * Ingreso del equipo médico con la cuenta corporativa de Bupa (Microsoft Entra ID).
 *
 * Es una pantalla aparte de la de pacientes a propósito, y no un botón más en
 * aquella: la vía de entrada es lo que determina el tipo de usuario en el backend
 * (EnsureUserType), así que mezclarlas invitaría a que un paciente entrara por la
 * puerta del equipo médico y quedara dado de alta como tal.
 *
 * El flujo real vive en AuthAzureService, que ya existía; aquí solo se dispara y
 * se recuerda por qué puerta se entró, para el enrutado posterior.
 */
@Component({
  selector: 'app-medico-login',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './medico-login.html',
  styleUrls: ['./medico-login.css'],
})
export class MedicoLogin {
  readonly authAzure = inject(AuthAzureService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async loginConBupa(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      // Se marca ANTES de salir a Microsoft: el flujo por redirect abandona la
      // página y vuelve a /auth-azure, así que cualquier cosa que se ejecutara
      // después de esta llamada podría no llegar a correr nunca.
      this.auth.setUserType('MEDICO');

      await this.authAzure.login();

      // Solo se llega aquí en el flujo por popup, donde la página no se descarga.
      if (this.auth.accessToken()) {
        await this.router.navigate(['/home/medicos']);
      }
    } catch (error) {
      console.error('[login médicos] error:', error);
      this.error.set('No fue posible iniciar sesión con Bupa.');
    } finally {
      this.loading.set(false);
    }
  }
}
