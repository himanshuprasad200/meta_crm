// routes/auth.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const qs = require('qs');
const User = require('../models/User');
const MetaPage = require('../models/MetaPage');
const MetaAdAccount = require('../models/MetaAdAccount');
const { fetchAndSaveCampaigns } = require('../utils/meta');

// GET /api/auth/login?userId=vendor_123
router.get('/login', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send('userId required');

  const params = qs.stringify({
    client_id: process.env.META_APP_ID,
    redirect_uri: `${process.env.BASE_URL}/api/auth/callback`,
    scope: 'pages_show_list,pages_manage_metadata,ads_read,leads_retrieval,pages_manage_ads',
    response_type: 'code',
    state: userId
  }, { encode: false });

  res.redirect(`https://www.facebook.com/v22.0/dialog/oauth?${params}`);
});

// GET /api/auth/callback?code=...&state=vendor_123
router.get('/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.redirect(`/?error=missing_params`);

  try {
    // Exchange token
    const tokenRes = await axios.get('https://graph.facebook.com/v22.0/oauth/access_token', {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: `${process.env.BASE_URL}/api/auth/callback`,
        code
      }
    });
    const longToken = tokenRes.data.access_token;

    // Get Meta user info
    const meRes = await axios.get('https://graph.facebook.com/v22.0/me', {
      params: { access_token: longToken, fields: 'id,name,email' }
    });
    const { id: metaUserId, name, email } = meRes.data;

    // Save or update user
    await User.findOneAndUpdate(
      { user_id: userId },
      { name, email, meta_user_id: metaUserId },
      { upsert: true }
    );

    // Save Pages
    const pagesRes = await axios.get('https://graph.facebook.com/v22.0/me/accounts', {
      params: { access_token: longToken, fields: 'id,name,access_token' }
    });

    for (const p of pagesRes.data.data) {
      await MetaPage.findOneAndUpdate(
        { page_id: p.id },
        { user_id: userId, page_name: p.name, page_access_token: p.access_token, is_active: true },
        { upsert: true }
      );
    }

    // Save Ad Accounts
    const adsRes = await axios.get('https://graph.facebook.com/v22.0/me/adaccounts', {
      params: { access_token: longToken, fields: 'id,name' }
    });

    for (const a of adsRes.data.data) {
      await MetaAdAccount.findOneAndUpdate(
        { ad_account_id: a.id },
        { user_id: userId, ad_account_name: a.name, user_access_token: longToken, is_active: true },
        { upsert: true }
      );
    }

    // Fetch campaigns
    await fetchAndSaveCampaigns(userId);

    res.redirect(`/?success=true&userId=${userId}`);
  } catch (err) {
    console.error('[OAUTH ERROR]', err.message);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;