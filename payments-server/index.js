'use strict';

const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');
const {google} = require('googleapis');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = trimSlash(process.env.PUBLIC_BASE_URL || '');
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || '';
const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || 'com.solo.fitness';
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET || '';

const PRODUCTS = Object.freeze({
  essence_500:   {currency: 'essencia', amount: 500,   bonus: 0,    title: '500 Essências',   price: 4.90},
  essence_1200:  {currency: 'essencia', amount: 1200,  bonus: 100,  title: '1.200 Essências', price: 9.90},
  essence_2800:  {currency: 'essencia', amount: 2800,  bonus: 350,  title: '2.800 Essências', price: 19.90},
  essence_6500:  {currency: 'essencia', amount: 6500,  bonus: 1000, title: '6.500 Essências', price: 49.90},
  coins_1000:    {currency: 'coins',     amount: 1000,  bonus: 0,    title: '1.000 Coins',     price: 2.90},
  coins_2500:    {currency: 'coins',     amount: 2500,  bonus: 250,  title: '2.500 Coins',     price: 6.90},
  coins_6000:    {currency: 'coins',     amount: 6000,  bonus: 900,  title: '6.000 Coins',     price: 14.90},
  coins_15000:   {currency: 'coins',     amount: 15000, bonus: 3000, title: '15.000 Coins',    price: 34.90}
});

initializeFirebase();
const db = admin.database();
const app = express();
app.use(express.json({limit: '256kb'}));
app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({ok: true, service: 'solo-fitness-payments'});
});

app.post('/api/mercado-pago/preference', requireFirebaseUser, async (req, res) => {
  try {
    requireSecret(MP_ACCESS_TOKEN, 'MERCADO_PAGO_ACCESS_TOKEN');
    requirePublicBaseUrl();
    const sku = safe(req.body && req.body.sku);
    const product = requireProduct(sku);
    const uid = req.user.uid;
    const orderId = `mp_${Date.now()}_${randomId(12)}`;

    const preferenceBody = {
      items: [{
        id: sku,
        title: product.title,
        description: `Crédito digital para Solo Fitness (${sku})`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: product.price
      }],
      external_reference: orderId,
      notification_url: `${PUBLIC_BASE_URL}/api/mercado-pago/webhook`,
      back_urls: {
        success: `${PUBLIC_BASE_URL}/payments/return?status=success`,
        pending: `${PUBLIC_BASE_URL}/payments/return?status=pending`,
        failure: `${PUBLIC_BASE_URL}/payments/return?status=failure`
      },
      auto_return: 'approved',
      metadata: {uid, sku, order_id: orderId}
    };

    const mpResponse = await mercadoPagoRequest('/checkout/preferences', {
      method: 'POST',
      headers: {'X-Idempotency-Key': orderId},
      body: JSON.stringify(preferenceBody)
    });

    await db.ref(`shop/orders/mercado_pago/${orderId}`).set({
      provider: 'mercado_pago',
      status: 'pending',
      uid,
      sku,
      expected_amount: product.price,
      currency_id: 'BRL',
      preference_id: safe(mpResponse.id),
      created_at: admin.database.ServerValue.TIMESTAMP
    });

    res.json({
      order_id: orderId,
      preference_id: mpResponse.id,
      init_point: mpResponse.init_point,
      sandbox_init_point: mpResponse.sandbox_init_point
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/mercado-pago/webhook', async (req, res) => {
  // A assinatura é obrigatória em produção quando o segredo foi configurado.
  if (MP_WEBHOOK_SECRET && !validateMercadoPagoWebhook(req)) {
    return res.status(401).json({received: false, error: 'invalid_signature'});
  }

  // Responda rápido ao Mercado Pago. O processamento continua idempotente.
  res.status(200).json({received: true});
  try {
    requireSecret(MP_ACCESS_TOKEN, 'MERCADO_PAGO_ACCESS_TOKEN');
    const paymentId = extractPaymentId(req);
    if (!paymentId) return;

    const payment = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET'
    });
    if (safe(payment.status) !== 'approved') return;

    const orderId = safe(payment.external_reference);
    if (!orderId) return;
    const orderSnap = await db.ref(`shop/orders/mercado_pago/${orderId}`).get();
    if (!orderSnap.exists()) return;
    const order = orderSnap.val() || {};
    const product = requireProduct(order.sku);

    const paid = Number(payment.transaction_amount || 0);
    const currency = safe(payment.currency_id);
    if (currency !== 'BRL' || Math.abs(paid - Number(product.price)) > 0.001) {
      await db.ref(`shop/orders/mercado_pago/${orderId}`).update({
        status: 'amount_mismatch',
        payment_id: String(paymentId),
        received_amount: paid,
        updated_at: admin.database.ServerValue.TIMESTAMP
      });
      return;
    }

    await creditOrderOnce({
      provider: 'mercado_pago',
      orderPath: `shop/orders/mercado_pago/${orderId}`,
      uniqueId: orderId,
      uid: safe(order.uid),
      sku: safe(order.sku),
      product,
      providerPaymentId: String(paymentId)
    });
  } catch (error) {
    console.error('Mercado Pago webhook:', error);
  }
});

app.get('/payments/return', (req, res) => {
  const status = safe(req.query.status || 'pending');
  const appUrl = `solofitness://payment-return?status=${encodeURIComponent(status)}`;
  res.type('html').send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Solo Fitness</title><body style="font-family:sans-serif;background:#050711;color:#eef6ff;padding:32px"><h1>Solo Fitness</h1><p>Status: <b>${escapeHtml(status)}</b></p><p>O saldo é creditado somente após a confirmação do pagamento.</p><p><a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:14px 20px;background:#18d7ff;color:#02101c;text-decoration:none;border-radius:10px;font-weight:bold">VOLTAR AO APP</a></p></body></html>`);
});

app.post('/api/google-play/verify', requireFirebaseUser, async (req, res) => {
  try {
    const uid = req.user.uid;
    const sku = safe(req.body && req.body.sku);
    const token = safe(req.body && req.body.purchase_token);
    const requestedPackage = safe(req.body && req.body.package_name);
    const product = requireProduct(sku);
    if (!token) throw httpError(400, 'purchase_token ausente.');
    if (requestedPackage && requestedPackage !== PACKAGE_NAME) {
      throw httpError(400, 'Pacote Android inválido.');
    }

    const androidPublisher = await androidPublisherClient();
    const response = await androidPublisher.purchases.products.get({
      packageName: PACKAGE_NAME,
      productId: sku,
      token
    });
    const purchase = response.data || {};
    if (Number(purchase.purchaseState) !== 0) {
      throw httpError(409, 'A compra ainda não está no estado comprado.');
    }
    if (purchase.obfuscatedExternalAccountId) {
      const expectedAccount = sha256(uid);
      if (purchase.obfuscatedExternalAccountId !== expectedAccount) {
        throw httpError(403, 'A compra pertence a outra conta.');
      }
    }

    const tokenHash = sha256(token);
    const result = await creditOrderOnce({
      provider: 'google_play',
      orderPath: `shop/orders/google_play/${tokenHash}`,
      uniqueId: tokenHash,
      uid,
      sku,
      product,
      providerPaymentId: safe(purchase.orderId),
      extraOrderData: {
        purchase_token_hash: tokenHash,
        purchase_time_millis: Number(purchase.purchaseTimeMillis || 0),
        acknowledgement_state: Number(purchase.acknowledgementState || 0),
        consumption_state: Number(purchase.consumptionState || 0)
      }
    });

    res.json({
      approved: true,
      credited: result.credited,
      already_credited: !result.credited,
      status: 'approved',
      message: result.credited ? 'Saldo creditado.' : 'Compra já processada.'
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.use((error, _req, res, _next) => sendError(res, error));
app.listen(PORT, () => console.log(`Solo Fitness payments on :${PORT}`));

async function creditOrderOnce({provider, orderPath, uniqueId, uid, sku, product,
  providerPaymentId, extraOrderData = {}}) {
  if (!uid) throw httpError(400, 'UID ausente no pedido.');
  const creditAttemptId = randomId(12);
  const result = await db.ref('/').transaction(root => {
    root = root || {};
    const existing = getPath(root, orderPath) || {};
    if (existing.credited === true || existing.status === 'approved') return root;

    const playerPath = `player/${uid}`;
    const player = getPath(root, playerPath);
    if (!player || typeof player !== 'object') return;

    const total = Number(product.amount) + Number(product.bonus);
    player[product.currency] = Math.max(0, Number(player[product.currency] || 0)) + total;
    player.payments = player.payments || {};
    player.payments[provider] = player.payments[provider] || {};
    player.payments[provider][uniqueId] = {
      sku,
      amount: product.amount,
      bonus: product.bonus,
      total,
      credited_at: Date.now()
    };
    setPath(root, playerPath, player);

    setPath(root, orderPath, Object.assign({}, existing, extraOrderData, {
      provider,
      uid,
      sku,
      status: 'approved',
      credited: true,
      amount: product.amount,
      bonus: product.bonus,
      total,
      provider_payment_id: providerPaymentId || '',
      credit_attempt_id: creditAttemptId,
      approved_at: Date.now(),
      updated_at: Date.now()
    }));
    return root;
  }, undefined, false);

  if (!result.committed) throw httpError(409, 'Não foi possível creditar o jogador.');
  const finalOrder = getPath(result.snapshot.val() || {}, orderPath) || {};
  return {credited: safe(finalOrder.credit_attempt_id) === creditAttemptId};
}

async function requireFirebaseUser(req, _res, next) {
  try {
    const authorization = safe(req.headers.authorization);
    if (!authorization.startsWith('Bearer ')) throw httpError(401, 'Token Firebase ausente.');
    const token = authorization.substring(7).trim();
    req.user = await admin.auth().verifyIdToken(token, true);
    next();
  } catch (error) {
    next(error.status ? error : httpError(401, 'Token Firebase inválido.'));
  }
}

async function mercadoPagoRequest(path, options) {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    headers: Object.assign({}, options && options.headers, {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    })
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!response.ok) {
    const message = safe(json.message || json.error || `Mercado Pago HTTP ${response.status}`);
    throw httpError(502, message);
  }
  return json;
}

async function androidPublisherClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher']
  });
  return google.androidpublisher({version: 'v3', auth: await auth.getClient()});
}

function initializeFirebase() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credential = raw
    ? admin.credential.cert(JSON.parse(raw))
    : admin.credential.applicationDefault();
  admin.initializeApp({credential, databaseURL: DATABASE_URL});
}

function requireProduct(sku) {
  const product = PRODUCTS[sku];
  if (!product) throw httpError(400, `SKU desconhecido: ${sku || '(vazio)'}`);
  return product;
}


function validateMercadoPagoWebhook(req) {
  try {
    const signature = safe(req.headers['x-signature']);
    const requestId = safe(req.headers['x-request-id']);
    const dataId = safe(
      req.query['data.id'] ||
      (req.body && req.body.data && req.body.data.id) ||
      (req.body && req.body.id)
    ).toLowerCase();
    if (!signature || !requestId || !dataId) return false;

    let timestamp = '';
    let receivedHash = '';
    signature.split(',').forEach(part => {
      const separator = part.indexOf('=');
      if (separator <= 0) return;
      const key = part.substring(0, separator).trim();
      const value = part.substring(separator + 1).trim();
      if (key === 'ts') timestamp = value;
      if (key === 'v1') receivedHash = value;
    });
    if (!timestamp || !receivedHash) return false;

    const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
    const expectedHash = crypto.createHmac('sha256', MP_WEBHOOK_SECRET)
      .update(manifest)
      .digest('hex');
    const expected = Buffer.from(expectedHash, 'utf8');
    const received = Buffer.from(receivedHash, 'utf8');
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  } catch (_error) {
    return false;
  }
}

function extractPaymentId(req) {
  return safe(
    (req.body && req.body.data && req.body.data.id) ||
    (req.body && req.body.id) ||
    req.query['data.id'] || req.query.id
  );
}

function getPath(root, path) {
  return path.split('/').filter(Boolean).reduce((node, key) =>
    node && typeof node === 'object' ? node[key] : undefined, root);
}

function setPath(root, path, value) {
  const parts = path.split('/').filter(Boolean);
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] = node[parts[i]] && typeof node[parts[i]] === 'object'
      ? node[parts[i]] : {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function requirePublicBaseUrl() {
  if (!PUBLIC_BASE_URL.startsWith('https://')) {
    throw httpError(500, 'PUBLIC_BASE_URL precisa usar HTTPS.');
  }
}

function requireSecret(value, name) {
  if (!value) throw httpError(500, `${name} não configurado no servidor.`);
}

function sendError(res, error) {
  const status = Number(error && error.status) || 500;
  const message = safe(error && error.message) || 'Erro interno.';
  if (status >= 500) console.error(error);
  res.status(status).json({error: true, message});
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(safe(value)).digest('hex');
}

function randomId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function trimSlash(value) {
  return safe(value).replace(/\/+$/, '');
}

function safe(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function escapeHtml(value) {
  return safe(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
