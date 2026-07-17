import { Component, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../auth.service';

/**
 * Ruta de éxito a la que el backend redirige tras el callback de Apple.
 * La sesión ya viaja en una cookie HttpOnly: aquí solo se resuelve con GET /auth/me.
 */
@Component({
  selector: 'app-apple-success',
  templateUrl: './apple-success.html',
  styleUrls: ['./apple-success.css'],
  standalone: true,
})
export class AppleSuccess implements OnInit {
  /** Estado de "cargando sesión" mientras se resuelve /auth/me. */
  loading = signal(true);

  constructor(private auth: AuthService, private router: Router) {}

  ngOnInit(): void {
    this.auth.me().subscribe({
      next: () => {
        // Sesión iniciada (currentUser ya poblado por el AuthService) → home.
        this.loading.set(false);
        this.router.navigate(['/home']);
      },
      error: (err) => {
        this.loading.set(false);
        // 401 → no autenticado; cualquier otro → error interno.
        const code = err?.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR';
        this.router.navigate(['/auth/apple/error'], { queryParams: { error: code } });
      },
    });
  }
}
