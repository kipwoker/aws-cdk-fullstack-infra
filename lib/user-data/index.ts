import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Reads a cloud-init script and replaces `{{PLACEHOLDER}}` tokens.
 * Keeping scripts as real shell files means they stay readable and can be
 * shell-checked outside of CDK.
 */
export function renderUserData(file: string, values: Record<string, string>): string {
  let script = readFileSync(join(__dirname, file), 'utf8')
  for (const [key, value] of Object.entries(values)) {
    script = script.split(`{{${key}}}`).join(value)
  }

  const missing = script.match(/{{[A-Z0-9_]+}}/g)
  if (missing) {
    throw new Error(`Unresolved user-data placeholders in ${file}: ${[...new Set(missing)].join(', ')}`)
  }
  return script
}
