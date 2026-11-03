

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { testConnection } = require('../config/database');

const router = express.Router();


router.get(
  '/health',
  asyncHandler(async (req, res) => {
    let database = 'disconnected';
    let databaseError = null;

    try {
      await testConnection();
      database = 'connected';
    } catch (error) {
      databaseError = error.code || error.message;
    }

    res.json({
      success: true,
      message: 'LASU Smart Hostel Allocation System API is running.',
      data: {
        server: 'up',
        database,
        databaseError,
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
      },
    });
  })
);

router.use('/auth', require('./auth'));
router.use('/students', require('./students'));
router.use('/applications', require('./applications'));
router.use('/complaints', require('./complaints'));
router.use('/admin/applications', require('./adminApplications'));
router.use('/admin/rooms', require('./adminRooms'));
router.use('/admin/complaints', require('./adminComplaints'));
router.use('/admin/sessions', require('./adminSessions'));
router.use('/payments', require('./payments'));
router.use('/admin/misc-charges', require('./adminMiscCharges'));
router.use('/renewals', require('./renewals'));
router.use('/admin/renewals', require('./adminRenewals'));
router.use('/fees', require('./fees'));
router.use('/admin/fees', require('./adminFees'));











module.exports = router;
