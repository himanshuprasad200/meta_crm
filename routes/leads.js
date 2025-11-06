// routes/leads.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const Lead = require("../models/Lead");
const MetaPage = require("../models/MetaPage");
const MetaCampaign = require("../models/MetaCampaign");
const { handleLead } = require("../utils/meta");

// === GET /api/leads/campaigns?userId=himanshu
router.get("/campaigns", async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    console.log("[LEADS] GET /campaigns → Missing userId");
    return res.status(400).json({ error: "userId is required" });
  }

  console.log(`[LEADS] GET /campaigns → Fetching for user: ${userId}`);

  try {
    const campaigns = await MetaCampaign.find({ user_id: userId })
      .select("campaign_id name status objective leads_count spend")
      .sort({ name: 1 })
      .lean();

    console.log(`[LEADS] Found ${campaigns.length} campaigns for ${userId}`);
    res.json(campaigns);
  } catch (err) {
    console.error(`[LEADS] Error fetching campaigns:`, err.message);
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

// === POST /api/leads/sync/:campaignId { userId: "himanshu" }
router.post("/sync/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    console.log("[SYNC] POST /sync → Missing userId in body");
    return res.status(400).json({ error: "userId is required in body" });
  }

  let synced = 0;
  let totalFetched = 0;

  console.log(`[SYNC] START → Campaign ID: ${campaignId} | User: ${userId}`);

  try {
    const campaign = await MetaCampaign.findOne({
      campaign_id: campaignId,
      user_id: userId,
    }).lean();

    if (!campaign) {
      console.log(`[SYNC] Campaign NOT FOUND: ${campaignId}`);
      return res.status(404).json({ error: "Campaign not found" });
    }

    console.log(`[SYNC] Campaign: "${campaign.name}" (ID: ${campaignId})`);

    const pages = await MetaPage.find({ user_id: userId, is_active: true }).lean();
    console.log(`[SYNC] Found ${pages.length} active pages`);

    if (pages.length === 0) {
      console.log(`[SYNC] No active pages → returning 0`);
      return res.json({ synced: 0, campaign: campaign.name, campaign_id: campaignId });
    }

    for (const page of pages) {
      console.log(`[SYNC] PAGE: ${page.page_name} (ID: ${page.page_id})`);

      let forms = [];
      try {
        console.log(`[SYNC] Fetching forms from page ${page.page_id}`);
        const formsRes = await axios.get(
          `https://graph.facebook.com/v22.0/${page.page_id}/leadgen_forms`,
          {
            params: { access_token: page.page_access_token, fields: "id,name" },
            timeout: 12000,
          }
        );
        forms = formsRes.data.data || [];
        console.log(`[SYNC] Found ${forms.length} forms`);
      } catch (e) {
        console.error(`[SYNC] Forms API error:`, e.response?.data?.error?.message || e.message);
        continue;
      }

      for (const form of forms) {
        console.log(`[SYNC] FORM: "${form.name}" (ID: ${form.id})`);

        let after = null;
        let formSynced = 0;

        do {
          let leadRes;
          try {
            console.log(`[SYNC] Fetching leads from form ${form.id} (after: ${after || "start"})`);
            leadRes = await axios.get(
              `https://graph.facebook.com/v22.0/${form.id}/leads`,
              {
                params: {
                  access_token: page.page_access_token,
                  fields: "id,created_time,field_data,campaign_id",
                  limit: 100,
                  after,
                },
                timeout: 15000,
              }
            );

            const leads = leadRes.data.data || [];
            totalFetched += leads.length;

            if (leads.length > 0) {
              console.log(`[DEBUG] First lead:`, JSON.stringify(leads[0], null, 2));
            } else {
              console.log(`[DEBUG] No leads in this batch`);
            }

            for (const lead of leads) {
              const leadCampaignId = lead.campaign_id?.toString();

              // === CRITICAL: Campaign ID check ===
              if (!leadCampaignId) {
                console.log(`[SKIP] Lead ${lead.id} → MISSING campaign_id`);
                continue;
              }
              if (leadCampaignId !== campaignId) {
                console.log(`[SKIP] Lead ${lead.id} → wrong campaign (${leadCampaignId})`);
                continue;
              }

              // === Duplicate check ===
              if (await Lead.exists({ lead_id: lead.id })) {
                console.log(`[SKIP] Lead ${lead.id} → already in DB`);
                continue;
              }

              // === Safe field_data parsing ===
              const fieldData = Array.isArray(lead.field_data) ? lead.field_data : [];
              const fields = {};
              fieldData.forEach(f => {
                if (f?.name) {
                  fields[f.name.toUpperCase()] = f.values?.[0] ?? "";
                }
              });

              const leadData = {
                user_id: userId,
                page_id: page.page_id,
                lead_id: lead.id,
                form_id: form.id,
                campaign_id: leadCampaignId,
                name: fields.FULL_NAME || fields.EMAIL || "Unknown",
                email: fields.EMAIL || "",
                phone: fields.PHONE_NUMBER || fields.PHONE || "",
                custom_fields: fields,
                created_time: new Date(lead.created_time),
                source: "campaign_sync",
                data_source: "meta_api_sync",
              };

              try {
                await Lead.create(leadData);
                synced++;
                formSynced++;

                await MetaCampaign.updateOne(
                  { campaign_id: campaignId },
                  { $inc: { leads_count: 1 } }
                );

                const saved = await Lead.findOne({ lead_id: lead.id }).lean();
                global.send?.(userId, "new_lead", {
                  ...leadData,
                  _id: saved._id.toString(),
                });

                console.log(`[SAVED] ${lead.id} → ${leadData.name} (${leadData.email})`);
              } catch (saveErr) {
                console.error(`[SAVE FAILED] ${lead.id}:`, saveErr.message);
              }
            }

            after = leadRes.data.paging?.cursors?.after;
            if (after) console.log(`[PAGING] Next cursor: ${after}`);
          } catch (e) {
            if (e.response?.status === 400 && e.response?.data?.error?.error_subcode === 80005) {
              console.warn(`[RATE LIMIT] Sleeping 65s...`);
              await new Promise(r => setTimeout(r, 65000));
              continue;
            }
            console.error(`[SYNC] Lead fetch error:`, e.response?.data?.error?.message || e.message);
            break;
          }
        } while (after);

        console.log(`[SYNC] Form "${form.name}" → ${formSynced} leads saved`);
      }
    }

    console.log(`[SYNC] DONE → ${synced} saved | ${totalFetched} fetched | "${campaign.name}"`);
    res.json({ synced, campaign: campaign.name, campaign_id: campaignId });
  } catch (err) {
    console.error(`[SYNC] FATAL:`, err.message);
    res.status(500).json({ error: "Sync failed", details: err.message });
  }
});

// === GET /api/leads?userId=himanshu&campaignId=...
router.get("/", async (req, res) => {
  const { campaignId, userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const filter = { user_id: userId };
  if (campaignId) filter.campaign_id = campaignId;

  console.log(`[LEADS] GET / → user: ${userId} | campaign: ${campaignId || "all"}`);

  try {
    const leads = await Lead.find(filter)
      .sort({ created_time: -1 })
      .limit(500)
      .lean();

    console.log(`[LEADS] Returning ${leads.length} leads`);
    res.json(leads);
  } catch (err) {
    console.error(`[LEADS] DB error:`, err.message);
    res.status(500).json({ error: "Failed to fetch leads" });
  }
});

// === POST /api/leads/sync (sync all)
router.post("/sync", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  console.log(`[SYNC] Syncing ALL campaigns for ${userId}`);

  try {
    const campaigns = await MetaCampaign.find({ user_id: userId }).lean();
    let total = 0;

    for (const camp of campaigns) {
      console.log(`[SYNC] Syncing: ${camp.name}`);
      try {
        const result = await axios.post(
          `${process.env.BASE_URL || "http://localhost:8085"}/api/leads/sync/${camp.campaign_id}`,
          { userId },
          { headers: { "Content-Type": "application/json" } }
        );
        total += result.data.synced || 0;
        console.log(`[SYNC] Synced ${result.data.synced} from ${camp.name}`);
      } catch (err) {
        console.error(`[SYNC] Failed: ${camp.campaign_id}`, err.message);
      }
    }

    console.log(`[SYNC] ALL DONE: ${total} total leads`);
    res.json({ synced: total });
  } catch (err) {
    console.error(`[SYNC] ALL FAILED:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// === WEBHOOK: Verify & Receive
router.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log("[WEBHOOK] Verified");
    res.send(challenge);
  } else {
    console.log("[WEBHOOK] Verification failed");
    res.sendStatus(403);
  }
});

router.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  console.log("[WEBHOOK] Payload received");

  for (const entry of req.body.entry || []) {
    const page = await MetaPage.findOne({ page_id: entry.id, is_active: true }).lean();
    if (!page) continue;

    for (const change of entry.changes || []) {
      if (change.field !== "leadgen") continue;
      try {
        await handleLead(change.value, page);
      } catch (err) {
        console.error("[WEBHOOK] handleLead error:", err.message);
      }
    }
  }
  console.log("[WEBHOOK] Done");
});

module.exports = router;