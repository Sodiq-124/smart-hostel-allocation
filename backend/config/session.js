const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { pool } = require('./database');

const store = new MySQLStore(
  {
    createDatabaseTable: false,      
    schema: {
      tableName: 'sessions',
      columnNames: {
        session_id: 'session_id',
        expires: 'expires',
        data: 'data',
      },
    },
    
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000, 
  },
  pool
);

store.onReady().catch((error) => {
  console.error('  Session store failed to initialise:', error.message);
});

const isProduction = process.env.NODE_ENV === 'production';

const sessionMiddleware = session({
  name: 'hostel.sid',           
  secret: process.env.SESSION_SECRET,
  store,

  resave: false,                  
  saveUninitialized: false,       
  rolling: true,                 

  cookie: {
    httpOnly: true,             
    sameSite: 'lax',              
    secure: isProduction,       
    maxAge: Number(process.env.SESSION_MAX_AGE_MS) || 2 * 60 * 60 * 1000, 
  },
});

module.exports = sessionMiddleware;
