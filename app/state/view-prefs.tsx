import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  loadLaneLayout,
  loadNameOrder,
  loadTimerId,
  saveLaneLayout,
  saveNameOrder,
} from "~/lib/storage";
import type { LaneLayout } from "~/types/meet";
import type { NameOrder } from "~/types/preferences";

/**
 * How this device likes to look at things, as opposed to what's true about a
 * meet. Lives here rather than in the meet document so it survives to the next
 * meet and doesn't sync — one coach's layout isn't another's.
 *
 * The controls for these sit in the header, centred, so they cost no vertical
 * space on the screens that need every pixel.
 */
interface ViewPrefs {
  laneLayout: LaneLayout;
  setLaneLayout: (layout: LaneLayout) => void;
  /** This device's identity as a timer — every watch it takes is filed under it. */
  timerId: string;
  /** How names are written and sorted for whoever is holding this device. */
  nameOrder: NameOrder;
  setNameOrder: (order: NameOrder) => void;
}

const ViewPrefsContext = createContext<ViewPrefs | null>(null);

export function ViewPrefsProvider({ children }: { children: ReactNode }) {
  // Starts at the default and adopts the stored value once mounted: the
  // server can't read localStorage, and guessing would mismatch on hydration.
  const [laneLayout, setLayout] = useState<LaneLayout>("grid");
  const [timerId, setTimerId] = useState("device");
  const [nameOrder, setOrder] = useState<NameOrder>("last");

  useEffect(() => {
    setLayout(loadLaneLayout());
    setTimerId(loadTimerId());
    setOrder(loadNameOrder());
  }, []);

  const value = useMemo<ViewPrefs>(
    () => ({
      laneLayout,
      timerId,
      nameOrder,
      setLaneLayout: (next) => {
        setLayout(next);
        saveLaneLayout(next);
      },
      setNameOrder: (next) => {
        setOrder(next);
        saveNameOrder(next);
      },
    }),
    [laneLayout, timerId, nameOrder],
  );

  return (
    <ViewPrefsContext.Provider value={value}>
      {children}
    </ViewPrefsContext.Provider>
  );
}

export function useViewPrefs(): ViewPrefs {
  const value = useContext(ViewPrefsContext);
  if (!value) throw new Error("useViewPrefs used outside ViewPrefsProvider");
  return value;
}
