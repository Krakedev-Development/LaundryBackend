import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { PushService, type ExpoPushMessage, type ExpoPushTicket } from '../../src/notifications/push.service';
import { bearer, bootApp, createUser, login, type TestApp } from '../helpers';
import { api, buildWorld, type World } from '../world';

let t: TestApp;
let w: World;
let wsUrl: string;
const sockets: Socket[] = [];

const get = (token: string, path: string) =>
  t.http.get(`${api}${path}`).set(bearer(token));
const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const del = (token: string, path: string, body: object = {}) =>
  t.http.delete(`${api}${path}`).set(bearer(token)).send(body);

async function connectSocket(token: string): Promise<Socket> {
  const socket = io(wsUrl, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket auth timeout')), 4_000);
    socket.on('authenticated', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('authentication_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Socket auth error: ${JSON.stringify(err)}`));
    });
  });
  return socket;
}

function waitForEvent<T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  match: (payload: T) => boolean = () => true,
  timeoutMs = 4_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout esperando evento "${event}"`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function pollUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(await check(), 'Condición no cumplida dentro del tiempo límite');
}

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
  const { port } = t.app.getHttpServer().address() as { port: number };
  wsUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const s of sockets) s.disconnect();
  await t.close();
});

describe('chat en tiempo real y notificaciones push (Expo)', () => {
  it('entrega chat de 3 partes en tiempo real con senderName y respeta aislamiento', async () => {
    const client = await w.newClient('chat3@test.local');
    const outsider = await w.newClient('outsider3@test.local');

    // Segunda sede con su propio supervisor para verificar aislamiento entre sedes.
    const otherZone = await post(w.admin, '/zones', {
      name: 'Zona Chat Aislada',
      polygon: [
        { lat: 20, lng: 20 },
        { lat: 21, lng: 20 },
        { lat: 21, lng: 21 },
        { lat: 20, lng: 21 },
      ],
    }).expect(201);
    const otherFacility = await post(w.admin, '/facilities', {
      zoneId: otherZone.body.id,
      name: 'Sede Chat Aislada',
      address: 'Av. Aislada',
      latitude: 20.5,
      longitude: 20.5,
    }).expect(201);
    const otherSup = await createUser(t, {
      email: 'sup-other-chat@test.local',
      password: 'Password123',
      role: 'SUPERVISOR',
    });
    await t.prisma.user.update({
      where: { id: otherSup.id },
      data: { facilityId: otherFacility.body.id },
    });
    const otherSupToken = await login(t, otherSup.email, 'Password123');

    await w.credit(client.customerId, 100);
    const orderId = await w.order(client);
    await post(client.token, `/orders/${orderId}/pay`, { expectedVersion: 1 }).expect(201);
    await post(w.admin, `/orders/${orderId}/assign`, {
      expectedVersion: await w.version(orderId),
      leg: 'INBOUND',
      driverId: w.driverId,
    }).expect(201);

    const [clientSock, driverSock, supSock, outsiderSock, otherSupSock] =
      await Promise.all([
        connectSocket(client.token),
        connectSocket(w.driverToken),
        connectSocket(w.supervisor),
        connectSocket(outsider.token),
        connectSocket(otherSupToken),
      ]);

    const outsiderMessages: unknown[] = [];
    const otherSupMessages: unknown[] = [];
    outsiderSock.on('chat:message:new', (m) => outsiderMessages.push(m));
    otherSupSock.on('chat:message:new', (m) => otherSupMessages.push(m));

    // El cliente escribe y tanto el chofer asignado como el supervisor reciben chat:message:new y notification:new.
    const driverChatWait = waitForEvent<{ senderName: string; senderRole: string; text: string }>(
      driverSock,
      'chat:message:new',
      (m) => m.text === 'Estoy en la garita',
    );
    const supChatWait = waitForEvent<{ senderName: string; text: string }>(
      supSock,
      'chat:message:new',
      (m) => m.text === 'Estoy en la garita',
    );
    const driverNotifWait = waitForEvent<{ category: string; orderId: string }>(
      driverSock,
      'notification:new',
      (n) => n.category === 'CHAT' && n.orderId === orderId,
    );

    const cMsg = await post(client.token, `/orders/${orderId}/messages`, {
      text: 'Estoy en la garita',
    }).expect(201);
    assert.ok(cMsg.body.senderName);

    const [dChat, sChat, dNotif] = await Promise.all([
      driverChatWait,
      supChatWait,
      driverNotifWait,
    ]);
    assert.equal(dChat.senderRole, 'CLIENT');
    assert.equal(dChat.senderName, cMsg.body.senderName);
    assert.equal(sChat.text, 'Estoy en la garita');
    assert.equal(dNotif.orderId, orderId);

    // El supervisor responde en el mismo hilo y el cliente + chofer lo reciben en vivo.
    const clientChatWait = waitForEvent<{ senderRole: string; senderName: string }>(
      clientSock,
      'chat:message:new',
      (m) => m.senderRole === 'SUPERVISOR',
    );
    const supMsg = await post(w.supervisor, `/orders/${orderId}/messages`, {
      text: 'El chofer va entrando',
    }).expect(201);
    const receivedByClient = await clientChatWait;
    assert.equal(receivedByClient.senderName, supMsg.body.senderName);

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(outsiderMessages.length, 0);
    assert.equal(otherSupMessages.length, 0);

    // GET /orders/:id/messages incluye senderName para todo el historial.
    const history = await get(w.driverToken, `/orders/${orderId}/messages`).expect(200);
    assert.equal(history.body.length, 2);
    assert.ok(history.body.every((m: { senderName?: string }) => Boolean(m.senderName)));

    // El chofer consulta su bandeja y marca notificaciones leídas.
    const driverInbox = await get(w.driverToken, '/notifications').expect(200);
    assert.ok(
      driverInbox.body.data.some((n: { category: string }) => n.category === 'ORDER_ASSIGNED'),
    );
    assert.ok(
      driverInbox.body.data.some((n: { category: string }) => n.category === 'CHAT'),
    );
    await post(w.driverToken, '/notifications/read-all').expect(201);
    const driverUnread = await get(w.driverToken, '/notifications?unread=true').expect(200);
    assert.equal(driverUnread.body.total, 0);
  });

  it('registra DeviceToken, envía push Expo, desactiva DeviceNotRegistered y permite baja', async () => {
    const pushService = t.app.get(PushService);
    const sentBatches: ExpoPushMessage[][] = [];
    let nextTickets: ExpoPushTicket[] = [{ status: 'ok', id: 'ticket-1' }];

    const originalSend = pushService.sendToExpoApi.bind(pushService);
    pushService.sendToExpoApi = async (messages: ExpoPushMessage[]) => {
      sentBatches.push(messages);
      return messages.map((_, idx) => nextTickets[idx] ?? { status: 'ok', id: `ticket-${idx}` });
    };

    try {
      const c = await w.newClient('push-client@test.local');
      const clientPushToken = 'ExponentPushToken[client-token-001]';
      const driverPushToken = 'ExponentPushToken[driver-token-001]';

      const regClient = await post(c.token, '/notifications/devices', {
        token: clientPushToken,
        platform: 'ANDROID',
        appType: 'CLIENT',
        deviceName: 'Pixel Test',
      }).expect(201);
      assert.equal(regClient.body.active, true);

      await post(w.driverToken, '/notifications/devices', {
        token: driverPushToken,
        platform: 'IOS',
        appType: 'DRIVER',
        deviceName: 'iPhone Driver',
      }).expect(201);

      await w.credit(c.customerId, 100);
      const orderId = await w.order(c);
      await post(c.token, `/orders/${orderId}/pay`, { expectedVersion: 1 }).expect(201);
      await post(w.admin, `/orders/${orderId}/assign`, {
        expectedVersion: await w.version(orderId),
        leg: 'INBOUND',
        driverId: w.driverId,
      }).expect(201);

      await pollUntil(() =>
        sentBatches.some((b) =>
          b.some((m) => m.to === driverPushToken && m.channelId === 'assignments'),
        ),
      );

      // Ahora simulamos DeviceNotRegistered en el siguiente push al chofer.
      sentBatches.length = 0;
      nextTickets = [{ status: 'error', details: { error: 'DeviceNotRegistered' } }];
      await post(c.token, `/orders/${orderId}/messages`, {
        text: 'Por favor tocar el timbre 2B',
      }).expect(201);

      await pollUntil(() =>
        sentBatches.some((b) => b.some((m) => m.to === driverPushToken)),
      );
      await pollUntil(async () => {
        const row = await t.prisma.deviceToken.findUnique({
          where: { token: driverPushToken },
        });
        return row?.active === false;
      });

      const storedDriverToken = await t.prisma.deviceToken.findUnique({
        where: { token: driverPushToken },
      });
      assert.equal(storedDriverToken?.active, false);

      // Baja explícita del token del cliente.
      const unreg = await del(c.token, '/notifications/devices', {
        token: clientPushToken,
      }).expect(200);
      assert.equal(unreg.body.unregistered, true);
      const storedClientToken = await t.prisma.deviceToken.findUnique({
        where: { token: clientPushToken },
      });
      assert.equal(storedClientToken?.active, false);
    } finally {
      pushService.sendToExpoApi = originalSend;
    }
  });
});
