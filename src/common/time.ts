// Utilidades de fecha y hora con zona horaria IANA. Las fechas operativas (franjas, cortes)
// se expresan en la zona de la política; internamente todo instante se maneja en UTC.

interface WallClock {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

function wallClock(timezone: string, at: Date): WallClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: n('year'), m: n('month'), d: n('day'), hh: n('hour'), mm: n('minute') };
}

const pad = (v: number) => String(v).padStart(2, '0');

// Fecha (AAAA-MM-DD) y hora (HH:mm) actuales en la zona horaria dada.
export function nowIn(timezone: string, at = new Date()) {
  const w = wallClock(timezone, at);
  return { date: `${w.y}-${pad(w.m)}-${pad(w.d)}`, time: `${pad(w.hh)}:${pad(w.mm)}` };
}

// Instante UTC que corresponde a una fecha y hora de reloj en la zona dada.
// Se itera dos veces para resolver correctamente los cambios de horario.
export function zonedToUtc(date: string, time: string, timezone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (t: number) => {
    const w = wallClock(timezone, new Date(t));
    return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm) - t;
  };
  let t = wanted - offsetAt(wanted);
  t = wanted - offsetAt(t);
  return new Date(t);
}
