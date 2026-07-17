import { Component, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-biometria',
  templateUrl: './biometria.html',
  styleUrls: ['./biometria.css'],
  standalone: true,
})
export class Biometria {
  loading = signal(false);
  error = signal<string | null>(null);

  constructor(private router: Router, private auth: AuthService) {}

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
      this.error.set(err?.message ?? 'No se pudo activar la biometría. Intenta de nuevo.');
    } finally {
      this.loading.set(false);
    }
  }

  skipToHome(): void {
    this.router.navigate(['/home']);
  }

  /**
   * Intenta obtener un biometricToken del backend.
   * Si el endpoint aún no existe, usa el accessToken como fallback
   * para que el flujo funcione durante desarrollo.
   */
  private async resolveCredential(deviceId: string): Promise<string> {
    try {
      const res = await firstValueFrom(this.auth.registerBiometric(deviceId));
      console.log('[Biometria] biometricToken obtenido del backend');
      return res.biometricToken;
    } catch (err) {
      console.warn('[Biometria] Backend biometric/register no disponible, usando accessToken como fallback:', err);
      const token = this.auth.accessToken();
      if (!token) throw new Error('No hay sesión activa. Por favor inicia sesión con Google primero.');
      return token;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
