const mongoose = require('mongoose');
const PageSchema = new mongoose.Schema({
  user_id: String,
  page_id: { type: String, unique: true },
  page_name: String,
  page_access_token: String,
  webhook_subscribed: { type: Boolean, default: false },
  is_active: { type: Boolean, default: true }
});
module.exports = mongoose.model('MetaPage', PageSchema);