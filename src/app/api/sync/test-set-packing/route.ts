import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache, getAccessToken, getEndpoint } from '@/lib/sp-api/auth';

interface SPAPICredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId: string;
}

/**
 * GET /api/sync/test-set-packing?batchId=16
 *
 * Diagnostic for the 403 on setPackingInformation. Reads the batch's
 * inboundPlanId, packingOptionId, pack groups, boxes and box items from the
 * DB, builds the same body /pack would build, and fires PUT setPackingInformation
 * directly with verbose logging. Returns the raw HTTP status, body, and a
 * second GET against the inbound plan so we can see whether the same token
 * has read access for the same plan id (proving auth vs body issue).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const batchId = parseInt(searchParams.get('batchId') || '');
  if (!batchId) return NextResponse.json({ error: 'Pass ?batchId=N' }, { status: 400 });

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');

  const settingsRows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const r of settingsRows) settings[r.key] = r.value;
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) {
    db.close();
    return NextResponse.json({ error: 'Missing SP-API credentials in settings' }, { status: 400 });
  }
  const creds: SPAPICredentials = {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };

  const batch = db.prepare(`
    SELECT inbound_plan_id as inboundPlanId, packing_option_id as packingOptionId, channel, status
    FROM listing_batches WHERE id = ?
  `).get(batchId) as { inboundPlanId: string; packingOptionId: string | null; channel: string; status: string } | undefined;

  if (!batch) {
    db.close();
    return NextResponse.json({ error: `Batch ${batchId} not found` }, { status: 404 });
  }
  if (!batch.inboundPlanId) {
    db.close();
    return NextResponse.json({ error: 'Batch has no inboundPlanId' }, { status: 400 });
  }

  const packGroups = db.prepare(`
    SELECT packing_group_id as packingGroupId
    FROM listing_batch_pack_groups WHERE batch_id = ?
    ORDER BY group_index ASC
  `).all(batchId) as Array<{ packingGroupId: string }>;

  const boxes = db.prepare(`
    SELECT id, box_index as boxIndex, length_in as lengthIn, width_in as widthIn,
           height_in as heightIn, weight_lb as weightLb, packing_group_id as packingGroupId
    FROM listing_batch_boxes WHERE batch_id = ?
    ORDER BY box_index ASC
  `).all(batchId) as Array<{ id: number; boxIndex: number; lengthIn: number; widthIn: number; heightIn: number; weightLb: number; packingGroupId: string | null }>;

  const boxItems = db.prepare(`
    SELECT bi.box_id as boxId, lbi.sku as msku, bi.quantity
    FROM listing_batch_box_items bi
    INNER JOIN listing_batch_items lbi ON lbi.id = bi.item_id
    INNER JOIN listing_batch_boxes b ON b.id = bi.box_id
    WHERE b.batch_id = ?
  `).all(batchId) as { boxId: number; msku: string; quantity: number }[];

  db.close();

  const validGroupIds = packGroups.map((g) => g.packingGroupId);
  const isMultiGroup = validGroupIds.length > 1;
  let boxCounter = 0;
  const packageGroupings = validGroupIds.map((groupId) => {
    const groupBoxes = isMultiGroup ? boxes.filter((b) => b.packingGroupId === groupId) : boxes;
    return {
      packingGroupId: groupId,
      boxes: groupBoxes.map((box) => {
        boxCounter += 1;
        return {
          boxId: `B${boxCounter}`,
          contentInformationSource: 'BOX_CONTENT_PROVIDED' as const,
          dimensions: {
            unitOfMeasurement: 'IN' as const,
            length: box.lengthIn,
            width: box.widthIn,
            height: box.heightIn,
          },
          weight: { unit: 'LB' as const, value: box.weightLb },
          quantity: 1,
          items: boxItems.filter((bi) => bi.boxId === box.id).map((bi) => ({
            msku: bi.msku,
            quantity: bi.quantity,
            labelOwner: 'SELLER' as const,
            prepOwner: 'SELLER' as const,
          })),
        };
      }),
    };
  });

  clearTokenCache();
  const token = await getAccessToken(creds);
  const endpoint = getEndpoint(creds.marketplaceId);

  const planUrl = `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(batch.inboundPlanId)}`;
  const packingUrl = `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(batch.inboundPlanId)}/packingInformation`;

  const planRead = await fetch(planUrl, { headers: { 'x-amz-access-token': token } });
  const planReadBody = await planRead.text();

  const putRes = await fetch(packingUrl, {
    method: 'PUT',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageGroupings }),
  });
  const putBody = await putRes.text();

  return NextResponse.json({
    batch: { id: batchId, channel: batch.channel, status: batch.status, inboundPlanId: batch.inboundPlanId, packingOptionId: batch.packingOptionId },
    tokenPreview: `${token.slice(0, 12)}…${token.slice(-6)} (len=${token.length})`,
    endpoint,
    planRead: {
      status: planRead.status,
      ok: planRead.ok,
      body: tryJson(planReadBody),
    },
    setPackingInformation: {
      url: packingUrl,
      method: 'PUT',
      requestBody: { packageGroupings },
      status: putRes.status,
      ok: putRes.ok,
      responseBody: tryJson(putBody),
      headers: {
        'x-amzn-RequestId': putRes.headers.get('x-amzn-RequestId'),
        'x-amzn-ErrorType': putRes.headers.get('x-amzn-ErrorType'),
      },
    },
    interpretation: interpret(planRead.status, putRes.status),
  });
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function interpret(planReadStatus: number, putStatus: number): string {
  if (planReadStatus === 403 && putStatus === 403) {
    return 'GET on the same plan ALSO returns 403 — token does not have access to this plan at all. Re-authorize the SP-API app to refresh role grants.';
  }
  if (planReadStatus === 200 && putStatus === 403) {
    return 'GET on the plan works but PUT setPackingInformation is denied — write permission is missing for this operation specifically. Re-authorize the SP-API app, ensuring the "Inventory and Order Tracking" role (or whatever Amazon calls Fulfillment Inbound write) is granted.';
  }
  if (planReadStatus === 200 && putStatus === 200) {
    return 'Both calls succeeded. The earlier 403 may have been transient or related to a stale token cache.';
  }
  if (planReadStatus === 404) {
    return 'Plan no longer exists / wrong region. Verify the inboundPlanId is current and you are using the correct marketplace.';
  }
  return `planRead=${planReadStatus} put=${putStatus} — see response bodies.`;
}
