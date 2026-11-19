// Correção automática de respostas do chat (tolerante a acentos, parênteses e sobrenome/nome).
export const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const STOP = new Set(['para', 'com', 'dos', 'das', 'uma', 'que', 'por']);

export function makeMatcher(answer) {
  const a = String(answer || '').trim();
  if (!a || a === '—' || /^resposta livre/i.test(a)) return null; // respostas abertas: não corrige sozinho
  const base = a.replace(/\(.*?\)/g, ' ');
  const alts = base.split(/\s*[\/|]\s*|\s+ou\s+/i).map(norm).filter(Boolean);
  const full = norm(base);
  const words = base.split(/[\s&,]+/).map(norm).filter(w => w.length >= 4 && !STOP.has(w));
  return comment => {
    const c = norm(comment);
    if (c.length < 2) return false;
    if (c === full || alts.includes(c)) return true;
    if (full.length >= 4 && c.includes(full)) return true;
    return c.length >= 4 && words.includes(c);
  };
}
