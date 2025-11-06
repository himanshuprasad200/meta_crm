const mongoose = require('mongoose');
const LeadSchema = new mongoose.Schema({
  lead_id: { type: String, unique: true, required: true },
  user_id: String,
  page_id: String,
  form_id: String,
  campaign_id: String,
  ad_id: String,
  name: String,
  email: String,
  phone: String,
  custom_fields: Object,
  created_time: Date,
  source: { type: String, enum: ['webhook', 'sync', 'api'] },
  data_source: String,
  processed: { type: Boolean, default: false }
});
module.exports = mongoose.model('Lead', LeadSchema);