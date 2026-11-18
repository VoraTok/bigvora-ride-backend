import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { GeofenceService } from '../services/geofenceService';
import { MapboxService } from '../services/mapboxService';
import { PricingService } from '../services/pricingService';

const router = Router();

// 1. Get Customer Profile & Saved Places
router.get('/:customerId/profile', async (req: Request, res: Response) => {
  const { customerId } = req.params;

  const { data: customer, error } = await supabase
    .from('customers')
    .select('*, users(full_name, phone, email, rating)')
    .eq('id', customerId)
    .single();

  if (error || !customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  return res.json({ customer });
});

// 2. Save / Update Place (Home, Work, Metro)
router.post('/:customerId/saved-places', async (req: Request, res: Response) => {
  const { customerId } = req.params;
  const { tag, address, lat, lng } = req.body; // tag: 'home' | 'work' | 'metro'

  const { data: customer } = await supabase.from('customers').select('saved_places').eq('id', customerId).single();
  let places = Array.isArray(customer?.saved_places) ? customer?.saved_places : [];

  // Update or append
  places = places.filter((p: any) => p.tag !== tag);
  places.push({ tag, address, lat, lng, updatedAt: new Date().toISOString() });

  const { data: updated, error } = await supabase
    .from('customers')
    .update({ saved_places: places })
    .eq('id', customerId)
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ success: true, savedPlaces: updated.saved_places });
});

// 3. Estimate Fares for all vehicle types (Bike, Auto, Cab, Parcel)
router.post('/estimate-fare', async (req: Request, res: Response) => {
  const { pickup, drop, stops = [] } = req.body;

  if (!pickup || !drop || !pickup.lat || !drop.lat) {
    return res.status(400).json({ error: 'Valid pickup and drop locations are required.' });
  }

  // Geofence check
  const inZone = GeofenceService.isInsideDelhiNCR(pickup.lat, pickup.lng);
  if (!inZone) {
    return res.status(400).json({
      inServiceZone: false,
      message: 'Outside Active Service Zone. BigVora is currently live in Delhi-NCR & Gurugram.'
    });
  }

  // Get Road Route & Distance via Mapbox
  const route = await MapboxService.getDirections(pickup, drop, stops);

  // Check 1-KM Sector & Surge
  const sector = await GeofenceService.getNearestSector(pickup.lat, pickup.lng);
  const surgeMultiplier = sector?.current_surge_multiplier || 1.0;

  // Calculate for Bike, Auto, Cab, Parcel
  const bike = PricingService.calculateCustomerFare('bike', route.distanceKm, route.durationMins, surgeMultiplier);
  const auto = PricingService.calculateCustomerFare('auto', route.distanceKm, route.durationMins, surgeMultiplier);
  const cab = PricingService.calculateCustomerFare('cab', route.distanceKm, route.durationMins, surgeMultiplier);
  const parcel = PricingService.calculateCustomerFare('parcel', route.distanceKm, route.durationMins, surgeMultiplier);

  return res.json({
    inServiceZone: true,
    sector: sector?.sector_name || 'Delhi NCR',
    zoneStatus: sector?.zone_status || 'green',
    surgeMultiplier,
    route,
    estimates: {
      bike,
      auto,
      cab,
      parcel
    }
  });
});

// 4. Customer Ride History
router.get('/:customerId/rides', async (req: Request, res: Response) => {
  const { customerId } = req.params;

  const { data: rides, error } = await supabase
    .from('rides')
    .select('*, drivers(vehicle_type, vehicle_model, vehicle_number, users(full_name, phone))')
    .eq('customer_id', customerId)
    .order('requested_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ rides: rides || [] });
});

export default router;
