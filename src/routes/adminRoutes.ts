import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';

const router = Router();

// 1. Overall Dashboard Statistics
router.get('/stats', async (req: Request, res: Response) => {
  const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { count: totalDrivers } = await supabase.from('drivers').select('*', { count: 'exact', head: true });
  const { count: onlineDrivers } = await supabase.from('drivers').select('*', { count: 'exact', head: true }).eq('is_online', true);
  const { count: pendingKyc } = await supabase.from('drivers').select('*', { count: 'exact', head: true }).eq('kyc_status', 'pending');
  const { count: totalRides } = await supabase.from('rides').select('*', { count: 'exact', head: true });
  const { count: activeRides } = await supabase.from('rides').select('*', { count: 'exact', head: true }).in('status', ['requested', 'accepted', 'arrived', 'in_progress']);

  const { data: completedRides } = await supabase.from('rides').select('total_fare, platform_fee').eq('status', 'completed');
  const totalRevenue = (completedRides || []).reduce((acc, r) => acc + Number(r.total_fare || 0), 0);
  const platformEarnings = (completedRides || []).reduce((acc, r) => acc + Number(r.platform_fee || 0), 0);

  return res.json({
    totalUsers: totalUsers || 0,
    totalDrivers: totalDrivers || 0,
    onlineDrivers: onlineDrivers || 0,
    pendingKyc: pendingKyc || 0,
    totalRides: totalRides || 0,
    activeRides: activeRides || 0,
    totalRevenue: Math.round(totalRevenue),
    platformEarnings: Math.round(platformEarnings)
  });
});

// 2. Driver Verification Queue & Management
router.get('/drivers', async (req: Request, res: Response) => {
  const { status } = req.query; // pending | approved | rejected | all

  let query = supabase.from('drivers').select('*, users(full_name, phone, created_at)');
  if (status && status !== 'all') {
    query = query.eq('kyc_status', status);
  }

  const { data: drivers, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  return res.json({ drivers: drivers || [] });
});

// 3. Get Single Driver Details with all Uploaded KYC Documents
router.get('/drivers/:driverId', async (req: Request, res: Response) => {
  const { driverId } = req.params;

  const { data: driver } = await supabase.from('drivers').select('*, users(*)').eq('id', driverId).single();
  const { data: documents } = await supabase.from('driver_documents').select('*').eq('driver_id', driverId);

  return res.json({ driver, documents: documents || [] });
});

// 4. Update Driver KYC Status (Approve / Reject / Re-upload)
router.post('/drivers/:driverId/kyc-decision', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { decision, reason } = req.body; // decision: 'approved' | 'rejected' | 'reupload_needed'

  if (!['approved', 'rejected', 'reupload_needed'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision. Must be approved, rejected, or reupload_needed.' });
  }

  const { data: updated, error } = await supabase
    .from('drivers')
    .update({
      kyc_status: decision,
      rejection_reason: reason || null
    })
    .eq('id', driverId)
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.json({
    success: true,
    message: `Driver KYC status updated to ${decision}`,
    driver: updated
  });
});

// 5. 1-KM Micro-Sectors & Manual Surge Override
router.post('/zones/:zoneId/surge-override', async (req: Request, res: Response) => {
  const { zoneId } = req.params;
  const { multiplier, bonusAmount, status } = req.body;

  const { data: updated, error } = await supabase
    .from('zones')
    .update({
      current_surge_multiplier: multiplier || 1.0,
      surge_bonus_amount: bonusAmount || 0,
      zone_status: status || 'green',
      is_red_zone: status === 'red',
      last_surge_calculated_at: new Date().toISOString()
    })
    .eq('id', zoneId)
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ success: true, zone: updated });
});

// 6. Get Live Pricing Configuration (Base fares, Per KM, Instant Cuts, Slabs, Device Tier)
router.get('/pricing-config', async (req: Request, res: Response) => {
  const { data: config, error } = await supabase.from('pricing_config').select('*').eq('id', 'default').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ config });
});

// 7. Update Live Pricing Configuration from Admin Panel
router.put('/pricing-config', async (req: Request, res: Response) => {
  const updates = req.body;
  delete updates.id;
  updates.updated_at = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from('pricing_config')
    .update(updates)
    .eq('id', 'default')
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Reload cache in memory
  const { PricingService } = await import('../services/pricingService');
  await PricingService.loadConfig();

  return res.json({
    success: true,
    message: 'Pricing and slab rules updated successfully!',
    config: updated
  });
});

// 8. Driver App Promotional Banner Management
let driverBanner = {
  imageUrl: 'https://images.unsplash.com/photo-1558981403-c5f9899a28bc?auto=format&fit=crop&w=800&q=80',
  title: 'Earn More with BigVora Captain',
  subtitle: 'Zero commission on your first 15 rides this week! Drive safe.',
  actionText: 'Explore Perks'
};

router.get('/banner', (req: Request, res: Response) => {
  return res.json({ banner: driverBanner });
});

router.post('/banner', (req: Request, res: Response) => {
  const { imageUrl, title, subtitle, actionText } = req.body;
  if (imageUrl) driverBanner.imageUrl = imageUrl;
  if (title) driverBanner.title = title;
  if (subtitle) driverBanner.subtitle = subtitle;
  if (actionText) driverBanner.actionText = actionText;
  return res.json({ success: true, banner: driverBanner });
});

export default router;
