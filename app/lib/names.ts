/**
 * Split a typed name into first and last.
 *
 * Two orders, because a timer types whichever one they are looking at. "Mike
 * Robinson" is what someone writes unprompted; "Robinson, Mike" is what they
 * copy off a heat sheet or off this app's own roster column, which sorts by
 * surname. The comma is the only reliable signal of which is which, and
 * without it a name lands in the meet as "Robinson," — with the punctuation
 * still attached, in the wrong field, in front of a coach at the desk.
 */
export function splitTypedName(raw: string): {
  firstName: string;
  lastName: string;
} {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { firstName: "", lastName: "" };

  const comma = name.indexOf(",");
  if (comma > 0) {
    return {
      lastName: name.slice(0, comma).trim(),
      firstName: name.slice(comma + 1).trim(),
    };
  }

  const cut = name.lastIndexOf(" ");
  return cut > 0
    ? { firstName: name.slice(0, cut), lastName: name.slice(cut + 1) }
    : { firstName: name, lastName: "" };
}
