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
      fields: 'id,name,content_type,size,created_at,category',
      limit: 200,
    },
  });

  return resp.data?.data || [];
}

async function getClioNotes(matter_id) {
  const token = process.env.CLIO_ACCESS_TOKEN;
  if (!token) throw new Error('CLIO_ACCESS_TOKEN not set');

  const resp = await axios.get('https://app.clio.com/api/v4/notes.json', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      matter_id,
      fields: 'id,subject,detail,date,created_at',
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

async function listMatterSubfolders(matter_folder_id) {
  const token = await getBoxToken();

  const resp = await axios.get(
    `https://api.box.com/2.0/folders/${matter_folder_id}/items`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 200, fields: 'id,name,type' },
    }
  );

  const items = resp.data?.entries || [];
  return items.filter((item) => item.type === 'folder');
}

// Keyword-based routing rules: [keywords, target subfolder name]
const ROUTING_RULES = [
  [['note', 'questionnaire', 'intake', 'consultation'], 'notes'],
  [['will', 'trust', 'poa', 'power of attorney', 'hipaa', 'hippa', 'declaration', 'guardianship'], 'estate planning'],
  [['death cert', 'birth cert', 'marriage', 'divorce', 'certificate'], 'vital records'],
  [['deed', 'title', 'property'], 'real property'],
  [['draft'], 'drafts'],
  [['fee agreement', 'engagement'], 'fee agreement'],
  [['pleading', 'motion', 'order', 'petition'], 'pleadings'],
  [['correspondence', 'letter', 'email'], 'correspondence'],
  [['tax', '1099', 'w-2', 'w2', 'return'], 'tax'],
  [['expense', 'receipt', 'invoice'], 'expenses'],
  [['creditor', 'claim', 'debt'], 'creditors'],
  [['vehicle', 'car', 'auto'], 'vehicle'],
];

function categorizeDocument(filename, clioCategory) {
  const lower = (clioCategory || '').toLowerCase() + ' ' + (filename || '').toLowerCase();

  for (const [keywords, target] of ROUTING_RULES) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return target;
    }
  }

  return null; // no match — upload to root matter folder
}

function matchSubfolder(subfolders, targetName) {
  if (!targetName) return null;
  const target = targetName.toLowerCase();
  return subfolders.find((f) => f.name.toLowerCase().includes(target)) || null;
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
    const fileList = files_uploaded.map((f) => `• ${f.name} → _${f.folder}_`).join('\n');
    text =
      `✅ *Clio → Box sync complete*\n` +
      `*Matter:* ${matter_number} — ${matter_name}\n` +
      `*Client:* ${client_name}\n` +
      `*Files routed (${files_uploaded.length}):*\n${fileList}\n` +
      (box_folder_url ? `*Box Folder:* <${box_folder_url}|Open in Box>` : '');
  } else {
    text =
      `⚠️ *Clio → Box sync: no files found*\n` +
      `*Matter:* ${matter_number} — ${matter_name}\n` +
      `*Client:* ${client_name}\n` +
      `No documents or notes were found in Clio for this matter.`;
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
    boxFolderUrl = `https://app.box.com/folder/${matterFolder.id}`;

    // 2. List all subfolders in matter folder
    const subfolders = await listMatterSubfolders(matterFolder.id);
    logger.info(`Found ${subfolders.length} subfolder(s): ${subfolders.map((f) => f.name).join(', ')}`);

    // 3. Get Clio documents
    logger.info(`Fetching Clio documents for matter_id ${matter_id}`);
    const clioDocuments = await getClioDocuments(matter_id);
    logger.info(`Found ${clioDocuments.length} Clio document(s)`);

    // 4. Get Clio notes
    logger.info(`Fetching Clio notes for matter_id ${matter_id}`);
    const clioNotes = await getClioNotes(matter_id);
    logger.info(`Found ${clioNotes.length} Clio note(s)`);

    if (clioDocuments.length === 0 && clioNotes.length === 0) {
      await sendSlackNotification({
        matter_number, matter_name, client_name,
        files_uploaded: [],
        box_folder_url: boxFolderUrl,
        errors,
      });
      return;
    }

    // 5. Download documents from Clio and route to correct Box subfolder
    for (const doc of clioDocuments) {
      try {
        const category = categorizeDocument(doc.name, doc.category);
        const targetFolder = matchSubfolder(subfolders, category);
        const uploadFolderId = targetFolder ? targetFolder.id : matterFolder.id;
        const folderLabel = targetFolder ? targetFolder.name : matterFolder.name;

        logger.info(`Downloading: ${doc.name} → ${folderLabel}`);
        const fileBuffer = await downloadClioDocument(doc.id);

        logger.info(`Uploading to Box: ${doc.name} → ${folderLabel}`);
        await uploadToBox(uploadFolderId, doc.name, fileBuffer, doc.content_type);
        filesUploaded.push({ name: doc.name, folder: folderLabel });
      } catch (err) {
        logger.error(`Failed to sync file ${doc.name}: ${err.message}`);
        errors.push(`${doc.name}: ${err.message}`);
      }
    }

    // 6. Export notes as .txt files to Notes subfolder
    const notesFolder = matchSubfolder(subfolders, 'notes');
    const notesFolderId = notesFolder ? notesFolder.id : matterFolder.id;
    const notesFolderLabel = notesFolder ? notesFolder.name : matterFolder.name;

    for (const note of clioNotes) {
      try {
        const dateStr = note.date || note.created_at?.split('T')[0] || 'undated';
        const subject = (note.subject || 'Note').replace(/[/\\:*?"<>|]/g, '-');
        const filename = `${dateStr} - ${subject}.txt`;
        const content = `${note.subject || 'Note'}\n${dateStr}\n\n${note.detail || '(empty)'}`;
        const fileBuffer = Buffer.from(content, 'utf-8');

        logger.info(`Uploading note: ${filename} → ${notesFolderLabel}`);
        await uploadToBox(notesFolderId, filename, fileBuffer, 'text/plain');
        filesUploaded.push({ name: filename, folder: notesFolderLabel });
      } catch (err) {
        logger.error(`Failed to sync note "${note.subject}": ${err.message}`);
        errors.push(`Note "${note.subject}": ${err.message}`);
      }
    }

    // 7. Slack summary
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
