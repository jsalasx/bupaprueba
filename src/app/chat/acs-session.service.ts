import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { ChatClient, ChatMessageReceivedEvent } from '@azure/communication-chat';
import { AzureCommunicationTokenCredential } from '@azure/communication-common';
import { BehaviorSubject, Subject } from 'rxjs';
import { AuthService } from '../auth.service';
import { ChatService } from './chat.service';

@Injectable({ providedIn: 'root' })
export class AcsSessionService {
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  private readonly document = inject(DOCUMENT);
  private readonly destroy = inject(DestroyRef);
  private readonly pageActive = signal(true);
  private readonly messages = new Subject<ChatMessageReceivedEvent>();
  private readonly connected = new BehaviorSubject(false);
  readonly messages$ = this.messages.asObservable();
  readonly connected$ = this.connected.asObservable();

  private readonly pending = new Map<string, Set<string>>();
  private stopClient?: () => Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private lifecycle = Promise.resolve();
  private account: string | null = null;
  private generation = 0;

  constructor() {
    const window = this.document.defaultView;
    const hide = () => this.pageActive.set(false);
    const show = () => {
      this.pageActive.set(true);
      this.flushDeliveries();
    };
    this.document.addEventListener('visibilitychange', this.flushDeliveries);
    window?.addEventListener('pagehide', hide);
    window?.addEventListener('pageshow', show);

    effect(() => {
      const account = this.auth.accessToken() && this.pageActive()
        ? this.auth.userEmail() ?? ''
        : null;
      this.switchAccount(account);
    });

    this.destroy.onDestroy(() => {
      this.document.removeEventListener('visibilitychange', this.flushDeliveries);
      window?.removeEventListener('pagehide', hide);
      window?.removeEventListener('pageshow', show);
      this.switchAccount(null);
    });
  }

  confirmReceived(threadId: string, ids: string[]): void {
    if (!ids.length || !this.auth.accessToken() || !this.pageActive()) return;
    if (this.document.visibilityState === 'visible') {
      void this.chat.confirmDelivery(threadId, ids);
      return;
    }

    const messages = this.pending.get(threadId) ?? new Set<string>();
    for (const id of ids) messages.add(id);
    this.pending.set(threadId, messages);
  }

  private readonly flushDeliveries = (): void => {
    if (!this.pageActive() || !this.auth.accessToken() || this.document.visibilityState !== 'visible') return;
    for (const [threadId, pending] of this.pending) {
      const ids = [...pending];
      for (let offset = 0; offset < ids.length; offset += 100) {
        void this.chat.confirmDelivery(threadId, ids.slice(offset, offset + 100));
      }
    }
    this.pending.clear();
  };

  private switchAccount(account: string | null): void {
    if (this.account === account) return;
    this.account = account;
    const generation = ++this.generation;
    this.pending.clear();
    this.connected.next(false);
    clearTimeout(this.retry);
    this.lifecycle = this.lifecycle.then(async () => {
      const stop = this.stopClient;
      this.stopClient = undefined;
      await stop?.();
      if (account !== null && generation === this.generation) await this.connect(generation);
    });
  }

  private async connect(generation: number): Promise<void> {
    try {
      const token = await this.chat.chatToken();
      if (generation !== this.generation) return;
      const credential = new AzureCommunicationTokenCredential({
        token: token.token,
        refreshProactively: true,
        tokenRefresher: async () => {
          if (generation !== this.generation) throw new Error('La sesión de chat terminó.');
          return (await this.chat.chatToken(true)).token;
        },
      });
      const client = new ChatClient(token.endpoint, credential);
      const onMessage = (event: ChatMessageReceivedEvent) => {
        if (generation !== this.generation || !this.pageActive() || !this.auth.accessToken()) return;
        const sender = (event.sender as { communicationUserId?: string })?.communicationUserId;
        if (sender && sender !== token.identity) {
          this.confirmReceived(event.threadId, [event.id]);
          this.chat.inboxChanges.next({ threadId: event.threadId });
        }
        this.messages.next(event);
      };
      const onConnected = () => {
        if (generation === this.generation) this.connected.next(true);
      };
      const onDisconnected = () => {
        if (generation === this.generation) this.connected.next(false);
      };
      this.stopClient = async () => {
        try {
          client.off('chatMessageReceived', onMessage);
          const emitter = client as unknown as {
            off(event: string, listener: () => void): void;
          };
          emitter.off('realTimeNotificationConnected', onConnected);
          emitter.off('realTimeNotificationDisconnected', onDisconnected);
          await client.stopRealtimeNotifications();
        } catch {
          // El cliente puede haber fallado antes de arrancar el canal.
        } finally {
          credential.dispose();
        }
      };
      await client.startRealtimeNotifications();
      if (generation !== this.generation) return;
      client.on('chatMessageReceived', onMessage);
      client.on('realTimeNotificationConnected', onConnected);
      client.on('realTimeNotificationDisconnected', onDisconnected);
      this.connected.next(true);
    } catch {
      const stop = this.stopClient;
      this.stopClient = undefined;
      await stop?.();
      if (generation !== this.generation) return;
      this.connected.next(false);
      this.retry = setTimeout(() => {
        if (generation === this.generation) {
          this.lifecycle = this.lifecycle.then(() => this.connect(generation));
        }
      }, 10_000);
    }
  }
}
