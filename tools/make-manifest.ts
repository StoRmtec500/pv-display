/**
 * Erzeugt das manifest.json für das ESPHome-Update (`update: platform: http_request`)
 * und gleichzeitig für ESP Web Tools (Erstinstallation per Browser).
 *
 * Aufruf:
 *   tsx tools/make-manifest.ts \
 *     --dir site/pv-display --base-url https://update.mksoft.at/pv-display \
 *     --name "PV Display" --version 1.2.0 \
 *     --ota pv-display-1.2.0.ota.bin --factory pv-display-1.2.0.factory.bin \
 *     --summary "Energiefluss-Seite" --release-url https://github.com/...
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

interface OtaInfo {
  path: string;
  md5: string;
  summary: string;
  release_url?: string;
}

interface FlashPart {
  path: string;
  offset: number;
}

interface ManifestBuild {
  chipFamily: 'ESP32-S3';
  ota: OtaInfo;
  parts: FlashPart[];
}

interface Manifest {
  name: string;
  version: string;
  home_assistant_domain: 'esphome';
  new_install_prompt_erase: boolean;
  builds: ManifestBuild[];
}

interface CliOptions {
  dir: string;
  baseUrl: string;
  name: string;
  version: string;
  ota: string;
  factory: string;
  summary: string;
  releaseUrl?: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      'base-url': { type: 'string' },
      name: { type: 'string' },
      version: { type: 'string' },
      ota: { type: 'string' },
      factory: { type: 'string' },
      summary: { type: 'string' },
      'release-url': { type: 'string' },
    },
    strict: true,
  });

  const required = ['dir', 'base-url', 'name', 'version', 'ota', 'factory'] as const;
  const missing = required.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new Error(`Fehlende Parameter: ${missing.map((m) => `--${m}`).join(', ')}`);
  }

  const version = values.version as string;
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Ungültige Version "${version}" – erwartet z. B. 1.2.0 oder 1.2.0-beta.1`);
  }

  return {
    dir: values.dir as string,
    baseUrl: (values['base-url'] as string).replace(/\/+$/, ''),
    name: values.name as string,
    version,
    ota: values.ota as string,
    factory: values.factory as string,
    summary: values.summary?.trim() || `Version ${version}`,
    releaseUrl: values['release-url'] || undefined,
  };
}

async function md5Of(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  if (data.length === 0) throw new Error(`Datei ist leer: ${filePath}`);
  return createHash('md5').update(data).digest('hex');
}

async function main(): Promise<void> {
  const opts = readOptions();
  const md5 = await md5Of(join(opts.dir, opts.ota));
  await md5Of(join(opts.dir, opts.factory)); // nur Existenz/Inhalt prüfen

  const manifest: Manifest = {
    name: opts.name,
    version: opts.version,
    home_assistant_domain: 'esphome',
    new_install_prompt_erase: true,
    builds: [
      {
        chipFamily: 'ESP32-S3',
        ota: {
          path: `${opts.baseUrl}/${opts.ota}`,
          md5,
          summary: opts.summary,
          ...(opts.releaseUrl ? { release_url: opts.releaseUrl } : {}),
        },
        parts: [{ path: `${opts.baseUrl}/${opts.factory}`, offset: 0 }],
      },
    ],
  };

  const target = join(opts.dir, 'manifest.json');
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`manifest.json geschrieben: ${opts.name} ${opts.version} (md5 ${md5})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
