/**
 * Swim times are conventionally shown to hundredths: "28.91", "1:23.45".
 */

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  const totalHundredths = Math.floor(ms / 10);
  const hundredths = totalHundredths % 100;
  const totalSeconds = Math.floor(totalHundredths / 100);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  const hh = String(hundredths).padStart(2, "0");
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, "0")}.${hh}`;
  }
  return `${seconds}.${hh}`;
}

/**
 * Same as `formatTime` but always shows m:ss so the running clock never
 * reflows.
 *
 * `hundredths: false` drops the `.hh` — for a clock that's still counting up,
 * where a hundredths digit that only refreshes once a second would just
 * jitter rather than read as precision. Once the watch stops, pass `true` (the
 * default) so the number that lands matches what `formatTime` would show.
 */
export function formatClock(
  ms: number,
  opts?: { hundredths?: boolean },
): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalHundredths = Math.floor(ms / 10);
  const hundredths = totalHundredths % 100;
  const totalSeconds = Math.floor(totalHundredths / 100);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`;
  if (opts?.hundredths === false) return mmss;
  return `${mmss}.${String(hundredths).padStart(2, "0")}`;
}

function toMs(minutes: number, seconds: number, frac?: string): number {
  // ".4" is four tenths, ".45" is 45 hundredths — pad, don't parse as-is.
  const millis = frac ? parseInt(frac.padEnd(3, "0"), 10) : 0;
  return minutes * 60_000 + seconds * 1000 + millis;
}

/**
 * Read the whole-seconds part of a decimal entry. One or two digits is a plain
 * seconds count ("30.45"); three or more puts the last two in the seconds
 * place, the way a scoreboard reads it ("101.45" is 1:01.45).
 */
function fromWholeSeconds(whole: string, frac?: string): number | null {
  if (whole.length <= 2) return toMs(0, parseInt(whole, 10), frac);
  const seconds = parseInt(whole.slice(-2), 10);
  if (seconds > 59) return null;
  return toMs(parseInt(whole.slice(0, -2), 10), seconds, frac);
}

/**
 * Parse a hand-entered time.
 *
 * The keypad has neither a colon nor much patience, so the main form is bare
 * digits with no separator at all: the last two are always hundredths, the two
 * before them seconds, and anything left over is minutes. "3045" is 30.45 and
 * "11127" is 1:11.27.
 *
 * A decimal point or a colon still works if you'd rather type one, and gives
 * the same answer — "3045", "30.45" all mean the same thing, as do "11127",
 * "111.27" and "1:11.27".
 *
 * Returns null if it can't be read as a time.
 */
export function parseTime(input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!text) return null;

  const withColon = /^(\d{1,3}):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(text);
  if (withColon) {
    const [, min, sec, frac] = withColon;
    return toMs(parseInt(min, 10), parseInt(sec, 10), frac);
  }

  const withPoint = /^(\d{1,5})\.(\d{1,3})$/.exec(text);
  if (withPoint) {
    const [, whole, frac] = withPoint;
    return fromWholeSeconds(whole, frac);
  }

  if (!/^\d{1,7}$/.test(text)) return null;

  // Pad so a short entry still lands in the hundredths place: "45" is 0.45,
  // "5" is 0.05.
  const padded = text.padStart(2, "0");
  const hundredths = padded.slice(-2);
  const rest = padded.slice(0, -2);
  const secondsPart = rest.slice(-2);
  const minutesPart = rest.slice(0, -2);

  const seconds = secondsPart ? parseInt(secondsPart, 10) : 0;
  // Seconds can run past 59 only when no minutes were typed ("9945" is
  // 99.45); "16045" would be 1:60.45, which isn't a time.
  if (minutesPart && seconds > 59) return null;

  return toMs(minutesPart ? parseInt(minutesPart, 10) : 0, seconds, hundredths);
}
export function formatSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(2);
}
