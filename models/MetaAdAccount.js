const mongoose = require('mongoose');
const AdAccountSchema = new mongoose.Schema({
  user_id: String,
  ad_account_id: { type: String, unique: true },
  ad_account_name: String,
  user_access_token: String,
  is_active: { type: Boolean, default: true },
  last_error: String,
  last_error_time: Date
});
module.exports = mongoose.model('MetaAdAccount', AdAccountSchema);