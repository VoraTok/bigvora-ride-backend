import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { DELHI_NCR_BOUNDARY } from '../services/geofenceService';

const router = Router();

// 1. Get Delhi-NCR Outer Boundary & 1-KM Micro-Sectors
router.get('/', async (req: Request, res: Response) => {
  const { data: zones, error } = await supabase
    .from('zones')
    .select('*')
    .order('name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  return res.json({
    boundary: {
      type: 'Polygon',
      coordinates: [DELHI_NCR_BOUNDARY]
    },
    zones: zones || []
  });
});

export default router;
