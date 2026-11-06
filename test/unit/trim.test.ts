import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TrimPipe } from '../../src/common/pipes/trim.pipe';

const pipe = new TrimPipe();
const body = { type: 'body' } as never;

describe('TrimPipe', () => {
  it('recorta textos anidados y arreglos, pero no contraseñas', () => {
    const out = pipe.transform(
      { text: '  hola ', nested: { a: ' x ' }, list: [' y '], password: ' clave ', n: 3 },
      body,
    );
    assert.deepEqual(out, { text: 'hola', nested: { a: 'x' }, list: ['y'], password: ' clave ', n: 3 });
  });
  it('no toca parámetros que no son del cuerpo', () => {
    assert.equal(pipe.transform(' a ', { type: 'query' } as never), ' a ');
  });
});
