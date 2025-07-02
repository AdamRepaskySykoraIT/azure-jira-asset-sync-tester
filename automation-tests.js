const config = require('./config');

const JIRA_USER = config.JIRA_USER;
const JIRA_API_TOKEN = config.JIRA_API_TOKEN;
const IMPORT_SOURCE_ID = config.IMPORT_SOURCE_ID;
const WORKSPACE_ID = config.WORKSPACE_ID;
const WEBTRIGGER_URL = config.WEBTRIGGER_URL;

if (!JIRA_USER || !JIRA_API_TOKEN || !WORKSPACE_ID || !IMPORT_SOURCE_ID) {
  console.error('❌ Configuration variables are not set properly:');
  console.log(JIRA_USER, JIRA_API_TOKEN, WORKSPACE_ID, IMPORT_SOURCE_ID);
  process.exit(1);
}
console.log('Using JIRA_USER:', JIRA_USER, 'WORKSPACE_ID:', WORKSPACE_ID, 'IMPORT_SOURCE_ID:', IMPORT_SOURCE_ID);

const authBasic = 'Basic ' + Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64');

async function getContainerToken() {
  const url = `https://api.atlassian.com/jsm/assets/workspace/${WORKSPACE_ID}/v1/importsource/${IMPORT_SOURCE_ID}/token`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authBasic,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get container token: ${res.status} - ${err}`);
  }

  const data = await res.json();
  if (!data.token) {
    throw new Error(`No token returned in response: ${JSON.stringify(data)}`);
  }

  console.log('🔑 Container token received.');
  return data.token;
}

async function getImportLinks(containerToken) {
  const res = await fetch('https://api.atlassian.com/jsm/assets/v1/imports/info', {
    headers: {
      Authorization: `Bearer ${containerToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get import links: ${res.status} - ${err}`);
  }

  const data = await res.json();
  if (!data.links || !data.links.start || !data.links.getStatus) {
    throw new Error(`Missing import links in response: ${JSON.stringify(data)}`);
  }

  return data.links;
}

async function pollStatus(containerToken, getStatusUrl) {
  console.log('🔁 Polling import status...');

  let executionStatusUrl = null;
  let status = null;

  // Phase 1: Poll import status until IN_PROGRESS
  for (let i = 0; i < 60; i++) {
    const res = await fetch(getStatusUrl, {
      headers: {
        Authorization: `Bearer ${containerToken}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to check status: ${res.status} - ${err}`);
    }

    const statusData = await res.json();
    status = statusData.status;
    console.log(`[Import Status][${i}]`, status);

    if (status === 'RUNNING' && statusData.links && statusData.links.getExecutionStatus) {
      executionStatusUrl = statusData.links.getExecutionStatus;
      break;
    }

    if (status === 'FAILURE' || status === 'CANCELLED') {
      console.error(`❌ Import failed: ${status}`);
      return false;
    }

    if (status === 'IDLE') {
      console.log('✅ Import completed successfully (no execution started).');
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  if (!executionStatusUrl) {
    throw new Error('❌ Could not get execution status link from import status.');
  }

  // Phase 2: Poll execution status until not IN_PROGRESS
  for (let j = 0; j < 600; j++) {
    const execRes = await fetch(executionStatusUrl, {
      headers: {
        Authorization: `Bearer ${containerToken}`,
        Accept: 'application/json',
      },
    });

    if (!execRes.ok) {
      const err = await execRes.text();
      throw new Error(`Failed to fetch execution status: ${execRes.status} - ${err}`);
    }

    const execStatusData = await execRes.json();
    const execStatus = execStatusData.status;
    console.log(`[Execution Status][${j}]`, execStatusData.status);

    if (execStatus === 'DONE') {
      console.log('✅ Execution completed successfully!');
      return true;
    }
    if (execStatus === 'CANCELLED') {
      console.error(`❌ Execution failed: ${execStatus}`);
      return false;
    }
    if (execStatus != 'INGESTING' && execStatus != 'PROCESSING') {
      console.log(`❌ Unexpected execution status: ${execStatus}`);
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error('⌛ Timeout waiting for execution to complete.');
}

// Webtrigger for starting import
async function startImportWebtrigger(request) {
  console.log('startImportWebtrigger called');
  console.log('Request body:', request.url);
  // You can add logic here to start the import, for now just log
  // If you want to call your import logic, you can do so here
  // Example: await startImport(...)
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'startImportWebtrigger executed', event }),
  };
};

// Webtrigger for starting import via HTTP
async function startImportViaWebtrigger() {
  if (!WEBTRIGGER_URL) {
    throw new Error('WEBTRIGGER_URL env variable is not set');
  }
  // Add query params for demonstration
  const url = new URL(WEBTRIGGER_URL);
  //url.searchParams.append('automation', 'true');

  //console.log(`Calling webtrigger: ${url.toString()}`);
  console.log("webtrigger URL:", url.toString());
  console.log("context:", {
    workspaceId: WORKSPACE_ID,
    importId: IMPORT_SOURCE_ID,
  });
  const res = await fetch(url.toString(), { 
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      context: { 
        workspaceId: WORKSPACE_ID,
        importId: IMPORT_SOURCE_ID,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webtrigger call failed: ${res.status} - ${err}`);
  }
  const data = await res.json();
  //console.log('Webtrigger response:', data);
  return data;
}

(async () => {
  try {
    await startImportViaWebtrigger();

    const containerToken = await getContainerToken();
    await new Promise(resolve => setTimeout(resolve, 3000)); // wait 3 second
    const links = await getImportLinks(containerToken);
    
    const success = await pollStatus(containerToken, links.getStatus);
    process.exit(success ? 0 : 1);
    //process.exit(0);
  } catch (err) {
    console.error('💥 Error:', err.message);
    process.exit(1);
  }
})();
