import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || '';

export interface RouteStop {
  lat: number;
  lng: number;
  address?: string;
}

export interface RouteResult {
  distanceKm: number;
  durationMins: number;
  polyline: string;
}

export class MapboxService {
  // 1. Get multi-stop directions & road polyline
  public static async getDirections(
    pickup: RouteStop,
    drop: RouteStop,
    stops: RouteStop[] = []
  ): Promise<RouteResult> {
    try {
      // Build coordinates string: lng1,lat1;lng2,lat2;...
      const points = [
        `${pickup.lng},${pickup.lat}`,
        ...stops.map(s => `${s.lng},${s.lat}`),
        `${drop.lng},${drop.lat}`
      ].join(';');

      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${points}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
      const response = await axios.get(url);

      if (response.data && response.data.routes && response.data.routes.length > 0) {
        const route = response.data.routes[0];
        const distanceKm = Math.round((route.distance / 1000) * 10) / 10;
        const durationMins = Math.round(route.duration / 60);

        return {
          distanceKm,
          durationMins,
          polyline: JSON.stringify(route.geometry),
        };
      }

      // Fallback rough estimate
      return {
        distanceKm: 5.0,
        durationMins: 15,
        polyline: JSON.stringify({ type: 'LineString', coordinates: [[pickup.lng, pickup.lat], [drop.lng, drop.lat]] }),
      };
    } catch (err: any) {
      console.error('Mapbox Directions API Error:', err.message);
      return {
        distanceKm: 5.0,
        durationMins: 15,
        polyline: JSON.stringify({ type: 'LineString', coordinates: [[pickup.lng, pickup.lat], [drop.lng, drop.lat]] }),
      };
    }
  }

  // 2. Reverse Geocoding (Coordinates to Place Name)
  public static async reverseGeocode(lat: number, lng: number): Promise<string> {
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${MAPBOX_TOKEN}&country=in`;
      const response = await axios.get(url);

      if (response.data && response.data.features && response.data.features.length > 0) {
        return response.data.features[0].place_name;
      }
      return `${lat.toFixed(4)}, ${lng.toFixed(4)}, Delhi NCR`;
    } catch (err) {
      return `${lat.toFixed(4)}, ${lng.toFixed(4)}, Delhi NCR`;
    }
  }
}
