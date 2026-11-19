import { Server, Socket } from 'socket.io';
import { supabase } from '../config/supabase';
import { GeofenceService } from '../services/geofenceService';
import { MapboxService } from '../services/mapboxService';
import { PricingService } from '../services/pricingService';

// Active connected sockets
const driverSockets = new Map<string, string>(); // driverId -> socketId
const customerSockets = new Map<string, string>(); // customerId -> socketId

export const setupSocketHandlers = (io: Server) => {
  io.on('connection', (socket: Socket) => {
    // 1. Driver Handshake & Auth
    socket.on('driver:join', async ({ driverId }: { driverId: string }) => {
      driverSockets.set(driverId, socket.id);
      socket.join(`driver:${driverId}`);
      socket.join('all_drivers');
      console.log(`[Socket] Driver connected: ${driverId}`);
    });

    // 2. Customer Handshake & Auth
    socket.on('customer:join', ({ customerId }: { customerId: string }) => {
      customerSockets.set(customerId, socket.id);
      socket.join(`customer:${customerId}`);
      console.log(`[Socket] Customer connected: ${customerId}`);
    });

    // 3. Admin Handshake
    socket.on('admin:join', () => {
      socket.join('admin_channel');
      console.log(`[Socket] Admin joined monitoring channel`);
    });

    // 4. Driver Live Location Beacon (every 3 seconds)
    socket.on('driver:location_update', async (data: {
      driverId: string;
      lat: number;
      lng: number;
      heading?: number;
      speed?: number;
    }) => {
      const { driverId, lat, lng, heading = 0, speed = 0 } = data;

      // Update in Supabase
      await supabase
        .from('drivers')
        .update({
          current_lat: lat,
          current_lng: lng,
          current_heading: heading,
          last_location_updated_at: new Date().toISOString()
        })
        .eq('id', driverId);

      // Broadcast to Admin live radar
      io.to('admin_channel').emit('admin:driver_moved', {
        driverId,
        lat,
        lng,
        heading,
        speed,
        timestamp: new Date().toISOString()
      });

      // Broadcast to any active ride customer
      socket.broadcast.emit(`driver_location:${driverId}`, {
        lat,
        lng,
        heading,
        speed
      });
    });

    // 5. Customer Searches for Nearby Drivers on Map
    socket.on('customer:get_nearby_drivers', async (data: {
      lat: number;
      lng: number;
      vehicleType?: 'bike' | 'auto' | 'cab';
    }) => {
      const { lat, lng, vehicleType } = data;

      const { data: drivers } = await supabase
        .from('drivers')
        .select('id, vehicle_type, vehicle_model, vehicle_number, current_lat, current_lng, current_heading, rating')
        .eq('is_online', true)
        .eq('is_busy', false)
        .eq('kyc_status', 'approved');

      if (!drivers) {
        socket.emit('nearby_drivers_response', []);
        return;
      }

      // Filter drivers within 5 km
      const nearby = drivers.filter(d => {
        if (vehicleType && d.vehicle_type !== vehicleType) return false;
        const dist = GeofenceService.getDistanceKm(lat, lng, d.current_lat, d.current_lng);
        return dist <= 5.0;
      });

      socket.emit('nearby_drivers_response', nearby);
    });

    // 6. Ride Request Creation & 10-KM Broadcast to Drivers
    socket.on('ride:create_request', async (payload: {
      customerId: string;
      pickup: { lat: number; lng: number; address: string };
      drop: { lat: number; lng: number; address: string };
      stops?: Array<{ lat: number; lng: number; address?: string }>;
      vehicleType: 'bike' | 'auto' | 'cab' | 'parcel';
      paymentMode?: 'cash' | 'upi' | 'wallet';
    }) => {
      const { customerId, pickup, drop, stops = [], vehicleType, paymentMode = 'cash' } = payload;

      // Step A: Geofence Verification (Must be within Delhi-NCR / Gurugram)
      const insideGeofence = GeofenceService.isInsideDelhiNCR(pickup.lat, pickup.lng);
      if (!insideGeofence) {
        socket.emit('ride:error', {
          code: 'OUTSIDE_GEOFENCE',
          message: 'Outside Active Service Zone. BigVora is currently live in Delhi-NCR & Gurugram.'
        });
        return;
      }

      // Step B: Calculate Route & Polyline via Mapbox
      const route = await MapboxService.getDirections(pickup, drop, stops);

      // Step C: Check 1-KM Sector & Dynamic Surge
      const sector = await GeofenceService.getNearestSector(pickup.lat, pickup.lng);
      const surgeMultiplier = sector?.current_surge_multiplier || 1.0;

      // Step D: Calculate Transparent Pricing
      const fare = PricingService.calculateCustomerFare(
        vehicleType,
        route.distanceKm,
        route.durationMins,
        surgeMultiplier
      );

      // Step E: Generate 4-digit Ride Start OTP
      const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
      const rideCode = `BVR-${Math.floor(100000 + Math.random() * 900000)}`;

      // Step F: Save Ride in Supabase
      const { data: ride, error: rideErr } = await supabase
        .from('rides')
        .insert({
          ride_code: rideCode,
          customer_id: customerId,
          vehicle_type: vehicleType,
          status: 'requested',
          pickup_address: pickup.address,
          pickup_lat: pickup.lat,
          pickup_lng: pickup.lng,
          drop_address: drop.address,
          drop_lat: drop.lat,
          drop_lng: drop.lng,
          stops: stops,
          distance_km: fare.distanceKm,
          duration_mins: fare.durationMins,
          base_fare: fare.baseFare,
          surge_multiplier: fare.surgeMultiplier,
          surge_bonus: fare.surgeBonus,
          total_fare: fare.totalCustomerFare,
          driver_earning: fare.driverEarning,
          platform_fee: fare.instantCut,
          start_otp: startOtp,
          payment_mode: paymentMode,
          payment_status: 'pending'
        })
        .select('*')
        .single();

      if (rideErr || !ride) {
        socket.emit('ride:error', { message: 'Could not create ride request. Please try again.' });
        return;
      }

      // Emit created ride back to Customer
      socket.emit('ride:request_created', {
        ride,
        fare,
        route,
        startOtp
      });

      // Step G: Query Online Verified Drivers in 10 KM Radius
      const { data: availableDrivers } = await supabase
        .from('drivers')
        .select('id, vehicle_type, current_lat, current_lng, is_online, is_busy, home_route_active, home_route_lat, home_route_lng')
        .eq('is_online', true)
        .eq('is_busy', false)
        .eq('kyc_status', 'approved');

      const eligibleDrivers = (availableDrivers || []).filter(d => {
        // Vehicle type match
        if (d.vehicle_type !== vehicleType && vehicleType !== 'parcel') return false;

        // 10 KM Distance check from pickup
        const distToPickup = GeofenceService.getDistanceKm(pickup.lat, pickup.lng, d.current_lat, d.current_lng);
        if (distToPickup > 10.0) return false;

        // Home Route Filter: If driver has "Going Home" turned on, check if drop point is within 3 km of home
        if (d.home_route_active && d.home_route_lat && d.home_route_lng) {
          const distToHome = GeofenceService.getDistanceKm(drop.lat, drop.lng, d.home_route_lat, d.home_route_lng);
          if (distToHome > 3.0) return false;
        }

        return true;
      });

      // Voice Announcer Text in Hindi
      const voiceText = `Nayi Ride! ${pickup.address.split(',')[0]} se ${drop.address.split(',')[0]}. Kiraya ${fare.totalCustomerFare} rupaye Cash.${fare.surgeBonus > 0 ? ` Isme ${fare.surgeBonus} rupaye rush bonus shamil hai.` : ''}`;

      // Broadcast incoming ride alert with 20s countdown chime to eligible drivers
      for (const drv of eligibleDrivers) {
        io.to(`driver:${drv.id}`).emit('driver:incoming_ride_alert', {
          rideId: ride.id,
          rideCode: ride.ride_code,
          vehicleType,
          pickupAddress: pickup.address,
          dropAddress: drop.address,
          distanceKm: fare.distanceKm,
          estimatedFare: fare.totalCustomerFare,
          driverEarning: fare.driverEarning,
          surgeBonus: fare.surgeBonus,
          isSurge: fare.surgeBonus > 0,
          countdownSeconds: 20,
          voiceAnnouncement: voiceText
        });
      }

      // Also notify Admin channel
      io.to('admin_channel').emit('admin:new_ride_requested', {
        ride,
        eligibleDriverCount: eligibleDrivers.length
      });
    });

    // 7. Driver Accepts Ride
    socket.on('driver:accept_ride', async ({ rideId, driverId }: { rideId: string; driverId: string }) => {
      // Atomic lock check: make sure ride is still 'requested'
      const { data: ride } = await supabase.from('rides').select('*').eq('id', rideId).single();

      if (!ride || ride.status !== 'requested') {
        socket.emit('driver:ride_already_taken', { message: 'Ride has already been accepted by another driver.' });
        return;
      }

      // Assign to this driver and mark busy
      await supabase
        .from('rides')
        .update({
          driver_id: driverId,
          status: 'accepted',
          accepted_at: new Date().toISOString()
        })
        .eq('id', rideId);

      await supabase
        .from('drivers')
        .update({ is_busy: true })
        .eq('id', driverId);

      // Fetch Driver info to show Customer
      const { data: driverDetails } = await supabase
        .from('drivers')
        .select('*, users(full_name, phone, rating)')
        .eq('id', driverId)
        .single();

      // Notify Driver with Pickup Route
      socket.emit('driver:ride_confirmed', {
        rideId,
        customerPickup: { lat: ride.pickup_lat, lng: ride.pickup_lng, address: ride.pickup_address },
        customerDrop: { lat: ride.drop_lat, lng: ride.drop_lng, address: ride.drop_address },
        totalFare: ride.total_fare,
        driverEarning: ride.driver_earning
      });

      // Notify Customer with Driver Details & Start OTP
      io.to(`customer:${ride.customer_id}`).emit('customer:driver_assigned', {
        rideId,
        driver: {
          id: driverId,
          name: driverDetails?.users?.full_name || 'Driver',
          phone: driverDetails?.users?.phone || '',
          rating: driverDetails?.rating || 5.0,
          vehicleType: driverDetails?.vehicle_type,
          vehicleModel: driverDetails?.vehicle_model || '',
          vehicleNumber: driverDetails?.vehicle_number || '',
          lat: driverDetails?.current_lat,
          lng: driverDetails?.current_lng
        },
        startOtp: ride.start_otp
      });

      // Broadcast to Admin
      io.to('admin_channel').emit('admin:ride_status_change', { rideId, status: 'accepted', driverId });
    });

    // 8. Driver Arrived at Pickup Point (Starts 3-min free waiting timer)
    socket.on('driver:arrived_at_pickup', async ({ rideId }: { rideId: string }) => {
      const { data: ride } = await supabase
        .from('rides')
        .update({ status: 'arrived', arrived_at: new Date().toISOString() })
        .eq('id', rideId)
        .select('customer_id')
        .single();

      if (ride) {
        io.to(`customer:${ride.customer_id}`).emit('customer:driver_arrived', {
          message: 'Aapka driver pickup location par pahunch gaya hai.',
          freeWaitingMins: 3
        });
      }
    });

    // 9. Driver Starts Ride with 4-Digit OTP
    socket.on('driver:start_ride', async ({ rideId, inputOtp }: { rideId: string; inputOtp: string }) => {
      const { data: ride } = await supabase.from('rides').select('*').eq('id', rideId).single();

      if (!ride) return;

      if (ride.start_otp !== inputOtp) {
        socket.emit('driver:otp_error', { message: 'Galat OTP! Kripya customer se sahi 4-digit OTP lein.' });
        return;
      }

      await supabase
        .from('rides')
        .update({ status: 'in_progress', started_at: new Date().toISOString() })
        .eq('id', rideId);

      socket.emit('driver:ride_started_success', { rideId });
      io.to(`customer:${ride.customer_id}`).emit('customer:ride_started', { rideId });
      io.to('admin_channel').emit('admin:ride_status_change', { rideId, status: 'in_progress' });
    });

    // 10. Driver Completes Ride & Collects Fare
    socket.on('driver:complete_ride', async (payload: {
      rideId: string;
      tollCharge?: number;
      actualWaitingMins?: number;
    }) => {
      const { rideId, tollCharge = 0, actualWaitingMins = 0 } = payload;
      const { data: ride } = await supabase.from('rides').select('*').eq('id', rideId).single();

      if (!ride || ride.status === 'completed') return;

      // Calculate final bill with waiting & tolls
      const extraWaitingMins = Math.max(0, actualWaitingMins - 3);
      const waitingCost = extraWaitingMins * 2.0;
      const finalFare = Number(ride.total_fare) + waitingCost + tollCharge;
      const instantCut = PricingService.getInstantCut(ride.vehicle_type);
      const finalDriverEarning = finalFare - instantCut;

      // Update Ride
      await supabase
        .from('rides')
        .update({
          status: 'completed',
          waiting_charge: waitingCost,
          toll_charge: tollCharge,
          total_fare: finalFare,
          driver_earning: finalDriverEarning,
          completed_at: new Date().toISOString(),
          payment_status: 'paid'
        })
        .eq('id', rideId);

      // Driver becomes available again
      await supabase
        .from('drivers')
        .update({ is_busy: false })
        .eq('id', ride.driver_id);

      // Update Daily Slab Record for Driver
      const today = new Date().toISOString().split('T')[0];
      const { data: existingSlab } = await supabase
        .from('driver_daily_slabs')
        .select('*')
        .eq('driver_id', ride.driver_id)
        .eq('slab_date', today)
        .single();

      if (existingSlab) {
        await supabase
          .from('driver_daily_slabs')
          .update({
            completed_rides_count: existingSlab.completed_rides_count + 1,
            instant_cut_total: Number(existingSlab.instant_cut_total) + instantCut
          })
          .eq('id', existingSlab.id);
      } else {
        await supabase
          .from('driver_daily_slabs')
          .insert({
            driver_id: ride.driver_id,
            slab_date: today,
            vehicle_type: ride.vehicle_type,
            completed_rides_count: 1,
            instant_cut_total: instantCut
          });
      }

      // Notify Driver & Customer with Bill Receipt
      const receipt = {
        rideId,
        totalFare: finalFare,
        baseFare: ride.base_fare,
        surgeBonus: ride.surge_bonus,
        waitingCharge: waitingCost,
        tollCharge: tollCharge,
        instantCut,
        driverEarning: finalDriverEarning,
        paymentMode: ride.payment_mode
      };

      socket.emit('driver:ride_completed_receipt', receipt);
      io.to(`customer:${ride.customer_id}`).emit('customer:ride_completed_receipt', receipt);
      io.to('admin_channel').emit('admin:ride_status_change', { rideId, status: 'completed' });
    });

    // 11. In-App Realtime Chat
    socket.on('ride:send_chat', ({ rideId, sender, message }: { rideId: string; sender: 'customer' | 'driver'; message: string }) => {
      io.emit(`chat:${rideId}`, {
        sender,
        message,
        timestamp: new Date().toISOString()
      });
    });

    // 12. Safety SOS Trigger
    socket.on('ride:sos_trigger', async ({ rideId, triggeredBy, lat, lng }: { rideId: string; triggeredBy: 'customer' | 'driver'; lat: number; lng: number }) => {
      console.warn(`[EMERGENCY SOS] Triggered on ride ${rideId} by ${triggeredBy} at (${lat}, ${lng})`);
      io.to('admin_channel').emit('admin:emergency_sos_alert', {
        rideId,
        triggeredBy,
        lat,
        lng,
        timestamp: new Date().toISOString()
      });
    });

    // Disconnect Handler
    socket.on('disconnect', () => {
      for (const [driverId, sockId] of driverSockets.entries()) {
        if (sockId === socket.id) {
          driverSockets.delete(driverId);
          console.log(`[Socket] Driver disconnected: ${driverId}`);
          break;
        }
      }
      for (const [customerId, sockId] of customerSockets.entries()) {
        if (sockId === socket.id) {
          customerSockets.delete(customerId);
          console.log(`[Socket] Customer disconnected: ${customerId}`);
          break;
        }
      }
    });
  });
};
