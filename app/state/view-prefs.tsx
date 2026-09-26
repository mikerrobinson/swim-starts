import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { local } from "~/lib/local";
import type { NameOrder } from "~/types/preferences";

interface ViewPrefs {
  nameOrder: NameOrder;
}

interface ViewPrefsContextType {
  viewPrefs: ViewPrefs;
  updateViewPrefs: (updatedViewPrefs: Partial<ViewPrefs>) => void;
}

const DEFAULT_VIEWPREFS: ViewPrefs = {
  nameOrder: "last",
};

const ViewPrefsContext = createContext<ViewPrefsContextType | undefined>(
  undefined,
);

const VIEWPREFS_KEY = "swim-starts:view-prefs";

export function ViewPrefsProvider({ children }: { children: ReactNode }) {
  const [viewPrefs, setViewPrefs] = useState<ViewPrefs>(DEFAULT_VIEWPREFS);

  useEffect(() => {
    const stored = local.get(VIEWPREFS_KEY);
    if (stored) {
      try {
        setViewPrefs(JSON.parse(stored));
      } catch (e) {
        console.error("Failed to parse user config from localStorage", e);
      }
    }
  }, []);

  // 3. Update state AND sync to localStorage
  const updateViewPrefs = (updatedViewPrefs: Partial<ViewPrefs>) => {
    setViewPrefs((prev) => {
      const updated = { ...prev, ...updatedViewPrefs };
      local.set(VIEWPREFS_KEY, JSON.stringify(updated));
      return updated;
    });
  };

  return (
    <ViewPrefsContext.Provider value={{ viewPrefs, updateViewPrefs }}>
      {children}
    </ViewPrefsContext.Provider>
  );
}

export function useViewPrefs() {
  const value = useContext(ViewPrefsContext);
  if (!value) throw new Error("useViewPrefs used outside ViewPrefsProvider");
  return value;
}
