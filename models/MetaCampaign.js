// models/MetaCampaign.js
const mongoose = require('mongoose');

const MetaCampaignSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  ad_account_id: { type: String, required: true },
  ad_account_name: String,
  campaign_id: { type: String, unique: true, required: true },
  name: String,
  status: String,
  objective: String,
  spend: { type: Number, default: 0 },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  leads_count: { type: Number, default: 0 },
  last_updated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('MetaCampaign', MetaCampaignSchema);