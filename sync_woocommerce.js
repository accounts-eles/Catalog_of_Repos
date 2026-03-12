/**
 * sync_woocommerce.js
 *
 * Reads all public repos from accounts-eles GitHub org.
 * Groups them by Topic (e.g. jan26, feb26).
 * For each topic/bundle:
 *   - Builds description from each repo's About field
 *   - Uploads first repo's thumbnail to WooCommerce media library
 *   - Creates or updates the WooCommerce product
 *
 * Sits alongside generate_preview_script.js in the repo root.
 * Uses ORG_PAT_TOKEN consistent with the existing workflow.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// --- Configuration ---
const TARGET_ORG = 'accounts-eles';
const CATALOG_REPO = 'Catalog_of_Repos';
const PREVIEWS_DIR = path.join(__dirname, 'previews');
const BUNDLE_PRICE = '49.95';

// Read from environment (set as GitHub Secrets)
const GITHUB_TOKEN = process.env.ORG_PAT_TOKEN;       // Reuse existing secret
const WC_URL = process.env.WOOCOMMERCE_URL;
const WC_KEY = process.env.WOOCOMMERCE_CONSUMER_KEY;
const WC_SECRET = process.env.WOOCOMMERCE_CONSUMER_SECRET;

// Validate required environment variables
function validateEnv() {
  const missing = [];
  if (!GITHUB_TOKEN) missing.push('ORG_PAT_TOKEN');
  if (!WC_URL) missing.push('WOOCOMMERCE_URL');
  if (!WC_KEY) missing.push('WOOCOMMERCE_CONSUMER_KEY');
  if (!WC_SECRET) missing.push('WOOCOMMERCE_CONSUMER_SECRET');

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// GitHub API client
const ghHeaders = {
  'Authorization': `token ${GITHUB_TOKEN}`,
  'User-Agent': 'GitHub-Actions-WooCommerce-Sync',
  // Required to get topics in repo response
  'Accept': 'application/vnd.github.mercy-preview+json',
};

// WooCommerce API client
const wcApi = axios.create({
  baseURL: `${WC_URL}/wp-json/wc/v3`,
  auth: { username: WC_KEY, password: WC_SECRET },
});

// ─────────────────────────────────────────────
// GitHub helpers
// ─────────────────────────────────────────────

/**
 * Fetch all public repos for the org, with topics and about fields
 */
async function fetchAllRepos() {
  const repos = [];
  let page = 1;

  while (true) {
    const response = await axios.get(
      `https://api.github.com/user/repos`,
      {
        headers: ghHeaders,
        params: { per_page: 100, page },
      }
    );

    if (response.data.length === 0) break;

    // Filter to target org only, exclude catalog repo
    const filtered = response.data.filter(
      repo =>
        repo.owner.login === TARGET_ORG &&
        repo.name !== CATALOG_REPO
    );

    repos.push(...filtered);
    page++;

    // Check if there are more pages
    const link = response.headers['link'] || '';
    if (!link.includes('rel="next"')) break;
  }

  console.log(`📦 Found ${repos.length} repos in ${TARGET_ORG}`);
  return repos;
}

/**
 * Group repos by topic
 * Returns: { 'jan26': [repo1, repo2], 'feb26': [...] }
 * Repos with no topics are skipped
 */
function groupReposByTopic(repos) {
  const bundles = {};

  for (const repo of repos) {
    const topics = repo.topics || [];
    if (topics.length === 0) {
      console.log(`  ⚠️  ${repo.name} has no topics — skipping`);
      continue;
    }

    for (const topic of topics) {
      if (!bundles[topic]) bundles[topic] = [];
      bundles[topic].push(repo);
    }
  }

  return bundles;
}

// ─────────────────────────────────────────────
// WooCommerce helpers
// ─────────────────────────────────────────────

/**
 * Upload a thumbnail PNG to WordPress media library
 * Returns { id, src } or null on failure
 */
async function uploadThumbnail(repoName) {
  const imagePath = path.join(PREVIEWS_DIR, `${repoName}.png`);

  if (!fs.existsSync(imagePath)) {
    console.warn(`  ⚠️  No thumbnail found for: ${repoName}`);
    return null;
  }

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(imagePath), {
      filename: `${repoName}.png`,
      contentType: 'image/png',
    });

    const response = await axios.post(
      `${WC_URL}/wp-json/wp/v2/media`,
      form,
      {
        auth: { username: WC_KEY, password: WC_SECRET },
        headers: form.getHeaders(),
      }
    );

    console.log(`  🖼️  Thumbnail uploaded: ${repoName}.png`);
    return { id: response.data.id, src: response.data.source_url };
  } catch (error) {
    console.warn(`  ⚠️  Thumbnail upload failed for ${repoName}: ${error.message}`);
    return null;
  }
}

/**
 * Find existing WooCommerce product by SKU
 * Returns product ID or null
 */
async function findExistingProduct(sku) {
  try {
    const response = await wcApi.get('/products', { params: { sku } });
    return response.data.length > 0 ? response.data[0].id : null;
  } catch (error) {
    console.warn(`  ⚠️  Product search failed for SKU ${sku}: ${error.message}`);
    return null;
  }
}

/**
 * Build HTML product description from repo About fields
 */
function buildDescription(bundleName, repos) {
  const repoList = repos
    .map(repo => {
      const about = repo.description
        ? repo.description
        : '<em>No description available</em>';
      return `<li><strong>${repo.name}</strong> — ${about}</li>`;
    })
    .join('\n');

  return `
<p>The <strong>${bundleName.toUpperCase()}</strong> bundle contains <strong>${repos.length} HTML applications</strong>.</p>
<h3>What's included:</h3>
<ul>
${repoList}
</ul>
  `.trim();
}

/**
 * Create or update a WooCommerce product for a bundle
 */
async function syncProduct(bundleName, repos) {
  const sku = bundleName.toLowerCase();
  const title = `${bundleName.toUpperCase()} HTML Bundle`;
  const description = buildDescription(bundleName, repos);
  const shortDescription = `${repos.length} HTML applications — ${bundleName.toUpperCase()} bundle.`;

  // Use first repo's thumbnail as the product image
  const thumbnail = await uploadThumbnail(repos[0].name);

  const productData = {
    name: title,
    type: 'simple',
    status: 'publish',
    description,
    short_description: shortDescription,
    sku,
    regular_price: BUNDLE_PRICE,
    virtual: true,
    downloadable: false, // Download to be configured separately with Kathryn
  };

  if (thumbnail) {
    productData.images = [{ id: thumbnail.id }];
  }

  const existingId = await findExistingProduct(sku);

  if (existingId) {
    await wcApi.put(`/products/${existingId}`, productData);
    console.log(`  ✅ Updated: ${title} (ID: ${existingId})`);
  } else {
    const response = await wcApi.post('/products', productData);
    console.log(`  ✅ Created: ${title} (ID: ${response.data.id})`);
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log('🔍 Starting WooCommerce sync...\n');

  validateEnv();

  const repos = await fetchAllRepos();
  const bundles = groupReposByTopic(repos);
  const bundleNames = Object.keys(bundles);

  if (bundleNames.length === 0) {
    console.log('⚠️  No bundles found (no repos with topics). Exiting.');
    return;
  }

  console.log(`\n🗂️  Bundles to sync: ${bundleNames.join(', ')}\n`);

  for (const bundleName of bundleNames) {
    console.log(`⚙️  Processing: ${bundleName.toUpperCase()} (${bundles[bundleName].length} repos)`);
    await syncProduct(bundleName, bundles[bundleName]);
    console.log('');
  }

  console.log('🎉 WooCommerce sync complete');
}

main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
