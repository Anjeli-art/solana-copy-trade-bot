import type { View } from "../types";

export const VIEW_ROUTES: Record<View, string> = {
  dashboard: "/dashboard",
  positions: "/positions",
  traders: "/traders",
  analytics: "/analytics",
  logs: "/logs",
  mirror: "/mirror"
};

const routeEntries = Object.entries(VIEW_ROUTES) as Array<[View, string]>;

function normalizePath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

export function getRouteForView(view: View) {
  return VIEW_ROUTES[view];
}

export function isKnownRoute(pathname: string) {
  const path = normalizePath(pathname);
  return path === "/" || routeEntries.some(([, route]) => route === path);
}

export function getViewFromPath(pathname: string): View {
  const path = normalizePath(pathname);
  const match = routeEntries.find(([, route]) => route === path);
  return match?.[0] || "dashboard";
}
