import fs from 'fs';
import path from 'path';

const ENV_FILE_NAMES = ['.env', '.env.local'];

function parseEnvLine(line: string) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const separatorIndex = trimmed.indexOf('=');

  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function getEnvSearchDirs() {
  return Array.from(
    new Set([
      process.cwd(),
      path.resolve(process.cwd(), 'server'),
      __dirname,
      path.resolve(__dirname, '..'),
    ]),
  );
}

function loadEnvFiles() {
  const loadedFiles: string[] = [];
  const originalEnvKeys = new Set(Object.keys(process.env));

  for (const dir of getEnvSearchDirs()) {
    for (const fileName of ENV_FILE_NAMES) {
      const filePath = path.resolve(dir, fileName);

      if (!fs.existsSync(filePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');

      for (const line of content.split(/\r?\n/)) {
        const entry = parseEnvLine(line);

        if (!entry || originalEnvKeys.has(entry.key)) {
          continue;
        }

        process.env[entry.key] = entry.value;
      }

      loadedFiles.push(filePath);
    }
  }

  return loadedFiles;
}

function parsePort(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCorsOrigin(value: string | undefined) {
  const normalized = value?.trim();

  if (!normalized || normalized === '*') {
    return '*';
  }

  const origins = normalized
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (origins.length <= 1) {
    return origins[0] ?? '*';
  }

  return origins;
}

export const loadedEnvFiles = loadEnvFiles();

export const serverEnv = {
  port: parsePort(process.env.PORT, 5011),
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? '',
  deepseekApiUrl:
    process.env.DEEPSEEK_API_URL?.trim() ?? 'https://api.deepseek.com/chat/completions',
  deepseekModel: process.env.DEEPSEEK_MODEL?.trim() ?? 'deepseek-chat',
};
