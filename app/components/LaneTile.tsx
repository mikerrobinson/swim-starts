import type { MouseEvent, PointerEvent, RefObject } from "react";
import { formatTime } from "~/lib/time";
import type { SwimTime } from "~/lib/timing";
import { displayName } from "~/types/meet";
import { type LaneLayout } from "../routes/splits-heat";
import { type NameOrder } from "~/types/preferences";
import type { Athlete } from "~/types/athlete";

/**
 * Grid tiles stack their content; list rows run it left to right so the lane
 * number sits in a fixed column down the edge, which is the whole point of the
 * list layouts — read the finish, drop straight down the column.
 */
const GRID_HEIGHT: Record<number, string> = {
  4: "h-32",
  5: "h-28",
  6: "h-28",
  8: "h-24",
  10: "h-20",
};

/** Shorter, because a list puts every lane in its own row. */
const LIST_HEIGHT: Record<number, string> = {
  4: "h-20",
  5: "h-18",
  6: "h-16",
  8: "h-[3.25rem]",
  10: "h-12",
};

export function laneTileHeight(laneCount: number, layout: LaneLayout): string {
  const table = layout === "grid" ? GRID_HEIGHT : LIST_HEIGHT;
  return table[laneCount] ?? (layout === "grid" ? "h-28" : "h-16");
}

function tone(result: SwimTime | undefined, running: boolean): string {
  if (result) {
    return result.status === "OK"
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
      : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
  }
  return running
    ? "bg-red-600 text-white active:bg-red-700"
    : "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
}

export function LaneTile({
  lane,
  athlete,
  time: result,
  exhibition,
  stoppedHere,
  running,
  clockRunning,
  layout,
  laneCount,
  nameOrder,
  dragging,
  dropTarget,
  suppressClickRef,
  onStop,
  onEdit,
  onAssign,
  onDragStart,
}: {
  lane: number;
  athlete?: Athlete;
  /** The lane's official time, from whoever's watches are on it. */
  time?: SwimTime;
  /** Swum outside the competition — a real time, but no place or points. */
  exhibition?: boolean;
  /**
   * Whether *this* device has taken this lane.
   *
   * Separate from `result` on purpose. A lane that another timer has already
   * stopped shows their time, and this device may still take its own watch on
   * it — that's what several watches per lane are for. Reading stoppability
   * off `result` meant a time arriving from a phone locked the button here,
   * which is the opposite of what an extra watch is.
   */
  stoppedHere: boolean;
  running: boolean;
  clockRunning: boolean;
  layout: LaneLayout;
  laneCount: number;
  nameOrder: NameOrder;
  /** This tile is the one a long-press has lifted. */
  dragging?: boolean;
  /** A lifted tile is currently held over this one. */
  dropTarget?: boolean;
  /**
   * Shared with every tile on the heat: a long-press that turned into a drag
   * sets this so the tap it would otherwise also fire (mouseup lands on a
   * button same as any other click) gets swallowed once, here.
   */
  suppressClickRef: RefObject<boolean>;
  onStop: () => void;
  onEdit: () => void;
  onAssign: () => void;
  /** Undefined for a tile nothing can be dragged off of (empty, or frozen). */
  onDragStart?: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  const height = laneTileHeight(laneCount, layout);
  const isList = layout !== "grid";

  const dragClasses = `${dragging ? "scale-95 opacity-60" : ""} ${
    dropTarget ? "ring-4 ring-blue-500 ring-inset" : ""
  }`;

  const guardClick =
    (action: () => void) =>
    (e: MouseEvent<HTMLButtonElement>): void => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        e.preventDefault();
        return;
      }
      action();
    };

  if (!athlete) {
    return (
      <button
        type="button"
        data-lane={lane}
        disabled={clockRunning}
        onClick={guardClick(onAssign)}
        className={`${height} flex touch-manipulation select-none items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 text-slate-400 transition-transform disabled:opacity-60 dark:border-slate-700 ${dragClasses} ${
          isList ? "flex-row px-4" : "flex-col"
        }`}
      >
        <span className="text-sm font-semibold">Lane {lane}</span>
        <span className="text-xs">
          {clockRunning ? "empty" : "+ Add swimmer"}
        </span>
      </button>
    );
  }

  const canStop = running && !stoppedHere;
  const value = result
    ? result.status === "OK"
      ? formatTime(result.timeMs)
      : result.status
    : running
      ? "STOP"
      : "—";

  const handle = () => (canStop ? onStop() : onEdit());

  if (isList) {
    return (
      <button
        type="button"
        data-lane={lane}
        onClick={guardClick(handle)}
        onPointerDown={onDragStart}
        className={`${height} flex w-full touch-manipulation select-none items-center gap-3 rounded-2xl px-3 text-left transition-colors transition-transform ${tone(result, running)} ${dragClasses}`}
      >
        <span className="w-16 shrink-0 text-center text-sm font-bold opacity-80">
          Lane {lane}
        </span>
        <span className="min-w-0 flex-1 truncate text-lg font-bold leading-tight">
          {displayName(athlete, nameOrder)}
        </span>
        {exhibition && (
          <span
            title="Exhibition — won't score or place"
            className="shrink-0 rounded-full bg-black/10 px-1.5 py-0.5 text-xs font-bold dark:bg-white/10"
          >
            X
          </span>
        )}
        <span className="shrink-0 text-2xl font-bold tabular-nums">
          {value}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-lane={lane}
      onClick={guardClick(handle)}
      onPointerDown={onDragStart}
      className={`${height} relative flex touch-manipulation select-none flex-col items-center justify-center rounded-2xl px-2 text-center transition-colors transition-transform ${tone(result, running)} ${dragClasses}`}
    >
      {exhibition && (
        <span
          title="Exhibition — won't score or place"
          className="absolute right-1.5 top-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-xs font-bold dark:bg-white/10"
        >
          X
        </span>
      )}
      <span className="text-xs font-bold opacity-70">Lane {lane}</span>
      <span className="w-full truncate text-base font-bold leading-tight">
        {displayName(athlete, nameOrder)}
      </span>
      <span className="mt-0.5 text-2xl font-bold leading-none tabular-nums">
        {value}
      </span>
    </button>
  );
}
