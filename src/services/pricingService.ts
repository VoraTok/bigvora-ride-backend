import { supabase } from '../config/supabase';

export interface FareBreakdown {
  vehicleType: 'bike' | 'auto' | 'cab' | 'parcel';
  distanceKm: number;
  durationMins: number;
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeMultiplier: number;
  surgeBonus: number;
  deviceTierAdjustment: number;
  waitingCharge: number;
  tollCharge: number;
  totalCustomerFare: number;
  instantCut: number;
  driverEarning: number;
}

export interface PricingConfigData {
  bike_base_fare: number;
  bike_per_km: number;
  bike_instant_cut: number;
  auto_base_fare: number;
  auto_per_km: number;
  auto_instant_cut: number;
  cab_base_fare: number;
  cab_per_km: number;
  cab_instant_cut: number;
  bike_slab_1_2: number;
  bike_slab_3_5: number;
  bike_slab_6_10: number;
  bike_slab_11_plus: number;
  auto_slab_1_2: number;
  auto_slab_3_5: number;
  auto_slab_6_10: number;
  auto_slab_11_plus: number;
  cab_slab_1_2: number;
  cab_slab_3_5: number;
  cab_slab_6_10: number;
  cab_slab_11_plus: number;
  enable_device_tier_pricing: boolean;
  flagship_markup_percent: number;
  low_battery_markup_percent: number;
}

// In-memory cache for ultra-fast calculations
let cachedConfig: PricingConfigData = {
  bike_base_fare: 30.0,
  bike_per_km: 9.5,
  bike_instant_cut: 2.0,
  auto_base_fare: 45.0,
  auto_per_km: 16.0,
  auto_instant_cut: 3.0,
  cab_base_fare: 60.0,
  cab_per_km: 22.0,
  cab_instant_cut: 5.0,
  bike_slab_1_2: 10.0,
  bike_slab_3_5: 20.0,
  bike_slab_6_10: 35.0,
  bike_slab_11_plus: 45.0,
  auto_slab_1_2: 15.0,
  auto_slab_3_5: 30.0,
  auto_slab_6_10: 50.0,
  auto_slab_11_plus: 65.0,
  cab_slab_1_2: 25.0,
  cab_slab_3_5: 45.0,
  cab_slab_6_10: 70.0,
  cab_slab_11_plus: 90.0,
  enable_device_tier_pricing: true,
  flagship_markup_percent: 5.0,
  low_battery_markup_percent: 3.0,
};

export class PricingService {
  // Sync live configuration from Supabase
  public static async loadConfig(): Promise<PricingConfigData> {
    try {
      const { data } = await supabase.from('pricing_config').select('*').eq('id', 'default').single();
      if (data) {
        cachedConfig = { ...cachedConfig, ...data };
      }
    } catch (err: any) {
      console.warn('[Pricing] Using default pricing cache:', err.message);
    }
    return cachedConfig;
  }

  // 1. Instant Cut Rates (Per-Ride)
  public static getInstantCut(vehicleType: 'bike' | 'auto' | 'cab' | 'parcel'): number {
    switch (vehicleType) {
      case 'bike':
      case 'parcel':
        return cachedConfig.bike_instant_cut; // ₹2 flat
      case 'auto':
        return cachedConfig.auto_instant_cut; // ₹3 flat
      case 'cab':
        return cachedConfig.cab_instant_cut; // ₹5 flat
      default:
        return 2.0;
    }
  }

  // 2. Daily Slab Fee (Raat ko 12 baje Cron Job se)
  public static calculateDailySlabFee(
    vehicleType: 'bike' | 'auto' | 'cab' | 'parcel',
    completedRidesCount: number
  ): number {
    if (completedRidesCount === 0) return 0.0;

    if (vehicleType === 'bike' || vehicleType === 'parcel') {
      if (completedRidesCount >= 1 && completedRidesCount <= 2) return cachedConfig.bike_slab_1_2; // ₹10
      if (completedRidesCount >= 3 && completedRidesCount <= 5) return cachedConfig.bike_slab_3_5; // ₹20
      if (completedRidesCount >= 6 && completedRidesCount <= 10) return cachedConfig.bike_slab_6_10; // ₹35
      return cachedConfig.bike_slab_11_plus; // ₹45 Max limit
    }

    if (vehicleType === 'auto') {
      if (completedRidesCount >= 1 && completedRidesCount <= 2) return cachedConfig.auto_slab_1_2; // ₹15
      if (completedRidesCount >= 3 && completedRidesCount <= 5) return cachedConfig.auto_slab_3_5; // ₹30
      if (completedRidesCount >= 6 && completedRidesCount <= 10) return cachedConfig.auto_slab_6_10; // ₹50
      return cachedConfig.auto_slab_11_plus; // ₹65 Max limit
    }

    if (vehicleType === 'cab') {
      if (completedRidesCount >= 1 && completedRidesCount <= 2) return cachedConfig.cab_slab_1_2; // ₹25
      if (completedRidesCount >= 3 && completedRidesCount <= 5) return cachedConfig.cab_slab_3_5; // ₹45
      if (completedRidesCount >= 6 && completedRidesCount <= 10) return cachedConfig.cab_slab_6_10; // ₹70
      return cachedConfig.cab_slab_11_plus; // ₹90 Max limit
    }

    return 0.0;
  }

  // 3. Customer Fare Calculation with Rapido/Uber Dynamic Engine
  public static calculateCustomerFare(
    vehicleType: 'bike' | 'auto' | 'cab' | 'parcel',
    distanceKm: number,
    durationMins: number,
    surgeMultiplier: number = 1.0,
    waitingMins: number = 0,
    tollCharge: number = 0,
    deviceTier: 'flagship' | 'midrange' | 'budget' = 'midrange',
    batteryLevel?: number
  ): FareBreakdown {
    let baseFare = cachedConfig.bike_base_fare; // ₹30
    let ratePerKm = cachedConfig.bike_per_km; // ₹9.5
    let ratePerMin = 1.0;
    let baseKm = 1.5;

    if (vehicleType === 'auto') {
      baseFare = cachedConfig.auto_base_fare; // ₹45
      ratePerKm = cachedConfig.auto_per_km; // ₹16
      ratePerMin = 1.2;
      baseKm = 1.5;
    } else if (vehicleType === 'cab') {
      baseFare = cachedConfig.cab_base_fare; // ₹60
      ratePerKm = cachedConfig.cab_per_km; // ₹22
      ratePerMin = 1.5;
      baseKm = 2.0;
    } else if (vehicleType === 'parcel') {
      baseFare = 30;
      ratePerKm = 10;
      ratePerMin = 1.0;
      baseKm = 2.0;
    }

    const extraKm = Math.max(0, distanceKm - baseKm);
    const distanceFare = Math.round(extraKm * ratePerKm);
    const timeFare = Math.round(durationMins * ratePerMin);
    const subtotal = baseFare + distanceFare + timeFare;

    // Dynamic Surge Multiplier (1.0x to 1.8x)
    const surgeFactor = Math.max(1.0, surgeMultiplier);
    let totalWithSurge = Math.round(subtotal * surgeFactor);
    const surgeBonus = Math.max(0, totalWithSurge - subtotal);

    // Device-Tier & Urgency Algorithm (Rapido/Uber Smart Pricing)
    let deviceTierAdjustment = 0;
    if (cachedConfig.enable_device_tier_pricing) {
      let markupPercent = 0;
      if (deviceTier === 'flagship') {
        markupPercent += cachedConfig.flagship_markup_percent; // e.g. +5%
      }
      if (batteryLevel !== undefined && batteryLevel < 15) {
        markupPercent += cachedConfig.low_battery_markup_percent; // Urgency index +3%
      }
      deviceTierAdjustment = Math.round(totalWithSurge * (markupPercent / 100));
      totalWithSurge += deviceTierAdjustment;
    }

    // Waiting charge: Free for first 3 minutes, then ₹2/min
    const billableWaitingMins = Math.max(0, waitingMins - 3);
    const waitingCharge = billableWaitingMins * 2.0;

    const totalCustomerFare = totalWithSurge + waitingCharge + tollCharge;
    const instantCut = this.getInstantCut(vehicleType);
    const driverEarning = totalCustomerFare - instantCut;

    return {
      vehicleType,
      distanceKm: Math.round(distanceKm * 10) / 10,
      durationMins,
      baseFare,
      distanceFare,
      timeFare,
      surgeMultiplier: surgeFactor,
      surgeBonus,
      deviceTierAdjustment,
      waitingCharge,
      tollCharge,
      totalCustomerFare,
      instantCut,
      driverEarning,
    };
  }
}
