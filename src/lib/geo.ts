export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in kilometers (haversine formula). */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Moves `from` towards `to` by at most `stepKm`. Returns the new point and whether it arrived. */
export function stepTowards(from: LatLng, to: LatLng, stepKm: number): { point: LatLng; arrived: boolean } {
  const remaining = distanceKm(from, to);
  if (remaining <= stepKm) return { point: { ...to }, arrived: true };
  const ratio = stepKm / remaining;
  return {
    point: {
      lat: from.lat + (to.lat - from.lat) * ratio,
      lng: from.lng + (to.lng - from.lng) * ratio,
    },
    arrived: false,
  };
}

// Demo area: Bogotá, Colombia. Change CITY_CENTER_LAT/LNG to move the demo.
export const cityCenter: LatLng = {
  lat: Number(process.env.CITY_CENTER_LAT ?? 4.651),
  lng: Number(process.env.CITY_CENTER_LNG ?? -74.083),
};
