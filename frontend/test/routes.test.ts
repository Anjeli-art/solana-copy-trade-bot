import assert from "node:assert/strict";
import test from "node:test";
import { getRouteForView, getViewFromPath, isKnownRoute } from "../src/utils/routes.ts";

test("getViewFromPath maps routes to views", () => {
  assert.equal(getViewFromPath("/dashboard"), "dashboard");
  assert.equal(getViewFromPath("/positions"), "positions");
  assert.equal(getViewFromPath("/traders"), "traders");
  assert.equal(getViewFromPath("/analytics"), "analytics");
  assert.equal(getViewFromPath("/logs"), "logs");
});

test("getViewFromPath normalizes trailing slashes and unknown paths", () => {
  assert.equal(getViewFromPath("/positions/"), "positions");
  assert.equal(getViewFromPath("/"), "dashboard");
  assert.equal(getViewFromPath("/unknown"), "dashboard");
});

test("getRouteForView returns stable browser paths", () => {
  assert.equal(getRouteForView("dashboard"), "/dashboard");
  assert.equal(getRouteForView("logs"), "/logs");
});

test("isKnownRoute only accepts app routes and root", () => {
  assert.equal(isKnownRoute("/"), true);
  assert.equal(isKnownRoute("/analytics"), true);
  assert.equal(isKnownRoute("/analytics/"), true);
  assert.equal(isKnownRoute("/nope"), false);
});
