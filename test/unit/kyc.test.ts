import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidCedula } from '../../src/kyc/cedula';
import { detectImageMime } from '../../src/kyc/image-type';

describe('cédula ecuatoriana', () => {
  it('acepta cédulas con dígito verificador correcto', () => {
    assert.equal(isValidCedula('0912345675'), true);
    assert.equal(isValidCedula('1701234567'), true);
  });
  it('rechaza dígito verificador, provincia, tercer dígito y formato inválidos', () => {
    assert.equal(isValidCedula('0912345676'), false);
    assert.equal(isValidCedula('9912345675'), false);
    assert.equal(isValidCedula('0962345675'), false);
    assert.equal(isValidCedula('091234567'), false);
    assert.equal(isValidCedula('09123456755'), false);
    assert.equal(isValidCedula('09123456ab'), false);
    assert.equal(isValidCedula(''), false);
  });
});

describe('tipo de imagen por contenido', () => {
  it('reconoce JPEG, PNG y WebP', () => {
    assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
    assert.equal(
      detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
      'image/png',
    );
    assert.equal(
      detectImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
      'image/webp',
    );
  });
  it('rechaza cualquier otro contenido', () => {
    assert.equal(detectImageMime(Buffer.from('GIF89a....')), null);
    assert.equal(detectImageMime(Buffer.from('<svg></svg>')), null);
    assert.equal(detectImageMime(Buffer.alloc(0)), null);
  });
});
