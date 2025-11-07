// routes/leads.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const Lead = require("../models/Lead");
const MetaPage = require("../models/MetaPage");
const MetaCampaign = require("../models/MetaCampaign");
const { Parser } = require("json2csv");

// === GET /api/leads/campaigns?userId=himanshu
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

// === CORE SYNC FUNCTION (WITH RATE LIMIT + DEBUG)
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
    if (!pages.length) {
      console.log(`[SYNC] No active pages found for user`);
      return { synced: 0, fetched: 0, campaign: campaign.name };
    }

    // Track rate limit per page
    const rateLimitBackoff = new Map(); // page_id → next retry time

    for (const page of pages) {
      const pageId = page.page_id;
      console.log(`\n[SYNC] Page: ${page.page_name} (ID: ${pageId})`);

      // Skip if rate limited
      if (rateLimitBackoff.has(pageId)) {
        const retryAfter = rateLimitBackoff.get(pageId);
        if (Date.now() < retryAfter) {
          console.warn(`[RATE LIMIT] Skipping ${page.page_name} → retry in ${Math.round((retryAfter - Date.now()) / 1000)}s`);
          continue;
        } else {
          rateLimitBackoff.delete(pageId);
        }
      }

      let forms = [];
      try {
        console.log(`[DEBUG] Fetching forms for page ${pageId}`);
        const { data } = await axios.get(
          `https://graph.facebook.com/v22.0/${pageId}/leadgen_forms`,
          {
            params: { access_token: page.page_access_token, fields: "id,name" },
            timeout: 12000,
          }
        );
        forms = data.data || [];
        console.log(`[SYNC] ${forms.length} forms found on ${page.page_name}`);
      } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.message;
        if (e.response?.data?.error?.error_subcode === 80005) {
          const retryAfter = Date.now() + 70 * 1000; // 70 seconds
          rateLimitBackoff.set(pageId, retryAfter);
          console.warn(`[RATE LIMIT] ${page.page_name} → blocked. Retry in 70s`);
        } else {
          console.error(`[SYNC] Forms error on ${page.page_name}:`, errMsg);
        }
        continue;
      }

      for (const form of forms) {
        console.log(`\n[SYNC] Form: "${form.name}" (ID: ${form.id})`);
        let after = null;
        let formSaved = 0;

        do {
          let batch;
          try {
            console.log(`[DEBUG] Fetching leads batch → form: ${form.id}, after: ${after || "start"}`);
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
            } else {
              console.log(`[DEBUG] No leads in this batch`);
            }

            for (const lead of leads) {
              const leadCampaignId = lead.campaign_id?.toString();

              if (leadCampaignId && leadCampaignId !== campaignId) {
                console.log(`[SKIP] Lead ${lead.id} → wrong campaign (${leadCampaignId})`);
                continue;
              }

              const finalCampaignId = (leadCampaignId || campaignId).toString();

              const leadId = lead.id || `fb_${form.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

              if (await Lead.exists({ leadId })) {
                console.log(`[SKIP] Lead ${leadId} → already exists`);
                continue;
              }

              const fieldData = Array.isArray(lead.field_data) ? lead.field_data : [];
              const fields = {};
              fieldData.forEach(f => {
                if (f?.name) fields[f.name.toUpperCase()] = f.values?.[0] ?? "";
              });

              const leadDoc = {
                user_id: userId,
                page_id: pageId,
                leadId,
                created_time: lead.created_time,
                form_id: lead.form_id || form.id,
                field_data: fieldData,
                campaign_id: finalCampaignId,
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

                console.log(`[SAVED] ${leadId} → ${leadDoc.name} (${leadDoc.email}) | form: ${form.id} | campaign: ${finalCampaignId}`);
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
            const subcode = e.response?.data?.error?.error_subcode;
            if (subcode === 80005) {
              const retryAfter = Date.now() + 70 * 1000;
              rateLimitBackoff.set(pageId, retryAfter);
              console.warn(`[RATE LIMIT] Form ${form.id} → blocked. Retry in 70s`);
              break; // exit do-while, move to next form
            } else {
              console.error(`[SYNC] Batch error (form ${form.id}):`, e.response?.data?.error?.message || e.message);
              break;
            }
          }
        } while (after);

        console.log(`[SYNC] Form ${form.id} done → ${formSaved} saved`);
      }
    }

    console.log(`\n[SYNC] Campaign ${campaignId} → ${synced} saved | ${fetched} fetched`);
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
    console.log(`[LEADS] Returning ${leads.length} leads for campaign: ${campaignId || "all"}`);
    res.json(leads);
  } catch (err) {
    console.error(`[LEADS] DB error:`, err.message);
    res.status(500).json({ error: "Failed" });
  }
});

// === GET /api/leads/export
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
          user_id: "himanshu",
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