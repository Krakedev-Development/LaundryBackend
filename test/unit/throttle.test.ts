import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throttleTracker } from '../../src/common/guards/app-throttler.guard';

describe('throttleTracker', () => {
  it('usa solo la IP en rutas comunes', () => {
    assert.equal(throttleTracker({ ip: '1.2.3.4', path: '/api/v1/orders' }), '1.2.3.4');
  });
  it('en el login añade la cuenta normalizada', () => {
    assert.equal(
      throttleTracker({
        ip: '1.2.3.4',
        path: '/api/v1/auth/login',
        body: { email: '  Ana@Example.COM ' },
      }),
      '1.2.3.4|ana@example.com',
    );
  });
  it('un cuerpo sin correo cae a la IP y el correo se acota en longitud', () => {
    assert.equal(throttleTracker({ ip: 'x', path: '/auth/login', body: {} }), 'x');
    const long = 'a'.repeat(500) + '@x.com';
    assert.ok(
      throttleTracker({ ip: 'x', path: '/auth/login', body: { email: long } }).length <= 256,
    );
  });
});
