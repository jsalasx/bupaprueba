
import { Component, OnInit, NgZone, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { CommonModule } from '@angular/common';

declare const google: any;

@Component({
  selector: 'app-google-login-test',
  imports: [CommonModule],
  templateUrl: './google-login-test.html',
  styleUrls: ['./google-login-test.css'],
  standalone: true
})
export class GoogleLoginTest implements OnInit {

  private readonly CLIENT_ID = '537881986178-23dhaeonqr38trcrmj76ke6hs64j8qpk.apps.googleusercontent.com';
  private readonly BACKEND_URL = 'http://localhost:8080/portal-blua/ms-controller/auth/google';

  response = signal<any>(null);
  error = signal<any>(null);
  loading = signal(false);
  loginSuccess = signal(false);

  constructor(private http: HttpClient, private zone: NgZone) {}

  ngOnInit(): void {
    google.accounts.id.initialize({
      client_id: this.CLIENT_ID,
      callback: (resp: any) => this.zone.run(() => this.onGoogleToken(resp.credential)),
    });

    google.accounts.id.renderButton(
      document.getElementById('google-btn'),
      { theme: 'outline', size: 'large', text: 'signin_with' }
    );
  }

  clearSuccess(): void {
    this.loginSuccess.set(false);
  }

  clearError(): void {
    this.error.set(null);
  }

  private onGoogleToken(idToken: string): void {
    this.loading.set(true);
    this.response.set(null);
    this.error.set(null);
    this.loginSuccess.set(false);

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'X-Forms-Captcha': 'test-captcha-token',
    });

    this.http.post(this.BACKEND_URL, { idToken }, { headers }).subscribe({
      next: (res) => {
        this.loading.set(false);
        this.loginSuccess.set(true);
        this.response.set(res);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err.error ?? err.message ?? err);
      },
    });
  }
}
