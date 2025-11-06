// models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  user_id: { type: String, unique: true, required: true }, // e.g., "vendor_123"
  name: String,
  email: String,
  meta_user_id: String, // Facebook user ID
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);