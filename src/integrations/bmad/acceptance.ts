import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BmadAcceptanceCriteriaResult } from './contracts.js';

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match?.[1] ?? null;
}

function extractFrontmatterCriteria(frontmatter: string | null): string[] {
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^\s*acceptance_criteria\s*:\s*$/.test(line));
  if (startIndex === -1) return [];

  const criteria: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet?.[1]) {
      criteria.push(bullet[1].trim());
    }
  }
  return uniqueStrings(criteria);
}

function extractMarkdownHeadingCriteria(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const criteria: string[] = [];
  let inAcceptanceSection = false;

  for (const line of lines) {
    if (/^#{2,6}\s+Acceptance(?:\s+Criteria)?\s*$/i.test(line.trim())) {
      inAcceptanceSection = true;
      continue;
    }
    if (inAcceptanceSection && /^#{1,6}\s+/.test(line.trim())) {
      break;
    }
    if (!inAcceptanceSection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet?.[1]) {
      criteria.push(bullet[1].trim());
    }
  }

  return uniqueStrings(criteria);
}

export async function parseBmadAcceptanceCriteria(
  projectRoot: string,
  storyPath: string | null,
): Promise<BmadAcceptanceCriteriaResult> {
  if (!storyPath) {
    return {
      storyPath: null,
      criteria: [],
      source: 'none',
    };
  }

  const fullPath = join(projectRoot, storyPath);
  if (!existsSync(fullPath)) {
    return {
      storyPath,
      criteria: [],
      source: 'none',
    };
  }

  const content = await readFile(fullPath, 'utf-8');
  const frontmatterCriteria = extractFrontmatterCriteria(extractFrontmatterBlock(content));
  if (frontmatterCriteria.length > 0) {
    return {
      storyPath,
      criteria: frontmatterCriteria,
      source: 'frontmatter',
    };
  }

  const headingCriteria = extractMarkdownHeadingCriteria(content);
  if (headingCriteria.length > 0) {
    return {
      storyPath,
      criteria: headingCriteria,
      source: 'markdown-heading',
    };
  }

  return {
    storyPath,
    criteria: [],
    source: 'none',
  };
}
