#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(repoRoot, 'data', 'profile-config.json');
const outputPath = path.join(repoRoot, 'data', 'profile-live.json');
const cachePath = path.join(repoRoot, 'data', 'public-repos-cache.json');
const readmePath = path.join(repoRoot, 'README.md');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(token.slice(2), next);
    i += 1;
  } else {
    args.set(token.slice(2), 'true');
  }
}

const owner = args.get('owner') || 'avivlyweb';
const writeMode = args.get('write') === 'true';
const limit = Number.parseInt(args.get('limit') || '6', 10);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const loadJson = async (filePath, fallback) => {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
};

const replaceSection = (source, startMarker, endMarker, replacement) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Missing README markers: ${startMarker} / ${endMarker}`);
  }

  const before = source.slice(0, start + startMarker.length);
  const after = source.slice(end);
  return `${before}\n${replacement}\n${after}`;
};

const escapeHtml = (value) =>
  (value || '')
    .toString()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const formatDate = (isoString) => {
  if (!isoString) return 'date unavailable';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'date unavailable';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
};

const config = await loadJson(configPath, {
  owner,
  recentWorkLimit: limit,
  featuredCreation: { repo: 'prettig-thuis', caption: 'Latest creation', summary: 'A calm, trust-heavy Base44 app for care, routines, and home support.' },
  featuredUpdate: { repo: 'pubmed-gemini-extension', caption: 'Latest meaningful update', summary: 'A stronger research layer for PubMed workflows.' },
  excludeRepos: [],
  keywordBoosts: [],
  boilerplateNameTokens: []
});

const normalize = (value) => (value || '').toString().trim().toLowerCase();
const tokens = (value) => normalize(value).split(/[^a-z0-9]+/g).filter(Boolean);

const isMeaningfulRepo = (repo) => {
  if (!repo || repo.archived || repo.fork) return false;
  const name = normalize(repo.name);
  const description = normalize(repo.description);
  const homepage = normalize(repo.homepage);
  const allText = `${name} ${description} ${homepage}`;

  if ((config.excludeRepos || []).map(normalize).includes(name)) return false;
  if ((config.boilerplateNameTokens || []).some((needle) => name.includes(needle))) {
    const highSignal = (config.keywordBoosts || []).some((needle) => allText.includes(needle));
    if (!highSignal) return false;
  }
  if (!repo.description && !repo.homepage && repo.stargazers_count === 0) {
    const highSignal = (config.keywordBoosts || []).some((needle) => name.includes(needle));
    if (!highSignal) return false;
  }
  return true;
};

const scoreRepo = (repo) => {
  const pushedAt = new Date(repo.pushed_at || repo.updated_at || 0).getTime();
  const ageDays = Number.isFinite(pushedAt) ? Math.max(0, (Date.now() - pushedAt) / 86400000) : 9999;
  let score = 1000 - ageDays;
  if (repo.description) score += 50;
  if (repo.homepage) score += 35;
  if ((repo.stargazers_count || 0) > 0) score += Math.min(40, repo.stargazers_count * 8);
  const text = `${repo.name} ${repo.description || ''} ${repo.homepage || ''}`.toLowerCase();
  for (const keyword of config.keywordBoosts || []) {
    if (text.includes(keyword.toLowerCase())) score += 25;
  }
  if (repo.fork) score -= 100;
  if (repo.archived) score -= 120;
  if ((config.excludeRepos || []).map(normalize).includes(normalize(repo.name))) score -= 1000;
  return score;
};

const fetchRepos = async () => {
  const url = new URL(`https://api.github.com/users/${owner}/repos`);
  url.searchParams.set('per_page', '100');
  url.searchParams.set('sort', 'pushed');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('type', 'owner');

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`GitHub API request failed (${response.status}): ${detail}`);
    }

    return response.json();
  } catch (error) {
    if (error instanceof Error && error.message.includes('fetch failed')) {
      const cache = await loadJson(cachePath, null);
      if (cache) return cache;
      try {
        const ghOutput = execFileSync(
          'gh',
          ['api', `users/${owner}/repos?per_page=100&sort=pushed&direction=desc&type=owner`],
          {
            encoding: 'utf8'
          }
        );
        return JSON.parse(ghOutput);
      } catch (ghError) {
        throw ghError;
      }
    }
    throw error;
  }
};

const formatRepo = (repo) => ({
  name: repo.name,
  fullName: repo.full_name,
  url: repo.html_url,
  homepage: repo.homepage || null,
  description: repo.description || null,
  pushedAt: repo.pushed_at || null,
  stars: repo.stargazers_count || 0,
  language: repo.language || null
});

const enrichFeatured = (repos, item, fallbackLabel) => {
  const match = repos.find((repo) => normalize(repo.name) === normalize(item.repo));
  if (!match) {
    return {
      caption: item.caption || fallbackLabel,
      repo: item.repo,
      title: item.repo,
      summary: item.summary || null,
      url: `https://github.com/${owner}/${item.repo}`,
      source: 'manual'
    };
  }

  return {
    caption: item.caption || fallbackLabel,
    repo: match.name,
    title: match.name,
    summary: item.summary || match.description || null,
    url: match.html_url,
    homepage: match.homepage || null,
    pushedAt: match.pushed_at || null,
    stars: match.stargazers_count || 0,
    source: 'manual+live'
  };
};

const buildLatestSignalMarkup = (payload) => {
  const creation = payload.featuredCreation;
  const update = payload.featuredUpdate;

  return `<table>
  <tr>
    <td width="50%" valign="top">
      <h3>${escapeHtml(creation.caption)}</h3>
      <p><strong><a href="${escapeHtml(creation.url)}">${escapeHtml(creation.title)}</a></strong><br />
      ${escapeHtml(creation.summary || 'No summary yet.')}</p>
      <p><sub>Last public signal: ${escapeHtml(formatDate(creation.pushedAt))}</sub></p>
    </td>
    <td width="50%" valign="top">
      <h3>${escapeHtml(update.caption)}</h3>
      <p><strong><a href="${escapeHtml(update.url)}">${escapeHtml(update.title)}</a></strong><br />
      ${escapeHtml(update.summary || 'No summary yet.')}</p>
      <p><sub>Last public signal: ${escapeHtml(formatDate(update.pushedAt))}</sub></p>
    </td>
  </tr>
</table>`;
};

const buildLiveLabFeedMarkup = (payload) => {
  const rows = payload.recentPublicWork
    .map((repo) => {
      const description = repo.description || 'Public work worth surfacing.';
      return `| [${repo.name}](${repo.url}) | ${description} | ${repo.signal} | ${formatDate(repo.pushedAt)} |`;
    })
    .join('\n');

  return `> Auto-refreshed from public repo activity on ${formatDate(payload.generatedAt)}. Recency is filtered for signal, not just noise.

| Repo | What changed matters | Signal | Updated |
| --- | --- | --- | --- |
${rows}`;
};

const main = async () => {
  const repos = await fetchRepos();
  const usable = repos.filter(isMeaningfulRepo).sort((a, b) => scoreRepo(b) - scoreRepo(a));

  const recentPublicWork = usable.slice(0, Number.isFinite(limit) ? limit : 6).map((repo) => {
    const text = `${repo.name} ${repo.description || ''} ${repo.homepage || ''}`.toLowerCase();
    const matchedKeywords = (config.keywordBoosts || []).filter((keyword) => text.includes(keyword.toLowerCase()));
    const signal = matchedKeywords.length ? matchedKeywords.slice(0, 2).join(', ') : 'recent public work';
    return {
      ...formatRepo(repo),
      signal,
      signalScore: scoreRepo(repo),
      highlight: repo.description ? 'described' : 'quiet',
      matchedKeywords
    };
  });

  const featuredCreation = enrichFeatured(usable, config.featuredCreation || {}, 'Latest creation');
  const featuredUpdate = enrichFeatured(usable, config.featuredUpdate || {}, 'Latest meaningful update');

  const payload = {
    generatedAt: new Date().toISOString(),
    owner,
    source: 'GitHub public repos API',
    totalPublicRepos: repos.length,
    meaningfulRepos: usable.length,
    featuredCreation,
    featuredUpdate,
    recentPublicWork,
    meta: {
      recentWorkLimit: Number.isFinite(limit) ? limit : 6,
      excludeRepos: config.excludeRepos || [],
      keywordBoosts: config.keywordBoosts || []
    }
  };

  if (writeMode) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeFile(cachePath, `${JSON.stringify(repos, null, 2)}\n`, 'utf8');

    const readme = await readFile(readmePath, 'utf8');
    const nextReadme = replaceSection(
      replaceSection(
        readme,
        '<!--LATEST-SIGNAL-START-->',
        '<!--LATEST-SIGNAL-END-->',
        buildLatestSignalMarkup(payload)
      ),
      '<!--LIVE-LAB-FEED-START-->',
      '<!--LIVE-LAB-FEED-END-->',
      buildLiveLabFeedMarkup(payload)
    );
    await writeFile(readmePath, nextReadme, 'utf8');
  } else {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
