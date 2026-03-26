const axios = require('axios');
const FormData = require('form-data');
const { WebClient } = require('@slack/web-api');
const { getBoxToken } = require('./box-auth');
const { logger } = require('./logger');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ─── Clio ────────────────────────────────────────────────────────────────────

async function getClioDocuments(matter_id) {
  const token = process.env.CLIO_ACCESS_TOKEN;
  if (!token) throw new Error('CLIO_ACCESS_TOKEN not set');

  const resp = await axios.get('https://app.clio.com/api/v4/documents.json', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      matter_id,
      fields: 'id,name,content_type,size,created_at',
      limit: 200,
    },
  });

  return resp.data?.data || [];
}

async function downloadClioDocument(doc_id) {
  const token = process.env.CLIO_ACCESS_TOKEN;
  const resp = await axios.get(
    `https://app.clio.com/api/v4/documents/${doc_id}/download`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(resp.data);
}

// ─── Box ─────────────────────────────────────────────────────────────────────

async function findBoxMatterFolder(matter_number, client_name) {
  const token = await getBoxToken();

  // Search Box for folder matching matter number
  const searchQuery = matter_number.toString();
  const resp = await axios.get('https://api.box.com/2.0/search', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      query: searchQuery,
      type: 'folder',
      limit: 10,
    },
  });

  const entries = resp.data?.entries || [];
  logger.debug(`Box search for "${searchQuery}" returned ${entries.length} results`);

  // Find best match: folder name contains matter number
  let match = entries.find((e) =>
    e.name.toLowerCase().includes(matter_number.toString().toLowerCase())
  );

  // Fallback: search by client name
  if (!match && client_name) {
    const clientLastName = client_name.split(',')[0].trim();
    match = entries.find((e) =>
      e.name.toLowerCase().includes(clientLastName.toLowerCase())
    );
  }

  if (!match) {
    // Try broader search by client name directly
    const clientResp = await axios.get('https://api.box.com/2.0/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        query: client_name.split(',')[0].trim(),
        type: 'folder',
        limit: 10,
      },
    });
    const clientEntries = clientResp.data?.entries || [];
    match = clientEntries.find((e) =>
      e.name.toLowerCase().includes(matter_number.toString().toLowerCase())
    );
  }

  return match || null;
}

async function findVitalDocumentsFolder(matter_folder_id) {
  const token = await getBoxToken();

  const resp = await axios.get(
    `https://api.box.com/2.0/folders/${matter_folder_id}/items`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 200, fields: 'id,name,type' },
    }
  );

  const items = resp.data?.entries || [];
  const vitalDocs = items.find(
    (item) =>
      item.type === 'folder' &&
      item.name.toLowerCase().includes('vital')
  );

  return vitalDocs || null;
}

async function uploadToBox(folder_id, filename, fileBuffer, contentType) {
  const token = await getBoxToken();

  const form = new FormData();
  form.append(
    'attributes',
    JSON.stringify({ name: filename, parent: { id: folder_id } })
  );
  form.append('file', fileBuffer, {
    filename,
    contentType: contentType || 'application/octet-stream',
  });

  const resp = await axios.post(
    'https://upload.box.com/api/2.0/files/content',
    form,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    }
  );

  return resp.data?.entries?.[0] || null;
}

// ─── Slack ───────────────────────────────────────────────────────────────────

async function sendSlackNotification({ matter_number, matter_name, client_name, files_uploaded, box_folder_url, errors }) {
  const channel = process.env.SLACK_DM_CHANNEL || 'UQCGA53CJ';

  let text;
  if (files_uploaded.length > 0) {
    const fileList = files_uploaded.map((f) => `• ${f}`).join('\n');
    text =
      `✅ *Clio → Box sync complete*\n` +
      `*Matter:* ${matter_number} — ${matter_name}\n` +
      `*Client:* ${client_name}\n` +
      `*Files uploaded (${files_uploaded.length}):*\n${fileList}\n` +
      (box_folder_url ? `*Box Folder:* <${box_folder_url}|Vital Documents>` : '');
  } else {
    text =
      `⚠️ *Clio → Box sync: no files found*\n` +
      `*Matter:* ${matter_number} — ${matter_name}\n` +
      `*Client:* ${client_name}\n` +
      `No documents were attached to this matter in Clio yet. ` +
      `If Lauren uploads files later, they won't be auto-synced.`;
  }

  if (errors.length > 0) {
    text += `\n\n*Errors:*\n${errors.map((e) => `• ${e}`).join('\n')}`;
  }

  await slack.chat.postMessage({ channel, text });
}

async function sendSlackError({ matter_number, client_name, error }) {
  const channel = process.env.SLACK_DM_CHANNEL || 'UQCGA53CJ';
  await slack.chat.postMessage({
    channel,
    text:
      `❌ *Clio → Box sync FAILED*\n` +
      `*Matter:* ${matter_number}\n` +
      `*Client:* ${client_name}\n` +
      `*Error:* ${error}`,
  });
}

// ─── Main sync orchestrator ───────────────────────────────────────────────────

async function runFileSync({ matter_id, matter_number, matter_name, client_name }) {
  const filesUploaded = [];
  const errors = [];
  let boxFolderUrl = null;

  try {
    // 1. Find matter folder in Box
    logger.info(`Looking up Box folder for matter ${matter_number} / ${client_name}`);
    const matterFolder = await findBoxMatterFolder(matter_number, client_name);

    if (!matterFolder) {
      throw new Error(
        `Could not find Box folder for matter ${matter_number} (${client_name}). ` +
        `Clio may not have created it yet, or the naming pattern doesn't match.`
      );
    }
    logger.info(`Found Box matter folder: ${matterFolder.name} (${matterFolder.id})`);

    // 2. Find Vital Documents subfolder
    const vitalFolder = await findVitalDocumentsFolder(matterFolder.id);
    if (!vitalFolder) {
      throw new Error(`"Vital Documents" subfolder not found in Box folder ${matterFolder.name}`);
    }
    logger.info(`Found Vital Documents folder: ${vitalFolder.id}`);
    boxFolderUrl = `https://app.box.com/folder/${vitalFolder.id}`;

    // 3. Get Clio documents
    logger.info(`Fetching Clio documents for matter_id ${matter_id}`);
    const clioDocuments = await getClioDocuments(matter_id);
    logger.info(`Found ${clioDocuments.length} Clio document(s)`);

    if (clioDocuments.length === 0) {
      await sendSlackNotification({
        matter_number, matter_name, client_name,
        files_uploaded: [],
        box_folder_url: boxFolderUrl,
        errors,
      });
      return;
    }

    // 4. Download from Clio and upload to Box
    for (const doc of clioDocuments) {
      try {
        logger.info(`Downloading: ${doc.name}`);
        const fileBuffer = await downloadClioDocument(doc.id);

        logger.info(`Uploading to Box: ${doc.name}`);
        await uploadToBox(vitalFolder.id, doc.name, fileBuffer, doc.content_type);
        filesUploaded.push(doc.name);
      } catch (err) {
        logger.error(`Failed to sync file ${doc.name}: ${err.message}`);
        errors.push(`${doc.name}: ${err.message}`);
      }
    }

    // 5. Slack summary
    await sendSlackNotification({
      matter_number, matter_name, client_name,
      files_uploaded: filesUploaded,
      box_folder_url: boxFolderUrl,
      errors,
    });

  } catch (err) {
    logger.error(`Sync failed for matter ${matter_number}: ${err.message}`);
    await sendSlackError({ matter_number, client_name, error: err.message });
    throw err; // re-throw so BullMQ marks job as failed and retries
  }
}

module.exports = { runFileSync };
