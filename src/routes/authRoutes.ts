import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'BigVora#SecretKey';

// 1. Send OTP (Simulated / Live SMS Gateway)
router.post('/send-otp', async (req: Request, res: Response) => {
  const { phone, role } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  // Generate 4-digit OTP (e.g. 1234 in dev or SMS gateway in prod)
  const otp = '1234';
  console.log(`[AUTH] Sent OTP ${otp} to ${phone} (Role: ${role})`);

  return res.json({
    success: true,
    message: `OTP sent successfully to ${phone}`,
    devOtp: otp
  });
});

// 2. Verify OTP & Auto Login / Register
router.post('/verify-otp', async (req: Request, res: Response) => {
  const { phone, otp, role, fullName, vehicleType, vehicleModel, vehicleNumber } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required.' });
  }

  // Check existing user in Supabase
  let { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();

  if (!user) {
    // Create new User
    const { data: newUser, error: createErr } = await supabase
      .from('users')
      .insert({
        phone,
        full_name: fullName || (role === 'driver' ? 'New Captain' : 'New Rider'),
        role: role || 'customer'
      })
      .select('*')
      .single();

    if (createErr || !newUser) {
      return res.status(500).json({ error: 'Failed to create user account.' });
    }
    user = newUser;

    // Create role-specific profile
    if (role === 'driver') {
      await supabase.from('drivers').insert({
        id: user.id,
        vehicle_type: vehicleType || 'bike',
        vehicle_model: vehicleModel || 'Standard',
        vehicle_number: vehicleNumber || `DL-${Math.floor(10 + Math.random() * 89)}-${Math.floor(1000 + Math.random() * 8999)}`,
        kyc_status: 'pending'
      });
    } else {
      await supabase.from('customers').insert({
        id: user.id,
        wallet_balance: 50.00 // Welcome bonus ₹50 in wallet
      });
    }
  }

  // Fetch full details
  let roleDetails = null;
  if (user.role === 'driver') {
    const { data: drv } = await supabase.from('drivers').select('*').eq('id', user.id).single();
    roleDetails = drv;
  } else {
    const { data: cust } = await supabase.from('customers').select('*').eq('id', user.id).single();
    roleDetails = cust;
  }

  // Generate JWT Token
  const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '90d' });

  return res.json({
    success: true,
    token,
    user,
    roleDetails
  });
});

export default router;
