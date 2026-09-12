/**
 * Automated 1-command deployment script for `market-catalyst-live`.
 * 
 * Usage:
 *   npm run deploy:live
 *   (or: node deploy/deploy-live.js)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ID = 'market-catalyst-502415';
const REGION = 'us-central1';
const SERVICE_NAME = 'market-catalyst-live';
const BUCKET_NAME = 'run-sources-market-catalyst-502415-us-central1';
const IMAGE_URI = `us-central1-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE_NAME}:latest`;

async function main() {
  console.log('🚀 Starting automated deployment for market-catalyst-live...\n');

  // 1. Resolve token
  const tokenPath = path.join(process.env.USERPROFILE, '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(tokenPath)) {
    throw new Error('Firebase login token not found. Please run: firebase login');
  }
  const cfg = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  let token = cfg.tokens?.access_token;

  // 2. Refresh token if needed
  try {
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho85qd6.apps.googleusercontent.com',
        grant_type: 'refresh_token',
        refresh_token: cfg.tokens.refresh_token,
      }).toString()
    });
    const refreshed = await refreshRes.json();
    if (refreshed.access_token) {
      token = refreshed.access_token;
      cfg.tokens.access_token = token;
      fs.writeFileSync(tokenPath, JSON.stringify(cfg, null, 2));
    }
  } catch {
    // Proceed with existing token if refresh fails
  }

  // 3. Create zip
  console.log('📦 1/4 Creating clean deployment archive...');
  const repoRoot = path.resolve(__dirname, '..');
  const zipFile = path.join(repoRoot, 'deploy-temp.zip');
  if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);

  execSync(`tar.exe -a -cf "${zipFile}" --exclude="node_modules" --exclude=".git" --exclude="dist" *`, {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  const zipBuffer = fs.readFileSync(zipFile);
  const zipSizeMb = (zipBuffer.length / 1024 / 1024).toFixed(2);
  console.log(`   Created zip archive (${zipSizeMb} MB).`);

  // 4. Upload to Cloud Storage
  console.log('☁️  2/4 Uploading archive to Google Cloud Storage...');
  const objectName = `services/${SERVICE_NAME}/deploy-${Date.now()}.zip`;
  const uploadRes = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
      body: zipBuffer
    }
  );
  if (!uploadRes.ok) throw new Error(`Upload failed: ${await uploadRes.text()}`);
  console.log('   Upload complete.');
  fs.unlinkSync(zipFile); // clean up local zip

  // 5. Trigger Cloud Build
  console.log('🔨 3/4 Running Cloud Build on Google Cloud...');
  const buildConfig = {
    source: { storageSource: { bucket: BUCKET_NAME, object: objectName } },
    steps: [
      {
        name: 'gcr.io/cloud-builders/docker',
        args: ['build', '--network', 'cloudbuild', '--no-cache', '-t', IMAGE_URI, '.']
      }
    ],
    images: [IMAGE_URI]
  };

  const buildRes = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${PROJECT_ID}/builds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildConfig)
  });
  const buildData = await buildRes.json();
  const buildId = buildData.metadata?.build?.id;
  if (!buildId) throw new Error(`Cloud Build trigger failed: ${JSON.stringify(buildData)}`);
  console.log(`   Build started (ID: ${buildId}). Waiting for container to compile...`);

  // Poll Cloud Build
  while (true) {
    await new Promise((r) => setTimeout(r, 6000));
    const pollRes = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${PROJECT_ID}/builds/${buildId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const statusData = await pollRes.json();
    process.stdout.write(`   Build status: ${statusData.status}...\r`);
    if (statusData.status === 'SUCCESS') {
      console.log('\n   ✅ Container built successfully!');
      break;
    }
    if (['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED'].includes(statusData.status)) {
      throw new Error(`\n❌ Cloud Build failed with status: ${statusData.status}`);
    }
  }

  // 6. Deploy to Cloud Run
  console.log('🚀 4/4 Deploying new revision to Cloud Run (market-catalyst-live)...');
  const svcRes = await fetch(`https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const svcData = await svcRes.json();
  svcData.template.containers[0].image = IMAGE_URI;

  const patchRes = await fetch(
    `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}?updateMask=template`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: svcData.template })
    }
  );
  const patchData = await patchRes.json();
  const opName = patchData.name;

  // Poll operation
  while (true) {
    await new Promise((r) => setTimeout(r, 4000));
    const opRes = await fetch(`https://run.googleapis.com/v2/${opName}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const opData = await opRes.json();
    if (opData.done) {
      if (opData.error) {
        throw new Error(`Cloud Run deployment failed: ${JSON.stringify(opData.error)}`);
      }
      const readyRev = opData.metadata?.latestReadyRevision?.split('/').pop();
      console.log(`\n🎉 SUCCESS! Revision ${readyRev} is 100% active and live!`);
      break;
    }
  }
}

main().catch((err) => {
  console.error('\n❌ Deployment failed:', err.message);
  process.exit(1);
});
