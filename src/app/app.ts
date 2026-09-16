import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DeepLinkService } from './deep-link.service';
import { NotificationService } from './notifications/notification.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  private readonly deepLink = inject(DeepLinkService);
  readonly notifications = inject(NotificationService);

  /**
   * El listener de deep links se registra aquí y no en la pantalla de login:
   * el callback puede llegar con la app en cualquier ruta, o relanzarla desde
   * cero, y un listener atado a un componente se pierde en esos casos.
   */
  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.deepLink.init(),
      this.notifications.init(),
    ]);
  }

  reload(): void {
    window.location.reload();
  }
}
