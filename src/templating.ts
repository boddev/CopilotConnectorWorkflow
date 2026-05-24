import * as fs from 'fs';
import * as path from 'path';

/** Tiny mustache-like substitution: {{key}} -> values[key]. No conditionals.
 *  Unknown keys are left as {{key}} (preserves Agents Toolkit ${{ENV_VAR}} syntax). */
export function renderString(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, k) => {
    if (!(k in values)) return match;
    const v = values[k];
    return v == null ? '' : String(v);
  });
}

/** Render a single file: strips the .hbs suffix if present. */
export function renderFileToDir(
  srcFile: string,
  destDir: string,
  destRelativePath: string,
  values: Record<string, string>,
): string {
  const targetRel = destRelativePath.replace(/\.hbs$/, '');
  const dest = path.join(destDir, targetRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ext = path.extname(srcFile).toLowerCase();
  const binary = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.zip'].includes(ext);
  if (binary) {
    fs.copyFileSync(srcFile, dest);
  } else if (srcFile.endsWith('.hbs')) {
    const text = fs.readFileSync(srcFile, 'utf-8');
    fs.writeFileSync(dest, renderString(text, values), 'utf-8');
  } else {
    fs.copyFileSync(srcFile, dest);
  }
  return dest;
}

export function renderTree(
  srcDir: string,
  destDir: string,
  values: Record<string, string>,
  filter?: (rel: string) => boolean,
): string[] {
  const out: string[] = [];
  const walk = (cur: string, rel: string) => {
    for (const name of fs.readdirSync(cur)) {
      const p = path.join(cur, name);
      const r = rel ? `${rel}/${name}` : name;
      const stat = fs.statSync(p);
      if (stat.isDirectory()) walk(p, r);
      else {
        if (filter && !filter(r)) continue;
        out.push(renderFileToDir(p, destDir, r, values));
      }
    }
  };
  walk(srcDir, '');
  return out;
}
