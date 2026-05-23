import { useCallback, useEffect, useState } from "react";
import type { View } from "../types";
import { getRouteForView, getViewFromPath, isKnownRoute } from "../utils/routes";

function readCurrentView() {
  if (typeof window === "undefined") {
    return "dashboard";
  }

  return getViewFromPath(window.location.pathname);
}

export function useAppRoute() {
  const [activeView, setActiveView] = useState<View>(readCurrentView);

  useEffect(() => {
    function syncRoute() {
      const nextView = getViewFromPath(window.location.pathname);
      setActiveView(nextView);

      if (!isKnownRoute(window.location.pathname) || window.location.pathname === "/") {
        window.history.replaceState({ view: nextView }, "", getRouteForView(nextView));
      }
    }

    syncRoute();
    window.addEventListener("popstate", syncRoute);

    return () => {
      window.removeEventListener("popstate", syncRoute);
    };
  }, []);

  const navigateToView = useCallback((view: View) => {
    const route = getRouteForView(view);
    setActiveView(view);

    if (window.location.pathname !== route) {
      window.history.pushState({ view }, "", route);
    }
  }, []);

  return {
    activeView,
    navigateToView
  };
}
