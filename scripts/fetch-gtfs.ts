/**
 * Downloads and extracts TTC GTFS static data from Toronto Open Data if not already present
 * or if the data is older than MAX_GTFS_AGE_DAYS. Run via `npm start` before the server.
 */
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

const DATA_DIR  = path.join(__dirname, '..', 'data');
const GTFS_DIR  = path.join(DATA_DIR, 'gtfs');
const SENTINEL  = path.join(GTFS_DIR, 'stops.txt');
const CKAN_PACKAGE_URL =
  'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-routes-and-schedules';
const MAX_GTFS_AGE_DAYS = 45;

interface CkanResource { name: string; url: string; format: string; }
interface CkanResponse  { result: { resources: CkanResource[] }; }

function isStale(): boolean {
  if (!fs.existsSync(SENTINEL)) return true;
  const ageDays = (Date.now() - fs.statSync(SENTINEL).mtimeMs) / 86_400_000;
  return ageDays > MAX_GTFS_AGE_DAYS;
}

async function main(): Promise<void> {
  if (!isStale()) {
    console.log('[fetch-gtfs] GTFS data present and fresh — skipping download.');
    return;
  }

  const reason = fs.existsSync(SENTINEL)
    ? `data is older than ${MAX_GTFS_AGE_DAYS} days`
    : 'data missing';
  console.log(`[fetch-gtfs] Fetching GTFS from Toronto Open Data (${reason})...`);
  fs.mkdirSync(GTFS_DIR, { recursive: true });

  const metaResp = await fetch(CKAN_PACKAGE_URL);
  if (!metaResp.ok) throw new Error(`CKAN API error: ${metaResp.status}`);
  const meta = (await metaResp.json()) as CkanResponse;

  const resource = meta.result.resources.find(
    r => r.format.toUpperCase() === 'ZIP' || r.name.toLowerCase().includes('gtfs'),
  );
  if (!resource) throw new Error('Could not find GTFS ZIP in Toronto Open Data package.');

  console.log(`[fetch-gtfs] Downloading from ${resource.url}`);
  const zipResp = await fetch(resource.url);
  if (!zipResp.ok) throw new Error(`Download failed: ${zipResp.status}`);

  const buffer = Buffer.from(await zipResp.arrayBuffer());
  const zip = new AdmZip(buffer);
  zip.extractAllTo(GTFS_DIR, true);

  console.log(`[fetch-gtfs] Extracted ${zip.getEntries().length} files to ${GTFS_DIR}`);
}

main().catch(err => {
  console.error('[fetch-gtfs] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
