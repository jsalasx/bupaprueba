self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = event.notification.data?.destination || '/';
  const notificationId = event.notification.data?.notificationId;
  event.waitUntil(
    (async () => {
      const target = new URL(destination, self.location.origin);
      if (notificationId) target.searchParams.set('notificationId', notificationId);
      const url = target.href;
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('navigate' in client) await client.navigate(url);
        return client.focus();
      }
      return clients.openWindow(url);
    })(),
  );
});

/* Complete the public Firebase Web values before testing background notifications in QA. */
importScripts('https://www.gstatic.com/firebasejs/12.3.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.3.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAOmxVNxM0UTJ_3AIBmF1ev2KBed-Z4glc',
  authDomain: 'bupa-prueba.firebaseapp.com',
  projectId: 'bupa-prueba',
  storageBucket: 'bupa-prueba.firebasestorage.app',
  messagingSenderId: '218578439227',
  appId: '1:218578439227:web:413a78dacbe8c3ce67e01e',
});

firebase.messaging().onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = payload.notification?.title || data.title || data.senderName || 'Nuevo mensaje';
  const body = payload.notification?.body || data.body || data.message || 'Tienes un nuevo mensaje en el chat';
  return self.registration.showNotification(title, {
    body,
    tag: data.notificationId || `chat-${data.ticketId || 'message'}`,
    data: {
      destination: data.destination || (data.ticketId ? `/chat/${data.ticketId}` : '/'),
      notificationId: data.notificationId,
    },
  });
});
