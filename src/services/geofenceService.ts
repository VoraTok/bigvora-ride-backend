import { supabase } from '../config/supabase';

// Delhi-NCR Outer Boundary Polygon coordinates (Delhi, Gurugram, Noida, Greater Noida, Faridabad, Ghaziabad)
export const DELHI_NCR_BOUNDARY = [
  [76.8000, 28.2500], // South-West (Manesar / Sohna outer)
  [76.8500, 28.6000], // West (Najafgarh / Bahadurgarh border)
  [77.0000, 28.8800], // North-West (Narela / Sonipat border)
  [77.3500, 28.8500], // North-East (Loni / Baghpat border)
  [77.5500, 28.6500], // East (Ghaziabad / Dasna)
  [77.6500, 28.4000], // South-East (Greater Noida / Pari Chowk / Yamuna Exp)
  [77.4000, 28.2500], // South (Faridabad / Ballabgarh border)
  [76.8000, 28.2500], // Close loop
];

export interface ZoneData {
  id: string;
  name: string;
  sector_name: string;
  center_lat: number;
  center_lng: number;
  zone_status: 'green' | 'orange' | 'red';
  current_surge_multiplier: number;
  surge_bonus_amount: number;
  active_requests_count: number;
  online_drivers_count: number;
}

export class GeofenceService {
  // 1. Ray-Casting Algorithm to test if lat, lng is inside Delhi-NCR Polygon
  public static isInsideDelhiNCR(lat: number, lng: number): boolean {
    const vs = DELHI_NCR_BOUNDARY;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      const xi = vs[i][0], yi = vs[i][1];
      const xj = vs[j][0], yj = vs[j][1];
      const intersect = ((yi > lat) !== (yj > lat))
        && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // 2. Haversine distance in KM
  public static getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) *
        Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // 3. Find closest 1-KM micro-sector
  public static async getNearestSector(lat: number, lng: number): Promise<ZoneData | null> {
    const { data: zones, error } = await supabase.from('zones').select('*');
    if (error || !zones || zones.length === 0) return null;

    let closest: any = null;
    let minDistance = Infinity;

    for (const zone of zones) {
      const dist = this.getDistanceKm(lat, lng, zone.center_lat, zone.center_lng);
      if (dist < minDistance) {
        minDistance = dist;
        closest = zone;
      }
    }

    return closest;
  }

  // 4. Update Dynamic Surge for all sectors (Called by background timer / cron every 30s)
  public static async recalculateSurgeGrids(): Promise<ZoneData[]> {
    const { data: zones } = await supabase.from('zones').select('*');
    if (!zones) return [];

    const updatedZones: ZoneData[] = [];

    for (const zone of zones) {
      // Count active unassigned rides within 2 km of sector center
      const { data: activeRides } = await supabase
        .from('rides')
        .select('id, pickup_lat, pickup_lng')
        .eq('status', 'requested');

      const ridesInZone = (activeRides || []).filter(r => 
        this.getDistanceKm(r.pickup_lat, r.pickup_lng, zone.center_lat, zone.center_lng) <= 2.0
      ).length;

      // Count online available drivers within 2 km
      const { data: onlineDrivers } = await supabase
        .from('drivers')
        .select('id, current_lat, current_lng, is_online, is_busy')
        .eq('is_online', true)
        .eq('is_busy', false);

      const driversInZone = (onlineDrivers || []).filter(d =>
        this.getDistanceKm(d.current_lat, d.current_lng, zone.center_lat, zone.center_lng) <= 2.0
      ).length;

      let status: 'green' | 'orange' | 'red' = 'green';
      let multiplier = 1.0;
      let bonus = 0;

      const demandRatio = driversInZone === 0 ? (ridesInZone > 0 ? 5.0 : 0.5) : (ridesInZone / driversInZone);

      if (demandRatio >= 3.0 && ridesInZone >= 3) {
        status = 'red';
        multiplier = 1.8;
        bonus = 60.0;
      } else if (demandRatio >= 1.5 && ridesInZone >= 2) {
        status = 'orange';
        multiplier = 1.3;
        bonus = 30.0;
      } else {
        status = 'green';
        multiplier = 1.0;
        bonus = 0.0;
      }

      await supabase
        .from('zones')
        .update({
          zone_status: status,
          current_surge_multiplier: multiplier,
          surge_bonus_amount: bonus,
          active_requests_count: ridesInZone,
          online_drivers_count: driversInZone,
          is_red_zone: status === 'red',
          last_surge_calculated_at: new Date().toISOString()
        })
        .eq('id', zone.id);

      updatedZones.push({
        ...zone,
        zone_status: status,
        current_surge_multiplier: multiplier,
        surge_bonus_amount: bonus,
        active_requests_count: ridesInZone,
        online_drivers_count: driversInZone,
      });
    }

    return updatedZones;
  }
}
