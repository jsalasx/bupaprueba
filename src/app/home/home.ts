import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.html',
  styleUrls: ['./home.css'],
  standalone: true,
})
export class Home {
  constructor(public auth: AuthService, private router: Router) {}

  logout(): void {
    // Solo limpia los tokens de sesión.
    // Las credenciales biométricas del Keychain se conservan
    // para que el usuario pueda volver a autenticarse con biometría.
    this.auth.clearSession();
    this.router.navigate(['/login']);
  }
}
