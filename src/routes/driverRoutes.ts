import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';

const router = Router();

// 1. Get Driver Profile & KYC Status
router.get('/:driverId/status', async (req: Request, res: Response) => {
  const { driverId } = req.params;

  const { data: driver, error } = await supabase
    .from('drivers')
    .select('*, users(full_name, phone, rating)')
    .eq('id', driverId)
    .single();

  if (error || !driver) {
    return res.status(404).json({ error: 'Driver profile not found' });
  }

  const { data: docs } = await supabase
    .from('driver_documents')
    .select('*')
    .eq('driver_id', driverId);

  return res.json({
    driver,
    documents: docs || []
  });
});

// 1.1 Get Onboarding Progress (Auto-Resumes from exact incomplete step)
router.get('/:driverId/onboarding-progress', async (req: Request, res: Response) => {
  const { driverId } = req.params;

  const { data: driver, error } = await supabase
    .from('drivers')
    .select('id, onboarding_step, is_onboarding_completed, kyc_status, rejection_reason, selfie_url, dl_front_url, dl_back_url, dl_number, rc_front_url, rc_back_url, rc_number, vehicle_photo_url, vehicle_number, vehicle_model, aadhaar_front_url, aadhaar_back_url, aadhaar_number, payout_upi_id, users(full_name, phone)')
    .eq('id', driverId)
    .single();

  if (error || !driver) {
    return res.status(404).json({ error: 'Driver not found' });
  }

  return res.json({
    onboardingStep: driver.onboarding_step || 1,
    isCompleted: driver.is_onboarding_completed || false,
    kycStatus: driver.kyc_status,
    rejectionReason: driver.rejection_reason,
    savedData: driver
  });
});

// 1.2 Save Onboarding Step (Instant Cloud Save per step)
router.post('/:driverId/save-onboarding-step', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { step, stepData } = req.body; // step: 1..5

  const updatePayload: any = {
    onboarding_step: Math.max(step + 1, 1),
    ...stepData
  };

  // If final step (Step 5 - Bank/UPI or complete)
  if (step >= 4) {
    updatePayload.is_onboarding_completed = true;
    updatePayload.kyc_status = 'pending';
  }

  const { data: updated, error } = await supabase
    .from('drivers')
    .update(updatePayload)
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.json({
    success: true,
    message: `Step ${step} saved successfully to cloud!`,
    currentStep: updated.onboarding_step,
    isCompleted: updated.is_onboarding_completed,
    driver: updated
  });
});

// 2. Upload Document Record
router.post('/:driverId/documents', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { docType, fileUrl } = req.body;

  if (!docType || !fileUrl) {
    return res.status(400).json({ error: 'docType and fileUrl are required' });
  }

  const { data: doc, error } = await supabase
    .from('driver_documents')
    .insert({
      driver_id: driverId,
      doc_type: docType,
      file_url: fileUrl,
      status: 'pending'
    })
    .select('*')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({ success: true, document: doc });
});

// 3. Toggle Online/Offline Duty (with Helmet Check)
router.post('/:driverId/toggle-duty', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { isOnline, hasSpareHelmet } = req.body;

  const { data: driver } = await supabase.from('drivers').select('kyc_status').eq('id', driverId).single();

  if (isOnline && driver?.kyc_status !== 'approved') {
    return res.status(403).json({
      error: 'KYC Verification Pending. Admin review hone ke baad hi aap online ja sakte hain.'
    });
  }

  const { data: updated, error } = await supabase
    .from('drivers')
    .update({
      is_online: isOnline,
      has_spare_helmet: hasSpareHelmet ?? true,
      last_location_updated_at: new Date().toISOString()
    })
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ success: true, driver: updated });
});

// 4. Toggle Home Route Filter ("Going Home")
router.post('/:driverId/home-route', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { active, homeAddress, homeLat, homeLng } = req.body;

  const { data: updated, error } = await supabase
    .from('drivers')
    .update({
      home_route_active: active,
      home_route_address: homeAddress,
      home_route_lat: homeLat,
      home_route_lng: homeLng
    })
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ success: true, driver: updated });
});

// 5. Driver Daily Earnings & Slab Breakdown
router.get('/:driverId/earnings', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const today = new Date().toISOString().split('T')[0];

  // Today's slab
  const { data: slab } = await supabase
    .from('driver_daily_slabs')
    .select('*')
    .eq('driver_id', driverId)
    .eq('slab_date', today)
    .single();

  // Completed rides today
  const { data: rides } = await supabase
    .from('rides')
    .select('id, ride_code, pickup_address, drop_address, total_fare, driver_earning, surge_bonus, platform_fee, completed_at')
    .eq('driver_id', driverId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });

  const { data: driver } = await supabase
    .from('drivers')
    .select('wallet_balance, total_earnings')
    .eq('id', driverId)
    .single();

  return res.json({
    walletBalance: driver?.wallet_balance || 0,
    totalEarnings: driver?.total_earnings || 0,
    todayRidesCount: slab?.completed_rides_count || 0,
    todayInstantCuts: slab?.instant_cut_total || 0,
    estimatedDailySlabFee: slab?.daily_slab_fee || 0,
    rides: rides || []
  });
});

// 6. Request Instant UPI Payout
router.post('/:driverId/withdraw', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { amount, upiId } = req.body;

  if (!amount || amount < 50 || !upiId) {
    return res.status(400).json({ error: 'Minimum withdrawal ₹50 and valid UPI ID required.' });
  }

  const { data: driver } = await supabase.from('drivers').select('wallet_balance').eq('id', driverId).single();
  const currentBal = Number(driver?.wallet_balance || 0);

  if (currentBal < amount) {
    return res.status(400).json({ error: 'Insufficient wallet balance.' });
  }

  const newBal = currentBal - amount;
  await supabase.from('drivers').update({ wallet_balance: newBal }).eq('id', driverId);

  await supabase.from('wallet_transactions').insert({
    user_id: driverId,
    amount: amount,
    transaction_type: 'payout_withdrawal',
    description: `Instant UPI Payout to ${upiId}`,
    balance_after: newBal
  });

  return res.json({
    success: true,
    message: `₹${amount} successfully transferred to ${upiId}`,
    remainingBalance: newBal
  });
});

export default router;
