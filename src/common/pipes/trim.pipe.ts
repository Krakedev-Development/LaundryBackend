import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';

// Recorta los textos del cuerpo antes de validar, de modo que "   " cuente como vacío.
// Las contraseñas se dejan intactas: los espacios pueden ser parte legítima de ellas.
const KEEP = /password/i;

function trim(value: unknown, key?: string): unknown {
  if (typeof value === 'string') return key && KEEP.test(key) ? value : value.trim();
  if (Array.isArray(value)) return value.map((v) => trim(v, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, trim(v, k)]),
    );
  return value;
}

@Injectable()
export class TrimPipe implements PipeTransform {
  transform(value: unknown, meta: ArgumentMetadata) {
    return meta.type === 'body' ? trim(value) : value;
  }
}
