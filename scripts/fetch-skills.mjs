import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SKILLS = [
  {
    name: "helm",
    upstream:
      "https://raw.githubusercontent.com/helm-agent/helm-agent/main/skills/helm/SKILL.md",
  },
];

const OUT_DIR = "public/.well-known/agent-skills";
const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

function extractDescription(name, mdText) {
  const m = mdText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`${name}: SKILL.md has no YAML frontmatter`);
  const block = m[1];
  const dm = block.match(/^description:[ \t]*(.+?)[ \t]*$/m);
  if (!dm) throw new Error(`${name}: SKILL.md frontmatter missing 'description'`);
  const value = dm[1];
  if (value.length === 0) {
    throw new Error(`${name}: SKILL.md frontmatter 'description' is empty`);
  }
  if (/^["'>|]/.test(value)) {
    throw new Error(
      `${name}: SKILL.md frontmatter 'description' must be a plain YAML scalar (got value starting with ${JSON.stringify(value[0])}). Update upstream or extend the parser.`,
    );
  }
  return value;
}

async function sha256Hex(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchSkill({ name, upstream }) {
  const res = await fetch(upstream);
  if (!res.ok) {
    throw new Error(`${name}: upstream ${upstream} returned ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const description = extractDescription(name, text);
  const digestHex = await sha256Hex(bytes);
  return { name, bytes, description, digestHex };
}

async function main() {
  const fetched = [];
  for (const skill of SKILLS) {
    fetched.push(await fetchSkill(skill));
  }

  const index = {
    $schema: SCHEMA,
    skills: fetched.map((s) => ({
      name: s.name,
      type: "skill-md",
      description: s.description,
      url: `/.well-known/agent-skills/${s.name}/SKILL.md`,
      files: ["SKILL.md"],
      digest: `sha256:${s.digestHex}`,
    })),
  };

  for (const s of fetched) {
    const path = join(OUT_DIR, s.name, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, s.bytes);
  }
  const indexPath = join(OUT_DIR, "index.json");
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");

  for (const s of fetched) {
    console.log(`✓ ${s.name} sha256:${s.digestHex}`);
  }
}

await main();
