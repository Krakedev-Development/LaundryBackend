import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnprocessableEntityException } from '@nestjs/common';
import type { BusinessPolicy } from '../../src/generated/prisma/client';
import { PolicyService } from '../../src/policy/policy.service';

const service = new PolicyService({} as never);
const policy = { cutoffMinutes: 120, taxRate: null } as unknown as BusinessPolicy;

describe('PolicyService.requireParam', () => {
  it('devuelve el valor configurado', async () => {
    assert.equal(await service.requireParam('cutoffMinutes', policy), 120);
  });
  it('rechaza con 422 un parámetro sin configurar, sin asumir valor', async () => {
    await assert.rejects(
      service.requireParam('taxRate', policy),
      (e) => e instanceof UnprocessableEntityException,
    );
  });
});
