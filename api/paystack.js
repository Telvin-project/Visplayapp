const crypto = require('crypto');
const admin = require('firebase-admin');

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(body));
}

function firebaseAdmin() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON in Vercel environment variables.');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch (_) { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
  const databaseURL = process.env.FIREBASE_DATABASE_URL || 'https://visplay-edf7b-default-rtdb.firebaseio.com';
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL });
  return admin;
}

async function authenticatedUser(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('Please sign in again, then retry.'), { statusCode: 401 });
  const fb = firebaseAdmin();
  try { return await fb.auth().verifyIdToken(match[1]); }
  catch (_) { throw Object.assign(new Error('Your sign-in expired. Sign in again and retry.'), { statusCode: 401 }); }
}

async function paystackRequest(path, payload) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('Missing PAYSTACK_SECRET_KEY in Vercel environment variables.');
  const response = await fetch('https://api.paystack.co' + path, {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  let data;
  try { data = await response.json(); }
  catch (_) { throw new Error('Paystack returned an unreadable response. Please try again.'); }
  if (!response.ok || !data.status) throw new Error(data.message || 'Paystack could not process this request.');
  return data.data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for Paystack requests.' });
  try {
    const user = await authenticatedUser(req);
    const fb = firebaseAdmin();
    const db = fb.database();
    const action = req.body && req.body.action;

    if (action === 'initialize') {
      const amount = Number(req.body.amount);
      if (!Number.isSafeInteger(amount) || amount < 100 || amount > 1000000) {
        return send(res, 400, { error: 'Enter a deposit from ₦100 to ₦1,000,000.' });
      }
      const email = String(user.email || '').trim();
      if (!email || !user.email_verified) {
        return send(res, 400, { error: 'Use a verified email address on your Visplay account before depositing.' });
      }
      const reference = 'visplay_' + crypto.randomUUID().replace(/-/g, '');
      const baseUrl = 'https://' + (req.headers.host || 'visplayapp.vercel.app');
      await db.ref('paystackTransactions/' + reference).set({
        uid: user.uid, email, amountNaira: amount, amountKobo: amount * 100,
        currency: 'NGN', status: 'pending', createdAt: Date.now()
      });
      const result = await paystackRequest('/transaction/initialize', {
        email, amount: amount * 100, currency: 'NGN', reference,
        callback_url: baseUrl + '/?paystack_verify=1'
      });
      return send(res, 200, { authorization_url: result.authorization_url, reference: result.reference });
    }

    if (action === 'verify') {
      const reference = String(req.body.reference || '').trim();
      if (!/^visplay_[a-f0-9]{32}$/.test(reference)) return send(res, 400, { error: 'That payment reference is not valid.' });
      const txRef = db.ref('paystackTransactions/' + reference);
      const txSnap = await txRef.once('value');
      const saved = txSnap.val();
      if (!saved || saved.uid !== user.uid) return send(res, 404, { error: 'We could not find that deposit for your account.' });
      if (saved.status === 'credited') {
        const bal = await db.ref('wallets/' + user.uid + '/balance').once('value');
        return send(res, 200, { balance: Number(bal.val() || 0), alreadyCredited: true });
      }
      const payment = await paystackRequest('/transaction/verify/' + encodeURIComponent(reference));
      if (payment.status !== 'success' || payment.reference !== reference || payment.currency !== 'NGN' || Number(payment.amount) !== Number(saved.amountKobo)) {
        return send(res, 400, { error: 'Paystack has not confirmed this deposit as successful. Your wallet was not credited.' });
      }
      if (String(payment.customer && payment.customer.email || '').toLowerCase() !== String(saved.email).toLowerCase()) {
        return send(res, 400, { error: 'The payment email does not match this deposit. Please contact support.' });
      }
      // Mark the reference as claimed before changing the balance to prevent duplicate callbacks.
      const claim = await txRef.transaction(current => {
        if (!current || current.uid !== user.uid || current.status === 'credited' || current.status === 'processing') return;
        current.status = 'processing';
        current.processingAt = Date.now();
        return current;
      });
      if (!claim.committed) {
        const latest = (await txRef.once('value')).val();
        const bal = await db.ref('wallets/' + user.uid + '/balance').once('value');
        if (latest && latest.status === 'credited') return send(res, 200, { balance: Number(bal.val() || 0), alreadyCredited: true });
        return send(res, 409, { error: 'This deposit is already being processed. Refresh your wallet in a moment.' });
      }
      const walletRef = db.ref('wallets/' + user.uid + '/balance');
      await walletRef.transaction(current => Number(current || 0) + Number(saved.amountNaira));
      const newBalanceSnap = await walletRef.once('value');
      await txRef.update({ status: 'credited', creditedAt: Date.now(), paystackStatus: payment.status });
      return send(res, 200, { balance: Number(newBalanceSnap.val() || 0), alreadyCredited: false });
    }
    return send(res, 400, { error: 'Unknown Paystack action.' });
  } catch (error) {
    console.error('Visplay Paystack API error:', error && error.message ? error.message : error);
    return send(res, error.statusCode || 500, { error: error.message || 'The payment service had a problem. Please try again.' });
  }
};
  
