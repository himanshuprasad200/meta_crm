// utils/meta.js
const axios = require('axios');  // ADD THIS LINE
const MetaCampaign = require('../models/MetaCampaign');
const MetaAdAccount = require('../models/MetaAdAccount');

exports.fetchAndSaveCampaigns = async (userId) => {
  const accounts = await MetaAdAccount.find({ user_id: userId, is_active: true });

  for (const acc of accounts) {
    try {
      const res = await axios.get(`https://graph.facebook.com/v22.0/${acc.ad_account_id}/campaigns`, {
        params: {
          access_token: acc.user_access_token,
          fields: 'id,name,status,objective',
          limit: 100
        }
      });

      for (const c of res.data.data) {
        await MetaCampaign.findOneAndUpdate(
          { campaign_id: c.id },
          {
            user_id: userId,
            ad_account_id: acc.ad_account_id,
            ad_account_name: acc.ad_account_name,
            campaign_id: c.id,
            name: c.name,
            status: c.status,
            objective: c.objective
          },
          { upsert: true }
        );
      }
      console.log(`[CAMPAIGNS] Saved ${res.data.data.length} campaigns for ${acc.ad_account_name}`);
    } catch (err) {
      console.error(`[CAMPAIGNS] Failed for ${userId}:`, err.response?.data?.error?.message || err.message);
    }
  }
};

// handleLead function (already there)
exports.handleLead = async (value, page) => {
  const leadId = value.leadgen_id;
  if (!leadId) return;

  const existing = await Lead.findOne({ lead_id: leadId });
  if (existing) return;

  try {
    const leadRes = await axios.get(`https://graph.facebook.com/v22.0/${leadId}`, {
      params: {
        access_token: page.page_access_token,
        fields: 'id,created_time,field_data,campaign_id,ad_id,form_id'
      }
    });

    const lead = leadRes.data;
    const fields = {};
    lead.field_data.forEach(f => {
      fields[f.name.toUpperCase()] = f.values?.[0] || '';
    });

    const leadData = {
      user_id: page.user_id,
      page_id: page.page_id,
      lead_id: lead.id,
      form_id: lead.form_id,
      campaign_id: lead.campaign_id || null,
      ad_id: lead.ad_id || null,
      name: fields.FULL_NAME || fields.EMAIL || 'Unknown',
      email: fields.EMAIL || '',
      phone: fields.PHONE_NUMBER || '',
      custom_fields: fields,
      created_time: new Date(lead.created_time),
      source: 'realtime_webhook',
      data_source: 'meta_webhook_realtime'
    };

    const saved = await Lead.create(leadData);

    if (leadData.campaign_id) {
      await MetaCampaign.updateOne(
        { campaign_id: leadData.campaign_id },
        { $inc: { leads_count: 1 } }
      );
    }

    global.send?.(page.user_id, 'new_lead', {
      ...saved.toObject(),
      _id: saved._id.toString()
    });

    console.log(`[WEBHOOK] Saved real-time lead: ${leadData.name || leadId}`);
  } catch (err) {
    console.error(`[WEBHOOK] Failed to fetch/process lead ${leadId}:`, err.message);
  }
};