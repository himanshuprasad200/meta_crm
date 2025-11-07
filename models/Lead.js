const mongoose = require("mongoose");

const leadSchema = new mongoose.Schema({
  user_id: String,
  page_id: String,
  leadId: { type: String, unique: true, required: true },
  created_time: String,
  form_id: String,
  field_data: Array,
  campaign_id: String,
  name: String,
  email: String,
  phone: String,
});

module.exports = mongoose.model("Lead", leadSchema);