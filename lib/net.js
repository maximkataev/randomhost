"use strict";

/*
 * Сетевой скелет, общий для серверов мультиплеера: ключ адреса, адрес клиента из заголовков прокси,
 * защита от перебора кодов комнат, лимит сообщений, безопасная отправка в сокет.
 * Только встроенные модули Node: в образах игр нет общего node_modules.
 */

const looksLikeIp = (s) => /^[0-9a-fA-F:.]{3,45}$/.test(s) && /[.:]/.test(s);

// Ключ адреса для всех лимитов: IPv6 сводится к /64 (иначе у одного клиента миллиарды «разных» адресов),
// ::ffff:1.2.3.4 → 1.2.3.4
function ipKey(ip) {
  const v = String(ip).toLowerCase();
  if (!v.includes(":")) return v;
  const v4 = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return v4[1];
  const [head, tail] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(":") + "::/64";
}

function clientIp(req) {
  // Главный источник — X-Real-IP: его ставит ВНЕШНИЙ nginx ($remote_addr) и затирает всё,
  // что прислал клиент, а внутренний nginx пробрасывает как есть. Хвост X-Forwarded-For для
  // этого не годится: при двух прокси там лежит адрес внешнего nginx, один на всех, и лимит
  // комнат на адрес схлопнулся бы на весь сайт.
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (looksLikeIp(real)) return ipKey(real);
  // Запасной путь для одного прокси: последний элемент цепочки дописал он сам, подделать его нельзя.
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(looksLikeIp);
  return ipKey(chain.length ? chain[chain.length - 1] : (req.socket.remoteAddress || ""));
}

// Перебор кодов: адрес, промахнувшийся `limit` раз за окно, до конца окна не получает ни одной комнаты
function createGuessLimiter(limit, windowMs = 10 * 60 * 1000) {
  const guesses = new Map();
  return {
    blocked(ip) {
      const g = guesses.get(ip);
      if (g && Date.now() - g.since > windowMs) { guesses.delete(ip); return false; }
      return !!g && g.n >= limit;
    },
    missed(ip) {
      const g = guesses.get(ip);
      if (!g || Date.now() - g.since > windowMs) guesses.set(ip, { n: 1, since: Date.now() });
      else g.n += 1;
      if (guesses.size > 10000) for (const [k, v] of guesses) if (Date.now() - v.since > windowMs) guesses.delete(k);
      // и потолок памяти: при распределённом переборе выкидываем самые старые записи
      if (guesses.size > 50000) for (const k of guesses.keys()) { guesses.delete(k); if (guesses.size <= 40000) break; }
    },
  };
}

// не больше `rate` сообщений в секунду на клиента
function rateOk(client, rate) {
  const t = Date.now();
  if (!client.rl || t - client.rl.ts >= 1000) client.rl = { ts: t, n: 0 };
  return ++client.rl.n <= rate;
}

// msg — объект (сериализуем) или уже готовая строка
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
}

module.exports = { looksLikeIp, ipKey, clientIp, createGuessLimiter, rateOk, send };
