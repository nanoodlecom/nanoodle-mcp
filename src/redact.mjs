/**
 * Mask credential-bearing query parameters so a URL is safe to write to a log.
 *
 * Work/websocket endpoints carry API keys in the query string (e.g. Nanswap's
 * `?api_key=…`), and those URLs surface in startup lines and failover warnings.
 * Redact at the point a URL becomes log text so a key can never reach stderr,
 * the journal, or a shared terminal.
 *
 * Accepts a single URL or a comma-separated list (NANO_WORK_URL is a list).
 * Unparseable input still gets a blunt regex scrub so nothing slips through.
 */
const SECRET_PARAM = /key|token|secret|pass|auth|sig/i;

export function redactUrl(value) {
  if (!value) return value;
  return String(value)
    .split(",")
    .map((part) => {
      const s = part.trim();
      try {
        const u = new URL(s);
        let masked = false;
        for (const name of [...u.searchParams.keys()]) {
          if (SECRET_PARAM.test(name)) { u.searchParams.set(name, "***"); masked = true; }
        }
        return masked ? u.toString() : s;
      } catch {
        // not a parseable URL — mask any query pair whose name looks secret
        return s.replace(/([?&][^=&]*(?:key|token|secret|pass|auth|sig)[^=&]*)=[^&]*/gi, "$1=***");
      }
    })
    .join(",");
}
