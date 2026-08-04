import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage, AuthService } from '../auth.service';
import { PasskeyRegisterButton } from '../webauthn/passkey-register-button/passkey-register-button';
import { WebAuthnRegistrationStore } from '../webauthn/webauthn-registration.store';

@Component({
  selector: 'app-biometria',
  templateUrl: './biometria.html',
  styleUrls: ['./biometria.css'],
  standalone: true,
  imports: [PasskeyRegisterButton],
})
export class Biometria implements OnInit {
  loading = signal(false);
  error = signal<string | null>(null);

  /**
   * Registro de passkey FIDO2 — método ADICIONAL, independiente del token
   * biométrico de `activateBiometrics()`. Los dos botones conviven: si el
   * dispositivo no soporta passkeys, el botón ni se pinta y el usuario sigue
   * teniendo la biometría nativa y el resto de los métodos.
   */
  readonly passkey = inject(WebAuthnRegistrationStore);

  constructor(private router: Router, private auth: AuthService) {}

  /** Feature detection antes de mostrar cualquier UI de passkeys. */
  async ngOnInit(): Promise<void> {
    await this.passkey.checkSupport();
  }

  /** Botón "Registrar passkey". El store lleva el estado de la ceremonia. */
  async registerPasskey(): Promise<void> {
    await this.passkey.register();
  }

  async activateBiometrics(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      const available = await NativeBiometric.isAvailable();
      if (!available.isAvailable) {
        this.error.set('Tu dispositivo no tiene biometría disponible o no está configurada.');
        return;
      }

      await NativeBiometric.verifyIdentity({
        reason: 'Confirma tu identidad para activar el acceso biométrico',
        title: 'Activar biometría',
        subtitle: 'Usa Face ID o Touch ID',
        description: 'Esto te permitirá iniciar sesión sin contraseña',
      });

      const deviceId = this.auth.getDeviceId();
      const credential = await this.resolveCredential(deviceId);

      // Guardar en Keychain — si esto falla, el catch lo captura
      await NativeBiometric.setCredentials({
        username: deviceId,
        password: credential,
        server: this.auth.BIOMETRIC_SERVER,
      });

      this.router.navigate(['/home']);

    } catch (err: any) {
      if (err?.code === 10) return; // usuario canceló Face ID / Touch ID
      console.error('[Biometria] Error al activar:', err);
      this.error.set(
        apiErrorMessage(err, 'No se pudo activar la biometría. Intenta de nuevo.'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  skipToHome(): void {
    this.router.navigate(['/home']);
  }

  /**
   * Pide el biometricToken al backend. Es lo único que se guarda en el Keychain:
   * guardar el accessToken como sustituto dejaba una credencial que /auth/biometric/token
   * rechaza, así que un fallo aquí debe verse, no taparse.
   */
  private async resolveCredential(deviceId: string): Promise<string> {
    const res = await firstValueFrom(this.auth.registerBiometric(deviceId));
    return res.biometricToken;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
