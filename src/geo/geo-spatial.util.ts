export interface LatLng {
  lat: number;
  lng: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface ZoneSpatialIndex {
  zoneId: string;
  zoneName: string;
  ring: [number, number][];
  bbox: BoundingBox;
}

/**
 * Extrae un anillo `[lng, lat][]` desde formatos soportados:
 * - GeoJSON Polygon `{ type: 'Polygon', coordinates: [[[lng, lat], ...]] }`
 * - Arreglo `[{ lat, lng }, ...]` (formato canónico de LaundryBackend)
 * - Arreglo `[[lng, lat], ...]`
 */
export function ringFromPolygon(coordinates: unknown): [number, number][] | null {
  if (
    coordinates &&
    typeof coordinates === 'object' &&
    !Array.isArray(coordinates) &&
    (coordinates as { type?: string }).type === 'Polygon'
  ) {
    const geoJson = coordinates as { type: string; coordinates?: unknown };
    const outer = Array.isArray(geoJson.coordinates)
      ? (geoJson.coordinates[0] as unknown)
      : null;
    if (!Array.isArray(outer) || outer.length < 3) return null;
    const ring = outer
      .map((pt) =>
        Array.isArray(pt) && pt.length >= 2
          ? ([Number(pt[0]), Number(pt[1])] as [number, number])
          : null,
      )
      .filter(
        (pt): pt is [number, number] =>
          pt !== null && Number.isFinite(pt[0]) && Number.isFinite(pt[1]),
      );
    return ring.length >= 3 ? ring : null;
  }

  if (Array.isArray(coordinates)) {
    if (coordinates.length < 3) return null;
    const ring: [number, number][] = [];
    for (const item of coordinates) {
      if (Array.isArray(item) && item.length >= 2) {
        const lng = Number(item[0]);
        const lat = Number(item[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          ring.push([lng, lat]);
        }
      } else if (item && typeof item === 'object') {
        const pt = item as { lat?: unknown; lng?: unknown };
        const lat = Number(pt.lat);
        const lng = Number(pt.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          ring.push([lng, lat]);
        }
      }
    }
    return ring.length >= 3 ? ring : null;
  }

  return null;
}

/** Elimina el vértice de cierre repetido si el anillo ya viene cerrado. */
export function openRing(ring: [number, number][]): [number, number][] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return ring.slice(0, -1);
  }
  return ring;
}

export function boundingBoxFromRing(ring: [number, number][]): BoundingBox | null {
  if (ring.length < 3) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const [lng, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  if (
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLat) ||
    !Number.isFinite(minLng) ||
    !Number.isFinite(maxLng)
  ) {
    return null;
  }

  return { minLat, maxLat, minLng, maxLng };
}

export function isPointInBoundingBox(
  lat: number,
  lng: number,
  bbox: BoundingBox,
): boolean {
  return (
    lat >= bbox.minLat &&
    lat <= bbox.maxLat &&
    lng >= bbox.minLng &&
    lng <= bbox.maxLng
  );
}

/**
 * Ray-Casting sobre anillo `[lng, lat][]` (O(n) vértices).
 */
export function isPointInPolygonRing(
  lat: number,
  lng: number,
  ring: [number, number][],
): boolean {
  if (ring.length < 3) return false;

  let inside = false;
  let j = ring.length - 1;

  for (let i = 0; i < ring.length; i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
    j = i;
  }

  return inside;
}

export function isPointInPolygon(
  lat: number,
  lng: number,
  polygon: unknown,
): boolean {
  const ring = ringFromPolygon(polygon);
  if (!ring) return false;
  const bbox = boundingBoxFromRing(ring);
  if (!bbox || !isPointInBoundingBox(lat, lng, bbox)) return false;
  return isPointInPolygonRing(lat, lng, ring);
}

export function buildZoneSpatialIndex(
  zoneId: string,
  zoneName: string,
  polygon: unknown,
): ZoneSpatialIndex | null {
  const ring = ringFromPolygon(polygon);
  if (!ring) return null;
  const bbox = boundingBoxFromRing(ring);
  if (!bbox) return null;
  return { zoneId, zoneName, ring, bbox };
}

function orient(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsProperlyIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

/**
 * Valida que el polígono de zona sea geométricamente válido:
 * - Al menos 3 vértices distintos con coordenadas válidas.
 * - Área positiva (no colineal / degenerado).
 * - Sin auto-intersecciones entre aristas no adyacentes.
 * Devuelve mensaje de error o `null` si es válido.
 */
export function validatePolygonGeometry(points: LatLng[]): string | null {
  if (!Array.isArray(points) || points.length < 3) {
    return 'El polígono requiere al menos 3 vértices.';
  }

  const rawRing: [number, number][] = [];
  for (const p of points) {
    if (
      !Number.isFinite(p.lat) ||
      !Number.isFinite(p.lng) ||
      p.lat < -90 ||
      p.lat > 90 ||
      p.lng < -180 ||
      p.lng > 180
    ) {
      return 'El polígono contiene coordenadas fuera de rango.';
    }
    rawRing.push([p.lng, p.lat]);
  }

  const vertices = openRing(rawRing);
  if (vertices.length < 3) {
    return 'El polígono requiere al menos 3 vértices distintos.';
  }

  // Área shoelace > 0 (descarta polígonos degenerados / colineales).
  let twiceArea = 0;
  for (let i = 0; i < vertices.length; i++) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % vertices.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  if (Math.abs(twiceArea) < 1e-11) {
    return 'El polígono no tiene un área geográfica válida (vértices colineales).';
  }

  // Detectar auto-intersección entre aristas no adyacentes.
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = vertices[j];
      const d = vertices[(j + 1) % n];
      if (segmentsProperlyIntersect(a, b, c, d)) {
        return 'El polígono no puede cruzarse consigo mismo.';
      }
    }
  }

  return null;
}
