import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTenant,
  closePool,
  getConfig,
  seedTenant,
  seedUserWithJWT,
  type TestTenant,
} from './helpers.js';

describe('replay contract', () => {
  let tenant: TestTenant;
  let jwt: string;

  beforeAll(async () => {
    tenant = await seedTenant();
    jwt = (await seedUserWithJWT(tenant.orgId)).jwt;
  });

  afterAll(async () => {
    await cleanupTenant(tenant.orgId);
    await closePool();
  });

  it('ingests, correlates, retrieves, redacts, and exposes replay_id', async () => {
    const { ingestionUrl } = getConfig();

    const ingest = await fetch(`${ingestionUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.apiKey },
      body: JSON.stringify({
        error: { type: 'TypeError', message: 'replay-contract', stack: 'at a (src/a.ts:1:1)' },
        breadcrumbs: [],
        context: {},
        session_id: 'e2e-replay-sess',
      }),
    });
    expect(ingest.status).toBe(202);
    const ev = await ingest.json();
    expect(ev.error_group_id).toBe(ev.group_id);

    const init = await fetch(`${ingestionUrl}/api/v1/replays/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.apiKey },
      body: JSON.stringify({
        session_id: 'e2e-replay-sess',
        error_event_id: ev.event_id,
        trigger_type: 'error',
      }),
    });
    expect(init.status).toBe(201);
    const { replay_id: replayId, upload_url: uploadUrl } = await init.json();

    const secret = 'ghp_e2eplantedsecret123';
    const recording = JSON.stringify({
      events: [
        { type: 4, timestamp: 1000, data: {} },
        { type: 2, timestamp: 1000, data: { note: secret } },
        { type: 3, timestamp: 4000, data: { source: 5 } },
      ],
      meta: { crash_timestamp: 4000, page_url: 'https://app.example.com' },
    });
    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: recording,
    });
    expect(upload.ok).toBe(true);

    const complete = await fetch(`${ingestionUrl}/api/v1/replays/${replayId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': tenant.apiKey },
      body: JSON.stringify({ signals: {}, artifacts: [] }),
    });
    expect(complete.status).toBe(200);

    const get = await fetch(`${ingestionUrl}/api/v1/projects/${tenant.projectId}/replays/${replayId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(get.status).toBe(200);
    const body = await get.text();
    expect(body).not.toContain(secret);
    expect(JSON.parse(body).events.length).toBe(3);

    // Defense in depth: the presigned upload URL is still valid after completion.
    // Re-upload unredacted bytes, then confirm the read path redacts them anyway.
    const reuploadSecret = 'ghp_e2ereuploadsecret456';
    const reupload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 2, timestamp: 1000, data: { note: reuploadSecret } }],
        meta: {},
      }),
    });
    expect(reupload.ok).toBe(true);
    const getAfterReupload = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/replays/${replayId}`,
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
    expect(getAfterReupload.status).toBe(200);
    expect(await getAfterReupload.text()).not.toContain(reuploadSecret);

    const sdkGet = await fetch(`${ingestionUrl}/api/v1/projects/${tenant.projectId}/replays/${replayId}`, {
      headers: { 'X-API-Key': tenant.apiKey },
    });
    expect(sdkGet.status).not.toBe(200);

    const inc = await fetch(`${ingestionUrl}/api/v1/projects/${tenant.projectId}/incidents/${ev.error_group_id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(inc.status).toBe(200);
    expect((await inc.json()).replay_id).toBe(replayId);
  });
});
