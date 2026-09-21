/**
 * How names are ordered and written. "last" gives "Aaronson, Avery" sorted by
 * surname; "first" gives "Avery Aaronson" sorted by given name. A preference
 * of whoever is looking, so it lives on the device.
 */

export type NameOrder = "first" | "last";
