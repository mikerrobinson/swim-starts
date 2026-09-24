/**
 * `/meets/:meetId/admin` on its own — used to send whoever's here to the
 * first event's heat desk via a `meetDetail` D1 read. Events/entries/swims/
 * watches moved into the meet's own Durable Object (see `meets2.tsx`), and
 * this old-model admin desk hasn't been ported to read from it, so there's
 * nowhere left to redirect to — the shell (`admin.tsx`) renders the "no
 * events yet" state itself when there's nowhere to send them.
 */
export async function loader() {
  return null;
}

export default function AdminIndex() {
  return null;
}
