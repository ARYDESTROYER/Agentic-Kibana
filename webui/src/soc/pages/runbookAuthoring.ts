/** Immediate client mirror of the backend Runbook submission policy. */
export const RUNBOOK_BODY_MAX_CHARS = 1_800;
export const RUNBOOK_TITLE_MAX_CHARS = 120;
export const RUNBOOK_SUMMARY_MAX_CHARS = 280;
export const RUNBOOK_PERSONA_MAX_CHARS = 48;
export const RUNBOOK_LIST_MAX_ITEMS = 12;
export const RUNBOOK_LIST_ITEM_MAX_CHARS = 64;
export const RUNBOOK_DESCRIPTOR_MAX_CHARS = 1_200;

export const RUNBOOK_REQUIRED_SECTIONS = [
  'SIGNAL',
  'EVIDENCE REQUIRED',
  'INVESTIGATION STEPS',
  'TRUE POSITIVE SIGNALS',
  'FALSE POSITIVE SIGNALS',
  'NEEDS HUMAN WHEN',
  'RECOMMENDED NEXT ACTION',
] as const;
export const RUNBOOK_OPTIONAL_SECTION = 'LIMITATIONS';

const ALL_LABELS = [...RUNBOOK_REQUIRED_SECTIONS, RUNBOOK_OPTIONAL_SECTION] as const;
const ALLOWED_FIELDS = new Set([
  'id',
  'title',
  'summary',
  'persona',
  'applies_to_rules',
  'applies_to_techniques',
  'applies_to_entities',
  'keywords',
]);
const LIST_FIELDS = [
  'applies_to_rules',
  'applies_to_techniques',
  'applies_to_entities',
  'keywords',
] as const;
const RUNBOOK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MITRE = /^T\d{4}(?:\.\d{3})?$/;
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const RESERVED_IDS = new Set(['readme', 'index', 'reindex']);
const MAX_DOCUMENT_BYTES = 128 * 1024;
const MIN_CONTENT_CHARS = 12;
const PLACEHOLDER = /(?:\[(?:describe|add|enter|explain|list|replace|write|provide|insert)[^\]\n]{0,100}\]|\b(?:todo|tbd|placeholder|lorem ipsum)\b)/i;

export interface RunbookAuthoringIssue {
  code: string;
  field: string;
  problem: string;
  reason: string;
  fix: string;
}

export interface RunbookAuthoringValidation {
  body: string;
  bodyCharacters: number;
  descriptorCharacters: number;
  issues: RunbookAuthoringIssue[];
}

interface ParsedDocument {
  hasFrontmatter: boolean;
  body: string;
  manifest: string;
  scalars: Map<string, string>;
  lists: Map<string, string[]>;
}

function pushIssue(issues: RunbookAuthoringIssue[], issue: RunbookAuthoringIssue): void {
  const key = `${issue.code}:${issue.field}`;
  if (!issues.some((candidate) => `${candidate.code}:${candidate.field}` === key)) {
    issues.push(issue);
  }
}

function issue(
  code: string,
  field: string,
  problem: string,
  reason: string,
  fix: string,
): RunbookAuthoringIssue {
  return { code, field, problem, reason, fix };
}

function unquote(value: string): string {
  const text = value.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function inlineValues(value: string): string[] {
  const text = value.trim();
  const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return inner.split(',').map(unquote).filter(Boolean);
}

function parseDocument(content: string): ParsedDocument {
  const normalized = content.replace(/^\uFEFF+/, '').replace(/\r\n?/g, '\n');
  const match = FRONTMATTER.exec(normalized);
  if (!match) {
    return {
      hasFrontmatter: false,
      body: normalized.trim(),
      manifest: '',
      scalars: new Map(),
      lists: new Map(),
    };
  }

  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let activeList = '';
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('- ') && activeList) {
      lists.set(activeList, [...(lists.get(activeList) ?? []), unquote(line.trimStart().slice(2))]);
      continue;
    }
    activeList = '';
    if (!line.includes(':')) continue;
    const separator = line.indexOf(':');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) {
      activeList = key;
      lists.set(key, []);
    } else if (value.startsWith('[')) {
      lists.set(key, inlineValues(value));
    } else {
      scalars.set(key, unquote(value));
    }
  }
  return {
    hasFrontmatter: true,
    body: match[2].trim(),
    manifest: match[1],
    scalars,
    lists,
  };
}

function values(parsed: ParsedDocument, field: string): string[] {
  if (parsed.lists.has(field)) return parsed.lists.get(field) ?? [];
  const scalar = parsed.scalars.get(field)?.trim();
  return scalar ? [scalar] : [];
}

function retrievalDescriptorCharacters(parsed: ParsedDocument): number {
  const title = values(parsed, 'title')[0] ?? '';
  const summary = values(parsed, 'summary')[0] ?? '';
  const parts = [`${title}.`, summary];
  const groups: Array<[string, string]> = [
    ['keywords', 'Keywords'],
    ['applies_to_rules', 'Rules'],
    ['applies_to_techniques', 'MITRE'],
    ['applies_to_entities', 'Entities'],
  ];
  for (const [field, label] of groups) {
    const entries = values(parsed, field);
    if (entries.length) parts.push(`${label}: ${entries.join(', ')}.`);
  }
  const labelled = parts.filter(Boolean).join(' ').trim();
  const compact = [
    title,
    summary,
    values(parsed, 'keywords').join(' '),
    values(parsed, 'applies_to_rules').join(' '),
    values(parsed, 'applies_to_techniques').join(' '),
    values(parsed, 'applies_to_entities').join(' '),
    values(parsed, 'persona')[0] ?? '',
  ].filter(Boolean).join(' ').trim();
  return Math.max(Array.from(labelled).length, Array.from(compact).length);
}

const META_FORMATS: Array<[string, RegExp, string, string]> = [
  ['bold', /\*\*[^*\n]+\*\*|__[^_\n]+__/, 'Bold formatting is not allowed.', 'Remove the paired ** or __ markers.'],
  ['italic', /(?<!\*)\*(?!\*)(?=\S)[^*\n]*?\S\*(?!\*)|(?<![\w_])_(?!_)(?=\S)[^_\n]*?\S_(?![\w_])/, 'Italic formatting is not allowed.', 'Remove the paired * or _ markers; ordinary field_name underscores are valid.'],
  ['underline', /<\/?u(?:\s[^<>]*)?>|\+\+[^+\n]+\+\+/i, 'Underline formatting is not allowed.', 'Remove underline markup.'],
  ['strikethrough', /~~[^~\n]+~~/, 'Strikethrough formatting is not allowed.', 'Delete obsolete text instead of crossing it out.'],
  ['code', /`/, 'Code formatting is not allowed.', 'Remove every backtick and retain only the plain-text value.'],
  ['link', /!?\[[^\]\n]*\]\([^\n)]*\)|!?\[[^\]\n]+\]\[[^\]\n]*\]|<(?:https?:\/\/|mailto:)[^>\n]+>/i, 'Link or image formatting is not allowed.', 'State the fact directly; a plain URL is allowed only when indispensable.'],
  ['html', /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/i, 'Raw HTML is not allowed.', 'Remove HTML tags and retain only their plain-text meaning.'],
  ['heading', /^\s{0,3}#{1,6}(?:\s|$)|^\s*\S.*\n\s*(?:=+|-+)\s*$/m, 'Heading formatting is not allowed.', 'Remove heading markers and use a concise plain-text value.'],
  ['table', /\|/, 'Table-like pipe characters are not allowed.', 'Replace the pipe expression with one concise value or separate list values.'],
];

function manifestSyntaxIssues(parsed: ParsedDocument): RunbookAuthoringIssue[] {
  const issues: RunbookAuthoringIssue[] = [];
  const seen = new Set<string>();
  let activeList = false;
  parsed.manifest.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    if (line.trimStart().startsWith('- ') && activeList) return;
    activeList = false;
    if (!line.includes(':')) {
      pushIssue(issues, issue(
        'manifest.syntax.invalid',
        'manifest',
        `Frontmatter line ${index + 2} is not a key: value entry.`,
        'Ignored metadata makes retrieval applicability incomplete.',
        'Write the field as key: value or remove the line.',
      ));
      return;
    }
    const separator = line.indexOf(':');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (seen.has(key)) {
      pushIssue(issues, issue(
        'manifest.field.duplicate', key || 'manifest',
        `Frontmatter field ${key || '(blank)'} is repeated.`,
        'Duplicate metadata is ambiguous and the last value would silently win.',
        `Keep exactly one ${key}: entry.`,
      ));
    }
    seen.add(key);
    if (!ALLOWED_FIELDS.has(key)) {
      pushIssue(issues, issue(
        'manifest.field.unsupported', key || 'manifest',
        `Frontmatter field ${key || '(blank)'} is not supported.`,
        'Unknown fields are not indexed and waste authoring context.',
        'Remove it or move its essential meaning into a supported field.',
      ));
    }
    const strippedValue = value.trim();
    if (strippedValue.startsWith('[') !== strippedValue.endsWith(']')) {
      pushIssue(issues, issue(
        'manifest.syntax.invalid_list', key || 'manifest',
        `Frontmatter list ${key || '(blank)'} has an unmatched square bracket.`,
        'Malformed lists can silently change retrieval metadata.',
        `Write ${key}: [value, value] with both brackets.`,
      ));
    }
    activeList = !value.trim();
  });
  return issues;
}

function metadataIssues(parsed: ParsedDocument, expectedId?: string): RunbookAuthoringIssue[] {
  if (!parsed.hasFrontmatter) {
    return [issue(
      'manifest.required', 'manifest', 'Frontmatter is missing or malformed.',
      'Applicability metadata is required for accurate retrieval.',
      'Begin and end the supported key: value fields with --- lines.',
    )];
  }
  const issues = manifestSyntaxIssues(parsed);
  for (const field of ['id', 'title', 'summary', 'persona'] as const) {
    if (parsed.lists.has(field)) {
      pushIssue(issues, issue(
        'manifest.field.type', field,
        `Frontmatter field ${field} must be one plain scalar value.`,
        'A list in a scalar field produces ambiguous catalog metadata.',
        `Write one line in the form ${field}: concise value.`,
      ));
    }
  }
  for (const field of ['id', 'title', 'summary'] as const) {
    if (!values(parsed, field).join('').trim()) {
      pushIssue(issues, issue(
        `manifest.${field}.required`, field,
        `Required frontmatter field ${field} is missing or empty.`,
        'High-signal metadata is needed for catalog discovery and retrieval.',
        `Add a concise ${field}: value to the frontmatter.`,
      ));
    }
  }
  for (const field of ['applies_to_rules', 'applies_to_entities', 'keywords'] as const) {
    if (!values(parsed, field).length) {
      pushIssue(issues, issue(
        `manifest.${field}.required`, field,
        `Required frontmatter field ${field} needs at least one value.`,
        'The agent uses this field to retrieve the runbook for the right signal.',
        `Add at least one specific value, for example ${field}: [value].`,
      ));
    }
  }

  const id = values(parsed, 'id')[0] ?? '';
  if (id && !RUNBOOK_ID.test(id)) {
    pushIssue(issues, issue(
      'manifest.id.invalid', 'id', 'The frontmatter id is not a valid lowercase slug.',
      'Stable ids are used for durable storage and retrieval document identifiers.',
      'Use 1–64 lowercase letters, numbers, hyphens, or underscores.',
    ));
  } else if (RESERVED_IDS.has(id)) {
    pushIssue(issues, issue(
      'manifest.id.reserved', 'id', `The runbook id ${id} is reserved.`,
      'Reserved ids are used by catalog operations.',
      'Choose a descriptive signal-family id that is not reserved.',
    ));
  }
  if (expectedId?.trim() && id && id !== expectedId.trim()) {
    pushIssue(issues, issue(
      'manifest.id.mismatch', 'id',
      `Frontmatter id ${id} does not match requested id ${expectedId.trim()}.`,
      'One stable id must identify both the stored record and retrieval document.',
      `Change the frontmatter line to id: ${expectedId.trim()}`,
    ));
  }

  for (const [field, maximum] of [
    ['title', RUNBOOK_TITLE_MAX_CHARS],
    ['summary', RUNBOOK_SUMMARY_MAX_CHARS],
    ['persona', RUNBOOK_PERSONA_MAX_CHARS],
  ] as const) {
    const value = values(parsed, field)[0] ?? '';
    if (Array.from(value).length > maximum) {
      pushIssue(issues, issue(
        `manifest.${field}.too_long`, field,
        `${field} is ${Array.from(value).length} characters; maximum is ${maximum}.`,
        'Bounded metadata keeps every retrieved descriptor concise.',
        `Shorten ${field} to ${maximum} characters or fewer.`,
      ));
    }
  }

  for (const field of LIST_FIELDS) {
    const entries = values(parsed, field);
    if (entries.length > RUNBOOK_LIST_MAX_ITEMS) {
      pushIssue(issues, issue(
        `manifest.${field}.too_many`, field,
        `${field} has ${entries.length} values; maximum is ${RUNBOOK_LIST_MAX_ITEMS}.`,
        'Broad metadata reduces retrieval precision and inflates every chunk.',
        'Keep only values that directly identify this signal family.',
      ));
    }
    if (entries.some((entry) => Array.from(entry).length > RUNBOOK_LIST_ITEM_MAX_CHARS)) {
      pushIssue(issues, issue(
        `manifest.${field}.item_too_long`, field,
        `A ${field} value exceeds ${RUNBOOK_LIST_ITEM_MAX_CHARS} characters.`,
        'Oversized tags inflate every retrieved runbook chunk.',
        `Shorten each value to ${RUNBOOK_LIST_ITEM_MAX_CHARS} characters or fewer.`,
      ));
    }
    const normalized = entries.map((entry) => entry.toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      pushIssue(issues, issue(
        `manifest.${field}.duplicate`, field,
        `${field} contains duplicate values.`,
        'Repeated metadata spends context without improving retrieval.',
        'Remove duplicate values, including duplicates that differ only by letter case.',
      ));
    }
  }
  if (values(parsed, 'applies_to_techniques').some((entry) => !MITRE.test(entry))) {
    pushIssue(issues, issue(
      'manifest.applies_to_techniques.invalid', 'applies_to_techniques',
      'One or more MITRE technique ids are invalid.',
      'Canonical ids improve exact retrieval and avoid invented techniques.',
      'Use ids such as T1234 or T1234.001, or remove the optional field.',
    ));
  }

  const descriptorCharacters = retrievalDescriptorCharacters(parsed);
  if (descriptorCharacters > RUNBOOK_DESCRIPTOR_MAX_CHARS) {
    pushIssue(issues, issue(
      'manifest.descriptor.too_long', 'manifest',
      `The combined retrieval metadata is ${descriptorCharacters} characters; maximum is ${RUNBOOK_DESCRIPTOR_MAX_CHARS}.`,
      'Metadata prefixes every retrieved guidance chunk, so an oversized descriptor increases inference cost on every match.',
      `Remove broad synonyms and keep only the most specific title, summary, rules, techniques, entities, and keywords until the combined descriptor is ${RUNBOOK_DESCRIPTOR_MAX_CHARS} characters or fewer.`,
    ));
  }

  for (const field of ['id', 'title', 'summary', 'persona', ...LIST_FIELDS]) {
    for (const value of values(parsed, field)) {
      if (PLACEHOLDER.test(value)) {
        pushIssue(issues, issue(
          `manifest.${field}.placeholder`, field,
          `${field} still contains placeholder text.`,
          'Placeholder metadata can retrieve this runbook for the wrong case.',
          `Replace the ${field} placeholder with a specific reviewed value.`,
        ));
      }
      for (const [name, pattern, problem, fix] of META_FORMATS) {
        if (pattern.test(value)) {
          pushIssue(issues, issue(
            `manifest.${field}.format.${name}`, field, problem,
            'Retrieval metadata must be concise plain text without presentation tokens.', fix,
          ));
        }
      }
    }
  }
  return issues;
}

const BODY_FORMATS: Array<[string, RegExp, string, string, string]> = [
  ['body.format.heading', /^\s{0,3}#{1,6}(?:\s|$)/m, 'Markdown headings are not allowed in the guidance body.', 'The fixed labels already provide structure; heading tokens add no agent value.', 'Remove # characters and use only the required uppercase labels.'],
  ['body.format.setext_heading', /^\s*\S.*\n\s*(?:=+|-+)\s*$/m, 'Setext-style Markdown headings are not allowed.', 'Underline-style headings spend context tokens and bypass the fixed structure.', 'Remove the === or --- underline and use the required label line.'],
  ['body.format.table', /\|/, 'Tables and table-like pipe syntax are not allowed.', 'Tables are token-dense and their row-to-header meaning is fragile in retrieval.', 'Remove pipe characters and rewrite each relevant row as a short plain sentence.'],
  ['body.format.bold', /\*\*[^*\n]+\*\*|__[^_\n]+__/, 'Bold Markdown is not allowed.', 'Emphasis markers consume context without changing the agent evidence.', 'Remove paired ** or __ markers and keep the words as plain text.'],
  ['body.format.italic', /(?<!\*)\*(?!\*)(?=\S)[^*\n]*?\S\*(?!\*)|(?<![\w_])_(?!_)(?=\S)[^_\n]*?\S_(?![\w_])/, 'Italic Markdown is not allowed.', 'Emphasis markers consume context without changing the agent evidence.', 'Remove paired emphasis markers; ordinary field_name underscores are valid.'],
  ['body.format.underline', /<\/?u(?:\s[^<>]*)?>|\+\+[^+\n]+\+\+/i, 'Underline formatting is not allowed.', 'Presentation markup consumes context and has no investigation meaning.', 'Remove underline markup and keep the words as plain text.'],
  ['body.format.strikethrough', /~~[^~\n]+~~/, 'Strikethrough Markdown is not allowed.', 'Deleted-looking text is ambiguous evidence and wastes context.', 'Delete obsolete text or replace it with the intended plain sentence.'],
  ['body.format.fenced_code', /^\s*(?:```|~~~)/m, 'Fenced code blocks are not allowed.', 'Large code blocks are expensive and can dominate the retrieved guidance.', 'Describe the required evidence or read-only query intent as a short sentence.'],
  ['body.format.inline_code', /`[^`\n]+`/, 'Inline code formatting is not allowed.', 'Backticks add presentation tokens without adding evidence.', 'Remove backticks and keep field names or values as plain text.'],
  ['body.format.indented_code', /^(?: {4}|\t)\S/m, 'Indented code blocks are not allowed.', 'Indented blocks are parsed as code and are inefficient retrieval context.', 'Remove indentation and express the instruction as one plain line.'],
  ['body.format.html', /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/i, 'Raw HTML is not allowed.', 'HTML is presentation markup and is not trusted as investigation guidance.', 'Remove the HTML tags and keep only the plain-text meaning.'],
  ['body.format.link', /!?\[[^\]\n]*\]\([^\n)]*\)|!?\[[^\]\n]+\]\[[^\]\n]*\]|^\s*\[[^\]\n]+\]:\s+\S+|<(?:https?:\/\/|mailto:)[^>\n]+>/im, 'Markdown links or images are not allowed.', 'Link markup adds context cost and can hide the actual evidence.', 'State the relevant fact directly; use a plain URL only when indispensable.'],
  ['body.format.blockquote', /^\s{0,3}>\s?/m, 'Markdown blockquotes are not allowed.', 'Quoted presentation is ambiguous in trusted operational guidance.', 'Rewrite the necessary fact as a direct plain sentence.'],
  ['body.format.task_list', /^\s*[-+*]\s+\[[ xX]\]\s+/m, 'Markdown task lists are not allowed.', 'Checkbox syntax is presentation state, not investigation evidence.', 'Use sequential numbered steps under INVESTIGATION STEPS.'],
  ['body.format.unordered_list', /^\s{0,3}[-+*]\s+/m, 'Markdown bullet lists are not allowed.', 'Fixed sections and numbered steps are cheaper and more deterministic to parse.', 'Remove the bullet marker and write one short plain sentence per line.'],
  ['body.format.horizontal_rule', /^\s{0,3}(?:([-*_])\s*){3,}$/m, 'Markdown horizontal rules are not allowed.', 'Separator markup consumes tokens; the fixed labels already separate concerns.', 'Remove the separator line.'],
];

function meaningful(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ').trim();
  return Array.from(compact).length >= MIN_CONTENT_CHARS && !PLACEHOLDER.test(compact);
}

function canonicalLabel(line: string): { label: string; exact: boolean } | null {
  const text = line.trim();
  const candidate = text.endsWith(':') ? text.slice(0, -1).trim() : text;
  const label = candidate.toUpperCase();
  return (ALL_LABELS as readonly string[]).includes(label) ? { label, exact: text === label } : null;
}

function structureIssues(body: string): RunbookAuthoringIssue[] {
  const issues: RunbookAuthoringIssue[] = [];
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const occurrences: Array<{ label: string; index: number }> = [];
  const positions = new Map<string, number[]>(ALL_LABELS.map((label) => [label, []]));
  lines.forEach((line, index) => {
    const parsed = canonicalLabel(line);
    if (parsed) {
      occurrences.push({ label: parsed.label, index });
      positions.get(parsed.label)?.push(index);
      if (!parsed.exact) pushIssue(issues, issue(
        'body.structure.label_format', `body.${parsed.label}`,
        `${parsed.label} must be uppercase, without punctuation, on its own line.`,
        'Exact labels make the guidance deterministic to validate and retrieve.',
        `Replace that line with exactly: ${parsed.label}`,
      ));
    } else if (/^[A-Z][A-Z0-9 _/&-]{2,}:?$/.test(line.trim())) {
      pushIssue(issues, issue(
        'body.structure.label_unknown', 'body',
        `Unknown section label ${line.trim()} was found.`,
        'Unrecognized sections break the fixed compact guidance scaffold.',
        `Move its essential content under one of: ${ALL_LABELS.join(', ')}.`,
      ));
    }
  });
  for (const label of RUNBOOK_REQUIRED_SECTIONS) {
    if (!(positions.get(label)?.length)) pushIssue(issues, issue(
      'body.structure.section_missing', `body.${label}`,
      `Required section ${label} is missing.`,
      'Every runbook must carry the same complete evidence and decision scaffold.',
      `Add ${label} on its own line in the required position, then add guidance below it.`,
    ));
  }
  for (const [label, indexes] of positions) {
    if (indexes.length > 1) pushIssue(issues, issue(
      'body.structure.section_duplicate', `body.${label}`,
      `Section ${label} appears more than once.`,
      'Duplicate sections waste context and make precedence ambiguous.',
      `Merge the guidance under one ${label} label.`,
    ));
  }
  const order = new Map<string, number>(ALL_LABELS.map((label, index) => [label, index]));
  const observed = [...positions.entries()].filter(([, indexes]) => indexes.length).sort((a, b) => a[1][0] - b[1][0]).map(([label]) => label);
  if (observed.some((label, index) => index > 0 && (order.get(label) ?? 0) < (order.get(observed[index - 1]) ?? 0))) {
    pushIssue(issues, issue(
      'body.structure.section_order', 'body', 'Body sections are not in the required order.',
      'Stable ordering reduces retrieval ambiguity for smaller models.',
      `Order the labels as: ${ALL_LABELS.join(' → ')}.`,
    ));
  }
  if (occurrences.length) {
    const first = Math.min(...occurrences.map(({ index }) => index));
    if (lines.slice(0, first).some((line) => line.trim())) pushIssue(issues, issue(
      'body.structure.leading_content', 'body', 'Guidance appears before the SIGNAL label.',
      'Unlabelled content cannot be assigned a deterministic meaning.',
      'Move it into the appropriate required section.',
    ));
  }
  occurrences.sort((a, b) => a.index - b.index).forEach((entry, occurrenceIndex) => {
    const next = occurrences[occurrenceIndex + 1]?.index ?? lines.length;
    const sectionLines = lines.slice(entry.index + 1, next).map((line) => line.trim()).filter(Boolean);
    const sectionText = sectionLines.join('\n');
    if (!meaningful(sectionText)) {
      pushIssue(issues, issue(
        'body.structure.section_incomplete', `body.${entry.label}`,
        `Section ${entry.label} does not contain meaningful guidance.`,
        'Empty, very short, or placeholder sections cannot ground an investigation.',
        `Add at least ${MIN_CONTENT_CHARS} specific characters below ${entry.label}.`,
      ));
      return;
    }
    if (entry.label === 'INVESTIGATION STEPS') {
      const numbers: number[] = [];
      let invalid = false;
      let incomplete = false;
      sectionLines.forEach((line) => {
        const match = /^(\d+)\.\s+(.+)$/.exec(line);
        if (!match) invalid = true;
        else {
          numbers.push(Number(match[1]));
          if (!meaningful(match[2])) incomplete = true;
        }
      });
      if (invalid || !numbers.length) pushIssue(issues, issue(
        'body.steps.format', 'body.INVESTIGATION STEPS',
        'Every investigation step must be one numbered line.',
        'One-line numbered steps are compact and deterministic for smaller models.',
        'Use only lines such as 1. Inspect authentication outcomes.',
      ));
      if (numbers.length && numbers.some((number, index) => number !== index + 1)) pushIssue(issues, issue(
        'body.steps.sequence', 'body.INVESTIGATION STEPS',
        'Investigation step numbers are not sequential from 1.',
        'Stable numbering prevents missing or duplicated procedural steps.',
        'Renumber the one-line steps as 1., 2., 3., without gaps.',
      ));
      if (incomplete) pushIssue(issues, issue(
        'body.steps.incomplete', 'body.INVESTIGATION STEPS',
        'One or more investigation steps are too short or still placeholders.',
        'A step must name a concrete evidence check or analyst action.',
        `Give every step at least ${MIN_CONTENT_CHARS} specific characters.`,
      ));
    } else if (sectionLines.some((line) => /^\d+\.\s+/.test(line))) {
      pushIssue(issues, issue(
        'body.structure.numbered_outside_steps', `body.${entry.label}`,
        `Numbered lines are only allowed under INVESTIGATION STEPS, not ${entry.label}.`,
        'Numbers outside the procedure blur evidence signals with ordered actions.',
        'Remove the number and keep each item as a plain sentence line.',
      ));
    }
  });
  return issues;
}

export function validateRunbookAuthoring(content: string, expectedId?: string): RunbookAuthoringValidation {
  if (!content.trim()) {
    return {
      body: '', bodyCharacters: 0, descriptorCharacters: 0,
      issues: [issue('document.required', 'content', 'Runbook content is required.', 'The catalog cannot index an empty runbook.', 'Start from the in-product template and complete every required field.')],
    };
  }
  const parsed = parseDocument(content);
  const issues: RunbookAuthoringIssue[] = [];
  if (content.includes('\0')) pushIssue(issues, issue('document.nul_byte', 'content', 'Runbook content contains a NUL byte.', 'NUL bytes are not valid authoring text and can break downstream storage.', 'Remove the NUL byte and paste clean UTF-8 text.'));
  if (new TextEncoder().encode(content).length > MAX_DOCUMENT_BYTES) pushIssue(issues, issue('document.too_large', 'content', 'The complete runbook exceeds the 128 KiB storage safety limit.', 'The outer safety bound protects durable state and API payloads.', 'Remove pasted logs or attachments; keep only concise guidance.'));
  metadataIssues(parsed, expectedId).forEach((entry) => pushIssue(issues, entry));
  const descriptorCharacters = retrievalDescriptorCharacters(parsed);
  const bodyCharacters = Array.from(parsed.body).length;
  if (!parsed.body) {
    pushIssue(issues, issue('body.required', 'body', 'The guidance body is empty.', 'A runbook needs evidence and decision guidance to help an investigation.', 'Complete every required body section in the in-product template.'));
  } else {
    if (bodyCharacters > RUNBOOK_BODY_MAX_CHARS) pushIssue(issues, issue('body.too_long', 'body', `The guidance body is ${bodyCharacters} characters; maximum is ${RUNBOOK_BODY_MAX_CHARS}.`, 'A single bounded guidance chunk reduces cost and improves smaller-model focus.', `Remove repetition and examples until the body is ${RUNBOOK_BODY_MAX_CHARS} Unicode characters or fewer.`));
    BODY_FORMATS.forEach(([code, pattern, problem, reason, fix]) => {
      if (pattern.test(parsed.body)) pushIssue(issues, issue(code, 'body', problem, reason, fix));
    });
    if (PLACEHOLDER.test(parsed.body)) pushIssue(issues, issue('body.placeholder', 'body', 'The guidance still contains template placeholder text.', 'Placeholder scaffolding supplies no evidence and can mislead the agent.', 'Replace every bracketed instruction, TODO, or TBD with case-specific guidance.'));
    structureIssues(parsed.body).forEach((entry) => pushIssue(issues, entry));
  }
  return { body: parsed.body, bodyCharacters, descriptorCharacters, issues };
}

function issueFromUnknown(value: unknown, index: number): RunbookAuthoringIssue | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const text = (key: string) => (typeof row[key] === 'string' ? row[key].trim() : '');
  const problem = text('problem') || text('message') || text('detail');
  if (!problem) return null;
  return {
    code: text('code') || `backend_issue_${index}`,
    field: text('field') || text('path') || 'Runbook',
    problem,
    reason: text('reason') || 'The backend rejected this value under the current authoring policy.',
    fix: text('fix') || 'Correct the reported value and submit the runbook again.',
  };
}

export function extractRunbookBackendIssues(error: unknown): RunbookAuthoringIssue[] {
  if (!error || typeof error !== 'object') return [];
  const candidate = error as { status?: unknown; body?: unknown };
  if (candidate.status !== 422 || !candidate.body || typeof candidate.body !== 'object') return [];
  const body = candidate.body as Record<string, unknown>;
  const detail = body.detail;
  let raw: unknown[] = [];
  if (Array.isArray(detail)) raw = detail;
  else if (detail && typeof detail === 'object') {
    const envelope = detail as Record<string, unknown>;
    if (Array.isArray(envelope.issues)) raw = envelope.issues;
    else if (Array.isArray(envelope.errors)) raw = envelope.errors;
  }
  if (!raw.length && Array.isArray(body.issues)) raw = body.issues;
  return raw.map(issueFromUnknown).filter((entry): entry is RunbookAuthoringIssue => entry !== null);
}

export function runbookTemplate(id = ''): string {
  return `---
id: ${id}
title:
summary:
persona:
applies_to_rules: []
applies_to_techniques: []
applies_to_entities: []
keywords: []
---

SIGNAL

EVIDENCE REQUIRED

INVESTIGATION STEPS

TRUE POSITIVE SIGNALS

FALSE POSITIVE SIGNALS

NEEDS HUMAN WHEN

RECOMMENDED NEXT ACTION
`;
}
