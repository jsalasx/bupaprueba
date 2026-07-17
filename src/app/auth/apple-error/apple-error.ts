import { Component, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

/**
 * Ruta de error a la que el backend redirige con ?error=<CODE> cuando el flujo
 * de Apple falla. Mapea el código a un mensaje legible para el usuario.
 */
@Component({
  selector: 'app-apple-error',
  templateUrl: './apple-error.html',
  styleUrls: ['./apple-error.css'],
  standalone: true,
})
export class AppleError implements OnInit {
  /** Mapa de códigos de error del backend a mensajes en español. */
  private readonly messages: Record<string, string> = {
    APPLE_CANCELLED: 'El inicio de sesión con Apple fue cancelado.',
    INVALID_STATE: 'La solicitud no es válida o expiró.',
    APPLE_TOKEN_EXCHANGE_FAILED: 'No fue posible completar el inicio de sesión con Apple.',
    INVALID_ID_TOKEN: 'La identidad entregada por Apple no es válida.',
    MISSING_EMAIL: 'Apple no entregó un correo para tu cuenta.',
    SESSION_ISSUANCE_FAILED: 'No fue posible crear tu sesión. Intenta nuevamente.',
    UNAUTHORIZED: 'No autenticado.',
    INTERNAL_ERROR: 'Servicios no disponibles, intenta más tarde.',
  };

  code = signal<string>('INTERNAL_ERROR');
  message = signal<string>(this.messages['INTERNAL_ERROR']);

  constructor(private route: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    const code = this.route.snapshot.queryParamMap.get('error') ?? 'INTERNAL_ERROR';
    this.code.set(code);
    // Cualquier código desconocido cae en el mensaje genérico.
    this.message.set(this.messages[code] ?? this.messages['INTERNAL_ERROR']);
  }

  retry(): void {
    this.router.navigate(['/login']);
  }
}
