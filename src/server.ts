import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from 'socket.io';

import authRoutes from './routes/authRoutes';
import driverRoutes from './routes/driverRoutes';
import customerRoutes from './routes/customerRoutes';
import adminRoutes from './routes/adminRoutes';
import zoneRoutes from './routes/zoneRoutes';
import { setupSocketHandlers } from './sockets/socketHandler';
import { startCronJobs } from './services/cronService';

dotenv.config();

const app = express();
const server = http.createServer(app);

// Cross-Origin Resource Sharing (CORS)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Initialize Realtime Socket.IO
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Setup Sockets
setupSocketHandlers(io);

// Mount API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/driver', driverRoutes);
app.use('/api/v1/customer', customerRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/zones', zoneRoutes);

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'BigVora Ride Production Backend & Realtime Engine',
    region: 'Delhi-NCR & Gurugram',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 BigVora Ride Production Server running on PORT ${PORT}`);
  console.log(`📍 Geofence Active: Delhi-NCR & Gurugram`);
  console.log(`⚡ Realtime Socket.IO: Ready for Live Driver GPS & Dispatch`);
  console.log(`====================================================`);

  // Start Background Cron Jobs (Surge updates & Midnight Slabs)
  startCronJobs();
});
