import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage } from '../auth.service';
import { ChatAttachmentMetadata, ChatConversation, ChatService, StoredMessage, messageAttachments } from './chat.service';

@Component({
  selector: 'app-chat-history',
  standalone: true,
  imports: [DatePipe, RouterLink],
  templateUrl: './chat-history.html',
  styleUrls: ['./chat-room.css'],
})
export class ChatHistory implements OnInit {
  private readonly chat = inject(ChatService);
  private readonly ticketId = inject(ActivatedRoute).snapshot.paramMap.get('ticketId') ?? '';
  private readonly navigation = inject(Router).currentNavigation()?.extras.info as
    { conversation?: ChatConversation } | undefined;

  readonly conversation = this.navigation?.conversation?.ticketId === this.ticketId
    ? this.navigation.conversation
    : undefined;
  readonly messages = signal<(StoredMessage & { attachments: ChatAttachmentMetadata[] })[]>([]);
  readonly cursor = signal<string | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  async load(cursor?: string): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await firstValueFrom(this.chat.listMessageHistory(this.ticketId, cursor));
      const items = page.items.map((message) => ({ ...message, attachments: messageAttachments(message.metadata) }));
      this.messages.update((rows) => cursor ? [...rows, ...items] : items);
      this.cursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(error instanceof HttpErrorResponse
        ? apiErrorMessage(error, 'No se pudo cargar el historial.')
        : 'No se pudo cargar el historial.');
    } finally {
      this.loading.set(false);
    }
  }
}
