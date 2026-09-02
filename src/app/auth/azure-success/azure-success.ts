import { Component, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthAzureService } from '../auth.service';
import { AuthService } from '../../auth.service';

/**
 * Ruta de callback del login con Microsoft (Azure AD / MSAL), registrada en
 * Azure Portal como Redirect URI (SPA). Al llegar aquí, initialize() ya consumió
 * el hash y canjeó el id_token en POST /auth/azure; este componente solo muestra
 * el estado y redirige al mismo destino que el login con Google.
 */
@Component({
  selector: 'app-azure-success',
  templateUrl: './azure-success.html',
  styleUrls: ['./azure-success.css'],
  standalone: true,
})
export class AzureSuccess implements OnInit {
  loading = signal(true);
  account;
  error;

  constructor(
    private authAzure: AuthAzureService,
    private auth: AuthService,
    private router: Router,
  ) {
    this.account = this.authAzure.account;
    this.error = this.authAzure.error;
  }

  async ngOnInit(): Promise<void> {
    await this.authAzure.initialize();
    this.loading.set(false);

    // initialize() ya canjeó el id_token por la sesión de Bupa (POST /auth/azure).
    //
    // El destino depende de por qué puerta se entró: quien vino de /login/medicos
    // quedó marcado como MEDICO antes del redirect, y mandarlo a /biometria lo
    // dejaría en una pantalla que no le corresponde y sin ver su cola de trabajo.
    if (this.authAzure.isAuthenticated()) {
      const destino = this.auth.userType() === 'MEDICO' ? '/home/medicos' : '/biometria';
      setTimeout(() => this.router.navigate([destino]), 1200);
    } else {
      console.warn('[MSAL] Callback sin sesión válida; volviendo a /login.');
      setTimeout(() => this.router.navigate(['/login']), 1500);
    }
  }
}
