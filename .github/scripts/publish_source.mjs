import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repository = 'nanoodlecom/nanoodle-mcp';
const packageName = 'nanoodle-mcp';
const validVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function output(executable, args, input) {
  return execFileSync(executable, args, { encoding: 'utf8', input }).trim();
}

function isSourceRecovery() {
  return process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.SOURCE_ONLY === 'true';
}

function qualify(packReport, before) {
  const [packed] = JSON.parse(readFileSync(packReport, 'utf8'));
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const version = packed.version;
  if (packed.name !== packageName || packed.filename !== packageName + '-' + version + '.tgz' ||
      manifest.name !== packageName || manifest.version !== version || !validVersion.test(version)) {
    throw new Error('Source version differs from the tested npm distribution');
  }
  if (isSourceRecovery()) {
    if (process.env.REQUESTED_VERSION !== version) {
      throw new Error('Requested source version differs from the tested npm distribution');
    }
    console.log('source_version=' + version);
    return;
  }
  if (!before || before === '0'.repeat(40)) return;
  if (!/^[0-9a-f]{40}$/.test(before)) throw new Error('Expected the full commit before the main push');

  const previous = JSON.parse(output('git', ['show', before + ':package.json']));
  if (previous.version !== version) console.log('source_version=' + version);
}

function tagCommit(tag) {
  const ref = 'refs/tags/' + tag;
  const peeled = ref + '^{}';
  const lines = output('git', ['ls-remote', 'https://github.com/' + repository + '.git', ref, peeled]);
  const refs = new Map(lines.split('\n').filter(Boolean).map((line) => {
    const [sha, name] = line.split('\t');
    return [name, sha];
  }));
  return refs.get(peeled) ?? refs.get(ref);
}

function releaseRecord(tag) {
  const pages = output('gh', [
    'api', '--paginate', 'repos/' + repository + '/releases?per_page=100',
    '--jq', '[.[] | select(.tag_name == ' + JSON.stringify(tag) + ')]',
  ]);
  const records = pages.split('\n').filter(Boolean).flatMap((page) => JSON.parse(page));
  if (records.length > 1) throw new Error('Multiple releases use tag ' + tag);
  return records[0];
}

function publish(version) {
  const { GITHUB_SHA: source, GITHUB_RUN_ID: run, REQUESTED_VERSION: requested } = process.env;
  const recovery = isSourceRecovery() && requested === version;
  if (
    process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/main' ||
    (process.env.GITHUB_EVENT_NAME !== 'push' && !recovery) || !/^[0-9a-f]{40}$/.test(source) ||
    source !== output('git', ['rev-parse', 'HEAD']) || !validVersion.test(version)
  ) {
    throw new Error('Expected a tested main release from ' + repository);
  }
  const tag = 'v' + version;
  const prerelease = version.includes('-');
  const current = tagCommit(tag);
  if (current && current !== source) {
    throw new Error(tag + ' already points to ' + current + '. Use a new version.');
  }
  const existing = releaseRecord(tag);
  if (existing) {
    if (current !== source || existing.draft || existing.prerelease !== prerelease) {
      throw new Error('Existing release state requires review for ' + tag);
    }
    console.log(existing.html_url);
    return;
  }
  if (!current) {
    output('gh', [
      'api', '--method', 'POST', 'repos/' + repository + '/git/refs',
      '-f', 'ref=refs/tags/' + tag, '-f', 'sha=' + source,
    ]);
  }
  if (tagCommit(tag) !== source) throw new Error(tag + ' does not point to the tested commit');
  const payload = {
    tag_name: tag,
    target_commitish: source,
    name: packageName + ' ' + tag,
    generate_release_notes: true,
    prerelease,
    body: 'Tested GitHub source release from commit ' + source + '.\n\n[Node and packaging checks](https://github.com/' +
      repository + '/actions/runs/' + run + ')',
  };
  const record = JSON.parse(output(
    'gh', ['api', '--method', 'POST', 'repos/' + repository + '/releases', '--input', '-'],
    JSON.stringify(payload),
  ));
  if (record.tag_name !== tag || record.draft || record.prerelease !== prerelease || tagCommit(tag) !== source) {
    throw new Error('Unexpected published release state for ' + tag);
  }
  console.log(record.html_url);
}

const [operation, version] = process.argv.slice(2);
if (operation === 'qualify') qualify(version, process.env.BEFORE_SHA);
else if (operation === 'publish') publish(version);
else throw new Error('Expected qualify or publish');
