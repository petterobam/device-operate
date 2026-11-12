import { geoEqualEarth, geoInterpolate, geoPath } from "d3-geo";

export const NETWORK_WORLD_WIDTH = 980;
export const NETWORK_WORLD_HEIGHT = 470;
export const NETWORK_WORLD_PADDING = 18;

// Equal Earth is a good world overview projection, but its default
// Greenwich-centered orientation pushes East Asia toward the right edge and
// cuts great-circle paths at the antimeridian. Rotating both axes around the
// host puts the host at the exact canvas center and keeps the visible
// destinations on the side users expect.
export function createNetworkWorldProjection(origin) {
  const projection = geoEqualEarth();
  if (origin) projection.rotate([-origin[0], -origin[1]]);
  return projection.fitExtent(
    [[NETWORK_WORLD_PADDING, NETWORK_WORLD_PADDING], [NETWORK_WORLD_WIDTH - NETWORK_WORLD_PADDING, NETWORK_WORLD_HEIGHT - NETWORK_WORLD_PADDING]],
    { type: "Sphere" }
  );
}

export function networkArcKind(point) {
  if (point?.inbound && point?.outbound) return "mixed";
  return point?.inbound ? "inbound" : "outbound";
}

export function buildNetworkArc({ origin, point, direction = "all" }) {
  if (!origin || !point || !Number.isFinite(point.longitude) || !Number.isFinite(point.latitude)) return null;
  if (direction === "outbound" && !point.outbound) return null;
  if (direction === "inbound" && !point.inbound) return null;
  if (direction === "all" && !point.total) return null;

  const kind = networkArcKind(point);
  const target = [point.longitude, point.latitude];
  // Inbound connections are drawn from the remote IP back to the host;
  // outbound connections leave the host. Mixed points use the outbound leg
  // because they have both directions represented by the same target.
  const start = kind === "inbound" ? target : origin;
  const end = kind === "inbound" ? origin : target;
  const interpolate = geoInterpolate(start, end);
  const coordinates = Array.from({ length: 33 }, (_value, index) => interpolate(index / 32));
  return {
    kind,
    coordinates,
    start,
    end,
    markerId: `networkArrow${kind[0].toUpperCase()}${kind.slice(1)}`
  };
}

export function networkArcPath(projection, arc) {
  if (!arc) return "";
  return geoPath(projection)({ type: "LineString", coordinates: arc.coordinates });
}
