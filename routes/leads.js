// routes/leads.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const Lead = require("../models/Lead");
const MetaPage = require("../models/MetaPage");
const MetaCampaign = require("../models/MetaCampaign");
const { Parser } = require("json2csv");

// === GET /api/leads/campaigns?userId=demo
router.get("/campaigns", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });

  console.log(`[LEADS] Fetching campaigns for ${userId}`);
  try {
    const campaigns = await MetaCampaign.find({ user_id: userId })
      .select("campaign_id name status objective leads_count spend")
      .sort({ name: 1 })
      .lean();

    console.log(`[LEADS] Found ${campaigns.length} campaigns`);
    res.json(campaigns);
  } catch (err) {
    console.error(`[LEADS] DB error:`, err.message);
    res.status(500).json({ error: "Failed" });
  }
});

// === POST /api/leads/sync/:campaignId
router.post("/sync/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ error: "userId required" });

  const result = await syncSingleCampaign(userId, campaignId);
  res.json(result);
});

// === POST /api/leads/sync-many
router.post("/sync-many", async (req, res) => {
  const { userId, campaignIds } = req.body;

  if (!userId || !Array.isArray(campaignIds) || campaignIds.length === 0) {
    return res.status(400).json({ error: "userId and campaignIds[] required" });
  }

  console.log(`[SYNC-MANY] Starting sync for ${campaignIds.length} campaigns | User: ${userId}`);

  let totalSynced = 0;
  let totalFetched = 0;

  for (const campaignId of campaignIds) {
    const result = await syncSingleCampaign(userId, campaignId);
    totalSynced += result.synced;
    totalFetched += result.fetched;
  }

  console.log(`[SYNC-MANY] DONE → ${totalSynced} saved | ${totalFetched} fetched`);
  res.json({ totalSynced, totalFetched, campaignIds });
});

// === CORE SYNC FUNCTION (reusable)
async function syncSingleCampaign(userId, campaignId) {
  let synced = 0;
  let fetched = 0;

  console.log(`\n[SYNC] Campaign: ${campaignId} | User: ${userId}`);

  try {
    const campaign = await MetaCampaign.findOne({ campaign_id: campaignId, user_id: userId }).lean();
    if (!campaign) {
      console.log(`[SYNC] Campaign NOT found → skipping`);
      return { synced: 0, fetched: 0, campaign: null };
    }
    console.log(`[SYNC] Campaign: "${campaign.name}"`);

    const pages = await MetaPage.find({ user_id: userId, is_active: true }).lean();
    if (!pages.length) return { synced: 0, fetched: 0, campaign: campaign.name };

    for (const page of pages) {
      console.log(`[SYNC] Page: ${page.page_name}`);

      let forms = [];
      try {
        const { data } = await axios.get(
          `https://graph.facebook.com/v22.0/${page.page_id}/leadgen_forms`,
          { params: { access_token: page.page_access_token, fields: "id,name" }, timeout: 12000 }
        );
        forms = data.data || [];
        console.log(`[SYNC] ${forms.length} forms found`);
      } catch (e) {
        console.error(`[SYNC] Forms error:`, e.response?.data?.error?.message || e.message);
        continue;
      }

      for (const form of forms) {
        console.log(`[SYNC] Form: "${form.name}" (ID: ${form.id})`);
        let after = null;
        let formSaved = 0;

        do {
          let batch;
          try {
            console.log(`[SYNC] Fetching batch (after: ${after || "start"})`);
            const { data } = await axios.get(
              `https://graph.facebook.com/v22.0/${form.id}/leads`,
              {
                params: {
                  access_token: page.page_access_token,
                  fields: "id,created_time,field_data,campaign_id,form_id",
                  limit: 100,
                  after,
                },
                timeout: 15000,
              }
            );
            batch = data;
            const leads = batch.data || [];
            fetched += leads.length;

            if (leads.length > 0) {
              console.log(`[DEBUG] Sample lead:`, JSON.stringify(leads[0], null, 2));
            }

            for (const lead of leads) {
              const leadCampaignId = lead.campaign_id?.toString();

              // === SAVE ALL LEADS FROM THIS FORM (even if campaign_id missing) ===
              if (leadCampaignId && leadCampaignId !== campaignId) {
                console.log(`[SKIP] Lead ${lead.id || "null"} → wrong campaign (${leadCampaignId})`);
                continue;
              }

              // === FORCE campaign_id to be the sync campaign if missing ===
              const finalCampaignId = leadCampaignId || campaignId;

              // === UNIQUE leadId (real ID or fallback) ===
              const leadId = lead.id || `fb_${form.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

              // === SKIP IF ALREADY EXISTS ===
              if (await Lead.exists({ leadId })) {
                console.log(`[SKIP] Lead ${leadId} → already exists`);
                continue;
              }

              // === PARSE FIELDS ===
              const fieldData = Array.isArray(lead.field_data) ? lead.field_data : [];
              const fields = {};
              fieldData.forEach(f => {
                if (f?.name) fields[f.name.toUpperCase()] = f.values?.[0] ?? "";
              });

              const leadDoc = {
                user_id: userId,
                page_id: page.page_id,
                leadId,
                created_time: lead.created_time,
                form_id: lead.form_id || form.id,
                field_data: fieldData,
                campaign_id: finalCampaignId, // ← ALWAYS SET
                name: fields.FULL_NAME || fields.EMAIL || "Unknown",
                email: fields.EMAIL || "",
                phone: fields.PHONE_NUMBER || fields.PHONE || "",
              };

              try {
                await Lead.create(leadDoc);
                synced++;
                formSaved++;

                await MetaCampaign.updateOne(
                  { campaign_id: campaignId },
                  { $inc: { leads_count: 1 } }
                );

                console.log(`[SAVED] ${leadId} → ${leadDoc.name} (${leadDoc.email}) | campaign: ${finalCampaignId}`);
              } catch (saveErr) {
                if (saveErr.code === 11000) {
                  console.log(`[SKIP] Lead ${leadId} → duplicate (E11000)`);
                } else {
                  console.error(`[SAVE FAILED] ${leadId}:`, saveErr.message);
                }
              }
            }

            after = batch.paging?.cursors?.after;
            if (after) console.log(`[PAGING] Next cursor: ${after}`);
          } catch (e) {
            if (e.response?.data?.error?.error_subcode === 80005) {
              console.warn(`[RATE LIMIT] Sleeping 65s...`);
              await new Promise(r => setTimeout(r, 65000));
              continue;
            }
            console.error(`[SYNC] Batch error:`, e.response?.data?.error?.message || e.message);
            break;
          }
        } while (after);

        console.log(`[SYNC] Form done → ${formSaved} saved`);
      }
    }

    console.log(`[SYNC] Campaign ${campaignId} → ${synced} saved | ${fetched} fetched`);
    return { synced, fetched, campaign: campaign.name, campaign_id: campaignId };
  } catch (err) {
    console.error(`[SYNC] Campaign ${campaignId} failed:`, err.message);
    return { synced: 0, fetched: 0, error: err.message };
  }
}

// === GET /api/leads
router.get("/", async (req, res) => {
  const { userId, campaignId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const filter = { user_id: userId };
  if (campaignId) filter.campaign_id = campaignId;

  try {
    const leads = await Lead.find(filter).sort({ created_time: -1 }).limit(500).lean();
    console.log(`[LEADS] Returning ${leads.length} leads`);
    res.json(leads);
  } catch (err) {
    console.error(`[LEADS] DB error:`, err.message);
    res.status(500).json({ error: "Failed" });
  }
});

// === GET /api/leads/export?userId=demo&campaignId=...
router.get("/export", async (req, res) => {
  const { userId, campaignId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const filter = { user_id: userId };
  if (campaignId) filter.campaign_id = campaignId;

  try {
    const leads = await Lead.find(filter).lean();
    if (!leads.length) {
      return res.status(404).json({ error: "No leads found" });
    }

    const fields = ["name", "email", "phone", "created_time", "form_id", "campaign_id"];
    const parser = new Parser({ fields });
    const csv = parser.parse(leads);

    res.header("Content-Type", "text/csv");
    res.attachment(`leads_${userId}_${campaignId || "all"}.csv`);
    res.send(csv);
  } catch (err) {
    console.error(`[EXPORT] Error:`, err.message);
    res.status(500).json({ error: "Export failed" });
  }
});

// === WEBHOOK
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("[WEBHOOK] Verified");
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  console.log("[WEBHOOK] Payload received");

  for (const entry of req.body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "leadgen") continue;

      const leadgen_id = change.value.leadgen_id;
      console.log("[WEBHOOK] New lead:", leadgen_id);

      try {
        const { data } = await axios.get(
          `https://graph.facebook.com/v22.0/${leadgen_id}?access_token=${process.env.PAGE_ACCESS_TOKEN}`
        );

        const leadId = data.id || `webhook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const newLead = new Lead({
          user_id: "demo",
          leadId,
          created_time: data.created_time,
          form_id: data.form_id,
          field_data: data.field_data || [],
          campaign_id: data.campaign_id || "webhook",
          name: data.field_data?.find(f => f.name === "FULL_NAME")?.values?.[0] || "Unknown",
          email: data.field_data?.find(f => f.name === "EMAIL")?.values?.[0] || "",
          phone: data.field_data?.find(f => f.name === "PHONE_NUMBER")?.values?.[0] || "",
        });

        await newLead.save();
        console.log(`[WEBHOOK] Saved lead ${leadId}`);
      } catch (err) {
        console.error("[WEBHOOK] Error:", err.message);
      }
    }
  }
});

module.exports = router;