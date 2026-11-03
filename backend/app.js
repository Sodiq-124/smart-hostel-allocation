

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const apiRoutes = require('./routes');
const notFound = require('./middleware/notFound');
const errorMiddleware = require('./middleware/errorMiddleware');
const csrfGuard = require('./middleware/csrfGuard');
const { parseTrustProxy } = require('./config/security');

const app = express();

// Only when TRUST_PROXY is set on purpose (see config/security.js): lets req.ip and the secure
// session cookie work behind a reverse proxy without trusting spoofable headers by default.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== null) app.set('trust proxy', trustProxy);


const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');


app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        
        
        frameSrc: ["'self'", 'https://checkout.paystack.com'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
      },
    },
    
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  })
);


app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));


// The Paystack webhook signature is an HMAC of the EXACT bytes received, so keep
// the raw body for that one path (and only that path).
app.use(express.json({
  limit: '100kb',
  verify: (req, res, buf) => {
    if (req.originalUrl.split('?')[0] === '/api/payments/webhook') req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));


app.use(require('./config/session'));


app.use(
  express.static(FRONTEND_DIR, {
    extensions: ['html'],   
    index: 'index.html',
  })
);


app.use('/api', csrfGuard);
app.use('/api', apiRoutes);


app.use('/api', notFound);

app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) {
    return res.status(404).sendFile(path.join(FRONTEND_DIR, '404.html'), (err) => {
      if (err) res.status(404).type('txt').send('Page not found.');
    });
  }
  return notFound(req, res, next);
});


app.use(errorMiddleware);

module.exports = app;
