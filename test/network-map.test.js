import assert from "node:assert/strict";
import test from "node:test";
import { geoPath } from "d3-geo";
import {
  buildNetworkArc,
  createNetworkWorldProjection,
  NETWORK_WORLD_HEIGHT,
  NETWORK_WORLD_WIDTH,
  networkArcKind,
  networkArcPath
} from "../src/network-map.js";

const ORIGIN = [120.1614, 30.2936];
const TARGET = [-121.895, 37.339];

test("the network world projection centers the host in the map canvas", () => {
  const projection = createNetworkWorldProjection(ORIGIN);
  const [x, y] = projection(ORIGIN);
  assert.ok(Math.abs(x - NETWORK_WORLD_WIDTH / 2) < 0.01, `host x ${x} should be centered`);
  assert.ok(Math.abs(y - NETWORK_WORLD_HEIGHT / 2) < 0.01, `host y ${y} should be centered`);
  const bounds = geoPath(projection).bounds({ type: "Sphere" });
  assert.ok(bounds[0][0] >= 18 && bounds[0][1] >= 18);
  assert.ok(bounds[1][0] <= NETWORK_WORLD_WIDTH - 18 && bounds[1][1] <= NETWORK_WORLD_HEIGHT - 18);
});

test("outbound arcs start at the host and point at the target", () => {
  const arc = buildNetworkArc({ origin: ORIGIN, point: { longitude: TARGET[0], latitude: TARGET[1], outbound: 2, total: 2 } });
  assert.equal(arc.kind, "outbound");
  assert.deepEqual(arc.start, ORIGIN);
  assert.deepEqual(arc.end, TARGET);
  assert.equal(arc.markerId, "networkArrowOutbound");
  const projection = createNetworkWorldProjection(ORIGIN);
  const path = networkArcPath(projection, arc);
  assert.equal((path.match(/M/g) || []).length, 1, "arc should not wrap into a second edge path");
  const host = projection(ORIGIN);
  assert.match(path, new RegExp(`^M${host[0]},${host[1]}`));
  const target = projection(TARGET);
  const last = [...path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].at(-1);
  assert.ok(Math.abs(Number(last[1]) - target[0]) < 0.1);
  assert.ok(Math.abs(Number(last[2]) - target[1]) < 0.1);
});

test("inbound arcs start at the remote target and point back to the host", () => {
  const arc = buildNetworkArc({ origin: ORIGIN, point: { longitude: TARGET[0], latitude: TARGET[1], inbound: 1, total: 1 } });
  assert.equal(arc.kind, "inbound");
  assert.deepEqual(arc.start, TARGET);
  assert.deepEqual(arc.end, ORIGIN);
  assert.equal(arc.markerId, "networkArrowInbound");
  const projection = createNetworkWorldProjection(ORIGIN);
  const path = networkArcPath(projection, arc);
  const host = projection(ORIGIN);
  const last = [...path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].at(-1);
  assert.ok(Math.abs(Number(last[1]) - host[0]) < 0.1);
  assert.ok(Math.abs(Number(last[2]) - host[1]) < 0.1);
});

test("direction filters skip points with no matching traffic", () => {
  assert.equal(buildNetworkArc({ origin: ORIGIN, point: { longitude: TARGET[0], latitude: TARGET[1], inbound: 1, total: 1 }, direction: "outbound" }), null);
  assert.equal(buildNetworkArc({ origin: ORIGIN, point: { longitude: TARGET[0], latitude: TARGET[1], outbound: 1, total: 1 }, direction: "inbound" }), null);
  assert.equal(networkArcKind({ inbound: 2, outbound: 1 }), "mixed");
});
