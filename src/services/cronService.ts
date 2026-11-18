import cron from 'node-cron';
import { supabase } from '../config/supabase';
import { GeofenceService } from './geofenceService';
import { PricingService } from './pricingService';

export const startCronJobs = () => {
  // 1. Dynamic Surge Recalculation every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await GeofenceService.recalculateSurgeGrids();
    } catch (err: any) {
      console.error('[Cron] Error updating dynamic surge grids:', err.message);
    }
  });

  // 2. Midnight Daily Slab Fee Settlement (Runs at 00:01 AM every night)
  cron.schedule('1 0 * * *', async () => {
    console.log('[Cron] Running Midnight Driver Daily Slab Settlement...');

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayDate = yesterday.toISOString().split('T')[0];

    const { data: unsettledSlabs } = await supabase
      .from('driver_daily_slabs')
      .select('*')
      .eq('slab_date', yesterdayDate)
      .eq('is_settled', false);

    if (!unsettledSlabs || unsettledSlabs.length === 0) {
      console.log('[Cron] No unsettled slabs for yesterday.');
      return;
    }

    for (const slab of unsettledSlabs) {
      const slabFee = PricingService.calculateDailySlabFee(slab.vehicle_type, slab.completed_rides_count);

      // Deduct from driver wallet
      const { data: driver } = await supabase.from('drivers').select('wallet_balance').eq('id', slab.driver_id).single();
      const currentBal = Number(driver?.wallet_balance || 0);
      const newBal = currentBal - slabFee;

      await supabase
        .from('drivers')
        .update({ wallet_balance: newBal })
        .eq('id', slab.driver_id);

      // Record transaction
      if (slabFee > 0) {
        await supabase.from('wallet_transactions').insert({
          user_id: slab.driver_id,
          amount: slabFee,
          transaction_type: 'daily_slab_fee',
          description: `Daily Slab Fee for ${slab.completed_rides_count} rides (${slab.vehicle_type})`,
          balance_after: newBal
        });
      }

      // Mark slab settled
      await supabase
        .from('driver_daily_slabs')
        .update({
          daily_slab_fee: slabFee,
          is_settled: true,
          settled_at: new Date().toISOString()
        })
        .eq('id', slab.id);

      console.log(`[Cron] Settled driver ${slab.driver_id}: ${slab.completed_rides_count} rides => ₹${slabFee} slab fee.`);
    }
  });

  console.log('[Cron] Background schedules initialized (Surge 30s + Midnight Slab 00:01 AM).');
};
