import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { GoogleLoginTest } from "./google-login-test/google-login-test";

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, GoogleLoginTest],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('bupaprueba');
}
